-- Runs on first Postgres boot (docker-entrypoint-initdb.d).
-- Extensions Prisma migrations will rely on.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- gen_random_uuid(), column-level crypto
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive email columns

-- Dedicated app role used at runtime. It has RLS-enforced access and cannot
-- bypass policies. Migrations should be run as the superuser ('rhud') defined
-- in docker-compose; the app connects as 'rhud_app'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhud_app') THEN
    CREATE ROLE rhud_app LOGIN PASSWORD 'rhud_app' NOBYPASSRLS;
  END IF;
END$$;

GRANT CONNECT ON DATABASE rhud TO rhud_app;
GRANT USAGE ON SCHEMA public TO rhud_app;
-- Future-proof: tables created later inherit these defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rhud_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rhud_app;
