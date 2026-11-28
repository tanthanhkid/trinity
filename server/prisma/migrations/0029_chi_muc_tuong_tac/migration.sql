-- Tốc độ vòng 3: màn Tương tác (Hộp thư) đọc `GET /interactions` (sắp theo thời gian, LIMIT 60) và `/interactions/stats`
-- (đếm theo ngày) trên ba bảng chưa có chỉ mục theo thời gian ⇒ quét/sắp cả bảng, chậm dần khi bình luận/tin nhắn nhiều.
-- Chạy lại nhiều lần cho cùng kết quả (IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS "facebook_comments_commented_idx" ON "facebook_comments"("commented_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "facebook_messages_in_sent_idx" ON "facebook_messages"("sent_at") WHERE "direction" = 'in';
CREATE INDEX IF NOT EXISTS "zalo_oa_messages_in_created_idx" ON "zalo_oa_messages"("created_at") WHERE "direction" = 'in';
