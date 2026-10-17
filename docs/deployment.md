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
4. Put a reverse proxy with TLS in front of the `web` container (port 3000). Everything goes to `web`
   (Next.js proxies `/api/v1/*` to the API container) except the real-time notification socket
   `/notif-ws/`, which must go straight to the API (port 4000) with WebSocket upgrade. Without that rule
   the bell only updates every 30 seconds and never plays a sound. Example Caddyfile:

   ```
   crm.example.com {
     reverse_proxy /notif-ws/* localhost:4000
     reverse_proxy localhost:3000
   }
   ```

   With nginx, add `location /notif-ws/ { proxy_pass http://127.0.0.1:4000; proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }` before `location /`.

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

## Fast updates without Docker

For a server run under a process manager, the maintainers' flow ([runbooks/fast-delivery.md](runbooks/fast-delivery.md)) is:
build on a workstation (only the parts the diff touches), ship the build output, keep the previous build output in a release
directory beside the app, restart, and move the previous release back if the health checks fail. Copy `.env` before every
update; dump the database only when the update contains a migration (a rollback does not undo migrations).

## Monitoring (optional)

Trinity can report errors to [Sentry](https://sentry.io) and send anonymous product metrics to
[PostHog](https://posthog.com). **Both are off by default**: while the variables below are empty the app makes no
network call for monitoring and never loads either SDK (the browser code is a dynamic import that only runs when the
API returns a config).

| Variable | Purpose |
|---|---|
| `SENTRY_DSN` | Sentry DSN for the API process. Only 5xx errors and traces are sent. |
| `SENTRY_DSN_WEB` | Sentry DSN for the browser, served to the web app by `GET /api/v1/telemetry/config`. |
| `SENTRY_ENVIRONMENT` | Environment label. Defaults to `NODE_ENV`. |
| `SENTRY_TRACES_SAMPLE_RATE` | Trace sampling, 0 to 1. Default `0.1`. |
| `TRINITY_RELEASE` | Release id. Falls back to `VERCEL_GIT_COMMIT_SHA` (first 7 chars), then to a `.release` file in `APP_ROOT` (or the working directory). |
| `POSTHOG_KEY` | PostHog project key. Enables server events and browser page views. |
| `POSTHOG_HOST` | PostHog ingestion host. Default `https://us.i.posthog.com`. |
| `POSTHOG_REPLAY` | Set to exactly `true` to enable session replay. Default off. |
| `MONITORING_HASH_SECRET` | Secret for hashing user ids. Falls back to `JWT_SECRET`. |

### What is filtered

- **User identity**: user ids are never sent. Both services receive `HMAC-SHA256(secret, id)` truncated to 24 hex
  characters. Without a secret nothing is identified.
- **Sentry (API and browser)**: `sendDefaultPii` is off. Request bodies, cookies, headers and query strings are
  removed; URLs are stripped of query strings and webhook tokens. Email addresses and phone numbers in messages
  and exception text are masked. Console breadcrumbs are dropped (and input breadcrumbs in the browser); URLs in HTTP
  breadcrumbs lose their query string. The only user field is the hashed id.
- **PostHog browser**: autocapture is off. Page views are recorded as paths with numeric and UUID segments replaced by
  `:id`, without query strings; referrers keep only the origin. All text, input values and element attributes are masked
  and images, video and canvas are blocked in replays.
- **PostHog server events** carry only keys, counts and booleans. Strings are cut at 60 characters, and any string
  containing `@` or a run of 8 or more digits is dropped. No names or record content is sent.
- Sending is fire-and-forget and never affects a request. Events are not sent when `NODE_ENV=test`.

### Server events

`onboarding_step` (`step`, `action`: confirm or skip) · `feature_toggled` (`feature`, `enabled`) · `plan_changed`
(`plan`) · `table_created` (`fields`) · `table_updated` (`fields`) · `post_published` (`networks`, `scheduled`,
`source`: web, mcp or csv) · `comment_rule_saved` (`created`, `actions`).

## Production checklist

- [ ] A reverse proxy in front of the API accepts uploads up to the app's limits (videos for social posting go up to 200 MB): with nginx, `client_max_body_size 210m;`. A smaller limit makes large uploads fail in the browser with a bare "Network Error".

- [ ] `/notif-ws/` reaches the API with WebSocket upgrade (a test request answers `101 Switching Protocols`, not a 404/499 from the web container).

- [ ] Every `change-me-*` value replaced; secrets are random and at least 32 bytes.
- [ ] `CORS_ORIGIN` lists only your real web origin(s).
- [ ] TLS in front of the web container; port 4000 not exposed to the internet.
- [ ] Postgres and Redis not exposed publicly, backups scheduled.
