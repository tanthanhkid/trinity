-- G07b: cổng thanh toán SePay, VNPay, MoMo đã gỡ khỏi mã (webhook/IPN/return của Trinity trả 410).
-- Dữ liệu cũ thành LƯU TRỮ: không xoá dòng nào (`payment_intents`, `connector_events`, `connector_accounts` giữ nguyên),
-- không gọi nhà cung cấp (không gỡ webhook/IPN phía họ). Kết nối đặt `disconnected` và xoá trắng khoá đã lưu (đã mã hoá),
-- như 0020b với Google và 0023 với kênh bán hàng. Chạy lại nhiều lần vẫn cho cùng kết quả.
UPDATE "connector_accounts"
SET "status" = 'disconnected',
    "credentials_enc" = '',
    "last_error" = 'Trinity đã ngừng hỗ trợ cổng thanh toán này — dữ liệu đã nhận được giữ làm lưu trữ.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "provider" IN ('sepay', 'vnpay', 'momo')
  AND ("status" <> 'disconnected' OR "credentials_enc" <> '' OR "last_error" IS DISTINCT FROM 'Trinity đã ngừng hỗ trợ cổng thanh toán này — dữ liệu đã nhận được giữ làm lưu trữ.');
