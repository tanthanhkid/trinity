# Custom objects ("Tính năng tuỳ biến")

Users add their own "features" (Student, Parent, Invoice, Contract…) under **Settings › Features › Custom features** (UI: "Cài đặt › Tính năng › Tính năng tuỳ biến"). The mechanism is industry-agnostic. A built-in **Education center** template is provided.

## Quick start

1. **Settings › Features** (needs `settings.features` to open the tab + `custom_objects.manage` to configure) → **Add feature**: name, plural, icon, show in menu, roles that can see it.
2. The configuration screen opens → **Add field**: name, type, required / unique / use as title / show in list. Reorder with the ↑↓ buttons.
3. Or **Use template: Education center** → creates 6 features already wired with relations + formulas (optionally with FAKE sample data).
4. The feature appears in the **Custom** menu group (page `/x/<code>`): list (table/cards), search by title, filter by field, sort, "Load more", CSV export, add/edit/delete records, view related records (e.g. Parent → their Students).
5. Assign permissions under **Roles › Custom features**: `custom_records.view` (view), `.manage` (add/edit), `.delete`, `.export`, `.phone_full` (see full phone numbers — a separate permission), `custom_objects.manage` (configure). Scope `own|team|subtree|all` is computed by **owner ∪ creator**.

## Field types

`text`, `long_text`, `number`, `currency` (VND, integer ≥ 0), `percent` (enter 5 = 5%), `date`, `datetime` (Vietnam time), `boolean`, `select`, `multi_select`, `email`, `phone` (VN, masked per `custom_records.phone_full`), `url` (http/https), `link` (chips to records, see below), `relation` (to another feature or the Contacts book; single/multiple), `user` (staff within scope), `formula` (computed, not entered by hand).

Limits: 50 features · 60 fields/feature · 32 KB/record · 100 options/field. Feature/field codes: `a-z0-9_`, starting with a letter, **immutable after creation**.

## Formulas

`+ − × ÷`, parentheses, numbers, `{field_key}` references (number / currency / % / date), `round(x, n)` (n = 0..6), `months_between(d1, d2)`, `days_between(d1, d2)`. `%` reads as a fraction (5% → 0.05). Missing data or division by zero → empty. A formula **cannot** reference another formula. Custom parser, **no** `eval`. A "Try it" button is available while editing.

Examples: `{gia_goc}*(1-{uu_dai})` · `round({gia_goc}*(1-{uu_dai})/{so_buoi}, 0)` · `round(months_between({bat_dau},{ket_thuc}), 1)`.

## Behavior to know

- Deleting a feature/field is a **soft delete**; a feature still referenced by another feature cannot be deleted; a field that is the title or is used by a formula cannot be deleted.
- A field that **already has data** cannot change type (except short text ↔ long text), cannot drop options in use, and cannot change a relation's target.
- "Roles that can see it" only **narrows** access (it grants no permission); holders of `custom_objects.manage` always see every feature.
- Relations to records outside your scope show "Not viewable" ("Không xem được"; the title is not leaked); the relation picker returns only records within scope.
- CSV export: newest → oldest, at most 20,000 rows, and it **says so clearly when truncated**; phone numbers are masked per permission; cells starting with `= + - @` are protected against CSV injection.
- Sample records (from "Use template") are FAKE data and do NOT emit events on creation; if you later edit/delete them, webhooks will receive `updated`/`deleted`. Numbers `0900000xxx` fall in the real 090 range — never send real messages/notifications to sample data.
- Every record create/update/delete writes an outbox event `custom_record.created|updated|deleted` (same transaction) — selectable in outgoing Webhooks; webhooks mask phone numbers and filter by scope/role of the endpoint's creator.

## Record codes

- Each custom table has a **prefix** (`custom_objects.code_prefix`, 2–4 uppercase letters): the DB generates it from the name when the table is created — the first letter of each word
  ("Học sinh" → `HS`, "Bệnh nhân" → `BN`), and on collision appends letters ("Khoá học" → `KHO`). Edit it under Settings › Features › Edit feature
  (or `PATCH /custom-objects/:key {code_prefix}`); the old prefix goes into `code_prefix_aliases`, so an old `@HS001` still resolves and no table can reuse it.
- Each record has a **code** `custom_records.code` = prefix + an incrementing number padded to 3 digits (`HS001`…`HS999`, `HS1000`). The counter
  `custom_objects.next_code_seq` only increases ⇒ **codes of deleted records are never reused**. Renaming a record does not change its code.
- Core tables: customers `KH001…`, deals `DL001…`, tasks (kanban cards) `CV001…` — separate sequences; these three prefixes are reserved.
- Codes are assigned by a **BEFORE INSERT trigger** (migration `0000_init`) ⇒ every write path (form, MCP `import_records`
  `createMany`, industry templates, legacy code) gets a code. Existing records were assigned codes in creation order `(created_at, id)`, including soft-deleted ones.
- Display: the "Code" ("Mã") column first in the list, at the top of kanban cards, in the detail page title; the list search box also matches code prefixes (`HS0` → HS001…HS009).
  CSV export has a "Code" column.

