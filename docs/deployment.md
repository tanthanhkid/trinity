# Deployment

Trinity ships as two container images built from the root `Dockerfile` (targets `api`, `web`) and wired by
`docker-compose.yml`. The same layout works on a single VM with Docker Compose, and the images can be used from any
orchestrator.

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

## Client IP (`TRUSTED_PROXY`)

Office-IP checks at login (`LOGIN_WIFI_CHECK_ENABLED`), attendance IP checks (they affect payroll), rate limits, login
logs, VNPay and the online store all use the client's IP. It is determined **once**, by the process that receives the
connection first (the **edge**), as soon as the headers arrive, and passed inward signed. No header sent by the client is
trusted unless `TRUSTED_PROXY` says the proxy in front of the edge writes it.

- **Web is the edge** in every normal install (browser → [Caddy/nginx/Cloudflare] → web → API). The preload file
  `apps/web/peer-ip.cjs` does the work: start the web server with `NODE_OPTIONS=--require <repo>/apps/web/peer-ip.cjs`
  (the Docker image sets it). It drops every `x-trinity-*` header the client sent, determines the IP from the TCP peer
  and `TRUSTED_PROXY`, and the `/api/v1` proxy re-signs it right before calling the API. Only `x-trinity-client-ip` and `x-trinity-peer-ip`
  are removed; other `x-trinity-*` headers (such as `X-Trinity-Signature` on incoming webhooks) pass through. A signed
  `x-trinity-client-ip` arriving at web is kept only from loopback or a proxy listed in `TRUSTED_PROXY`. The web process needs
  `TRUSTED_PROXY`, `CLOUDFLARE_IP_RANGES` (optional) and the internal secret (`INTERNAL_SERVICE_SECRET` or
  `SERVICE_SECRET`, the same value the API has). Without the preload file, or without a secret, the web sends
  "untrusted" and the API never sees a client-chosen address (the API accepts an unsigned "untrusted" only from
  loopback or a proxy listed in its own `TRUSTED_PROXY`; from anywhere else it is ignored). The web proxy never forwards `X-Forwarded-For`,
  `X-Real-IP`, `CF-Connecting-IP`, `Forwarded` or `True-Client-IP` from the browser.
- **The API** (`resolveClientIp`, `packages/rbac-nest/src/client-ip.ts`) trusts the signed header, and applies its own
  `TRUSTED_PROXY` only to connections that reach it directly (no signed header).

`TRUSTED_PROXY` applies to the **TCP peer** of the edge:

