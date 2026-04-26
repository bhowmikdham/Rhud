"""
Inference: load the active model, transform the incoming scope, return a
predicted price + band + top-k similar historical quotes.

Caching: we keep an LRU of {(tenant_id, sequence) -> payload} so most
predict calls are pure-CPU after the first hit.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np

from .features import cosine_similarity
from .storage import ArtifactStore


@dataclass
class PredictResult:
    predicted_price_cents: int
    price_low_cents: int
    price_high_cents: int
    confidence: float
    top_k_similar: list[dict[str, object]]
    model_version: int
    cold_start: bool
    # Set when the active model is the modifier kind. Lets the API
    # surface "× 0.92 of base" reasoning in the approval card without
    # re-loading the model on the JS side.
    adjustment_pct: float | None = None
    mode: str = "absolute"


# `lru_cache` keys on the tuple, so distinct (tenant, sequence) pairs cache
# independently. Keep this small — each entry is a serialised model.
@lru_cache(maxsize=32)
def _cached_payload(tenant_id: str, sequence: int) -> dict[str, Any]:
    return ArtifactStore().load_model(tenant_id, sequence)


def predict_for_tenant(
    tenant_id: str,
    scope: dict[str, Any],
    store: ArtifactStore,
    base_price_cents: int | None = None,
) -> PredictResult | None:
    """Returns None if no model has been trained at all for this tenant.

    For modifier-mode models, callers should pass `base_price_cents`
    (the deterministic Stage-2 result). The model returns an adjustment
    ratio that's applied to that base. If the caller doesn't pass a
    base, we fall back to the model's training-set median so the API
    still returns *something* without lying about precision.
    """
    sequence = store.get_active_sequence(tenant_id)
    if sequence is None:
        return None
    payload = _cached_payload(tenant_id, sequence)

    if payload.get("kind") == "cold_start":
        # Tenant trained but with too few rows. If we have a base, we
        # quote the base back with a 0% adjustment + wide band so the
        # approval card reads "modifier insufficient — quoting at base".
        if base_price_cents is not None:
            band = int(base_price_cents * 0.25)
            return PredictResult(
                predicted_price_cents=base_price_cents,
                price_low_cents=max(0, base_price_cents - band),
                price_high_cents=base_price_cents + band,
                confidence=0.40,
                top_k_similar=_top_k_simple(scope, payload.get("training_set", [])),
                model_version=sequence,
                cold_start=True,
                adjustment_pct=0.0,
                mode="modifier",
            )
        median = int(payload["median_price_cents"])
        band = int(median * 0.25)
        return PredictResult(
            predicted_price_cents=median,
            price_low_cents=median - band,
            price_high_cents=median + band,
            confidence=0.40,
            top_k_similar=_top_k_simple(scope, payload.get("training_set", [])),
            model_version=sequence,
            cold_start=True,
            mode="absolute",
        )

    pipeline = payload["pipeline"]
    model = payload["model"]
    training_features = payload.get("training_features")
    training_set = payload.get("training_set", [])
    mode: str = payload.get("mode", "absolute")

    X_new = pipeline.transform([scope])
    raw = float(model.predict(X_new)[0])

    if mode == "modifier":
        # raw is log(final/base). Apply to the deterministic base and
        # surface the ratio so the approval card can show "× 0.92".
        ratio = float(np.exp(raw))
        if base_price_cents is None:
            # Caller forgot to pass base — fall back to training-set
            # median so we don't return a meaningless ratio.
            base_price_cents = int(payload.get("median_price_cents", 0))
        pred_cents = int(round(base_price_cents * ratio))
        adjustment_pct = ratio - 1.0
    else:
        pred_cents = int(round(float(np.exp(raw))))
        adjustment_pct = None

    # Simple ±15% band — proper quantile XGBoost is design ambition.
    band = int(pred_cents * 0.15)
    low_cents = max(0, pred_cents - band)
    high_cents = pred_cents + band

    top_k = _top_k_features(X_new[0], training_features, training_set)

    rel = band / pred_cents if pred_cents > 0 else 1.0
    confidence = max(0.5, min(0.96, 1 - rel))

    return PredictResult(
        predicted_price_cents=pred_cents,
        price_low_cents=low_cents,
        price_high_cents=high_cents,
        confidence=float(confidence),
        top_k_similar=top_k,
        model_version=sequence,
        cold_start=False,
        adjustment_pct=adjustment_pct,
        mode=mode,
    )


def _top_k_features(
    new_vec: np.ndarray,
    training_features: np.ndarray | None,
    training_set: list[tuple[dict[str, Any], float]],
    k: int = 5,
) -> list[dict[str, object]]:
    if training_features is None or len(training_set) == 0:
        return []
    sims = [cosine_similarity(new_vec, training_features[i]) for i in range(len(training_set))]
    top = sorted(range(len(sims)), key=lambda i: sims[i], reverse=True)[:k]
    out: list[dict[str, object]] = []
    for i in top:
        scope, price = training_set[i]
        out.append({
            "score": round(sims[i], 4),
            "price_cents": int(price),
            "scope_summary": _summarise_scope(scope),
        })
    return out


def _top_k_simple(
    scope: dict[str, Any],
    training_set: list[Any],
    k: int = 5,
) -> list[dict[str, object]]:
    """For cold-start: order by Jaccard overlap on key/value pairs since we
    don't have a feature matrix yet."""
    if not training_set:
        return []
    keys_new = set((k_, str(v)[:60]) for k_, v in scope.items() if not isinstance(v, list))
    scored: list[tuple[float, dict[str, Any], float]] = []
    for entry in training_set:
        # entries are (scope, price) tuples but joblib may have made lists
        scope_old, price = entry[0], float(entry[1])
        keys_old = set(
            (k_, str(v)[:60]) for k_, v in scope_old.items() if not isinstance(v, list)
        )
        union = keys_new | keys_old
        inter = keys_new & keys_old
        score = (len(inter) / len(union)) if union else 0.0
        scored.append((score, scope_old, price))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [
        {
            "score": round(s, 4),
            "price_cents": int(price),
            "scope_summary": _summarise_scope(scope_old),
        }
        for s, scope_old, price in scored[:k]
    ]


def _summarise_scope(scope: dict[str, Any]) -> str:
    """Tiny human-readable digest of a scope dict for the UI's similar-list."""
    parts: list[str] = []
    for k_, v in list(scope.items())[:4]:
        if isinstance(v, list):
            parts.append(f"{k_}={','.join(map(str, v[:3]))}")
        else:
            parts.append(f"{k_}={str(v)[:30]}")
    return " · ".join(parts)
