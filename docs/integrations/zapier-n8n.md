# Zapier, Make and n8n

Trinity has no app in the Zapier or n8n marketplaces. You connect it with the generic building blocks every automation tool has, so nothing needs approval from Zapier or n8n:

| Direction | Trinity side | Zapier | n8n | Make |
|---|---|---|---|---|
| Trinity → your tools (something happened) | [Outgoing webhooks](webhooks.md) | **Webhooks by Zapier** › *Catch Raw Hook* | **Webhook** node | **Webhooks** › *Custom webhook* |
| Your tools → Trinity (create something) | Public API with an API key (below) | **Webhooks by Zapier** › *Custom Request* | **HTTP Request** node | **HTTP** › *Make a request* |

Ready-made n8n workflows are in [`integrations/n8n/`](../../integrations/n8n): import them with *Workflows › Import from File*.

## Trinity → your tools: outgoing webhooks

1. In your tool, create a webhook trigger and copy its URL (it must be public `https://`).
2. In Trinity: **Settings › Connections › Outgoing webhooks › Add endpoint**, paste the URL and pick the events (for example *Trang bán hàng: có đơn mới* = `store_order.created`, *Tạo khách hàng* = `contact.created`, *Thanh toán: đã nhận tiền* = `payment.received`). Copy the signing secret `whsec_…`; it is shown once.
3. Click **Gửi thử** (Send test). Your tool receives a `ping` event.

Every request is `POST` JSON `{ id, type, created_at, data }`. The full event list, payloads, retries and the signature algorithm are in [webhooks.md](webhooks.md). Two rules matter in automations:

- **Deduplicate on `id`** (same as header `X-Trinity-Delivery`): delivery is at-least-once, so a retry can arrive twice.
- **Filter on `type`**: one endpoint can receive several event types.

### Verifying the signature

The signature is an HMAC over the *raw* body, so the tool must give you the body bytes as received.

- **n8n**: in the Webhook node, turn on *Options › Raw Body*, then verify in a Code node. The sample workflows contain the code. Self-hosted n8n must allow the `crypto` module in Code nodes: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
- **Zapier**: use *Catch Raw Hook* (not *Catch Hook*), then a *Code by Zapier* (JavaScript) step:

```js
const crypto = require('crypto');
const secret = 'whsec_…';
const header = inputData.signature;          // map: Headers › X-Trinity-Signature
const raw = inputData.raw;                   // map: Raw Body
const p = Object.fromEntries(header.split(',').map((x) => x.split('=')));
const expected = crypto.createHmac('sha256', secret).update(`${p.t}.${raw}`).digest('hex');
if (expected !== p.v1 || Math.abs(Date.now() / 1000 - Number(p.t)) > 300) throw new Error('Bad Trinity signature');
const evt = JSON.parse(raw);
output = [{ type: evt.type, id: evt.id, ...evt.data }];
```

Skipping verification works, but then anyone who learns the URL can send fake events.

## Your tools → Trinity: public API with an API key

Create a key under **Settings › API keys** (Cài đặt › Khoá API). Pick the **owner**: every record is created *as that person*, with that person's permissions and data scope, exactly as if they had used the app. Tick only the scopes the automation needs:

| Scope | Endpoint | Creates | Owner needs permission |
|---|---|---|---|
| `contacts:create` | `POST /api/v1/public/contacts` | Customer | (owner becomes the assignee) |
| `contacts:create` | `GET /api/v1/public/contacts/sources` | (lists customer sources for `source_id`) | |
| `deals:create` | `POST /api/v1/public/deals` | Deal / order | `deals.manage` |
| `tasks:create` | `POST /api/v1/public/tasks` | Task (a card on a Kanban board) | `kanban.manage` |
| `tasks:create` | `GET /api/v1/public/tasks/columns` | (lists boards and columns for `column_id`) | `kanban.view` |

Administrators cannot own a key, and a key stops working (`403`) if its owner is later made an administrator: create a new key for a staff account with just the permissions needed.

Send the key in the header `X-API-Key: trinity_live_…`. Limit: 100 requests per minute per key. Errors: `401` wrong/revoked key or missing scope, `403` the owner lacks the permission, `400` invalid data.

### Create a deal (order)

