"""
Training pipeline.

Two training modes, automatically selected per tenant based on what the
historical quotes carry:

  • modifier  — every record has both `base_price` (computed against the
                rate card at the time) and `final_price` (what closed).
                Target: log(final_price / base_price). Output is an
                adjustment ratio applied to a fresh base price at
                predict time. This is the Phase-4 design from the
                Pricing Engine PDF §3.4.

  • absolute  — fallback for tenants whose historical contracts predate
                the rate-card schema, so we can't derive base_price.
                Target: log(final_price), same as the original MVP
                pipeline. Quotes that arrive with a known base get
                priced as base+0% adjustment; the model just retargets
                whenever real labelled data lands.

Cold-start rule (§4.8 / Pricing PDF §5.1): if `n_train < MIN_TRAIN` we
return the deterministic base + 0% adjustment with `active=False` so
the API can show "modifier model not yet activated" in the manager
approval card.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from xgboost import XGBRegressor

from .features import make_pipeline
from .storage import ArtifactStore, ModelMeta, _utc_now

# Below this many training rows, we skip XGBoost and serve a rule-based
# tenant-median fallback. Matches design doc §4.8.
MIN_TRAIN = 20


@dataclass
class TrainResult:
    sequence: int
    n_train: int
    active: bool
    mae: float | None
    rmse: float | None
    cold_start: bool
    median_price_cents: int


def _validate_records(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], np.ndarray, np.ndarray | None]:
    """Pull out scope_fields + final_price (+ optional base_price).

    Contract: `final_price` and `base_price` are in DOLLARS (float).
    We convert to integer cents internally so all downstream code
    (model output, API responses, engagement.predicted_price_cents)
    speaks one unit.

    Returns (scopes, final_cents, base_cents | None). `base_cents` is
    None when even one record lacks a `base_price` — the trainer
    falls back to absolute targeting in that case.
    """
    scopes: list[dict[str, Any]] = []
    prices_dollars: list[float] = []
    base_dollars: list[float] = []
    saw_base = True
    for r in records:
        sf = r.get("scope_fields") or r.get("scope")
        fp = r.get("final_price") or r.get("price")
        bp = r.get("base_price")
        if not isinstance(sf, dict) or fp is None:
            continue
        try:
            final_d = float(fp)
        except (TypeError, ValueError):
            continue
        scopes.append(sf)
        prices_dollars.append(final_d)
        if bp is None:
            saw_base = False
            base_dollars.append(0.0)
        else:
            try:
                base_dollars.append(float(bp))
            except (TypeError, ValueError):
                saw_base = False
                base_dollars.append(0.0)

    if not prices_dollars:
        raise ValueError("no usable training rows: need scope_fields + final_price")

    final_cents = np.round(np.array(prices_dollars, dtype=np.float64) * 100)
    base_cents = (
        np.round(np.array(base_dollars, dtype=np.float64) * 100) if saw_base else None
    )
    # Guard against zero/negative base prices breaking the log ratio.
    if base_cents is not None and (base_cents <= 0).any():
        base_cents = None
    return scopes, final_cents, base_cents


def train_for_tenant(
    tenant_id: str,
    records: list[dict[str, Any]],
    store: ArtifactStore,
) -> TrainResult:
    scopes, prices_cents, base_cents = _validate_records(records)
    n = len(scopes)
    median_cents = int(np.median(prices_cents))
    mode = "modifier" if base_cents is not None else "absolute"

    sequence = store.next_sequence(tenant_id)
    cold_start = n < MIN_TRAIN

    if cold_start:
        # Persist a fallback artifact so /predict has something to load.
        # No XGBoost — just records median + raw training set for top-k.
        payload: dict[str, Any] = {
            "kind": "cold_start",
            "median_price_cents": median_cents,
            "training_set": list(zip(scopes, prices_cents.tolist(), strict=False)),
        }
        meta = ModelMeta(
            sequence=sequence,
            trained_at=_utc_now(),
            n_train=n,
            mae=0.0,
            rmse=0.0,
            active=False,
            tenant_id=tenant_id,
        )
        store.put_model(tenant_id, sequence, payload, meta)
        store.set_active(tenant_id, sequence)
        return TrainResult(
            sequence=sequence,
            n_train=n,
            active=False,
            mae=None,
            rmse=None,
            cold_start=True,
            median_price_cents=median_cents,
        )

    # Real training path. Two modes:
    #   modifier  → target = log(final / base). Output is an adjustment
    #               ratio applied to a fresh base price at predict time.
    #   absolute  → target = log(final). Original MVP path; kept for
    #               tenants whose history predates the rate-card schema.
    pipeline = make_pipeline()
    X = pipeline.fit_transform(scopes)

    if mode == "modifier":
        assert base_cents is not None  # for type-checker
        # Defensive bound on the ratio: clip extreme outliers so a single
        # absurd row doesn't dominate the regressor. ±60% covers the bulk
        # of B2B services discounting + premiums.
        ratios = prices_cents / base_cents
        ratios = np.clip(ratios, 0.4, 1.6)
        y = np.log(ratios)
    else:
        y = np.log(prices_cents)

    model = XGBRegressor(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.08,
        subsample=0.85,
        objective="reg:squarederror",
        random_state=42,
        verbosity=0,
    )

    model.fit(X, y)
    y_pred = model.predict(X)

    if mode == "modifier":
        pred_cents = base_cents * np.exp(y_pred)  # type: ignore[operator]
    else:
        pred_cents = np.exp(y_pred)
    mae_cents = float(np.mean(np.abs(pred_cents - prices_cents)))
    rmse_cents = float(math.sqrt(np.mean((pred_cents - prices_cents) ** 2)))

    payload = {
        "kind": "xgboost",
        "mode": mode,                  # 'modifier' | 'absolute'
        "pipeline": pipeline,
        "model": model,
        "training_features": X,
        "training_set": list(zip(scopes, prices_cents.tolist(), strict=False)),
        "training_base_cents":
            base_cents.tolist() if base_cents is not None else None,
        "median_price_cents": median_cents,
    }
    meta = ModelMeta(
        sequence=sequence,
        trained_at=_utc_now(),
        n_train=n,
        mae=mae_cents,
        rmse=rmse_cents,
        active=True,
        tenant_id=tenant_id,
    )
    store.put_model(tenant_id, sequence, payload, meta)
    store.set_active(tenant_id, sequence)

    return TrainResult(
        sequence=sequence,
        n_train=n,
        active=True,
        mae=mae_cents,
        rmse=rmse_cents,
        cold_start=False,
        median_price_cents=median_cents,
    )
