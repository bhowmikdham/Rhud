"""
Rhud ML service — sprint 5.

Endpoints (design doc §4.5 + §4.8):
  - POST /train    — accept historical quotes, train per-tenant XGBoost,
                     persist artifact to S3 (MinIO locally).
  - POST /predict  — run inference for an engagement's scope, return
                     predicted price + band + top-k similar.
  - GET  /health   — readiness check.

Cold-start (n_train < 20): training succeeds with a fallback artifact
that records the tenant median; predict returns it with a wide band and
a low confidence so the UI can label "indicative only".
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .predict import predict_for_tenant
from .storage import ArtifactStore
from .train import train_for_tenant

app = FastAPI(title="rhud-ml", version="0.1.0")
_store = ArtifactStore()


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "ml"}


# ── /predict ────────────────────────────────────────────────────────────────


class PredictRequest(BaseModel):
    tenant_id: str
    engagement_id: str
    scope: dict[str, Any] = Field(
        description="Flattened scope answers keyed by node id."
    )
    # Deterministic Stage-2 base price. Required for modifier-mode
    # models; ignored by absolute-mode (legacy) models.
    base_price_cents: int | None = Field(default=None)


class TopKEntry(BaseModel):
    score: float
    price_cents: int
    scope_summary: str


class PredictResponse(BaseModel):
    predicted_price_cents: int
    price_low_cents: int
    price_high_cents: int
    confidence: float
    top_k_similar: list[TopKEntry]
    model_version: int
    cold_start: bool
    # Modifier-mode: ratio - 1 (e.g. -0.08 for an 8% discount). null for
    # absolute-mode models.
    adjustment_pct: float | None = None
    mode: str = "absolute"


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    result = predict_for_tenant(req.tenant_id, req.scope, _store, req.base_price_cents)
    if result is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "no_active_model",
                "message": (
                    "No model has been trained for this tenant. POST /train "
                    "with at least one historical quote before predicting."
                ),
            },
        )
    return PredictResponse(
        predicted_price_cents=result.predicted_price_cents,
        price_low_cents=result.price_low_cents,
        price_high_cents=result.price_high_cents,
        confidence=result.confidence,
        top_k_similar=[
            TopKEntry(
                score=float(t["score"]),  # type: ignore[arg-type]
                price_cents=int(t["price_cents"]),  # type: ignore[call-overload]
                scope_summary=str(t["scope_summary"]),
            )
            for t in result.top_k_similar
        ],
        model_version=result.model_version,
        cold_start=result.cold_start,
        adjustment_pct=result.adjustment_pct,
        mode=result.mode,
    )


# ── /tenants/<id>/models — status + history ────────────────────────────────


class ModelMetaOut(BaseModel):
    sequence: int
    trained_at: str
    n_train: int
    mae: float | None
    rmse: float | None
    active: bool
    tenant_id: str


class ModelStatusResponse(BaseModel):
    active_sequence: int | None
    active_meta: ModelMetaOut | None
    history: list[ModelMetaOut]


@app.get("/tenants/{tenant_id}/models", response_model=ModelStatusResponse)
def models_status(tenant_id: str) -> ModelStatusResponse:
    history = _store.list_models(tenant_id)
    active_seq = _store.get_active_sequence(tenant_id)
    active_meta = None
    if active_seq is not None:
        m = _store.get_meta(tenant_id, active_seq)
        if m is not None:
            active_meta = ModelMetaOut(**m)
    return ModelStatusResponse(
        active_sequence=active_seq,
        active_meta=active_meta,
        history=[ModelMetaOut(**m) for m in history],
    )


# ── /train ──────────────────────────────────────────────────────────────────


class TrainRecord(BaseModel):
    """One historical quote. `final_price` is dollars (float). Cents are
    computed inside the trainer.

    `base_price` (dollars) is the deterministic Stage-2 base computed for
    the same scope at the time the deal closed. When every record carries
    one, the trainer switches to modifier mode (target = log(final/base)).
    """

    service_line: str | None = None
    scope_fields: dict[str, Any] = Field(default_factory=dict)
    final_price: float
    base_price: float | None = None
    closed_at: str | None = None
    won_lost: bool | None = None


class TrainRequest(BaseModel):
    tenant_id: str
    records: list[TrainRecord]


class TrainResponse(BaseModel):
    sequence: int
    n_train: int
    active: bool
    cold_start: bool
    mae_cents: float | None
    rmse_cents: float | None
    median_price_cents: int


@app.post("/train", response_model=TrainResponse)
def train(req: TrainRequest) -> TrainResponse:
    if not req.records:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_records", "message": "Send at least one record."},
        )
    result = train_for_tenant(
        req.tenant_id,
        [r.model_dump() for r in req.records],
        _store,
    )
    return TrainResponse(
        sequence=result.sequence,
        n_train=result.n_train,
        active=result.active,
        cold_start=result.cold_start,
        mae_cents=result.mae,
        rmse_cents=result.rmse,
        median_price_cents=result.median_price_cents,
    )
