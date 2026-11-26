# Cross-process state sync (Postgres NOTIFY)

Several processes can serve one database (Node with Node, Node with the Rust server during the migration). Each keeps
caches in memory, so changes are announced on one Postgres channel and every other process applies them. This page is
the contract both implementations follow.

- Channel: `trinity_sync` (one channel for everything).
- Payload: one JSON object, at most 7,500 bytes (Postgres allows 8,000). Payloads carry keys, not content.
- Envelope: `{"v":1,"o":"<origin>","k":"<kind>","c":<companyId>, ...fields}`
  - `v` format version, `1`. A listener ignores other versions.
  - `o` origin id of the sender (`node-<pid>-<hex>`, `rust-...`). A process ignores its own messages: it applies a change
    locally first, then announces it.
  - `k` kind (below). `c` company id (`0` when there is no company context; single-company installs use `1`).
- Sending is fire-and-forget: a failed `NOTIFY` is logged, never raised. Listening needs a direct or session-mode
  connection (not a transaction pooler). If the listener drops, it reconnects with back-off and then clears its caches
  (messages sent meanwhile are lost); TTLs are the safety net.
- Switch: `TRINITY_SYNC=off` (or `TRINITY_RUNTIME=serverless`) disables listening and sending.

| Kind `k` | Fields | Receiver does |
|---|---|---|
| `rbac` | `ids`: user ids (array, at most 500) or `"*"` | Drop that company's permission-cache entries for those users (all users for `"*"`) |
| `token` | `op`: `"block"` or `"unblock"`, `u`: user id, `t`: change time (ms) | Apply only if `t` is not older than the change already held; add/remove the user in the token blacklist (15 minute TTL from `t`) |
| `session` | `op`: `"start"` or `"clear"`, `u`: user id, `s`: session id (start only), `t`: change time (ms) | Apply only if `t` is not older than the change already held; set/clear the user's single active session |
| `cache` | `p`: key prefix without the company part, e.g. `crm:contacts:count:` or `dashboard:` | Delete read-cache keys of company `c` that start with `p` |
| `bell` | `u`: user ids, `n`: `notification_logs` ids (each at most 200 per message; larger sets are split) | Read the rows from the database in company `c`, push `notification:new` to the sockets it holds, then recompute and push unread counts for `u` and the row owners. Empty `n`: only refresh unread counts |
| `payslip` | `p`: payslip id, `u`: user id, `m`: month `YYYY-MM`, `a`: total amount | Node only: run the payslip-approved notification path (templates, dedup, bell). Sent by the Rust server; Node approvals call the path directly and reach other processes through `bell` |
| `graph` | `ok`: boolean, `h`: HTTP status, `code`: Graph error code or null, `sub`: subcode or null, `send`: `true` | Add the outcome of an outgoing Graph call to the company's error window and the app-level back-off (only outgoing calls are sent) |

Security state is durable: token blacklist and active sessions are also written to `token_blacklist` and `active_sessions`
(per company schema). On start and after a listener reconnect every process reloads them from the tables, so a lost message
cannot leave a revoked user usable. Writers (Rust included) should write the row first, then send the message.

Notes for implementers: the cache key of company `c` is the bare key for company 1 and `c<id>:<key>` otherwise. A company
other than 1 uses schema `c_<id>`; read rows inside that schema. Payslip notices assume one Node process handles them.

## Rust side (K36)

`trinity_db::sync` implements this contract: `publish_in_tx` / `publish_bell_in_tx` send with `pg_notify` on the business
transaction (Postgres delivers it on commit only, so the row is always written before the message), `listen` receives with
reconnect and a `Resync` event after a reconnect, and ignores its own origin (`rust-<pid>-<hex>`). Modules never write the
tables or the message by hand: `trinity_db::outbox::publish_integration_event` writes `integration_events` (event types from
`server/contracts/events.json`, number text as `JSON.stringify` prints it) and `create_notification` writes `notification_logs`
and sends the `bell` message. The Node dispatcher picks Rust-written events up on its next 10 second tick. Known difference:
Prisma rounds floats with more than 15 significant digits when it writes a JSON column; Rust keeps the value.
