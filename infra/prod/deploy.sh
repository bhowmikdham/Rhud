#!/usr/bin/env bash
# infra/prod/deploy.sh
#
# Fetches secrets from AWS SSM Parameter Store, exports them, and brings
# up the Rhud production stack via docker compose. Run from the EC2:
#
#   cd ~/rhud/infra/prod
#   ./deploy.sh           # build + up + tail logs
#   ./deploy.sh restart   # restart all services without rebuilding
#   ./deploy.sh down      # stop the stack (volumes persist)
#
# Required SSM parameters (all SecureString, ap-south-1):
#   /rhud/db/password           — Postgres superuser password
#   /rhud/db/app-password       — rhud_app role password
#   /rhud/jwt/secret            — JWT signing secret (≥32 chars)
#   /rhud/llm/encryption-key    — Master key wrapping per-tenant LLM creds

set -euo pipefail

cd "$(dirname "$0")"

AWS_REGION="${AWS_REGION:-ap-south-1}"
COMMAND="${1:-up}"
export WEB_PUBLIC_URL="${WEB_PUBLIC_URL:-https://rhud.net}"

# S3 bucket that receives browser-direct presigned uploads. Must match
# S3_BUCKET in docker-compose.yml. The browser PUTs an xlsx/pdf with a
# non-simple Content-Type → CORS preflight OPTIONS → the bucket MUST
# advertise CORS for the web origins or the upload fails with
# "TypeError: Failed to fetch". Config lives in ./s3-cors.json.
S3_UPLOAD_BUCKET="${S3_UPLOAD_BUCKET:-rhud-uploads-prod-bhowmik}"

log() { printf "\033[1;34m→\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*" >&2; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ── Apply the S3 bucket CORS config (idempotent) ─────────────────────
# put-bucket-cors is a full replace, so re-running it just re-asserts
# the desired state from ./s3-cors.json — safe on every deploy. This is
# what lets the browser PUT presigned uploads directly to S3 (the API
# never proxies bytes). Never fail the whole deploy if this errors
# (e.g. the instance role lacks s3:PutBucketCors); log a warning and
# continue so the rest of the stack still comes up.
apply_s3_cors() {
  local cors_file="./s3-cors.json"
  if [[ ! -f "$cors_file" ]]; then
    warn "s3 CORS: $cors_file not found, skipping"
    return 0
  fi
  log "applying S3 CORS to bucket $S3_UPLOAD_BUCKET from $cors_file"
  if aws s3api put-bucket-cors \
       --bucket "$S3_UPLOAD_BUCKET" \
       --cors-configuration "file://$cors_file" \
       --region "$AWS_REGION" 2>/tmp/s3-cors.err; then
    log "S3 CORS applied"
  else
    warn "S3 CORS apply failed (continuing deploy): $(cat /tmp/s3-cors.err 2>/dev/null)"
    warn "browser-direct uploads may break until CORS is set. Needs s3:PutBucketCors on bucket $S3_UPLOAD_BUCKET."
  fi
}

# ── Reclaim Docker disk before building (idempotent) ─────────────────
# The 30GB root disk fills up across deploys: each rebuild leaves behind
# build-cache layers and dangling (untagged) image layers that nothing
# references. Left unbounded this ENOSPC's the next `docker compose
# build` (observed 2026-06-17: build failed during `pnpm --filter
# @rhud/api build` after ~7 rebuilds in one session).
#
# `--reserved-space 10GB` keeps the most-recently-used cache so warm
# rebuilds stay fast (~1 min) while capping growth. (This is the
# successor to the old `--keep-storage` flag, which is deprecated on the
# box's Docker 25.0.14 and prints a warning on every run.) We prune ONLY
# build cache and dangling images — never `docker volume prune`, which
# would destroy the postgres data volume. Never fail the deploy on a
# prune error (e.g. an older Docker lacking --reserved-space); log and
# continue so the build still runs.
reclaim_docker_space() {
  log "reclaiming Docker disk (build cache over 10GB + dangling images)"
  docker builder prune -f --reserved-space 10GB || warn "docker builder prune failed (continuing)"
  docker image prune -f || warn "docker image prune failed (continuing)"
}

# ── fetch a single SSM parameter, fail loudly if missing ─────────────
get_param() {
  local name="$1"
  local value
  value="$(aws ssm get-parameter \
             --name "$name" \
             --with-decryption \
             --query 'Parameter.Value' \
             --output text \
             --region "$AWS_REGION" 2>/dev/null || true)"
  [[ -n "$value" && "$value" != "None" ]] || die "SSM parameter $name is empty or missing"
  printf "%s" "$value"
}

case "$COMMAND" in
  down)
    log "stopping stack (volumes preserved)"
    docker compose down
    exit 0
    ;;
  restart)
    # Restart needs env present (containers may reference ${...} variables)
    ;;
  up|"")
    ;;
  *)
    die "unknown command: $COMMAND (use: up | restart | down)"
    ;;
esac

log "fetching secrets from SSM /rhud/* in $AWS_REGION"
export DB_PASSWORD="$(get_param /rhud/db/password)"
export DB_APP_PASSWORD="$(get_param /rhud/db/app-password)"
export JWT_SECRET="$(get_param /rhud/jwt/secret)"
export LLM_KEY_ENCRYPTION_KEY="$(get_param /rhud/llm/encryption-key)"

# Sanity: JWT_SECRET must be ≥32 chars (env.ts validates this too)
[[ "${#JWT_SECRET}" -ge 32 ]] || die "JWT_SECRET is shorter than 32 chars"

# Re-assert bucket CORS on every up/restart. Cheap, idempotent, and
# guards against the bucket being re-created without CORS.
apply_s3_cors

if [[ "$COMMAND" == "restart" ]]; then
  log "restarting all services"
  docker compose up -d --no-build
  docker compose ps
  exit 0
fi

# Free disk before the build so a layer accumulation can't ENOSPC it.
reclaim_docker_space

log "building images (first run: ~5-10 min; cached rebuilds: ~1 min)"
docker compose build

# ── Apply pending Prisma migrations BEFORE swapping containers ──
# Two reasons this happens here:
#   1. The new image has the new prisma/migrations/* on disk. We use a
#      one-shot container (`run --rm`) so we get the new migrations
#      without yet stopping the currently-running api.
#   2. The currently-running api keeps serving traffic during this
#      step. Once migrations are done, the `up -d` below swaps the
#      containers — by which time the schema already matches the new
#      code. This closes the window where the new api would race
#      against an un-migrated DB.
#
# `migrate deploy` is idempotent: if there's nothing pending it's a
# no-op, so this is safe to always run.
log "ensuring db is up before applying migrations"
docker compose up -d db
log "applying Prisma migrations"
docker compose run --rm api ./node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma

log "starting stack"
docker compose up -d

log "current status"
docker compose ps

log "tailing logs (Ctrl-C to detach — containers keep running)"
docker compose logs -f --tail=30
