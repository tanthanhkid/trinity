# Multi-tenant isolation with Postgres Row-Level Security (spike)

Status: **spike** — branch `spike/rls-tenant`, draft PR, not deployed. Covers 6 tables only:
`contacts`, `activities`, `deals`, `facebook_pages`, `facebook_conversations`, `facebook_messages` (+ `tenants`).

## How it works

| Layer | What it does |
|---|---|
| Migration `0016_tenant_rls_spike` | `tenants` table; `tenant_id uuid NOT NULL DEFAULT trinity_current_tenant()` on each table, existing rows backfilled to the default tenant `00000000-0000-0000-0000-000000000001`; `ENABLE` + `FORCE ROW LEVEL SECURITY`; one policy `USING` + `WITH CHECK (tenant_id = trinity_current_tenant())`. |
| `trinity_current_tenant()` | `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Not set ⇒ `NULL` ⇒ no row matches and inserts fail (`NOT NULL` / `WITH CHECK`). Fail closed. |
| Codes `KH001` / `DL001` | unique per tenant: `(tenant_id, code)`. External ids (`page_id+psid`, Meta `mid`) stay globally unique — a Page belongs to one tenant. |
| Same-tenant foreign keys | `activities` / `deals` → `contacts` also have a composite FK `(tenant_id, contact_id)`. FK checks bypass RLS, so a plain FK would let tenant A attach rows to tenant B's contact id. |
| `withTenantRls(client)` (`packages/prisma/src/tenant`) | Prisma client extension. Single operations (models and `$queryRaw`/`$executeRaw`) run as a batch `[set_config('app.tenant_id', $tenant, true), op]`; `$transaction(fn)` sets the tenant once at the start; `$transaction([...])` gets `set_config` prepended. |
| `runWithTenant(id, fn)` / `tenantMiddleware` | AsyncLocalStorage holding the tenant of the current request / job. The middleware uses `TRINITY_DEFAULT_TENANT_ID` (single tenant for now; a SaaS build resolves it from the subdomain or a verified JWT claim). |
| `TRINITY_TENANT_RLS=on` | Makes `PrismaService` the extended client. Must ship together with the migration and a non-bypass DB role — the migration alone, with the flag off, makes every insert into these tables fail. |
| `trinity_tenant_for_facebook_page(page_id)` | `SECURITY DEFINER` lookup for webhooks that only know the Page id. Its owner (the migration role) must be superuser or `BYPASSRLS`, otherwise FORCE RLS filters it too. |

## Database roles

- **Migration / admin role**: owns the tables, `BYPASSRLS` (or superuser). Runs `prisma migrate deploy` and the admin screens.
- **App role**: `LOGIN NOSUPERUSER NOBYPASSRLS`, with `SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE, SELECT` on sequences and
  `EXECUTE` on `trinity_tenant_for_facebook_page(text)`. Superuser and `BYPASSRLS` ignore every policy, `FORCE` included.

```sql
CREATE ROLE trinity_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO trinity_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trinity_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trinity_app;
GRANT EXECUTE ON FUNCTION trinity_tenant_for_facebook_page(text) TO trinity_app;
```

## Pitfalls found by the spike

- **Lazy Prisma promises.** `runWithTenant(t, () => prisma.contact.findMany())` returns a `PrismaPromise` that only runs when
  awaited — outside the tenant context — so it silently sees 0 rows. `runWithTenant` now awaits thenables inside the context;
  code that stores a Prisma promise and awaits it later in another context still fails closed (no leak, but empty results).
- **Pooled connections keep `''`.** After a transaction with `SET LOCAL`, the setting reverts to `''`, not `NULL`;
  `''::uuid` would throw. `trinity_current_tenant()` maps `''` to `NULL`.
- **Writes without a tenant fail.** Any path that writes without a tenant (seed, jobs, webhooks, tests running as the admin
  role) hits `NOT NULL` on `tenant_id`. CI sets a per-database default for the admin test role only:
  `ALTER ROLE test IN DATABASE trinity_sql_test SET app.tenant_id = '<default>'`.
- **Caches are not covered by RLS.** Redis keys (dashboard caches) must include the tenant id.

## Tests

`services/crm/src/__pg__/tenant-rls.pg.spec.ts` (job "SQL on Postgres"): two tenants; the app connects as a non-bypass role.
It checks reads, updates, deletes, cross-tenant inserts and FKs through Prisma, both transaction forms, `$queryRaw`, and the
hand-written SQL in `stale-work.scan`, `dashboard-trend`, `lead-scoring` and `record-refs`; missing tenant ⇒ 0 rows and
blocked writes; webhook routing by Page id. A negative test disables RLS and expects the leak detector to fire;
`RLS_NEGATIVE=1` runs the whole file with RLS disabled (the isolation tests must fail).

`scripts/ci/check-raw-sql.sh` blocks `$queryRawUnsafe` / `$executeRawUnsafe` in runtime code and `Prisma.raw(` outside reviewed files.
