-- Ánh xanh vòng 2: nút «Messenger» ở hồ sơ khách gọi `GET /facebook/conversations?contact_id=` mỗi lần mở khách
-- (khách chưa từng nhắn ⇒ không có dòng nào). Chỉ mục theo khách để không quét cả bảng hội thoại.
-- Chạy lại nhiều lần cho cùng kết quả (IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS "facebook_conversations_contact_idx" ON "facebook_conversations"("contact_id", "last_message_at" DESC);
