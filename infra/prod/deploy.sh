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

log() { printf "\033[1;34m→\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

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

if [[ "$COMMAND" == "restart" ]]; then
  log "restarting all services"
  docker compose up -d --no-build
  docker compose ps
  exit 0
fi

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