| Value | Client IP |
|---|---|
| `none` (default) | The peer address (an on-premises LAN client with a private address counts as a real client). No header is trusted |
| `cloudflare` | `CF-Connecting-IP`, only when the peer is in `CLOUDFLARE_IP_RANGES` (default: the list Cloudflare publishes at https://www.cloudflare.com/ips/; set the variable, comma-separated, when it changes); any other peer: the peer address |
| `cloudflare-tunnel` | `CF-Connecting-IP`. The edge must listen on loopback only: it **refuses to start**, before opening the port, otherwise (web: `HOSTNAME=127.0.0.1`; API: `LISTEN_HOST=127.0.0.1`) |
| `cidr:<list>` | The **right-most** `X-Forwarded-For` entry, only when the peer is in the list (CIDR or IP, comma-separated; the keyword `docker-gateway` is the container's default gateway read from `/proc/net/route`, only inside a container). `X-Real-IP` only with an explicit `;header=x-real-ip` |
| `cloudflare-behind:<list>` | Cloudflare → Caddy/nginx → app. When the peer is in the list: take the right-most `X-Forwarded-For` entry (written by that proxy); if it is in `CLOUDFLARE_IP_RANGES` use `CF-Connecting-IP`, otherwise that entry |

| Deployment | `TRUSTED_PROXY` (for web) |
|---|---|
| Process manager, Caddy/nginx on the same machine → web → API | `cidr:127.0.0.1/32` |
| Same, with Cloudflare in front of Caddy/nginx | `cloudflare-behind:127.0.0.1/32` |
| Docker Compose, `web` port published directly | `none` |
| Docker Compose, Cloudflare connects straight to the `web` port | `cloudflare` |
| Docker Compose behind Caddy/nginx on the host | `cidr:docker-gateway` (or `cloudflare-behind:docker-gateway`), and `WEB_BIND=127.0.0.1` |
| Cloudflare Tunnel, process manager (web on `HOSTNAME=127.0.0.1`) | `cloudflare-tunnel` |
| Cloudflare Tunnel with Docker Compose | not supported by the stock compose file yet (`cloudflared` must share the `web` container's network namespace so that web can listen on loopback); use one of the other values |

In Docker Compose, `web` gets `TRUSTED_PROXY`, `CLOUDFLARE_IP_RANGES` and `INTERNAL_SERVICE_SECRET`
(`${INTERNAL_SERVICE_SECRET:-${SERVICE_SECRET}}`, as for `api`); the `api` container gets `API_TRUSTED_PROXY`
(default `none`), which only matters for connections to its loopback port on the host. With a process manager, the API
reads `TRUSTED_PROXY` too; set `LISTEN_HOST=127.0.0.1` there when the API port should only be reachable locally.

Caddy always writes `X-Forwarded-For` itself. **nginx does not**: every `location` that points at the app needs
`proxy_set_header X-Forwarded-For $remote_addr;` (overwrite, not append) and `proxy_set_header X-Real-IP "";`; without
the overwrite a client can fake its IP. Do not use `set_real_ip_from` alone (its default `real_ip_header` is
`X-Real-IP`, i.e. the client's header). Use `cidr:` only when there really is a proxy in front and the app listens on
loopback. Opening the origin only to Cloudflare's ranges (or using a Tunnel) remains a recommended second layer.

**When the IP cannot be trusted** — the result is loopback, the container's default gateway (only inside a container:
traffic through `docker-proxy`/NAT, e.g. `cidr:` with a wrong Docker range, or Cloudflare reaching the origin over
IPv6), or the web process sent "untrusted" (no preload file, no secret, a proxy in the list that did not send its
header) — it is never compared with office IPs. Login Wi-Fi checks and attendance IP checks **let the user through**
instead of comparing a wrong address (attendance records then have no office and are marked `unverified` when checking in, shown as "IP not verified"), the server
logs a configuration error, and admins of the operating company see a warning banner on every page for 24 hours after
the last such request (also `GET /api/v1/settings/client-ip/alerts` and the MCP tool `get_client_ip_status`). Rate
limits do not collapse into one bucket that one person could fill for everybody: login keeps a very high ceiling per
peer address (3000 failures per 15 minutes, 1000 for the public login API) and, per email, slows failed attempts down
(1 s, 2 s, 4 s … up to 15 s) with a hard cap of 50 failures per 15 minutes; sign-up and invitation acceptance count
only failures, per email/invitation plus an overall ceiling; OAuth, MCP and the online store check **both** a ceiling
per peer address and a per-client key (OAuth client, bearer token, buyer phone number), so changing the client-chosen
key does not get around the ceiling. VNPay receives the client IP only when it is trusted and public.

**Between Trinity processes** the IP travels in `x-trinity-client-ip: <ip or "untrusted">;<unix time>;<signature>`:
HMAC-SHA256 over `<value>\n<unix time>` with a key derived by HKDF-SHA256 (empty salt, info
`trinity x-trinity-client-ip v1`) from the internal secret (`INTERNAL_SERVICE_SECRET`, then `SERVICE_SECRET`; the API
accepts either, like `@Internal` routes). It is valid for ±60 seconds and checked when the headers arrive, so a slow
upload does not expire it. A request carrying this header with a wrong or expired signature gets **400** (a mismatch
of secrets between web and API shows up as 400 on every request and a log line saying so). A bare `untrusted` without
a signature is accepted: it only lowers trust.

## Moving files off Blob storage

The Vercel deployment path and its Blob storage driver were removed. An instance that still has
`STORAGE_DRIVER=vercel-blob` (or only `BLOB_READ_WRITE_TOKEN` set) refuses to start instead of silently writing to
local disk. To move:

1. Download every object of the Blob store, keeping its key.
2. Keys that start with `uploads/` (avatars, product images) go to `<UPLOADS_LOCAL_ROOT>/<rest of the key>`
   (default `<cwd>/uploads`); every other key (documents, newsfeed and social media, per company under `c<id>/`) goes to
   `<STORAGE_LOCAL_ROOT>/<key>`. Alternatively copy all keys unchanged into an S3 bucket and use `STORAGE_DRIVER=s3`.
3. Set `STORAGE_DRIVER=local` (or `s3`), remove `BLOB_READ_WRITE_TOKEN` and `BLOB_ACCESS`, then start the API.

   With `STORAGE_DRIVER=s3` (variables `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_REGION`) the Rust server creates the bucket at startup when it is missing and stops if it cannot. If the access key may not create buckets, create it first: `mc mb <alias>/<bucket>`.

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
run `node apps/monolith/dist/apps/monolith/src/main.js` and `NODE_OPTIONS=--require ./apps/web/peer-ip.cjs node apps/web/.next/standalone/apps/web/server.js` (the web process also needs `TRUSTED_PROXY` and the internal secret, see "Client IP") under a
process manager of your choice (systemd, pm2). Apply migrations with `pnpm --filter @trinity/prisma migrate:deploy`.

**Several API processes.** In-memory state is kept in step across processes (Node with Node, and Node with the Rust
server during the migration) through Postgres `LISTEN/NOTIFY`: permission/role cache, token blacklist and active
sessions, read caches (customer counts, dashboard numbers), the notification bell and payslip notices, and the Graph
error window / app back-off of the channel guard. A revoked permission or a sign-out takes effect on the other processes
in well under a second (token blacklist and sessions are also stored in the database and reloaded on restart or reconnect). Message formats: [sync-notify.md](sync-notify.md). The listener needs a direct (session-mode)
Postgres connection: set `DIRECT_DATABASE_URL` when `DATABASE_URL` goes through a transaction pooler, or `TRINITY_SYNC=off`
to turn the sync off (single process only). If the listener connection drops, caches fall back to their TTL (the role
cache is 60 s) until it reconnects. Two limits remain: rate limits (MCP, public API, login) are counted per process, so
with N workers the effective limit is up to N times higher; and scheduled jobs are not coordinated between Node
processes, so keep the Node API at one process unless you run behind the job-ownership file of the migration. The server logs a startup warning when it detects PM2 cluster mode.
A sample PM2 file:

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'trinity-api',
    script: 'apps/monolith/dist/apps/monolith/src/main.js',
    exec_mode: 'fork',
    instances: 1,
  }],
}
```

Read caches (customer counts, dashboard numbers) are kept in process memory with a short TTL. `TRINITY_DISABLE_READ_CACHE=1`
turns them off so every read goes to the database (used for side-by-side comparison runs). `REDIS_URL` is no longer read
by the Node server and is ignored if still set.

## Fast updates without Docker

For a server run under a process manager, the maintainers' flow ([runbooks/fast-delivery.md](runbooks/fast-delivery.md)) is:
build on a workstation (only the parts the diff touches), ship the build output, keep the previous build output in a release
directory beside the app, restart, and move the previous release back if the health checks fail. Copy `.env` before every
update; dump the database only when the update contains a migration (a rollback does not undo migrations).

## Rust server configuration (preview)

The Rust rewrite of the backend (`server/`, [docs/rust/PLAN.md](rust/PLAN.md)) is not released yet. It reads the same
`.env` as the Node API, with these differences:

- `PORT` is ignored (one warning line at startup). The main port is `TRINITY_HTTP_PORT` (default 3000, the port the
  reverse proxy sends pages and `/api/v1` to); `COMPAT_API_PORT` (default 4000) keeps `/notif-ws` and `/api/v1` working
  for proxies that still point at the old API port. The two must differ.
- Variables that no longer apply (`REDIS_URL`, `BACKEND_URL`, `MONOLITH_INTERNAL_URL`, `AUTH_SERVICE_URL`, serverless and
  Vercel Blob settings, removed connectors, `TENANT_MAX_CLIENTS`, …) are ignored with one warning line each.
- `DB_POOL_SIZE` (default 8) sets the shared database pool; `PRISMA_CONNECTION_LIMIT` is still read when it is unset.
- In production the binary refuses to start with `change-me-*` or short secrets (same check as the Node API) and without
  `DATABASE_URL`. `trinity check-config` runs these checks and exits (0 = usable, 1 = would refuse to start).
- In a hybrid install (Rust in front, Node behind), `TRINITY_OWNERSHIP_FILE` points at a JSON file saying which side
  serves each route prefix and runs each background job. Format and matching rules (longest prefix, then method; `GET`
  also covers `HEAD`): [server/README.md](../server/README.md#tệp-sở-hữu-trinity_ownership_file).

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
| `TRINITY_RELEASE` | Release id. Falls back to a `.release` file in `APP_ROOT` (or the working directory). |
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
- The Rust server (`server/crates/trinity-obs`) applies the same filters and variables: no `SENTRY_DSN` means no Sentry client, no `POSTHOG_KEY` or hash secret means no event, `NODE_ENV=test` turns product events off, and in all these cases no network call is made. Both also stay off (with a warning) if the TLS crypto provider was not installed at startup. The environment label is `SENTRY_ENVIRONMENT`, then `NODE_ENV`, then `production`. Only status 500 and above reach Sentry through `report_server_error`; an event with no `http.status_code` tag (for example a panic) is not filtered by status and is sent. Request bodies, cookies, headers, query strings, `extra` data and stack-frame variables are removed, and exception type, module and value, URLs and tags are masked, before an event leaves the process. Performance traces are not sent yet: the Rust SDK cannot filter transactions, so `SENTRY_TRACES_SAMPLE_RATE` is read but not applied.

### Server events

`onboarding_step` (`step`, `action`: confirm or skip) · `feature_toggled` (`feature`, `enabled`) · `plan_changed`
(`plan`) · `table_created` (`fields`) · `table_updated` (`fields`) · `post_published` (`networks`, `scheduled`,
`source`: web, mcp or csv) · `comment_rule_saved` (`created`, `actions`).

## Production checklist

- [ ] A reverse proxy in front of the API accepts uploads up to the app's limits (videos for social posting go up to `SOCIAL_MAX_VIDEO_MB`, default 200 MB): with nginx, `client_max_body_size 210m;`. A smaller limit makes large uploads fail in the browser with a bare "Network Error". Behind the Cloudflare proxy (request body ≤ 100 MB) set `SOCIAL_MAX_VIDEO_MB=95`.

- [ ] `/notif-ws/` reaches the API with WebSocket upgrade (a test request answers `101 Switching Protocols`, not a 404/499 from the web container).

- [ ] Every `change-me-*` value replaced; secrets are random and at least 32 bytes.
- [ ] `CORS_ORIGIN` lists only your real web origin(s).
- [ ] TLS in front of the web container; port 4000 not exposed to the internet.
- [ ] `TRUSTED_PROXY` set for your deployment (section "Client IP"); no client-IP warning banner after signing in as an admin.
- [ ] Postgres not exposed publicly, backups scheduled.
