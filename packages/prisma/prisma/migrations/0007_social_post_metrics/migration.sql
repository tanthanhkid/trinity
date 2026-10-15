-- Số liệu bài đã đăng (lượt xem, cảm xúc, bình luận, chia sẻ) lấy định kỳ từ mạng.
ALTER TABLE "social_post_targets" ADD COLUMN "metrics" JSONB;
ALTER TABLE "social_post_targets" ADD COLUMN "metrics_at" TIMESTAMPTZ(3);
