# Official Zalo OA + ZNS

Crate `server/crates/mod-zalo` (Zalo Official Account + ZNS). Flag/plan `zalo_oa` (organization feature gate).

## Official documentation cross-checked
- OA API overview: https://developers.zalo.me/docs/official-account
- OA OAuth v4: https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-oa — `GET https://oauth.zaloapp.com/v4/oa/permission` (app_id, redirect_uri, code_challenge S256, state); `POST https://oauth.zaloapp.com/v4/oa/access_token` (header `secret_key`, form app_id/code/grant_type/code_verifier or refresh_token). A refresh token is single-use.
- Webhook: https://developers.zalo.me/docs/official-account/webhook/tong-quan — `X-ZEvent-Signature: mac=sha256(app_id + body + timestamp + OA secret)` (xem https://developers.zalo.me/community/detail/f62243c57f8096decf91)
- Consultation message: https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-dang-van-ban — `POST https://openapi.zalo.me/v3.0/oa/message/cs`, header `access_token`, only within 48h of the customer's message.
- ZNS: https://developers.zalo.me/docs/zalo-notification-service/bat-dau/gioi-thieu — `POST https://business.openapi.zalo.me/message/template` (phone 84…, template_id, template_data, tracking_id, mode).

Note: the docs.zalo site is an SPA, so the full text cannot be read automatically; parameter details were additionally cross-checked against the RedAI community SDK and Zalo community posts. Re-verify manually against a real OA before relying on it in production.

## Prerequisites
1. `ZALO_OA_APP_ID`, `ZALO_OA_APP_SECRET` (a Zalo for Developers app linked to the OA).
2. `ZALO_WEBHOOK_SECRET` = the "OA Secret Key" ("Khoá bí mật OA"), used to sign webhooks.
3. `ZALO_OA_REDIRECT_URI` = `https://<CRM domain>/api/v1/zalo-oa/oauth/callback` — declare the same URL under App settings > Official Account > Callback URL.
4. Webhook URL declared on Zalo: `https://<CRM domain>/api/v1/zalo-oa/webhook`; enable the events user_send_*, follow, oa_send_*. Zalo requires domain verification (meta tag/file).
5. `INTEGRATIONS_SECRET_KEY` (32 byte base64) — tokens are stored encrypted; without it, connecting fails.
6. The OA id + the OA admin clicks "Kết nối Zalo OA" ("Connect Zalo OA") under Connections (Kết nối) > Zalo OA.
7. A ZNS template approved by Zalo (template_id + parameter names) and the OA's ZNS permission.
8. Optional, for tests only: `ZALO_OAUTH_BASE_URL`, `ZALO_OPENAPI_BASE_URL`, `ZALO_ZNS_BASE_URL` replace the base URLs
   (`https://oauth.zaloapp.com`, `https://openapi.zalo.me`, `https://business.openapi.zalo.me`) so calls go to a local fake
   server (only the variable of the endpoint being called is checked); `http://` is accepted only for loopback hosts
   (`localhost`, `127.0.0.1`, `::1`).

## Access model
The Zalo OA inbox is an organisation-wide shared inbox: anyone with `contacts.update` (and the `zalo_oa` organisation feature) can list and reply to every conversation, regardless of their own/team data scope on contacts. Grant `contacts.update` only to roles that should see all OA conversations.

## Saving a phone number from a message into the customer record
Inbox button «Lưu SĐT vào hồ sơ» under a customer bubble, and the MCP tool `save_phone_from_message` (see [mcp.md](mcp.md)).

- `GET /api/v1/zalo-oa/threads/:id/messages` returns `phones` on every message: the Vietnamese mobile numbers (`0xxxxxxxxx`, prefix 03/05/07/08/09) the server found in a message the CUSTOMER sent (`+84`, `84…`, spaces, dots and dashes accepted; amounts, order codes and digit runs glued to letters are ignored). Empty for outgoing messages. The web never detects numbers itself.
- `POST /api/v1/zalo-oa/threads/:id/save-phone` body `{ "message_id": "<id>", "phone": "<optional>" }`, permission `contacts.update` (same as `link`). The server re-detects the numbers in that message (the client's number is only a choice among them): `phone` is required when the message has several, and must be one of them (400 otherwise; also 400 when the message has none; 404 when the message is not an incoming message of that thread).
  - Thread not linked to a customer yet: finds the customer carrying that number, or creates one (owner = the user who clicked, source `zalo_oa`), and links the thread (`contact_id`, `phone`).
  - Thread already linked to a customer carrying that number: nothing changes (`already: true`).
  - The thread row is locked for the whole save, so two concurrent saves (or a save racing `link`) run one after the other and never relink silently. A thread linked to a customer that was deleted counts as not linked.
  - Thread linked to a customer carrying a DIFFERENT number: **409**, the number is never overwritten (change it on the customer screen).
  - Response `{ thread, contact_id, phone, created, already }`. There is no undo and no delete: a created customer stays (delete is a web-app action).
- Messenger conversations are not linked to customers (the conversation API has no `contact_id`), so the button is Zalo OA only.
