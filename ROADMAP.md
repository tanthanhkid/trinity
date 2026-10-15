# Roadmap

Trinity aims to cover the whole customer loop in one place: post to bring customers in → one shared inbox → CRM record → follow-up → sell, collect payment, invoice.

How well each channel and connector has been tested is tracked in [docs/integrations/status.md](docs/integrations/status.md).

## Done
- [x] Built-in AI control: connect ChatGPT, Claude, Gemini, Cursor or any MCP client and work within the user's permissions
- [x] CRM: contacts, Kanban pipelines, record codes and `@` links, newsfeed; sales, POS, HR, reports, roles and data scopes
- [x] Multi-channel posting to Facebook Pages and YouTube, with scheduling, a content calendar, a media library and post stats
- [x] Facebook comment automation: auto-replies, hiding phone numbers, private replies
- [x] Chat links and QR codes that open a conversation, Messenger flows with a Get Started button
- [x] Messenger inbox and broadcasts that respect the 24-hour messaging window
- [x] Zalo Official Account inbox and ZNS notifications (official API)
- [x] Outgoing webhooks
- [x] Manual replies to Facebook comments and an "awaiting reply" view across Messenger, comments and Zalo OA
- [x] Payment requests with bank-transfer QR auto-matched by SePay, and VNPay / MoMo payment links
- [x] Sales and accounting connectors: KiotViet, Sapo, WooCommerce, MISA, Shopee, Lazada (status per connector in [docs/integrations/status.md](docs/integrations/status.md))
- [x] Polished forms, settings tabs, connection rows, inbox and posting screens
- [x] Online store MVP (off by default): a storefront at `/s/<name>` or a subdomain, three themes, cart, cash on delivery or bank-transfer QR, orders and customers land in the CRM

## In progress
- [ ] Instagram posting (code ready, waiting for Meta App Review)
- [ ] iPOS connector (waiting for iPOS to publish its partner API)

## Next
- [ ] Instagram direct messages (after Meta grants the messaging permission)
- [ ] Marketplace of community add-ons
- [ ] Anonymous, opt-in usage stats (off by default, see [PRIVACY.md](PRIVACY.md))
- [ ] Upgrade NestJS 10 → 11 and Prisma 6 → 7 (clears the remaining dependency alerts that need a major version: `@nestjs/core`, `file-type`, `deepmerge-ts`)

## Not planned
- TikTok direct messages (no public messaging API in Vietnam)
- X / Twitter (paid API)
- Personal Zalo accounts (no official API)

Have an idea? Post it in [Discussions › Ideas](../../discussions/categories/ideas).
