"""
S3-compatible artifact storage for trained models.

Layout (matches design doc §4.8):
  s3://<bucket>/tenants/<tenant_id>/models/v<sequence>/
      model.joblib   — joblib-serialised dict {pipeline, model, training_set}
      meta.json      — {sequence, trained_at, n_train, mae, rmse, active, tenant_id}

A separate `pointer.json` at s3://.../tenants/<tenant_id>/models/active.json
holds the currently-active sequence number. Predict reads pointer.json,
loads model.joblib, caches in memory.
"""

from __future__ import annotations

import io
import json
import os
import time
from dataclasses import dataclass
from typing import Any

import boto3
import joblib
from botocore.client import Config


@dataclass
class ModelMeta:
    sequence: int
    trained_at: str
    n_train: int
    mae: float
    rmse: float
    active: bool
    tenant_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "sequence": self.sequence,
            "trained_at": self.trained_at,
            "n_train": self.n_train,
            "mae": self.mae,
            "rmse": self.rmse,
            "active": self.active,
            "tenant_id": self.tenant_id,
        }


class ArtifactStore:
    """Thin wrapper around boto3 for the per-tenant model layout. The same
    code talks to MinIO locally and AWS S3 in production — `force_path_style`
    is what makes MinIO work."""

    def __init__(self) -> None:
        endpoint = os.environ.get("S3_ENDPOINT", "http://localhost:9000")
        region = os.environ.get("S3_REGION", "us-east-1")
        access = os.environ.get("S3_ACCESS_KEY", "rhud")
        secret = os.environ.get("S3_SECRET_KEY", "rhud-secret")
        self.bucket = os.environ.get("S3_BUCKET", "rhud-dev")
        self.s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access,
            aws_secret_access_key=secret,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    # ── Keys ──────────────────────────────────────────────────────────────

    @staticmethod
    def _model_key(tenant_id: str, sequence: int) -> str:
        return f"tenants/{tenant_id}/models/v{sequence}/model.joblib"

    @staticmethod
    def _meta_key(tenant_id: str, sequence: int) -> str:
        return f"tenants/{tenant_id}/models/v{sequence}/meta.json"

    @staticmethod
    def _pointer_key(tenant_id: str) -> str:
        return f"tenants/{tenant_id}/models/active.json"

    # ── IO ────────────────────────────────────────────────────────────────

    def next_sequence(self, tenant_id: str) -> int:
        prefix = f"tenants/{tenant_id}/models/"
        try:
            resp = self.s3.list_objects_v2(Bucket=self.bucket, Prefix=prefix)
        except Exception:
            return 1
        contents = resp.get("Contents") or []
        seqs: list[int] = []
        for obj in contents:
            key = obj["Key"]
            # tenants/<id>/models/v<n>/...
            after = key[len(prefix):]
            if after.startswith("v"):
                head = after.split("/", 1)[0]
                try:
                    seqs.append(int(head[1:]))
                except ValueError:
                    continue
        return (max(seqs) + 1) if seqs else 1

    def put_model(
        self, tenant_id: str, sequence: int, payload: dict[str, Any], meta: ModelMeta
    ) -> None:
        buf = io.BytesIO()
        joblib.dump(payload, buf, compress=3)
        buf.seek(0)
        self.s3.put_object(
            Bucket=self.bucket,
            Key=self._model_key(tenant_id, sequence),
            Body=buf.getvalue(),
            ContentType="application/octet-stream",
        )
        self.s3.put_object(
            Bucket=self.bucket,
            Key=self._meta_key(tenant_id, sequence),
            Body=json.dumps(meta.to_dict()).encode("utf-8"),
            ContentType="application/json",
        )

    def set_active(self, tenant_id: str, sequence: int) -> None:
        self.s3.put_object(
            Bucket=self.bucket,
            Key=self._pointer_key(tenant_id),
            Body=json.dumps({"active_sequence": sequence, "updated_at": _utc_now()}).encode(),
            ContentType="application/json",
        )

    def get_active_sequence(self, tenant_id: str) -> int | None:
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=self._pointer_key(tenant_id))
        except Exception:
            # NoSuchKey or any S3 error → "no model yet" rather than 500.
            return None
        data = json.loads(obj["Body"].read().decode("utf-8"))
        seq = data.get("active_sequence")
        return int(seq) if isinstance(seq, int) else None

    def load_model(self, tenant_id: str, sequence: int) -> dict[str, Any]:
        obj = self.s3.get_object(
            Bucket=self.bucket, Key=self._model_key(tenant_id, sequence)
        )
        buf = io.BytesIO(obj["Body"].read())
        loaded: dict[str, Any] = joblib.load(buf)
        return loaded

    # ── Status / listing ─────────────────────────────────────────────────

    def get_meta(self, tenant_id: str, sequence: int) -> dict[str, Any] | None:
        try:
            obj = self.s3.get_object(
                Bucket=self.bucket, Key=self._meta_key(tenant_id, sequence)
            )
        except Exception:
            return None
        data: dict[str, Any] = json.loads(obj["Body"].read().decode("utf-8"))
        return data

    def list_models(self, tenant_id: str) -> list[dict[str, Any]]:
        """All versions for a tenant, newest first. Returns the meta.json of
        each — callers render train history without downloading artefacts."""
        prefix = f"tenants/{tenant_id}/models/"
        try:
            resp = self.s3.list_objects_v2(Bucket=self.bucket, Prefix=prefix)
        except Exception:
            return []
        seqs: list[int] = []
        for obj in resp.get("Contents") or []:
            key = obj["Key"]
            after = key[len(prefix):]
            if after.startswith("v") and after.endswith("/meta.json"):
                head = after.split("/", 1)[0]
                try:
                    seqs.append(int(head[1:]))
                except ValueError:
                    continue
        seqs.sort(reverse=True)
        out: list[dict[str, Any]] = []
        for s in seqs:
            meta = self.get_meta(tenant_id, s)
            if meta is not None:
                out.append(meta)
        return out


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
