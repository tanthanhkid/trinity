# Quyết định của chủ dự án cho các câu hỏi mở (26/11/2026)

1. **Vercel serverless: bỏ hẳn.** Gỡ đường deploy Vercel khỏi README/docs/mã (TRINITY_RUNTIME=serverless, scripts/vercel, handleWithNest…).
2. **Webhook ra/vào + API key công khai: giữ** (nền cho n8n/Zapier).
3. **Instagram: gỡ.**
4. **Trang bán hàng online: GIỮ, nhưng không cần cổng thanh toán.** Thanh toán = hiển thị mã QR chuyển khoản (VietQR tĩnh theo số tài khoản + số tiền + nội dung đơn) và COD; không gọi VNPay/MoMo/SePay, không tự khớp tiền.
5. **Không chạy script ngắt webhook / thu hồi token phía nhà cung cấp** trước khi gỡ mã — chỉ gỡ mã, dữ liệu cũ thành lưu trữ như plan.
6. **Đóng băng tính năng mới backend TS** trong lúc chuyển (chỉ sửa lỗi).
7. **Máy 1 GB: cố gắng**; chuẩn bắt buộc là 2 GB.
8. **TLS: đứng sau Cloudflare** (proxy Cloudflare; origin dùng Cloudflare Origin Certificate hoặc Cloudflare Tunnel) — binary Rust không tự xin chứng chỉ.
- Q5 gói `ket_noi` hết tính năng riêng, Q8 log Elasticsearch: theo đề xuất trong plan.
