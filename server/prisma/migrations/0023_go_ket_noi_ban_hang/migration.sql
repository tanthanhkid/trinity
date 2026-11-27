-- G06: kết nối phần mềm bán hàng và sàn TMĐT đã gỡ khỏi mã (chỉ còn cổng thanh toán SePay, VNPay, MoMo).
-- Dữ liệu cũ thành LƯU TRỮ: không xoá dòng nào (`connector_records`, `connector_events` giữ nguyên), không gọi nhà cung
-- cấp (không thu hồi token, không gỡ webhook phía họ — đường webhook/push cũ của Trinity trả 410 để họ ngừng gửi).
-- Kết nối của các nhà cung cấp đó đặt `disconnected` và xoá trắng khoá đã lưu (đã mã hoá), như 0020b với Google.
-- Viết theo danh sách CÒN hỗ trợ để không phải liệt kê lại tên đã gỡ. Chạy lại nhiều lần vẫn cho cùng kết quả.
UPDATE "connector_accounts"
SET "status" = 'disconnected',
    "credentials_enc" = '',
    "last_error" = 'Trinity đã ngừng hỗ trợ kết nối này — dữ liệu đã đồng bộ được giữ làm lưu trữ.',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "provider" NOT IN ('sepay', 'vnpay', 'momo')
  AND ("status" <> 'disconnected' OR "credentials_enc" <> '' OR "last_error" IS DISTINCT FROM 'Trinity đã ngừng hỗ trợ kết nối này — dữ liệu đã đồng bộ được giữ làm lưu trữ.');
