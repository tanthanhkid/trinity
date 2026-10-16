# Deployment

Trinity ships as two container images built from the root `Dockerfile` (targets `api`, `web`) and wired by
`docker-compose.yml`. The same layout works on a single VM with Docker Compose, and the images can be used from any
orchestrator.

## Vercel (serverless)

See the **Deploy** section of the [README](../README.md#deploy) for the button, the environment variables and the CLI steps.
How it works: `apps/web/vercel.json` runs `pnpm build:vercel` from the repository root, which (1) generates the Prisma
client, (2) runs `scripts/vercel/db-setup.sh` (`prisma migrate deploy` + idempotent seed; skipped on preview deployments
unless `DB_SETUP_ON_PREVIEW=1`, or everywhere with `SKIP_DB_SETUP=1`; `SKIP_DB_SEED=1` keeps the migrations and skips only the seed), (3) builds the workspace packages and the monolith,
(4) packs the monolith as a real package for the function (`scripts/vercel/prepare-nest-package.sh`) and (5) builds
the web app with `TRINITY_RUNTIME=serverless`, so `/api/v1/*` is served by the NestJS app inside the same function.
The first admin comes from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`; without a password one is generated and printed once
in the build log, which every project member can read, so set `SEED_ADMIN_PASSWORD` yourself.

## Single VM with Docker Compose

1. Provision a Linux VM (2 vCPU / 4 GB is comfortable), install Docker + Compose.
2. Run `./install.sh` (creates `.env` with random secrets, never overwrites an existing one), or `cp .env.example .env` and set at least: `POSTGRES_PASSWORD`, `JWT_SECRET`, `SERVICE_SECRET`,
   `INTERNAL_SERVICE_SECRET`, `CORS_ORIGIN` (your public web origin) and
   `SEED_ADMIN_PASSWORD`. Demo data is off by default; if you want demo data, set `SEED_DEMO_DATA=true`.
3. `docker compose up -d --build`.
4. Put a reverse proxy with TLS in front of the `web` container (port 3000). One proxy rule is enough:
   everything goes to `web`; Next.js proxies `/api/v1/*` to the API container. Example Caddyfile:

   ```
   crm.example.com {
     reverse_proxy localhost:3000
   }
   ```

   For streaming / large uploads raise the proxy timeouts (large exports can take a while).
5. If you enable MCP/OAuth set `INTEGRATIONS_PUBLIC_BASE_URL=https://crm.example.com` and
   `INTEGRATIONS_SECRET_KEY` (`openssl rand -base64 32`), then `docker compose up -d`.

## Updating

```bash
git pull
docker compose up -d --build   # the `migrate` job applies new migrations before the API starts
```

## Backups

Back up the `pgdata` volume (or run `pg_dump` against the `trinity` database) and the `storage` / `uploads` volumes.
Keep `INTEGRATIONS_SECRET_KEY` somewhere safe: losing it makes stored webhook secrets and OAuth tokens unreadable.

## Without Docker

Build with `pnpm --filter "./packages/*" build && pnpm --filter @trinity/monolith build && pnpm --filter web build`,
run `node apps/monolith/dist/apps/monolith/src/main.js` and `node apps/web/.next/standalone/apps/web/server.js` under a
process manager of your choice (systemd, pm2). Apply migrations with `pnpm --filter @trinity/prisma migrate:deploy`.
The monolith locates `services/crm/ext-deno` by walking up from its install directory, so keep the repository layout.

## Production checklist

- [ ] Every `change-me-*` value replaced; secrets are random and at least 32 bytes.
- [ ] `CORS_ORIGIN` lists only your real web origin(s).
- [ ] TLS in front of the web container; port 4000 not exposed to the internet.
- [ ] Postgres and Redis not exposed publicly, backups scheduled.
