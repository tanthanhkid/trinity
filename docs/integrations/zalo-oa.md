# Official Zalo OA + ZNS

Module `services/crm/src/zalo-oa/` (Zalo Official Account + ZNS). Flag/plan `zalo_oa` (`@RequireOrgFeature`).

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

## Access model
The Zalo OA inbox is an organisation-wide shared inbox: anyone with `contacts.update` (and the `zalo_oa` organisation feature) can list and reply to every conversation, regardless of their own/team data scope on contacts. Grant `contacts.update` only to roles that should see all OA conversations.
