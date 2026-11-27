# Architecture

```
browser ──► web (Next.js :3000) ──/api/v1/*──► api (NestJS monolith :4000) ──► PostgreSQL (db: trinity)
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js UI. Proxies `/api/v1/*` to the monolith. |
| `apps/monolith` | Single NestJS process that mounts the five domain services below; shared bootstrap (CORS, validation, RBAC boot check, Swagger). |
| `services/auth` | Login, users, roles/permissions administration, API keys. |
| `services/crm` | Contacts, deals, kanban, custom objects, reports, attendance, integrations (webhooks, MCP/OAuth, Facebook, Zalo OA). |
| `services/commerce` | Products, product categories and attributes, POS, projects. |
| `services/payroll` | Employees' payroll: salary rules, KPI, payslips. |
| `services/notification` | In-app/real-time notifications. |
| `packages/prisma` | Schema, migrations, seed. |
| `packages/rbac`, `packages/rbac-nest` | Permission catalog and the NestJS guard/scope service. |
| `packages/storage`, `packages/logger`, `packages/utils`, `packages/shared-types` | Shared libraries. |
| `tests/mcp-e2e` | End-to-end script for the MCP/OAuth flow. |

## Key design points

- **One process, many modules.** The domain services are separate NestJS modules but run in one process
  (`apps/monolith/src/app.module.ts`); they call each other through in-process ports, not HTTP.
- **RBAC = permission + scope.** Every route must declare its permission (`@Can`, `@AuthOnly`, `@Public`, `@Internal`);
  the monolith refuses to boot if a route is undeclared. Scopes (`own`, `team`, `subtree`, `all`) follow the manager tree.
- **AI is bring-your-own.** Trinity does not call an AI vendor with a server-side key. Assistants connect through the
  MCP server (`/api/v1/mcp`, OAuth 2.1 + PKCE) and act with the permissions of the connected user; writes execute right away within
  that user's permissions and scope (the `crm.write` OAuth scope gates them). An admin setting, *Require approval for AI changes*
  (default off), switches to the draft-then-approve flow where writes are *proposals* a human approves.
- **Multi-tenant (optional).** `MULTI_TENANT=true` turns a deployment into a hosted service: one company per sign-up,
  one Postgres schema per company, every query routed by `PrismaService` to the company of the request (fail-closed).
  See [multi-tenant.md](multi-tenant.md).
- **Feature flags default to OFF** for anything that reaches outside the system: webhooks, MCP.
- **Storage drivers**: local disk (default), S3/MinIO (`packages/storage`).
- **Employment periods.** Attendance and payroll count an employee on a day only if that day lies inside one of
  their `employment_periods`. Locking an employee or setting their status to `resigned` closes the open period, and
  unlocking or moving them back out of `resigned` opens a new one from today, so a lock/unlock cycle keeps the locked
  stretch out of past reports. Every path that changes this status goes through `packages/prisma/src/employment-periods.ts`:
  crm employees (lock, unlock, edit, re-create), auth users (lock, unlock, permanent delete) and payroll employees.
  An employee with no rows yet uses the older rule: `status` plus `resigned_at`. Their first row is built from that
  rule on their first status change, so migration `0018` only adds the table.

## Databases

- `trinity` — main schema (`packages/prisma/prisma/schema.prisma`, a baseline migration plus additive follow-ups, with raw SQL for code
  generation triggers and partial indexes).

## Rust backend (in progress)

The backend is being rewritten in Rust (`server/`, plan: [rust/PLAN.md](rust/PLAN.md), decisions: [rust/DECISIONS.md](rust/DECISIONS.md)).
The database schema, the HTTP contract (`server/contracts/`) and the behaviour stay the same; only the process that
serves them changes. **The Node monolith above is still what the stock `docker-compose.yml` and the published images
run.** The Rust binary is built from `main` by operators who opt in (hybrid deployment, see
[runbooks/hybrid.md](runbooks/hybrid.md)) and by developers ([rust/localhost.md](rust/localhost.md)).

```
today (stock images)   browser ─► web (Next.js :3000) ─/api/v1─► api (NestJS :4000) ─► PostgreSQL
hybrid (opt-in)        browser ─► trinity (Rust :3000) ─┬─ routes owned by Rust ─► PostgreSQL
                                                        ├─ pages ─► Next (loopback)
                                                        └─ other routes, /notif-ws ─► Node (loopback)
target (after X06)     browser ─► trinity (Rust :3000, one process, one port) ─► PostgreSQL
```

### Layout of `server/`

One Cargo workspace; many small crates so that they compile in parallel and each change touches few of them.

| Crates | Role |
|---|---|
| `trinity-bin` | The `trinity` binary: `serve`, `migrate`, `seed`, `check-config`, `check-routes`, `check-invariants`, `channel-lock`, `healthcheck`. `serve.rs` assembles the server. |
| `trinity-kernel`, `trinity-db`, `trinity-auth`, `trinity-rbac` | Configuration, errors, Vietnam-time helpers; pool and per-company `search_path` routing, embedded migrations compatible with Prisma's `_prisma_migrations`; JWT, sessions, API keys; permission catalog, scopes and cache. |
| `trinity-http`, `trinity-realtime`, `trinity-jobs`, `trinity-storage`, `trinity-docgen`, `trinity-obs`, `trinity-ops` | Router and edge layer (client IP by `TRUSTED_PROXY`, CORS, body limits, TLS, proxy to the old processes); `/notif-ws`; scheduler and queue worker on Postgres only; local disk or S3 storage; xlsx/pdf/image generation; logs, Sentry, product events; operational checks. |
| `mod-*` (one per domain) | Routes and logic of one module (`mod-users`, `mod-contacts`, `mod-hr`, `mod-pos`, `mod-mcp`, …). Each declares its routes (`RouteSpec`); `check-routes` compares them with the frozen `contracts/routes.json`. |

What the Rust design changes, compared with the Node layout described above:

- **One process, one binary** with the migrations embedded; no Redis (shared state goes through Postgres
  `LISTEN/NOTIFY`, [sync-notify.md](sync-notify.md)), no Prisma at run time, no separate migrate container.
- **Companies are routed by `search_path`** on one shared pool, so memory stays flat as the number of companies grows
  ([multi-tenant.md](multi-tenant.md)).
- **TLS is terminated by Cloudflare or a reverse proxy**; the binary never requests certificates (optional
  `TLS_MODE=files` for an origin certificate).

### What exists on `main`

| Area | State |
|---|---|
| `trinity serve` | Works. Mounted: system (health, site-config, build id), users, custom objects, reports, setup, HR (employees, contracts), attendance, channel guard, public API, OAuth, MCP (read tools of groups 1 and 2), AI actions, POS, contacts, leads. `/notif-ws` is served. |
| Not mounted yet | Deals, kanban, payroll, Facebook, store, commerce, notifications, newsfeed, settings, RBAC administration, API keys, auth (login). Their routes still belong to Node, so a Rust-only run (no Node behind it) has no sign-in route yet; the localhost run ([rust/localhost.md](rust/localhost.md)) is for exercising the mounted modules. In progress, tracked in [#426](https://github.com/tanthanhkid/trinity/issues/426). |
| Web | Still the Next.js server, reached through the Rust proxy in hybrid. Static web served by Rust: in progress ([#185](https://github.com/tanthanhkid/trinity/issues/185)). |
| Single image and default compose | In progress ([#264](https://github.com/tanthanhkid/trinity/issues/264), X06). Until it lands, `docker-compose.yml` is the Node stack. |
| Upgrade path from Node | Written in [upgrade-from-node.md](upgrade-from-node.md); the automated upgrade test is in progress ([#276](https://github.com/tanthanhkid/trinity/issues/276)). |
| Measured resource use | Targets only ([rust/PLAN.md](rust/PLAN.md) section 9); measurement in progress ([#263](https://github.com/tanthanhkid/trinity/issues/263)). |
