# Architecture

```
browser ──► trinity (Rust, :3000) ──► PostgreSQL (db: trinity)
              ├─ static web app (Next.js export, WEB_DIR)
              ├─ /api/v1/*, /uploads, /.well-known/*
              └─ /notif-ws (WebSocket), scheduler and queue worker
```

One process, one binary, one port. PostgreSQL 16 is the only runtime dependency: no Node backend, no Redis, no Prisma at
run time, no separate migrate container. TLS is terminated by Cloudflare or a reverse proxy in front.

## Repository layout

| Path | What it is |
|---|---|
| `server/` | The backend: a Cargo workspace producing the `trinity` binary. Details below and in [../server/README.md](../server/README.md). |
| `server/prisma/migrations/` | SQL migrations (the history started under Prisma; no Prisma tooling is used), embedded in the binary and applied by `trinity migrate`. |
| `server/contracts/` | The frozen HTTP contract: `openapi.json`, `routes.json`, `rbac.json` (permission catalog), `schema.sql`, golden responses. |
| `apps/web` | The web UI: Next.js 16, built with `build:export` into a static site that `trinity` serves (`WEB_DIR`). |
| `packages/rbac` | TypeScript view of the permission catalog (`server/contracts/rbac.json`), imported by the web app. |
| `tests/contract` | Contract tests: the same requests against a running server, compared with the golden responses. |
| `tests/mcp-e2e`, `tests/load` | End-to-end script for the MCP/OAuth flow; load and performance scripts. |
| `deploy/` | Deployment samples (Cloudflare Tunnel, ownership file used by the migration runbooks). |
| `docs/rust/` | Plan, decisions and reviews of the Rust rewrite. |

## Key design points

- **One process, many modules.** Each domain is a `mod-*` crate; they are linked into one binary and call each other as
  ordinary functions, not over HTTP.
- **RBAC = permission + scope.** Every route declares its permission (`RouteSpec`); `trinity check-routes` compares the
  declared routes with the frozen `server/contracts/routes.json`. Scopes (`own`, `team`, `subtree`, `all`) follow the manager tree.
- **AI is bring-your-own.** Trinity does not call an AI vendor with a server-side key. Assistants connect through the
  MCP server (`/api/v1/mcp`, OAuth 2.1 + PKCE) and act with the permissions of the connected user; writes execute right away within
  that user's permissions and scope (the `crm.write` OAuth scope gates them). An admin setting, *Require approval for AI changes*
  (default off), switches to the draft-then-approve flow where writes are *proposals* a human approves.
- **Multi-tenant (optional).** `MULTI_TENANT=true` turns a deployment into a hosted service: one company per sign-up,
  one Postgres schema per company, every query routed by `search_path` on one shared pool to the company of the request (fail-closed).
  See [multi-tenant.md](multi-tenant.md).
- **Feature flags default to OFF** for anything that reaches outside the system: webhooks, MCP.
- **Storage drivers**: local disk (default), S3/MinIO (`server/crates/trinity-storage`).
- **Employment periods.** Attendance and payroll count an employee on a day only if that day lies inside one of
  their `employment_periods`. Locking an employee or setting their status to `resigned` closes the open period, and
  unlocking or moving them back out of `resigned` opens a new one from today, so a lock/unlock cycle keeps the locked
  stretch out of past reports. Every path that changes this status goes through the shared logic in `server/crates/mod-hr/src/employees.rs`:
  employees (lock, unlock, edit, re-create), users (lock, unlock, permanent delete) and payroll employees.
  An employee with no rows yet uses the older rule: `status` plus `resigned_at`. Their first row is built from that
  rule on their first status change, so migration `0018` only adds the table.

## Databases

- `trinity` — one PostgreSQL database. The schema lives in `server/prisma/migrations/` (a baseline migration plus additive follow-ups,
  with raw SQL for code generation triggers and partial indexes); there is no ORM schema file, the Rust structs follow the
  migrations. `trinity migrate` records applied migrations in `_prisma_migrations` (kept for compatibility with installs
  that were created by the Node version; checksums are unchanged).

## The Rust workspace (`server/`)

The backend was rewritten in Rust (plan: [rust/PLAN.md](rust/PLAN.md), decisions: [rust/DECISIONS.md](rust/DECISIONS.md)); the
database schema, the HTTP contract (`server/contracts/`) and the behaviour stayed the same. One Cargo workspace; many small
crates so that they compile in parallel and each change touches few of them.

| Crates | Role |
|---|---|
| `trinity-bin` | The `trinity` binary: `serve`, `migrate`, `seed`, `check-config`, `check-routes`, `check-invariants`, `channel-lock`, `healthcheck`. `serve.rs` assembles the server. |
| `trinity-kernel`, `trinity-db`, `trinity-auth`, `trinity-rbac` | Configuration, errors, Vietnam-time helpers; pool and per-company `search_path` routing, embedded migrations; JWT, sessions, API keys; permission catalog, scopes and cache. |
| `trinity-http`, `trinity-realtime`, `trinity-jobs`, `trinity-storage`, `trinity-docgen`, `trinity-obs`, `trinity-ops` | Router and edge layer (client IP by `TRUSTED_PROXY`, CORS, body limits, TLS, static web); `/notif-ws`; scheduler and queue worker on Postgres only; local disk or S3 storage; xlsx/pdf/image generation; logs, Sentry, product events; operational checks. |
| `mod-*` (one per domain) | Routes and logic of one module (`mod-users`, `mod-contacts`, `mod-hr`, `mod-pos`, `mod-mcp`, …). Each declares its routes (`RouteSpec`). |

What this design gives:

- **One process, one binary** with the migrations embedded; shared state goes through Postgres `LISTEN/NOTIFY`
  ([sync-notify.md](sync-notify.md)).
- **Companies are routed by `search_path`** on one shared pool, so memory stays flat as the number of companies grows
  ([multi-tenant.md](multi-tenant.md)).
- **TLS is terminated by Cloudflare or a reverse proxy**; the binary never requests certificates (optional
  `TLS_MODE=files` for an origin certificate).

Running it: [getting-started.md](getting-started.md) (Docker, or Rust + Postgres on a laptop), [deployment.md](deployment.md).
Moving an install made with the older Node images: [upgrade-from-node.md](upgrade-from-node.md). Measured resource use against
the targets: [rust/PLAN.md](rust/PLAN.md) section 9.
