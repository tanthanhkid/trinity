# Integration test status

How far each channel and connector has been tested. We only mark something "tested with a real account" after it worked end to end against the live platform.

| Level | Meaning |
|---|---|
| **Tested with a real account** | Worked end to end against the live platform (date shown) |
| **Tested in sandbox / simulated webhooks only** | Unit tests with the platform's official samples, or the platform's sandbox; never run against a live account |
| **Not tested — no account yet** | Code exists, but we have no account to try it with |
| **Waiting for platform approval** | Code ready; the platform has to approve the app before real accounts can connect |
| **Ready — not yet tried with a real account** | The connector is in the open-source code and works against the platform's documented API or sandbox, but nobody has run it with a live account yet. Use it, and tell us how it goes |

The same label shows next to each item on **Settings › Connections** in the app.

## Channels

| Channel | Status | Notes |
|---|---|---|
| Facebook Page — posting | Tested with a real account (2026-10-13) | |
| Facebook Messenger — inbox, replies, broadcasts | Tested with a real account (2026-10-13) | Pages owned by the app's developers; other Pages wait for Meta App Review |
| Facebook comments — auto-replies, hide phone numbers | Tested with a real account (2026-10-13) | |
| Facebook comments — manual replies | Tested in sandbox / simulated webhooks only | Public reply and one private reply per comment within 7 days |
| YouTube — video upload | Tested with a real account (2026-10-13) | |
| Zalo Official Account — connect, incoming messages | Tested with a real account (2026-10-15) | OAuth connection; a real user's message reached the CRM through the webhook and opened a conversation |
| Zalo Official Account — replies (consultation messages), sender profile | Ready — not yet tried with a real account (needs a paid Zalo OA Tier plan) | Zalo rejects both on the free OA plan: the OA has to upgrade its Zalo OA Tier package. Without the profile, conversations have no name or phone and are not matched to contacts automatically (they can be linked by hand) |
| Zalo ZNS | Not tested — no account yet | Needs approved ZNS templates |
| Instagram — posting | Ready — not yet tried with a real account | Unit tests only. Needs Meta App Review before other accounts can connect |
| Instagram — direct messages | Not built yet | See [ROADMAP](../../ROADMAP.md) |
| TikTok — video posting | Ready — not yet tried with a real account | Unit tests with TikTok's documented payloads. Needs TikTok production approval; the app review has not been submitted yet |
| Google Business Profile — updates, reviews | Ready — not yet tried with a real account | Code ready (`google-business.provider.ts`, tests with Google's documented payloads): each location is a channel, business updates with one photo, Google reviews in the inbox with public replies. Google's API quota is 0 until it approves Basic API Access — applied for on 2026-10-15; Google answers in 7–10 business days. Switched on with `GOOGLE_BUSINESS_ENABLED=true` |

## Connectors

| Connector | Status | Notes |
|---|---|---|
| SePay | Ready — not yet tried with a real account | Bank-transfer payment requests with VietQR code; incoming transfers auto-matched by code and amount (webhook, `Authorization: Apikey`). Tested with SePay's official sample payload, not yet with a live account. |
| KiotViet | Ready — not yet tried with a real account | Customers, orders, invoices and products: key check through a real token request, webhooks registered automatically (`X-Hub-Signature` HMAC-SHA256 plus a secret URL token), incremental sync by `lastModifiedFrom`; customers matched to CRM contacts by phone, new orders logged on the contact. Tested with payloads built from KiotViet's public API documentation; not yet run against a KiotViet store. |
| Sapo | Ready — not yet tried with a real account | Customers, orders and products through a private app (Basic auth to `{store}.mysapo.net/admin`): key check on connect, webhooks registered automatically, incremental sync by `modified_on_min`. Webhooks are authenticated by a secret URL token (plus HMAC when Sapo sends one) and the record is re-read from the Sapo API before it is stored. Tested with sample payloads; not yet run against a Sapo store. |
| MISA | Ready — not yet tried with a real account | AMIS Kế toán ACT Open API: customers (accounting objects) and inventory items via `get_dictionary`, incremental by `last_sync_time`; the customer pastes an access code from AMIS. Needs a partner `MISA_APP_ID` that MISA issues to Trinity on registration — until it is set the app shows "server not configured". Invoices and receivables are not in the public read API we found. Tested with response shapes taken from working open-source clients. |
| VNPay | Tested in sandbox / simulated webhooks only | Tested end to end on the VNPay sandbox (2026-10-15): payment link → NCB test card → OTP → return page verified VNPay's signature, and VNPay's own IPN call marked the request paid within seconds (a repeated IPN answers 02). Not yet tested with a live merchant. |
| MoMo | Tested in sandbox / simulated webhooks only | Payment link per request (captureWallet, HMAC-SHA256). Creating a payment was accepted by the MoMo test environment with its public test keys (2026-10-15); IPN checked with signed samples. Not yet tested with a live merchant. |
| iPOS | Not built yet | No code yet. iPOS.vn publishes no public API; waiting for iPOS to provide its partner API documentation. |
| WooCommerce | Tested in sandbox / simulated webhooks only | Tested with a test WooCommerce store (WordPress Playground + WooCommerce, fake data, reached over a public HTTPS tunnel, 2026-10-15): REST keys accepted, first sync pulled customers/products/orders, Trinity registered 9 webhooks, a new order reached the CRM through WooCommerce's real webhook within seconds, disconnect removed the webhooks. Wrong secret and internal addresses are rejected. Not yet run against a merchant's live shop. |
| Shopee | Ready — not yet tried with a real account | Open Platform v2: the shop owner authorizes on Shopee (signed `state`), tokens refreshed automatically; orders synced by `update_time` in 15-day windows and on push (code 3), push verified by `Authorization` = HMAC(partner_key, url\|body). Needs Trinity's Shopee partner app (`SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY`). Buyer chat is not available: Shopee opens the chat API only to approved partners. Buyer phone numbers are masked by Shopee, so orders usually are not matched to contacts. No real shop yet; signatures checked against an independent implementation of the documented formula. |
| Lazada | Ready — not yet tried with a real account | Open Platform: the seller authorizes on Lazada (signed `state`), tokens refreshed automatically; orders and items synced by `update_after` and on push (message_type 0), push verified by `Authorization` = HMAC(app_secret, app_key + body). Needs Trinity's Lazada app (`LAZADA_APP_KEY`/`LAZADA_APP_SECRET`). Buyer chat (IM) needs a separate Lazada permission — not built. No real shop yet; signatures checked against an independent implementation of the documented formula. |
| n8n | Tested in sandbox / simulated webhooks only | No marketplace app: outgoing webhooks + public API with an API key ([guide](zapier-n8n.md), sample n8n workflows in `integrations/n8n`). Tested 2026-10-15 with n8n 2.43 running locally behind a public HTTPS tunnel against the test server: an API key created a deal (with a new customer by phone) and a Kanban task linked to the same customer; Trinity's outgoing webhooks delivered `ping`, `contact.created` and `store_order.created`, the n8n workflows verified the signature and parsed the order; a forged signature was rejected. Zapier steps are written from Zapier's generic Webhooks/Code apps and not yet run in a Zapier account. |
| Zapier, Make | Ready — not yet tried with a real account | Same webhooks and API key as n8n ([guide](zapier-n8n.md)); the Zapier steps are written from Zapier's generic Webhooks/Code apps |

Every pull request that adds or changes a connector updates this table.
