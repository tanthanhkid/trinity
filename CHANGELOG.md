# Changelog

All notable changes to Trinity are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added
- **AI-native overview**: the home page opens with "AI assistants at work" (which assistants are connected, who is active now, what the AI did today) and "Connected channels" (Fanpage, Zalo OA, posting channels, payments, online store, sales connectors) with status and today's counts. With no assistant connected, it shows a step-by-step invite. New `GET /reports/dashboard-channels`, filtered by enabled features and the viewer's permissions.
- **Feature switches**: Settings › Features shows grouped cards (core, channels & inbox, sales, people, advanced) with one switch each; the menu and the related Settings sections only show what is on. New `inbox` switch for the Inbox menu. A newly built workspace always turns on the core set (overview, customers, tasks, reports, inbox, AI connections) plus what the AI picks for the industry.
- **AI assistant (MCP)**: `list_features`, `set_features` (switching off needs `confirmed_by_user`), `save_crm_option` (add, rename, reorder or hide customer sources, stages and statuses; no delete), `get_connected_channels`.

### Changed
- Settings: customer sources, stages and statuses are one "Customer lists" tab; Projects and Job titles left Settings (job titles stay under Management); the Messenger and Zalo OA inboxes inside Settings moved to the Inbox menu. Old `?tab=` links still open the right tab.
- A Fanpage that is turned off shows "Turned off" instead of looking connected.

### Upgrade notes
- No migrations. Running systems keep their feature switches (missing keys still mean on), so the new `inbox` switch starts on.

## 0.3.0 — 2026-10-15

