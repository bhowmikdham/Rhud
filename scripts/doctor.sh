#!/usr/bin/env bash
# `pnpm doctor` — quick green/red status check across the dev stack.
#
#   API   :8000 → /api/v1/health
#   Web   :3000 → /  (any 2xx/3xx is fine; Next 404 on / would still
#                     mean "the server is up", but we treat it as ok)
#   ML    :8001 → /health
#   Postgres :5432 → TCP connect (via pg_isready if available, falls
#                                 back to a raw TCP probe)
#   Redis :6379 → PING (via redis-cli if available, else TCP probe)
#
# No external deps required — everything degrades gracefully. Output
# is human-readable; exits 0 if every check passes, 1 otherwise so it
# can be wired into CI later.

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

ok=()
bad=()

check() {
  local name="$1"
  local cmd="$2"
  if eval "${cmd}" >/dev/null 2>&1; then
    printf "  ${GREEN}✓${RESET} %-22s ${DIM}%s${RESET}\n" "${name}" "${cmd}"
    ok+=("${name}")
  else
    printf "  ${RED}✗${RESET} %-22s ${DIM}%s${RESET}\n" "${name}" "${cmd}"
    bad+=("${name}")
  fi
}

# Reachability check — `curl --fail` returns non-zero on 4xx/5xx,
# good for API health but too strict for Next.js' "/" which can
# legit 404 in dev. tcp_check is the loose version.
http_2xx() {
  curl -fsS --max-time 2 "$1" >/dev/null
}

http_reachable() {
  # `--max-time 2` so a hung host doesn't pin us; any code, even 4xx/5xx,
  # means the server bound the port.
  curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "$1" \
    | grep -qE '^[1-5][0-9][0-9]$'
}

tcp_check() {
  local host="$1"
  local port="$2"
  # macOS + Linux portable: bash's /dev/tcp pseudo-device.
  (echo > "/dev/tcp/${host}/${port}") >/dev/null 2>&1
}

echo
echo "== Rhud doctor =="
echo

echo "App services:"
check "API     :8000"        "http_2xx http://localhost:8000/api/v1/health"
check "Web     :3000"        "http_reachable http://localhost:3000/"
check "ML      :8001"        "http_2xx http://localhost:8001/health"

echo
echo "Data plane:"
if command -v pg_isready >/dev/null 2>&1; then
  check "Postgres :5432"     "pg_isready -h localhost -p 5432 -t 2"
else
  check "Postgres :5432"     "tcp_check localhost 5432"
fi

if command -v redis-cli >/dev/null 2>&1; then
  check "Redis    :6379"     "redis-cli -h localhost -p 6379 -t 2 ping | grep -q PONG"
else
  check "Redis    :6379"     "tcp_check localhost 6379"
fi

echo
if [ "${#bad[@]}" -eq 0 ]; then
  printf "${GREEN}All ${#ok[@]} checks passed.${RESET}\n\n"
  exit 0
fi

printf "${RED}%d check(s) failed:${RESET} %s\n" "${#bad[@]}" "${bad[*]}"
echo
printf "${YELLOW}Hints:${RESET}\n"
for name in "${bad[@]}"; do
  case "${name}" in
    "API     :8000")     echo "  - API down. Run: pnpm api:dev (kills any stale process first)";;
    "Web     :3000")     echo "  - Web down. Run: pnpm web:dev";;
    "ML      :8001")     echo "  - ML down. Run: pnpm ml:dev (needs the .venv activated)";;
    "Postgres :5432")    echo "  - Postgres down. Run: pnpm infra:up";;
    "Redis    :6379")    echo "  - Redis down. Run: pnpm infra:up";;
  esac
done
echo
exit 1