```bash
curl -X POST https://<your-trinity>/api/v1/public/deals \
  -H 'X-API-Key: trinity_live_…' -H 'Content-Type: application/json' \
  -d '{"title":"Website order #1001","value":1500000,"contact_phone":"0912345678","contact_name":"Nguyen Van A"}'
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | 1–255 characters |
| `value` | no | VND, integer |
| `status` | no | `open` (default), `won`, `lost` |
| `description`, `note` | no | ≤ 5000 characters |
| `contact_phone` | no | Links the deal to the customer with this phone, searched within the owner's data scope |
| `contact_name` | no | If no customer has that phone, a new customer is created with this name (owner needs `contacts.create`). Without it, an unknown phone returns `400` |
| `contact_source_id` | no | Source for a newly created customer (`GET /public/contacts/sources`) |

Response `201`: `{ "deal": { "id", "code", … }, "contact_id", "contact_created" }`. The deal is assigned to the owner and emits `deal.created`.

### Create a task

```bash
curl -X POST https://<your-trinity>/api/v1/public/tasks \
  -H 'X-API-Key: trinity_live_…' -H 'Content-Type: application/json' \
  -d '{"column_id":12,"title":"Call back about the quote","due_at":"2026-10-20T09:00:00+07:00","priority":"high","contact_phone":"0912345678"}'
```

Fields: `column_id` (required, from `GET /public/tasks/columns`), `title` (required), `description`, `due_at` (ISO 8601), `priority` (`low`, `normal`, `high`, `urgent`), `labels` (up to 20 strings), `attributes` (values of the board's custom fields, keyed by `fields[].key` from `GET /public/tasks/columns`; required if the board has required fields), plus the same `contact_phone` / `contact_name` / `contact_source_id` as deals. The task is assigned to the owner. The column, board and required fields are checked before a new customer is created, so a rejected task leaves nothing behind.

### Create a customer

See the `POST /public/contacts` section of the API docs (`/docs` on the API server, port 4000; in production set `SWAGGER_ENABLED=true` to turn them on): `phone`, `full_name`, `source_id` are required.

## Zapier step by step

**New order in Trinity → row in Google Sheets**

1. Trigger: *Webhooks by Zapier › Catch Raw Hook*. Copy the URL.
2. Trinity: outgoing webhook with event `store_order.created`. Click *Gửi thử*, then place a test order (or wait for one) so Zapier has a sample.
3. Action: *Code by Zapier* (signature check above).
4. Action: *Filter*, continue only if `type` is `store_order.created`.
5. Action: *Google Sheets › Create Spreadsheet Row*, map `order code`, `customer_name`, `total`…

**Post failed → alert in Slack or Telegram**

1. Trigger: *Webhooks by Zapier › Catch Raw Hook*.
2. Trinity: outgoing webhook with events `social_post.published` and `social_post.failed`. Only users who can post to social channels receive these events.
3. Action: *Filter*, continue only if `type` is `social_post.failed` (or keep both and log every post to a sheet).
4. Action: *Slack › Send Channel Message*. `data` has `post_id`, `network` (`facebook`, `youtube`), `account_id`, `url` (link to the live post, or empty) and `error`.

Scheduled, queued, imported and recurring posts all send the same two events, once per channel, when they are published.

**Form submission → deal + task in Trinity**

1. Trigger: your form (Google Forms, Typeform, Facebook Lead Ads…).
2. Action: *Webhooks by Zapier › Custom Request*, method `POST`, URL `https://<your-trinity>/api/v1/public/deals`, headers `X-API-Key` and `Content-Type: application/json`, data as in the example above.
3. Optional second *Custom Request* to `/api/v1/public/tasks`.

## n8n step by step

Import a file from [`integrations/n8n/`](../../integrations/n8n), then follow the sticky note in the workflow:

| File | What it does |
|---|---|
| `don-online-moi-google-sheets.json` | Webhook `store_order.created` → verify signature → append a row to Google Sheets |
| `khach-moi-telegram.json` | Webhook `contact.created` → verify signature → Telegram message (swap the last node for Slack if you prefer) |
| `tao-don-va-viec-tu-n8n.json` | Your data → `POST /public/deals` → `POST /public/tasks` with an API key (*Header Auth* credential, name `X-API-Key`) |

Webhook triggers need a public URL: n8n Cloud has one; a self-hosted n8n needs a domain or a tunnel.