## @-mentions + the "Link" field

- **Long text fields** (type `long_text`) use `components/refs/mention-editor.tsx`: typing `@` suggests by code or name across ALL tables
  (`@HS` filters by prefix, `@Nguyễn` by name, `@HS001` exact code); ↑↓ to choose, Enter/Tab inserts the chip, Backspace after a chip deletes the whole chip,
  pasting `HS001` turns it into a chip, clicking a chip opens the record, hovering shows a quick preview. The STORED value is text `… @HS001 …` (readable by CSV/AI).
- **Field type `link` ("Liên kết", Link)**: multiple chips pointing to records in any table, with no constraint. Accepts codes (`HS001`, `@HS001`) or
  `type:id`; the backend converts to `type:id` (`record:12`, `contact:5`, `deal:3`, `task:9`) — changing a prefix does not break links. At most 50 chips.
- **Table `record_links`** (migration `0000_init`, no FKs): each time a record is saved, edges (source, field) → target are rewritten
  for `long_text` fields (@ chips) and `link` fields. An @ chip becomes an edge only if the WRITER can see the target record.
- **API** `/api/v1/refs` (permission: one of `custom_records.view|contacts.view|deals.view|kanban.view`; every result is filtered by view
  permission — a table the caller lacks permission for does not appear): `GET suggest?q=` · `GET resolve?codes=HS001,KH002` · `GET :type/:id/backlinks`
  ("Mentioned in", 404 if the target record is not visible) · `GET :type/:id/preview` (quick preview). Sources: customers (KH), deals (DL),
  tasks (CV) and every custom table. Suggestions use the code index (`LIKE 'HS%'`) + `lower(title)`; mid-name matches scan with a LIMIT.
- Custom record detail pages and the customer page have a **"Mentioned in"** section ("Được nhắc tới ở").
- @ chips on core screens (source `task` / `contact` in `record_links`): the **task description** (`description` field, editor uses `MentionEditor`,
  Markdown preview renders chips), the customer's **"Reminder notes"** (`reminder_notes`) and **customer notes added by the AI assistant** (field `note:<activity id>`);
  written through `RecordLinksService.syncMentions` after saving (errors are only logged and never break the save). **Task comments** (field `comment:<activity id>`, label "Comments"; editor `MentionEditor`, Ctrl/⌘+Enter to send; comments cannot be edited/deleted, so edges stay as they are).

## Calendar + Table views

- `custom_views.type` additionally accepts `calendar` and `table` (MCP `create_view`/`update_view`/`propose_workspace`). The four types (`list`, `kanban`, `calendar`, `table`) and their descriptions live in `VIEW_TYPE_INFO` (`view-config.ts`); MCP `list_screen_types` returns them, and any other type is rejected with that list.
- **Calendar**: `config.date_field` = a `date`/`datetime` field (e.g. Appointment date), `config.mode` = `month` (default) | `week`, `card_fields` shown in the
  week view. The Mon → Sun grid uses VIETNAM time; loads at most 100 records in the visible range (backend filters by `date_field` + view scope) and warns if exceeded.
- **Table**: `config.columns` (if unset = fields shown in the list). Click a cell to edit in place (input like the form; single-select saves immediately; other types
  save on Enter / Tab / click-away; Esc cancels; yes/no is a toggle). The backend validates like the form; without `custom_records.manage` it is view-only.

## API (`/api/v1/custom-objects`)

| Task | Route | Permission |
|---|---|---|
| List / add / edit / delete features | `GET,POST /` · `PATCH,DELETE /:key` | `custom_objects.manage` |
| Definition of one feature | `GET /:key` | `custom_records.view` or `custom_objects.manage` |
| Menu | `GET /nav` | `custom_records.view` |
| Fields | `POST /:key/fields` · `PATCH,DELETE /:key/fields/:fieldKey` · `PUT /:key/fields/order` | `custom_objects.manage` |
| Formula preview | `POST /formula/preview` | `custom_objects.manage` |
| Templates | `GET /templates` · `POST /templates/:template/apply` `{with_sample_data}` | `custom_objects.manage` (+ `custom_records.manage` if sample data is included) |
| Records | `GET,POST /:key/records` · `GET,PATCH,DELETE /:key/records/:id` | view / view+manage / view+delete |
| Backlinks | `GET /:key/records/:id/related` | `custom_records.view` |
| Lookup for relation picker | `GET /:key/lookup` · `/lookup/users` · `/lookup/contacts` | view |
| CSV export | `GET /:key/records/export` | `custom_records.view` + `custom_records.export` |

List: `?q=` (title) · `?sort=id|updated_at|title|field:<key>` · `?dir=` · `?filter={"key":value|[…]|{min,max}|{from,to}}` · `?cursor=` (taken from `next_cursor`).

## Deployment

Run `prisma migrate deploy`, then `prisma generate` + build the monolith + web (the proxy has the prefix `/api/v1/custom-objects`). No new cron/flags: the table is empty and nobody has the new permissions until roles are assigned — the feature has no effect until then.
