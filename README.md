# Rhud

AI-integrated working agent that collapses the B2B scope-gathering → quotation → proposal → approval → client-delivery cycle into one secure, tokenised workflow. Decision-tree gathering, ML price prediction, manager-in-the-loop approval, AI-drafted proposals, full audit thread.

See `Rhud_MVP_Design.pdf` (north-star spec) and `prototype/` (ideation-phase UX clickthrough).

## Repo layout

```
apps/
  api/            NestJS core API (tenants, auth, engagements, threads)
  web/            Next.js 14 portal (sales + manager + tokenised client views)
  ml/             FastAPI ML service (price prediction, per-tenant XGBoost)
packages/
  shared/         Shared TS types: thread event names, role enums, DTOs
infra/
  docker-compose.yml   Local dev infra: Postgres + Redis + MinIO
prototype/        Ideation-phase clickable prototype (reference only)
```

## Prerequisites

- Node.js 22+ (`.nvmrc`)
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker Desktop or OrbStack
- Python 3.11+ (for `apps/ml`)

## First-time setup

```bash
cp .env.example .env
pnpm install
pnpm infra:up                    # postgres + redis + minio
pnpm --filter @rhud/api prisma:migrate:dev
pnpm --filter @rhud/api seed
```

## Run

```bash
pnpm api:dev    # http://localhost:8000
pnpm web:dev    # http://localhost:3000
pnpm ml:dev     # http://localhost:8001
```

## Security posture

Tenant isolation relies on Postgres Row-Level Security plus a `withTenant()` Prisma wrapper — see [apps/api/src/db/with-tenant.ts](apps/api/src/db/with-tenant.ts). Bare `prisma` access outside the wrapper is forbidden and enforced by lint + integration test.
