# Multi-tenant hosting (one company per sign-up)

Trinity can run as a hosted service where every sign-up creates its own company. Companies never see each
other's data or connected channels. Self-hosted installs keep the default single-company mode and need none of this.

## Turning it on

| Variable | Default | Meaning |
|---|---|---|
| `MULTI_TENANT` | `false` | `true` = one company per sign-up. |
| `SIGNUP_ENABLED` | `true` | With `MULTI_TENANT=true`, show `/register` and accept `POST /api/v1/auth/register`. `false` = only existing companies. |
| `DEFAULT_COMPANY_NAME` | `Công ty mặc định` | Name of company 1 (the data that existed before multi-tenancy). |
| `TENANT_MAX_CLIENTS` | `30` | Database clients kept open at once (one per active company, LRU). |
| `TENANT_CONNECTION_LIMIT` | `2` | Connections per company client. Size Postgres `max_connections` ≥ `TENANT_MAX_CLIENTS × TENANT_CONNECTION_LIMIT` + the main pool. |

| `TENANT_DATABASE_URL` | `DIRECT_DATABASE_URL`, then `DATABASE_URL` | URL used for company schemas and their migrations. It must be a direct or session-mode connection: company clients rely on a per-connection `search_path`, which a transaction-mode pooler (PgBouncer, Neon pooled) shares between clients, so a pooled URL is refused. |

The database role needs `CREATE` on the database (to create one schema per company).

## How isolation works

- **One Postgres schema per company.** Company 1 is `public` (existing data stays where it is, nothing is migrated);
  company *N* is `c_N`, created at sign-up with every migration applied (`prisma migrate deploy` against that schema).
  Tables, raw SQL, triggers and code sequences (`KH-0001`…) are all per company, so a guessed id from another company
  simply does not exist in yours.
- **`PrismaService` routes every query.** It is a proxy that resolves each access against the company of the current
  async context (`AsyncLocalStorage`). With no company in context it throws (fail-closed) — a code path that forgot to
  choose a company errors instead of reading someone else's rows. Background jobs run once per company
  (`cronRegistry`): a tick stops starting new companies when the job's budget is spent and the next tick resumes
  where it stopped, and a company that fails is logged and reported without stopping the others.
- **Choosing the company of a request**
  - Signed-in requests: the JWT carries `cid`; tokens without it belong to company 1.
  - Login: `platform.company_logins` maps the email to its company (an email belongs to one company only).
  - OAuth connect callbacks (Facebook, Zalo, Google, social networks, marketplaces): the `state` value is remembered
    with its company when the flow starts.
  - Facebook / Zalo webhooks: routed by Page id / OA id (`platform.company_routes`). A Page or OA can be connected by
    one company only.
  - API keys, MCP OAuth codes and tokens issued to company *N* start with `cN.`; unprefixed ones belong to company 1.
  - Links Trinity hands out (webhook URLs, store and payment links…) carry `?cid=N`. The hint only picks the schema;
    the secret token or slug must still match there. Links without a hint belong to company 1.
- **State outside the database** — permission cache, token blacklist, sessions, rate limits, socket rooms, stored
  files — is keyed by company as well (`tenantKey`), since ids repeat across companies.
- **Shared tables** live in the `platform` schema (created at boot, outside Prisma migrations): `companies`,
  `company_logins`, `company_routes`. Triggers in every company schema keep logins and Page/OA routes in sync, and
  their primary keys make a second company claiming the same email or Page fail at the database.
- **One user per signed-up company.** A hosted company has exactly its owner: the server refuses a second user (and a
  database trigger backs it up), and the web app hides staff, users, roles, departments and teams. Company 1 keeps
  its existing users.

## Deploying an update

1. `prisma migrate deploy` for `public` (company 1), as before.
2. `MULTI_TENANT=true pnpm --filter @trinity/prisma migrate:companies` — every company schema, 4 at a time
   (`TENANT_MIGRATE_CONCURRENCY`); exits non-zero if a company failed.
3. Restart. Boot runs `ensurePlatform()` and, in the background, migrates any company still behind (a company
   whose migration fails is logged; the others keep working). Sync triggers are reinstalled only when
their version changes, so a restart takes no table locks. A sign-up abandoned mid-way (process killed while
migrating) is cleaned up after 15 minutes, freeing its email. Back up the whole
database (all schemas) before a migration.

## Known limits

- One database client per active company (LRU, `TENANT_MAX_CLIENTS`). Background jobs walk every company, so with
  far more companies than the cap the pool keeps cycling; raise the cap (and Postgres `max_connections`) as the
  number of active companies grows.
- A job's per-company work keeps the job's own budget. A tick stops starting new companies when its budget is
  spent and the next tick resumes after the last company reached, so one busy company delays the others by
  about one tick per company ahead of them.

## Tests

`services/crm/src/__pg__/tenant-isolation.pg.spec.ts` signs up two companies on a real Postgres and checks that one
cannot read, count, update or delete the other's rows (models, raw SQL, transactions, guessed ids), that a Page and an
email belong to one company only, and that a company has exactly one user.
