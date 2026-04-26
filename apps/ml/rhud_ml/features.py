"""
Feature engineering for Rhud price prediction.

Design (§4.8):
- Flatten the scope_fields JSON into a flat dict of (key, value) pairs.
- One-hot any categorical (string) keys, numeric pass-through.
- Text fields could go through sentence-embeddings; for MVP we hash short
  string answers into a small dimension, deferring embeddings to v1.1 (they
  pull in transformers + 100MB+ of weights, not worth it before we have a
  customer training corpus large enough to benefit from semantic features).

The pipeline is fit during training and persisted alongside the model so
inference uses the IDENTICAL transform.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.feature_extraction import DictVectorizer
from sklearn.pipeline import Pipeline


class ScopeFlattener(BaseEstimator, TransformerMixin):  # type: ignore[misc]
    """Take a list of scope dicts, normalise list-valued answers into
    pipe-joined strings so they hash consistently. Returns list[dict[str, Any]]
    suitable for DictVectorizer."""

    def fit(self, X: list[dict[str, Any]], y: Any | None = None) -> ScopeFlattener:
        return self

    def transform(self, X: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for row in X:
            flat: dict[str, Any] = {}
            for k, v in row.items():
                if isinstance(v, list):
                    # multi-select -> indicator features per element
                    for elt in v:
                        flat[f"{k}={elt}"] = 1
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    flat[k] = float(v)
                elif isinstance(v, bool):
                    flat[k] = int(v)
                elif v is None:
                    continue
                else:
                    # categorical / short text -> one-hot via DictVectorizer
                    flat[f"{k}={str(v)[:60]}"] = 1
            out.append(flat)
        return out


def make_pipeline() -> Pipeline:
    """Sklearn pipeline used for both training and inference. Persisted to
    S3 alongside the trained XGBoost model so the same transformations
    apply at serve time."""
    return Pipeline(
        steps=[
            ("flatten", ScopeFlattener()),
            ("dictvec", DictVectorizer(sparse=False, sort=True)),
        ]
    )


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two 1D vectors."""
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
