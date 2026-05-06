#!/usr/bin/env bash
# Dev-loop wrapper for the API. Three jobs:
#
#   1. Kill any stale process holding port 8000 (typical culprit:
#      a leftover `dist/main` from `pnpm build && pnpm start`, or a
#      previous `nest start --watch` that didn't shut down cleanly).
#   2. Wait briefly for the port to actually free.
#   3. Run `nest start --watch` with `.env` loaded.
#
# Failures during the kill step are non-fatal — most of the time the
# port is already free and `lsof` returns nothing. The wait loop is
# capped so a stuck process can't pin this script forever.
#
# Run from `apps/api` via `pnpm dev`.

set -uo pipefail

PORT=8000
MAX_WAIT_SECONDS=5

# Find the PID(s) holding the port. Suppress lsof errors (e.g. when
# the port is free, lsof exits 1 with no output — fine for us).
PIDS="$(lsof -ti :"${PORT}" 2>/dev/null || true)"

if [ -n "${PIDS}" ]; then
  echo "[dev] Port ${PORT} held by PID(s): ${PIDS}. Sending SIGTERM."
  # shellcheck disable=SC2086
  kill ${PIDS} 2>/dev/null || true

  # Wait up to MAX_WAIT_SECONDS for the port to actually free.
  waited=0
  while [ "${waited}" -lt "${MAX_WAIT_SECONDS}" ]; do
    if [ -z "$(lsof -ti :"${PORT}" 2>/dev/null || true)" ]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # Last resort: SIGKILL anything still hanging on.
  REMAINING="$(lsof -ti :"${PORT}" 2>/dev/null || true)"
  if [ -n "${REMAINING}" ]; then
    echo "[dev] PID(s) ${REMAINING} still on :${PORT} after ${MAX_WAIT_SECONDS}s. Sending SIGKILL."
    # shellcheck disable=SC2086
    kill -9 ${REMAINING} 2>/dev/null || true
    sleep 1
  fi
fi

echo "[dev] Starting Nest with .env loaded…"
exec pnpm exec dotenv -e ../../.env -- nest start --watch
