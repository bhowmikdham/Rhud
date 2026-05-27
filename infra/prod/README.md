# rhud-prod — production stack

Single-node Docker Compose stack that runs the Rhud demo on EC2 behind
Caddy with automatic HTTPS via Let's Encrypt.

## Layout

```
infra/prod/
  Caddyfile                   reverse proxy + TLS terminator
  Dockerfile.api              multi-stage NestJS image
  Dockerfile.web              multi-stage Next.js (standalone) image
  docker-compose.yml          5 services: caddy, web, api, db, cache
  deploy.sh                   SSM secret fetch → compose up
  postgres-init/01-init.sh    first-boot DB init (extensions + rhud_app role)
```

## Secrets

All secrets live in AWS SSM Parameter Store under `/rhud/*`, fetched by
`deploy.sh` using the EC2 instance role. Nothing sensitive is baked into
images or committed to the repo.

| SSM path                       | Type         | Used for                              |
|--------------------------------|--------------|---------------------------------------|
| `/rhud/db/password`            | SecureString | Postgres superuser `rhud`             |
| `/rhud/db/app-password`        | SecureString | Runtime DB user `rhud_app` (RLS-enforced) |
| `/rhud/jwt/secret`             | SecureString | JWT signing key (≥32 chars)           |
| `/rhud/llm/encryption-key`     | SecureString | Master key wrapping per-tenant LLM creds |

S3 access uses the EC2 instance role — no access keys to manage.

## First-time bring-up

From the EC2 (via SSH or Session Manager):

```bash
cd ~/rhud/infra/prod
./deploy.sh
```

The first build takes 5–10 minutes (pulling base images, installing deps,
running `next build` and `nest build`). Subsequent rebuilds with cached
layers complete in about a minute.

## Migrations

`./deploy.sh` applies pending Prisma migrations automatically between
`docker compose build` and `docker compose up -d` — using a one-shot
container off the freshly built image, so the currently-running api keeps
serving traffic until the schema matches the new code. `prisma migrate
deploy` is idempotent (no-ops if nothing's pending).

To apply migrations manually against the prod DB (e.g. you SSH'd in to
run a migration without rebuilding):

```bash
docker compose exec -T api ./node_modules/.bin/prisma migrate deploy \
  --schema=prisma/schema.prisma
```

Note: this is `./node_modules/.bin/prisma`, not `node node_modules/.bin/prisma`
— the binary is a shell-script wrapper, not a Node entrypoint, so invoking
it with `node` fails with a `SyntaxError`.

The api container connects as the `rhud` superuser via `DATABASE_URL` for
migrations and as `rhud_app` via `APP_DATABASE_URL` for runtime queries.

## Resource budget (t3.small, 2 GB RAM + 2 GB swap)

| Service | Memory limit |
|---------|--------------|
| api     | 500 MB       |
| web     | 500 MB       |
| db      | 500 MB       |
| cache   | 120 MB       |
| caddy   | 100 MB       |
| **sum** | **1.72 GB**  |

The remaining ~280 MB leaves headroom for the host (sshd, systemd,
amazon-ssm-agent, dnf metadata cache). Swap absorbs build-time spikes.

## Maintenance

```bash
./deploy.sh             # build + up + tail logs
./deploy.sh restart     # restart services without rebuilding
./deploy.sh down        # stop the stack (volumes persist)
docker compose logs -f api      # follow api logs
docker compose exec api sh      # shell into a container
```

## ML service

Intentionally not included in this stack. The NestJS API tolerates the ML
service being absent (see `apps/api/src/ml/ml-client.service.ts` —
predictions return null on failure, engagements stay in `submitted`
instead of advancing to `predicted`). To enable ML later, either:

- run apps/ml on a separate small instance and set `ML_SERVICE_URL` on the
  api container, or
- upgrade this box to t3.medium / t3.large and add an `ml` service to
  `docker-compose.yml`.
