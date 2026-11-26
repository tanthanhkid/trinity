# Getting started

## Option 1 — Docker (recommended)

Requirements: Docker 24+ with the Compose plugin, ~4 GB of free RAM for the build.

```bash
git clone <your-fork-or-this-repo> trinity && cd trinity
cp .env.example .env
# Edit .env: replace every `change-me-*` value (openssl rand -hex 32 is a good generator).
docker compose up --build
```

What happens:

1. `postgres` starts.
2. `migrate` applies the Prisma migrations and runs the seed: the system role, the setting options,
   the first admin account and (only when you set `SEED_DEMO_DATA=true`; default `false`) a few demo contacts with obviously fake data.
3. `api` (NestJS monolith, port 4000) and `web` (Next.js, port 3000) start.

Open <http://localhost:3000>. The admin e-mail is `SEED_ADMIN_EMAIL` (default `admin@example.com`). If
`SEED_ADMIN_PASSWORD` was empty, the generated password is printed once:

```bash
docker compose logs migrate | grep -A2 "Admin account"
```

Health check: <http://localhost:4000/api/v1/health>. Swagger UI (<http://localhost:4000/docs>) is off in production; set `SWAGGER_ENABLED=true` in `.env` and restart to turn it on.

Stop and remove everything (including data): `docker compose down -v`.

## Option 2 — Local development

Requirements: Node 22 (`.nvmrc`), pnpm 10, PostgreSQL 16.

```bash
cp .env.example .env            # edit DATABASE_URL / secrets
set -a; source .env; set +a     # the apps read process.env
pnpm install
pnpm db:generate
pnpm --filter "./packages/*" build
pnpm --filter @trinity/prisma migrate:deploy
pnpm db:seed

# API (port 4000) and web (port 3000) in two terminals:
pnpm --filter @trinity/monolith build && pnpm --filter @trinity/monolith start
pnpm --filter web dev
```

## First sign-in: the start wizard

A fresh system opens a short full-screen wizard (no AI assistant needed):

1. **Type of business**: education center, retail and services, clinic/spa/vet, real estate, or *Other* (basic CRM). Each of the first four loads the matching custom-object template.
2. **Modules**: switches ticked for your type (the core set is locked on); add or remove any, then press **Build my system**. This saves the feature switches, applies the template, adds 2–3 clearly fake **sample records** and marks the system built. Running it again is safe (existing tables are kept, no new samples).
3. **First customer**: add one with the short form (or skip). Sample records delete themselves as soon as the first real customer or custom record exists, whether it was created in the UI, through the API or by an AI assistant. The ids of the samples live in the setting row `sample_records`, which is removed after the cleanup.
4. **Channels and first post**: only when the server has social networks configured; both can be skipped.

Accounts created after the system was built skip the wizard. The same build is available as `POST /api/v1/setup/build` (`{"industry": "education_center", "features": ["payments"]}`) and as the MCP tool `setup_build`. Connecting an AI assistant stays optional (Settings › Connections & AI).

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm typecheck` | Type-check every workspace package |
| `pnpm test` | Unit tests of every workspace package (DB-backed suites are skipped without a database) |
| `pnpm --filter web lint` | ESLint for the web app |
| `pnpm --filter web e2e` | Playwright end-to-end tests (see `apps/web/e2e/README.md`) |
| `pnpm db:studio` | Prisma Studio |

## Next steps

- Connect an AI assistant over MCP: [integrations/mcp.md](integrations/mcp.md)
- Webhooks: [integrations/webhooks.md](integrations/webhooks.md)
- Custom objects (build your own tables): [custom-objects.md](custom-objects.md)
- Architecture: [architecture.md](architecture.md) — Deployment: [deployment.md](deployment.md)
