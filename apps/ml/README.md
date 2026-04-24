# rhud-ml

Per-tenant ML service. Sprint 1 scope: scaffold only — `/predict` and `/train` return 501.

## Run

```bash
cd apps/ml
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
uvicorn rhud_ml.main:app --reload --port 8001
```

Health check: http://localhost:8001/health
