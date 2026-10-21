# Architecture

```
browser ──► web (Next.js :3000) ──/api/v1/*──► api (NestJS monolith :4000) ──► PostgreSQL (db: trinity)
                                               ├──► Redis (db 0: cache, rate limits, realtime)
                                               └──► add-on runner (Deno child processes, optional)
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js UI. Proxies `/api/v1/*` to the monolith. |
| `apps/monolith` | Single NestJS process that mounts the five domain services below; shared bootstrap (CORS, validation, RBAC boot check, Swagger). |
| `services/auth` | Login, users, roles/permissions administration, API keys. |
| `services/crm` | Contacts, deals, kanban, custom objects, reports, attendance, integrations (webhooks, MCP/OAuth, Google Sheets, Facebook, Zalo OA), add-ons. |
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
- **Feature flags default to OFF** for anything that reaches outside the system: webhooks, MCP, add-ons.
- **Storage drivers**: local disk (default), S3/MinIO, Vercel Blob (`packages/storage`).
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
