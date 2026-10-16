# Online store

A quick storefront for small shops, built on the CRM's own product catalog. It is behind the organization feature **Trang bán hàng** (`online_store`), which is **off by default**.

## Turning it on

1. Settings › Features: turn on **Trang bán hàng**.
2. Connections (Kết nối) › **Trang bán hàng**: set the shop name and page address (for example `cua-hang-abc`), pick one of three themes and an accent colour, choose payment methods, tick the products to sell (products need a price), then switch on **Mở bán**.
3. Share `https://<your-domain>/s/<page-address>`.

## What a buyer gets

- Product grid, cart kept in the browser, checkout with name, phone and address.
- **Cash on delivery**, or **bank transfer**. Bank transfer shows a VietQR code and needs SePay to be connected. When the money arrives, SePay matches it automatically and the order turns *paid* while the buyer is still on the page.
- Prices always come from the catalog on the server. A buyer can only look up an order with its code and the phone number used to place it.
- Orders are limited to 5 per 10 minutes per IP address, and to 300 per 10 minutes per shop.

## What lands in the CRM

- The buyer is matched to a contact by phone number. If no contact has that number, a new contact is created and assigned to the person who set up the store.
- The contact history gets a line such as "Đơn online DH-7K2QXM — 290.000đ (Sách ×2) · COD".
- The orders list in the panel shows the status (new → confirmed → paid → shipping → done / cancelled).

## Subdomains

Set `STORE_DOMAIN=shop.example.com` and point a wildcard DNS record (`*.shop.example.com`) at the web app. After that, `cua-hang-abc.shop.example.com` shows the same storefront. Without `STORE_DOMAIN`, the path `/s/<name>` keeps working.
