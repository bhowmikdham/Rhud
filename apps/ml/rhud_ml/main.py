"""
Rhud ML service — MVP scaffold.

Sprint 1 stubs the two endpoints the design doc §4.5 / §4.8 call for:
  - POST /predict: given a scope vector, return predicted price + band.
  - POST /train: (re)train a per-tenant XGBoost model from historical quotes.

Both currently return 501 Not Implemented. Real implementation lands in
sprint 5 of the build order (§4.12).
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="rhud-ml", version="0.0.0")


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "ml"}


class PredictRequest(BaseModel):
    tenant_id: str
    engagement_id: str
    scope: dict[str, object] = Field(
        description="Flattened scope answers keyed by node id."
    )


class PredictResponse(BaseModel):
    predicted_price_cents: int
    price_low_cents: int
    price_high_cents: int
    confidence: float
    top_k_similar: list[dict[str, object]]
    model_version: int
    cold_start: bool


@app.post("/predict", response_model=PredictResponse, status_code=501)
def predict(_req: PredictRequest) -> PredictResponse:
    raise HTTPException(
        status_code=501,
        detail="not_implemented: sprint 5 — trains per-tenant XGBoost model",
    )


class TrainRequest(BaseModel):
    tenant_id: str
    # Paths to CSVs in the shared object store, or inline rows.
    csv_keys: list[str] | None = None


@app.post("/train", status_code=501)
def train(_req: TrainRequest) -> dict[str, object]:
    raise HTTPException(
        status_code=501,
        detail="not_implemented: sprint 5 — training pipeline + cold-start fallback",
    )
