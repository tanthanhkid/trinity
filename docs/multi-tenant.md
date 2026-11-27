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
| `CHANNEL_GUARD_WINDOW_MIN` / `_MIN_CALLS` / `_MIN_BLOCKS` / `_MAX_BLOCK_RATE` / `_POLICY_BLOCKS` / `_PAUSE_HOURS` / `_APP_BACKOFF_MIN` | `60` / `20` / `10` / `0.3` / `2` / `6` / `5` | Auto-pause thresholds, see [Channel abuse protection](#channel-abuse-protection). |
| `TENANT_DATABASE_URL` | `DIRECT_DATABASE_URL`, then `DATABASE_URL` | URL used for company schemas and their migrations. It must be a direct or session-mode connection: company clients rely on a per-connection `search_path`, which a transaction-mode pooler (PgBouncer, Neon pooled) shares between clients, so a pooled URL is refused. |

The database role needs `CREATE` on the database (to create one schema per company).

## How isolation works

- **One Postgres schema per company.** Company 1 is `public` (existing data stays where it is, nothing is migrated);
  company *N* is `c_N`, created at sign-up with every migration applied (the same embedded migrations, run against that schema).
  Tables, raw SQL, triggers and code sequences (`KH-0001`…) are all per company, so a guessed id from another company
  simply does not exist in yours.
- **Every query is routed by company.** The database layer (`trinity-db`) sets the `search_path` of the connection to the
  company of the current request. With no company in context it refuses (fail-closed) — a code path that forgot to
  choose a company errors instead of reading someone else's rows. Background jobs run once per company
  (`runForEachCompany`, wrapped by `tenantTimerTick` for timers): a round stops starting new companies when the job's
  budget is spent and the next round resumes where it stopped, and a company that fails is logged and reported without stopping the others.
- **Choosing the company of a request**
  - Signed-in requests: the JWT carries `cid`; tokens without it belong to company 1.
  - Login: `platform.company_logins` maps the email to its company (an email belongs to one company only).
  - OAuth connect callbacks (Facebook, Zalo, Google, social networks, marketplaces): the `state` value is remembered
    with its company when the flow starts.
  - Facebook / Zalo webhooks: routed by Page id / OA id (`platform.company_routes`). A Page or OA can be connected by
    one company only.
  - API keys, MCP OAuth codes and tokens issued to company *N* start with `cN.`; unprefixed ones belong to company 1.
  - Links Trinity hands out (webhook URLs, store links…) carry `?cid=N`. The hint
    only picks the schema; the secret token, slug or gateway signature must still match there. Links without a hint
    belong to company 1.
  - Online-store addresses (slugs) are claimed in `platform.company_routes` (`store_slug`) — first company wins, a
    second one is refused, a changed slug releases the claim. A route whose holder no longer has a store with that slug
    (old "last company wins" routes) is an orphan: the real owner can take it over (routes younger than 2 minutes are
    never taken, a claim precedes its row), and boot cleans orphans up. A store link without `?cid=` routes by its slug.
    Claims that predate this rule are registered at boot; routes of kinds no longer used (the marketplace connections
    removed in G06) are deleted at boot.
- **State outside the database** — permission cache, token blacklist, sessions, rate limits, socket rooms, stored
  files — is keyed by company as well (`tenantKey`), since ids repeat across companies.
- **Shared tables** live in the `platform` schema (created at boot, outside the numbered migrations): `companies` (also holds
  the channel-lock columns), `company_logins`, `company_routes`. Triggers in every company schema keep logins and Page/OA routes in sync, and
  their primary keys make a second company claiming the same email or Page fail at the database.
- **Staff of a company** (see below): a signed-up company starts with its owner and grows by invitation, up to the
  `maxUsers` of its plan. Company 1 keeps its existing users and plan rules.

## Inviting staff

There is no email service, so an invitation is a link the owner copies and sends through Zalo or Messenger.

1. Settings › Users › *Mời bằng link* (needs `users.manage`): email + role. The role must not exceed the inviter's own
   permissions, and the system *Quản trị* role is for administrators only. `POST /api/v1/auth/invitations` →
   `{ token, path }`; the web builds the link `<site>/invite/<token>`. The token is `cN.` + 32 random bytes (the prefix
   routes it to company *N*'s schema, like API keys), stored only as a SHA-256 hash, valid 7 days, single use.
2. Checks at creation: the email must not belong to another company (`platform.company_logins`) or already have an
   account here, and `active users + pending invitations` must stay below the plan's `maxUsers` (new companies get `DEFAULT_SIGNUP_PLAN`, `mac_dinh` = every plan-gated feature, 10 users; a company ≥ 2 with no plan row is treated the same everywhere (`resolvePlanForCompany`), only company 1 / single-company installs default to unlimited `custom`; every path that adds an active user takes one advisory lock per company)
   ("Gói hiện tại tối đa N người, liên hệ để nâng gói."; plan `custom` = unlimited). Inviting the same email again
   replaces the old link (only one inside your `users.manage` scope; another person's pending invitation answers 409; the database also allows one open invitation per email). Creating a user or employee directly for that email cancels the invitation first, and locking or deleting an inviter cancels theirs. An invitation whose inviter lost `users.manage` / was locked, or whose role was deleted, does not hold a seat and is listed as `unusable` (deleting a role cancels its invitations). Pending invitations are listed (`GET /auth/invitations`) and can be cancelled
   (`POST /auth/invitations/:id/revoke`), following the `users.manage` scope (`all` sees every invitation, a narrow scope only those created by people in it); the link itself is never shown again.
3. The invitee opens `/invite/<token>` (public): `POST /auth/invitations/preview` shows company, email and role;
   `POST /auth/invitations/accept` takes a name and password, creates the user (and its employee record) in the
   invitation's company with the chosen role, and returns tokens like a login. The plan limit is checked again then,
   inside the same transaction that marks the invitation used (under the company advisory lock, taken first in every invitation path; the inviter must still be active with `users.manage` and the role must not exceed the inviter's permissions, else 410; a narrow-scope inviter becomes the new user's manager; the office Wi-Fi check and single-session start run as in login), so two clicks cannot both win. A used, cancelled,
   expired or unknown token all answer 410 with the same sentence.
4. Forgot password: the owner opens the user in Settings › Users › *Cài lại mật khẩu*; *Tạo mật khẩu tạm* fills a random
   password that is shown once after saving, to copy and send. (`PATCH /users/:id/reset-password` revokes the old
   sessions.)
5. MCP: `create_invitation` (returns the link; needs a public base URL; never the *Quản trị* role through AI), `list_invitations` and `cancel_invitation`. No password tool: the AI never handles passwords.

The old database trigger "one user per company" is gone: migration `0019_user_invitations` drops it in every schema
(`migrate:companies`), and `installSyncTriggers` (version `trinity-sync-v3`) no longer creates it.

## Channel abuse protection

Every company shares one Meta app (and Zalo / Google apps). A company that spams Messenger, comments or posts can get
the **whole app** restricted, so outbound channels are limited per company. Everything below applies only when
`MULTI_TENANT=true`; a single-company install has no limits, no lock and no pause.

**Plan limits** (`PLANS[..].channelLimits` in `packages/rbac/src/org-features.ts`, counted on the server in the
company's own `channel_usage` table, atomically — parallel requests cannot overshoot):

| Plan | Bulk messages / day | Recipients / campaign | Posts / day | Auto comment replies / hour |
|---|---|---|---|---|
| `mac_dinh` (plan of a newly signed-up company) | 200 | 200 | 10 | 60 |
| `ket_noi` | 200 | 200 | 10 | 60 |
| `tro_ly_giam_doc` | 300 | 300 | 15 | 60 |
| `tro_ly_kinh_doanh` | 1000 | 1000 | 40 | 200 |
| `tro_ly_van_hanh` | 3000 | 2000 | 100 | 500 |
| `custom` (single-company installs and company 1 when no plan is set; wide, still capped) | 5000 | 2000 | 200 | 1000 |

"Bulk messages" = Messenger broadcast recipients and Zalo ZNS sends; "posts" = post targets created or scheduled (one
per channel); days are Vietnam days. Over a limit the action is refused with a plain Vietnamese message (HTTP 429, code
`channel_quota`), a warning is logged and a `limit_exceeded` event recorded. A broadcast that runs out of quota midway
stops: the rest is marked skipped with the reason. A campaign over the recipient cap is refused when you press send.

**Graph API error tracking.** Every *outgoing* Graph call (message, comment reply/hide, post) reports its outcome per company
(in memory, last 60 minutes); read calls (insights, conversations, tokens) are ignored, so a Page missing `read_insights`
never trips it. Counted as blocks: #368 (policy/spam), #551 (recipient unavailable), #17 and #32 (per-user / per-Page rate
limits). Not counted: permission errors (#10, #200–#299 — the company's own setup), outside the 24-hour window
(subcode 2018278), expired tokens (#190). Past the threshold — two #368, or at least 10 blocks and 30% of at least 20
sends — **the company's bulk and automatic sending pauses** (broadcasts, flows, automatic comment replies, scheduled posts)
for `CHANNEL_GUARD_PAUSE_HOURS` (default 6). A pause only **holds** work, it never cancels it: broadcast recipients stay
queued and resume after the pause, flow steps and scheduled posts are re-scheduled to the end of the pause (a post does not
use up a retry), and a comment that arrives during a pause stays "unanswered" for staff (hide-on-phone rules still run).
Only a lock or an exhausted quota stops work for good. The pause covers Facebook/Instagram sending only; Zalo is not paused by Graph errors (a lock still blocks them). The pause is stored in the company's
`channel_events` (an `auto_pause` event), so every instance sees it; staff replying by hand keep working. End a pause
early with `channel:lock -- resume <companyId>`.
App-wide limits (#4, #613, HTTP 429 on outgoing calls) are shared by all companies, so they are never charged to one
company: when they repeat (3 times within a minute, `CHANNEL_GUARD_APP_BACKOFF_HITS`) the instance backs off automatic
Facebook/Instagram sending for every company for `CHANNEL_GUARD_APP_BACKOFF_MIN` minutes (default 5); one-off hits and read
calls never trigger it. Quota is returned when a message does not reach the network (send failure, no token).

**Channel lock (platform owner).** `platform.companies.channels_locked` (+ reason, time) blocks every outbound send of a
company — bulk, automatic and manual, comments, posts; receiving messages and webhooks keeps working. The state is read
at most 10 seconds stale on any instance.

```bash
MULTI_TENANT=true DATABASE_URL=... trinity channel-lock list
MULTI_TENANT=true DATABASE_URL=... trinity channel-lock lock 7 "reported spam"
MULTI_TENANT=true DATABASE_URL=... trinity channel-lock unlock 7
MULTI_TENANT=true DATABASE_URL=... trinity channel-lock resume 7
```

**Seeing it.** `GET /settings/channel-guard` (admins; limits, usage, events), `GET /settings/channel-guard/alerts` (every signed-in user; only the warning text, feeds the banner) and the MCP tool `get_channel_limits` return the plan limits, usage so far,
lock/pause state, warnings and the latest events. The app shows a banner when a company is locked, paused or at 80% of a
limit, and Settings › Features shows the meters. Owners cannot change limits or the lock; only the plan (set by Trinity)
moves the limits.

## Deploying an update

1. `trinity migrate` for `public` (company 1).
2. `MULTI_TENANT=true trinity migrate --companies` — every company schema, 4 at a time
   (`TENANT_MIGRATE_CONCURRENCY`); exits non-zero if a company failed.
3. Restart. Boot ensures the `platform` schema and, in the background, migrates any company still behind (a company
   whose migration fails is logged; the others keep working). Sync triggers are reinstalled only when
their version changes, so a restart takes no table locks. A sign-up abandoned mid-way (process killed while
migrating) is cleaned up after 15 minutes, freeing its email. Back up the whole
database (all schemas) before a migration.

## Known limits

- One database client per active company (LRU, `TENANT_MAX_CLIENTS`). Background jobs walk every company, so with
  far more companies than the cap the pool keeps cycling; raise the cap (and Postgres `max_connections`) as the
  number of active companies grows.
- A job's per-company work keeps the job's own budget. A timer round (`runForEachCompany`) stops starting new
  companies when its budget is spent and the next round resumes after the last company reached, so one busy company
  delays the others by about one round per company ahead of them.

## Tests

The Postgres tests of `server/crates/mod-channel-guard` (`tests/guard_pg.rs`) and the routing tests of `trinity-db` cover channel limits (per company, atomic), the channel lock, auto-pause,
and routing: a second company cannot claim another's store slug, store links route by slug, retired route kinds are cleaned up,
and store links only ever touch the right company.

The tenant-isolation tests (`server/crates/trinity-db/tests/`) sign up two companies on a real Postgres and checks that one
cannot read, count, update or delete the other's rows (models, raw SQL, transactions, guessed ids), that a Page and an
email belong to one company only, and that a company can have several users.
`server/crates/mod-auth/tests/invitations.rs` covers invitations on a real Postgres (create, preview, accept into the right
company, single use, cancel, expiry, forged prefix, foreign email, `maxUsers`, the removed trigger).
`tests/multi-tenant-e2e/run.mjs` runs the same flow over HTTP against a local server.
