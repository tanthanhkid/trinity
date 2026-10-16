# Outgoing webhooks — guide for receivers

Trinity sends a JSON `POST` to the URL you register under **Connections (Kết nối) > Outgoing webhooks** ("Kết nối > Webhook ra") whenever an event you selected occurs.

## Format

```
POST <your url>
Content-Type: application/json
User-Agent: Trinity-Webhooks/1.0
X-Trinity-Event: contact.created
X-Trinity-Delivery: 7d1c0b9e-…            # delivery id — USE IT TO DEDUPLICATE
X-Trinity-Signature: t=1760000000,v1=<hex>
```

```json
{ "id": "7d1c0b9e-…", "type": "contact.created", "created_at": "2026-10-04T08:00:00.000Z", "data": { "contact": { … }, "origin": "manual" } }
```

`id` in the body = `X-Trinity-Delivery`. Every retry of the same event uses the **same** `id`.
Returning HTTP **2xx** (within 10 seconds) = success. Any other status, network error, timeout, or **redirect (3xx)** counts as a failure — Trinity does **not** follow redirects.

## Delivery guarantee: at-least-once

- Events may arrive **duplicated** (e.g. Trinity sent it but restarted before recording it; or you returned 2xx too slowly). The receiver **MUST** store processed `X-Trinity-Delivery` values and skip duplicates.
- **No ordering guarantee** between events (a delivery being retried may arrive after a newer event). Use `updated_at` in `data` to decide which version is newer.
- Retries: the first attempt + 6 more after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours (at most 7 attempts), then it stops (`dead`; click "Gửi lại" ("Resend") in the log to send again). An endpoint failing 20 times in a row is disabled automatically and the creator is notified.
- Events that occur while the endpoint does not exist or is disabled are **not** replayed later.

## Verifying the signature

`X-Trinity-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Use the **raw body** (the bytes received), not a parsed-and-rebuilt JSON. Reject if `t` is off by more than 5 minutes (replay protection). The secret (`whsec_…`) is shown **once**, at creation / regeneration.

Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'
export function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const t = Number(parts.t)
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
  const got = Buffer.from(parts.v1 ?? '', 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}
```

Python:

```python
import hashlib, hmac, time
def verify(secret: str, raw_body: bytes, header: str, tolerance=300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if not t or abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

## Data you receive

- `contact.*`, `deal.*` and `pos.order.completed` events carry core fields only (no address or custom fields). `custom_record.*` events carry the row's own field values.
- The payload is computed by the **permissions of the endpoint's creator (or last editor)**: only records that person can see are sent (`contacts.view` / `deals.view` / `pos.sell` by scope); phone numbers are full only if that person has `contacts.phone_full` covering that customer, otherwise masked like `***123`. A person who **changes the URL** of the endpoint (other than the creator) becomes the new "creator" — permissions follow whoever chooses where the data goes; changing events / regenerating the secret / renaming does not transfer ownership.
- If the creator is locked or loses the "Manage webhooks" permission ⇒ the endpoint is disabled automatically.

## Events

| Group | Events |
|---|---|
| Customers | `contact.created`, `contact.updated`, `contact.stage_changed`, `contact.assigned`, `contact.deleted` |
| Deals | `deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost` |
| Sales | `pos.order.completed`, `store_order.created` (new order from the online store), `payment.received` (SePay, VNPay, MoMo) |
| Custom objects | `custom_record.created`, `custom_record.updated`, `custom_record.deleted` (rows of [custom objects](../custom-objects.md)) |
| Messaging | `zalo_oa.message_received`, `zalo_oa.message_sent`, `messenger.message_received`, `messenger.message_sent`, `messenger.broadcast_finished`, `facebook.comment_received` |
| Posting | `social_post.published`, `social_post.failed` |

Plus `ping` when "Gửi thử" ("Send test") is clicked (`data: {"message":"Trinity webhook test"}`). The list the app offers comes from `packages/prisma/src/integrations/event-catalog.ts`. Using Zapier, Make or n8n: see [zapier-n8n.md](zapier-n8n.md).

## Safety limits

Only `https://` on port 443/8443, no `user:pass@`, and the hostname must resolve to a **public** IP (loopback, private networks, link-local, CGNAT, cloud metadata, internal/mapped IPv6… are blocked). Checked both at save time and on every delivery.

## Operations (admin)

Enable: `INTEGRATIONS_WEBHOOKS_ENABLED=true` + `INTEGRATIONS_SECRET_KEY` (32 bytes base64, `openssl rand -base64 32`) in `.env`, restart the monolith. **Changing/losing the key = every stored secret can no longer be decrypted** (you must "Regenerate secret" for each endpoint). A missing key while the flag is on ⇒ ERROR log, the worker does not run, the API returns 503.

---

# INCOMING webhooks — push customers into Trinity

Create a source under **Connections (Kết nối) > Incoming webhooks** ("Webhook vào"): choose the staff member who receives customers (owner), the customer source, the project (optional), and whether a signature is required. The URL with the token is shown only **once**.

```bash
curl -X POST 'https://<domain>/api/v1/hooks/in/whk_xxxxxxxx…' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Nguyen Van A","phone":"0912345678","email":"a@x.vn","note":"interested in plan A","source":"FB form","external_id":"lead-123","extra":{"utm":"x"}}'
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | 1–100 characters |
| `phone` | yes | VN phone: `0912345678`, `+84912345678`, `84912345678`, `912345678` (spaces/dots/dashes allowed) — stored as `0912345678` |
| `email`, `note` (≤2000), `source` (≤100, free-form label written to the history), `external_id` (≤128, `A-Za-z0-9._:-`), `extra` (object ≤4KB, stored in the history) | no | |

Response (JSON): always `200 {"status":"accepted","contact_id":null}` for a valid request — whether the phone is new, already a customer (of the receiving salesperson or of someone else), or the request is a resend with the same `external_id`. The response is deliberately identical so the sender cannot tell which phone numbers are already customers. (Before this change a new customer returned `201` with `contact_id`, and duplicates returned `200` with `duplicate`/`replayed`.) Trinity still creates the customer (or adds a note to the existing one) and records the outcome in the audit log; use `external_id` plus your own records if you need to correlate.

Errors: `400` bad payload · `401` missing/wrong signature · `404` wrong token/source off/feature not enabled (indistinguishable) · `413` body > 64KB · `422` the default receiver is no longer active or the customer source is disabled · `429` more than 100 requests/minute/source.

**Note on duplicate phones:** if the duplicate customer belongs to someone else (not the default receiver), Trinity only records a short trace (note truncated to 500 characters, `extra` not stored). Important sources should always send `external_id` for safe resending; a replay within 5 minutes of a signed request without `external_id` will add one more note to the duplicate customer.

**Signature (optional, recommended):** if the source has a signing secret, send `X-Trinity-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` — the same algorithm as outgoing webhooks (see the Node/Python snippets above, with the signer role reversed). A skew over 5 minutes is rejected. More than 30 wrong signatures/minute ⇒ 429 (counted separately, it does not affect the 100 requests/minute quota of a legitimate sender). **The token is in the URL, so it may leak into nginx/proxy/intermediary logs (the app masks the token in its own logs) — important sources should enable signatures; configure nginx to mask the token segment in the access log and apply `limit_req` to `/api/v1/hooks/in/`.**

The created customer emits a `contact.created` event (`origin: "webhook_in"`), so outgoing webhook endpoints receive it too.
