#!/bin/bash
# infra/prod/postgres-init/01-init.sh
#
# Runs once on first Postgres boot (docker-entrypoint-initdb.d convention).
# Idempotent: safe if re-run after a manual restart.
#
# Mirrors infra/postgres/init/01-extensions.sql (the dev init) but reads
# the rhud_app role password from the DB_APP_PASSWORD env var that compose
# injects, instead of hard-coding 'rhud_app'.

set -euo pipefail

if [[ -z "${DB_APP_PASSWORD:-}" ]]; then
  echo "ERROR: DB_APP_PASSWORD env var is required for prod init" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname   "$POSTGRES_DB" <<-EOSQL
  -- Extensions Prisma migrations rely on.
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
  CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive emails

  -- Runtime DB role. NOBYPASSRLS means every query MUST happen inside a
  -- withTenant() scope — otherwise tenant isolation policies hide all rows.
  -- See apps/api/src/db/with-tenant.ts.
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhud_app') THEN
      CREATE ROLE rhud_app LOGIN PASSWORD '${DB_APP_PASSWORD}' NOBYPASSRLS;
    ELSE
      ALTER ROLE rhud_app PASSWORD '${DB_APP_PASSWORD}';
    END IF;
  END\$\$;

  GRANT CONNECT ON DATABASE rhud TO rhud_app;
  GRANT USAGE   ON SCHEMA   public TO rhud_app;

  -- Future-proof: tables/sequences created later inherit these grants.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO rhud_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT                  ON SEQUENCES TO rhud_app;
EOSQL

echo "rhud-prod: postgres init complete"
