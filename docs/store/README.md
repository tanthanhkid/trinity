# Online store

A quick storefront for small shops, built on the CRM's own product catalog. It is behind the organization feature **Trang bán hàng** (`online_store`), which is **off by default**.

## Turning it on

1. Settings › Features: turn on **Trang bán hàng**.
2. Connections (Kết nối) › **Trang bán hàng**: set the shop name and page address (for example `cua-hang-abc`), pick one of three themes and an accent colour, choose payment methods, tick the products to sell (products need a price), then switch on **Mở bán**.
3. Share `https://<your-domain>/s/<page-address>`.

## What a buyer gets

- Product grid, cart kept in the browser, checkout with name, phone and address.
- **Cash on delivery**, or **bank transfer**. For bank transfer the shop picks its bank and enters the account number (and holder name) in the store settings; no payment gateway or connection is needed. After ordering, the buyer sees a VietQR code with the account, the amount and the order code as the transfer note already filled in. The QR string is built on the server (EMVCo/NAPAS format, `server/crates/mod-pos/src/vietqr.rs`) and drawn in the browser; no outside QR service is called.
- Money is not matched automatically: the order stays *new* until staff see the money in their account and set the order to *paid* (orders list, or `PATCH /store/orders/:id`). The buyer's page checks every 15 seconds for up to an hour and then shows a "Kiểm tra lại" (check again) button. Any status other than *new* is final on that page with its own message (paid, confirmed, shipping, done); a cancelled order says so and no longer shows the QR code.
- Every status change sends the outgoing webhook `store_order.status_changed`, and `store_order.paid` when the order becomes paid (see [webhooks](../integrations/webhooks.md)).
- AI assistants can read and change these settings, bank account included, with the MCP tools `get_store_settings` and `update_store_settings` (publishing needs the user's confirmation; there is no delete tool).
- Prices always come from the catalog on the server. A buyer can only look up an order with its code and the phone number used to place it.
- Orders are limited to 5 per 10 minutes per IP address, and to 300 per 10 minutes per shop.

## Upgrading from the SePay version

Earlier versions needed SePay for bank transfer. Migration `0022_store_vietqr` copies the bank and account number from the old SePay settings into the store settings (the bank name such as `MBBank` or `Vietcombank` is mapped to its NAPAS BIN). When it cannot (no SePay connection, unknown bank name), bank transfer is turned off, cash on delivery keeps working, and the store settings show a reminder to enter the account. Bank-transfer orders already waiting under the SePay flow stay as they are; staff confirm them by hand.

## What lands in the CRM

- The buyer is matched to a contact by phone number. If no contact has that number, a new contact is created and assigned to the person who set up the store.
- The contact history gets a line such as "Đơn online DH-7K2QXM — 290.000đ (Sách ×2) · COD".
- The orders list in the panel shows the status (new → confirmed → paid → shipping → done / cancelled).

## Subdomains

Set `STORE_DOMAIN=shop.example.com` and point a wildcard DNS record (`*.shop.example.com`) at the web app. After that, `cua-hang-abc.shop.example.com` shows the same storefront. Without `STORE_DOMAIN`, the path `/s/<name>` keeps working.