### Added
- **Recurring posts**: repeat a post daily, weekly or monthly (Vietnam time) with an end date or count. Trinity always keeps one upcoming scheduled post, skips a run it missed by more than an hour, and pauses the schedule with the reason if a channel needs re-linking. Manage them in Calendar › Bài lặp lại or with the `list_recurring_posts`, `create_recurring_post`, `update_recurring_post` and `set_recurring_post_active` MCP tools (public posts need the user's approval; there is no delete tool).

### Upgrade notes
- New migration `0015_social_recurrences` (additive: one new table). Run `prisma migrate deploy`; `docker compose up -d --build` does this through the `migrate` job.

## 0.2.0 — 2026-10-15

First release of the fresh public history.

### Added
- **Multi-channel posting**
  - Drafts: save incomplete posts, reopen them in the composer, and publish them. Publishing is atomic, so the same draft cannot be posted twice and approval binds to the exact version the user reviewed.
  - Weekly posting queue: set time slots, then pick "add to queue" and the post goes to the next free slot. An approved post whose slot is gone moves to the next free slot.
  - Reusable hashtag sets and signatures, including a default signature for new posts.
  - UTM tagging of links per channel (`utm_source` = network, `utm_medium=social`). Tagging happens at publish time, so stored text stays clean, and character limits are checked on the tagged text.
  - Per-channel preview: the exact text, the YouTube title and description, the first comment, where "See more" cuts, and warnings.
  - YouTube options (description, tags, category, made for kids, thumbnail, playlist) and a Facebook first comment.
  - Editing and rescheduling of scheduled posts, and cancelling them (status only, nothing is deleted).
  - Bulk import from CSV (Calendar › Import CSV, and the `import_social_posts` MCP tool): check every row first, then create drafts or scheduled posts. An import never publishes immediately, queue rows get distinct slots, and the import is refused if the data changed since the preview.
- **Facebook Page**: comment rules (test or live mode, hide comments with phone numbers), editing Messenger flows, and editing or cancelling pending broadcasts.
- **Inbox**: read every Messenger and Zalo OA conversation; list and reply to Google reviews (once Google grants API access).
- **AI assistant (MCP)**: tools for everything above. New write tools that publish or message customers need the user's approval (`confirmed_by_user`). See the full tool index in `docs/integrations/mcp.md`.

### Changed
- Vitest 4.1 and Vite 6.4 for the web app's test toolchain.
- Dependency security fixes within the same major versions: `sharp` 0.35.5 and `pnpm` overrides. The unused `xlsx` package was removed.

### Upgrade notes
- New migrations `0012_social_drafts`, `0013_social_queue_slots` and `0014_social_snippets`. They are additive only: new tables plus one nullable or defaulted column. Run `prisma migrate deploy`; `docker compose up -d --build` does this through the `migrate` job.

## 0.1.1 — 2026-10-15

Security release — upgrade recommended for every self-hosted install and Docker image.

### Security
- Next.js 16.2.1 → 16.3.8: unauthenticated remote code execution in Image Optimization with AVIF (GHSA-2xp9-vwfh-vxw4) and in `next/og` (GHSA-vcvr-r3jv-pc5j).
- handlebars 4.7.10; notification templates compile with known helpers only (an admin editing a template cannot call arbitrary helpers).
- proxy-addr 2.0.8 and in-range dependency upgrades: `pnpm audit --prod` 0 critical (was 3), 7 high (was 78).
- Server mode refuses to start in production with `change-me-*` example secrets or secrets shorter than 32 characters.
- `.gitignore` covers `.env.*` (examples kept).

### Added
- Zapier / Make / n8n: API key scopes `deals:create`, `tasks:create`; `store_order.created` webhook; sample n8n workflows.
- Google Business Profile updates and reviews in the inbox (enabled once Google grants API access).
- CLA Assistant and GitHub Discussions.

### Changed
- Fewer background API calls on serverless deployments (notifications every 60 s, due-work ticks scheduled at the next due time, slower inbox polling on Vercel).


### Breaking / Upgrade notes

- **New migration `0001_session_revocation_won_at_notification_claim`** (additive only: three nullable columns and one new table, no data is dropped or retyped). Run `prisma migrate deploy` before starting the new API — `docker compose up -d --build` does this for you through the `migrate` job. It adds `users.tokens_valid_after`, `deals.won_at`, `notification_logs.webhook_url`, `notification_logs.claimed_at` and the table `revoked_sessions`.
- **The inbound webhook (`POST /api/v1/hooks/in/:token`) now always answers `200 {"status":"accepted","contact_id":null}`** for a valid request. Before, a new customer returned `201 {"status":"created","contact_id":N}` and an existing phone returned `200` with `duplicate` / `replayed` / `accepted`. The responses are now identical so a sender cannot probe which phone numbers are already customers. Integrations that checked for `201` or read `contact_id` must be updated (see `docs/integrations/webhooks.md`).
- **Demo data is off by default in Docker.** `SEED_DEMO_DATA` now defaults to `false` in `docker-compose.yml`, `.env.example` and `install.sh`. If you want demo data, set `SEED_DEMO_DATA=true` before the first start (`SEED_DEMO_DATA=true ./install.sh` also works). An existing `.env` keeps whatever value it already has.
- **Locking a user no longer rewrites the e-mail.** Accounts locked by earlier versions still carry an address like `deleted_<id>_<timestamp>@removed.invalid`; it is not restored automatically, so edit the e-mail before unlocking such an account. Only permanent deletion still frees the e-mail for reuse.

- The "Deploy with Vercel" button now also asks for `INTEGRATIONS_MCP_ENABLED` and `INTEGRATIONS_SECRET_KEY`, and no longer passes the ineffective `project-name`. The MCP default is unchanged (off). The *Bắt đầu* screen tells an admin which variables to set and to redeploy. The Next.js `middleware.ts` file is now `proxy.ts` (Next 16 naming, same behaviour). The login page no longer shows a placeholder admin address or an HR contact line. README: Neon / region / Neon Auth steps for Vercel; Discussions links replaced with Issues.

Behaviour changes to be aware of when self-hosting:

- Sign-out revokes the refresh token of that session on the server (the web app sends it along with `POST /auth/logout`; the revocation is stored in the database, so it survives restarts and works across instances). Changing a password, resetting it (yourself or by an admin), locking an account, or deleting an employee revokes every refresh token issued before that moment, so unlocking an account does not bring old sessions back. Access tokens stay short-lived (15 minutes) as before.
- Locking a user (`PATCH /users/:id {"status":"locked"}` or `DELETE /users/:id`) keeps the e-mail, so the account can be unlocked and used straight away.
- Deleting an employee (soft delete) now also locks the linked login account. Restoring the employee (re-adding with the same e-mail) does not unlock it — unlock the account separately.
- The briefing and the dashboard revenue chart count won deals by the day they were won (new `deals.won_at`, set when the status changes to `won`); deals won before the upgrade fall back to `updated_at`.
- Attendance requests enforce `monthly_forgot_limit` (forgot check-in/check-out) and `monthly_late_early_limit` (late arrival / early leave) per calendar month of the requested work date; rejected requests do not count and `0` means unlimited. Over the limit the request is refused with a Vietnamese message.
- Scheduled `webhook` notifications keep their `webhook_url` until they are sent, and rows stuck in `processing` for more than 15 minutes (for example after a crash) are put back to `scheduled`, or marked `failed` after three attempts, on the existing 2-minute cycle.

- Docker Compose now publishes the API on `127.0.0.1:${API_PORT:-4000}` only. The web container still reaches it over the compose network; put a reverse proxy in front of the web container (port 3000) and do not expose 4000.
- A refresh token is no longer accepted as a Bearer access token (it returns 401).
- Notification webhooks (`webhook_url`) must be `https://` on port 443/8443 and resolve to a public IP; they time out after 5 s and never follow redirects. The push channel is not wired to FCM yet and now reports `skipped` instead of `sent`.
- A manual personal income tax entered on a payslip now overrides the system-computed tax instead of being deducted on top of it.
- Payslips removed from a period can no longer be approved or edited, and deleted employees are no longer included when payslips are generated.
- Kanban column colours must be hex values (e.g. `#198754`).
- Query strings that carry OAuth or token parameters (`code`, `state`, `token`, ...) are redacted in logs.
- Scheduled notifications are now claimed in batches of 100 (previously all due rows were claimed but only 100 processed).
- MCP/AI output masks dotted or comma-grouped `84…` phone numbers instead of treating them as money.
- Attribute definitions of type `select`/`multiselect` must have at least one option (400 otherwise). Salary rules return 400 (not 500) for invalid formulas or non-numeric `amount`; salary components accept `is_taxable`.
- Creating a custom record now requires `custom_records.manage` at the service level (covers add-ons and sheet import); reassigning a contact checks for a duplicate phone in the new owner's list; restoring a deleted employee checks `users.manage` scope.
- Cron schedules for add-ons are validated over a full week; the attendance export warns when it is truncated; the public login endpoint rate-limits by the proxy-aware client IP; `verify_token` and `oauth_token` query keys are redacted in logs.
- Web: POS asks before discarding an unsaved cart, kanban custom fields save per field (debounced), reminder times use local time, and several silent failures now show an error.
- Update endpoints return 400 (not 500, or a silently stored null) when a required field is sent as `null` (kanban labels and custom fields, job titles, contacts, projects, notification templates, users, employees). Clearing the phone number of a user or employee now actually clears it. Notification template and salary formula syntax is validated on save.
- Employees: editing checks for a duplicate phone, accepts only the user's own current avatar path, and lock/delete are written to the audit log. Add-on jobs stop running when the approver is locked or deleted.
- Scheduled notifications are claimed per row (no double delivery between instances); Facebook Lead Ads rate-limit errors are retried by Meta instead of dropping the lead; creating a project with a duplicate code returns 409 under concurrency; deal pagination has a stable order; the overdue filter on kanban cards matches the overdue badge; dashboard reminders no longer leak notes or ids of contacts outside the viewer's scope; the contact list accepts ISO date-times in `created_to`.
- Web: the contact list grid works with lead scoring off, the delete-column dialog resets its target, the contact edit form reloads the latest data, the recruitment donut uses the table's colours, payslip decimals accept a single dot, the top search button is hidden before setup, resetting the contact filters no longer re-applies the 7-day default, and `/api/fe-logging` is size- and rate-limited.
- Security: the attendance office-IP gate and login IP check take the proxy-appended (last public) `x-forwarded-for` entry, not the client-controlled first one; `PATCH /contacts/:id` with a new `assigned_to` also requires `contacts.transfer` over the current owner; Google Sheet import only updates contacts the importing user may edit; scheduled Google Sheet syncs re-check that the creator is active and still holds the permission (otherwise the sync is switched off); job-title salary fields are returned only to users with `org.manage`, `payroll.view` or `payroll.manage`.
- Fixes: Zalo OA messages already accepted by Zalo are no longer reported as failed when the history write fails; payslip Excel import reads Vietnamese decimal commas (`85,5`); progressive tax positions brackets by `lower_bound` and rejects `upper_bound <= lower_bound`; MCP `list_my_tasks` description states that ordering is per page; Swagger description is English.
- Web: the kanban settings page recovers after deleting the selected board, select fields cannot be saved with blank option labels, the default font loads the Vietnamese subset, and the login Wi-Fi check text states it applies only to the selected people/teams/departments.
- Docs: backups cover the single `trinity` database; auth comments name the `settings.integrations` permission.
- Fixes: contract stats count the current `hdld_*` contract types; contact/public-API duplicate-phone checks treat `0…`, `84…` and `+84…` as the same number (new contacts are stored as `0…`); datetime filters on custom objects read a plain date as a Vietnam-time day; `PATCH` custom object with `code_prefix: null` returns 400; OAuth refresh accepts the originally requested `offline_access` scope; kanban card assignees must be active users; changing a kanban column's `is_done` updates `completed_at` of the cards already in it; locking a user whose reassignment target is an indirect report no longer creates a manager loop; scheduled in-app notifications refresh the unread badge; the payroll and attendance default month follows Vietnam time; dashboard reminders for contacts outside the viewer's scope carry no contact id.
- Security: `PATCH /users/:id` and `PATCH /contacts/:id` mask phone numbers by `users.phone_full` / `contacts.phone_full` like the read endpoints; the login Wi-Fi check takes the outermost public `x-forwarded-for` hop instead of the client-controlled first entry.
- Fixes: early-leave and late minutes in the discipline report skip leave and maternity days; the absent-employee `sort_by` ignores prototype keys; a missing or invalid Deno binary no longer crashes the CRM process; a failing new tool version restores the previous one; MCP update actions for contacts and deals reject empty values like tasks do; Zalo OA link stores a normalised phone and the thread search ignores repeated `q`; payslip Excel import reports unparseable or negative numeric cells instead of dropping them silently.
- Web: Enter no longer submits kanban cards, checklist items, attachments, labels or job titles twice; API error messages are shown in the product, team and department forms; void POS orders have no print button; recruitment stats refresh after candidate changes; the extension approval screen reads correctly when only a timeout is set; the global search label matches what it searches; `test:ui` and `test:coverage` have their Vitest dependencies.
- Web: the attendance calendar no longer paints every day absent while loading or on error; the mobile contact card hides the lead score when lead scoring is off; clearing a date in the employee edit form saves; payslip bonus rate cannot save a stray `.` as null.
- Docs: `.env.example` and the webhook docs state that AI/MCP connections need `INTEGRATIONS_SECRET_KEY` and that `custom_record.*` events carry the row's field values.
- `install.sh` now generates `INTEGRATIONS_SECRET_KEY` as base64 of 32 random bytes (it previously wrote 64 hex characters, which the key loader rejects). If you installed with an earlier script and use AI connections or webhooks, replace the key with `openssl rand -base64 32` (secrets stored under the old key cannot be decrypted).
- Update endpoints return 400 for `null` on required fields in more places (POS settings, areas, tables and modifiers, offices, contracts, custom objects and fields, deals, recruitment, webhooks, Google Sheet syncs, payroll employees, salary rules and components, insurance and tax settings). Payroll employees accept only the documented positions.
- Contact list search by phone number needs at least 9 digits unless you can see full phone numbers, like the quick search. Deleting a contract also deletes its file; deleted payslips can no longer be read or exported by id.
- Scheduled notifications with an explicit time (for example 20:00) are now sent at that time instead of waiting for business hours. A temporary network or server error while refreshing the Zalo OA token no longer forces a reconnect.
- MCP audit logs mask phone numbers in tool arguments; add-on tools with colliding names no longer break the tool list; add-on network manifests reject more IPv6 spellings of internal addresses; schema snapshots no longer cap views at 500.
- Creating a kanban field without options no longer fails with a 500 (JSON null column). Payroll payslip import, import template and the payroll reports now return 400 when `month` (or `months`, max 24) is missing or malformed instead of matching every period. Insurance settings reject `effective_to` before `effective_from` and overlapping active rows of the same code (which would deduct twice); salary formulas reject identifiers such as `base2` at save time.
- Contract `file_url` can no longer be set through create/update (only through the upload endpoint); contracts that expired less than 24 h ago are reported as expired; deleting or locking a user whose chosen `reassign_to` is one of their direct reports no longer makes that user their own manager; a team lead can save their own employee profile; `WsEmitItemDto.action_url` must be a relative path; monthly report buckets starting on the 29th-31st no longer skip February; clinic and real-estate sample appointments use +07:00; re-activating an add-on tool restarts an ext-host that gave up.
- Web: the kanban card dialog opens when `?card=` changes on the same page, KPI tooltips say "this/last month" on monthly cards, paid payslips show "Đã trả lương", a lone `.` in a payslip number field is no longer saved as null, the workdays detail table returns to page 1 when the date range changes, the requests panel warns when more than 1000 requests exist, "Create task" on a contact needs `kanban.manage`, notification dates use the Vietnam time zone, and `/api/fe-logging` accepts only known field names.
- Web: errors in the dashboard no longer show raw messages, the newsfeed shows a load error with retry, kanban list labels show names and colours, the sales assistant JSON editor stays in sync, a new contact's reminder time is sent as an ISO timestamp, and the API proxy no longer forwards stale `content-encoding`/`content-length` headers.
- MCP: `create_task` without any kanban board says so instead of "not found", and the seed creates a default board ("Việc của tôi") on installs that have never had one; changing a contact's stage (web or MCP) records a `stage_change` activity; `import_records` returns skipped rows as `errors` [{row, reason}] (first 50, plus `error_total`) and names the first ones in the message; update summaries show the new name (`old → new`); `get_action_status` takes `action_id` (`id` still accepted); `list_records` select filters accept option labels and reject unknown options with the valid values; `get_record`/`update_record` reject an `id` and `code` that point to different records; class-validator errors are reported in Vietnamese.
- Saved views whose filter points at a select option (or field) that was deleted afterwards open normally again: the dead condition is dropped when the view is read, instead of the list failing with 400 (filters sent fresh by a user or AI still reject unknown options); the MCP audit log records `resourceId` for `get_action_status` called with `action_id`; new real-database tests cover the contact `stage_change` activity and `create_task` on the seeded default board (`stage-task.db.spec.ts`).

## 0.1.0 — first public release

- AI-native CRM with a built-in MCP server (OAuth login). AI writes run directly within the connected user's permissions; an optional workspace setting, *Require approval for AI changes*, restores a draft-then-approve flow.
- CRM (contacts, Kanban pipelines, newsfeed), sales (products, projects, POS), Zalo OA, HR, attendance, payroll, reports, roles and data scopes, custom objects, sandboxed add-ons.
- One-click deploy: Vercel serverless (`build:vercel` applies migrations and seeds the first admin during the build) and self-hosting with Docker Compose plus `install.sh` (random secrets).
- GitHub Actions: CI, plus Docker image builds that publish to GHCR on `v*` tags.
