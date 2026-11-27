-- G03: đồng bộ Google Sheets đã gỡ. Xoá token OAuth Google đã lưu (đã mã hoá) để không còn bí mật nằm lại trong DB.
-- KHÔNG gọi thu hồi ra Google; tài khoản Google tự thấy ứng dụng không còn dùng. Bảng giữ làm lưu trữ, không DROP.
-- Chạy lại nhiều lần không sao.
ALTER TABLE "google_connections" ALTER COLUMN "refresh_token_enc" DROP NOT NULL;
UPDATE "google_connections"
SET "refresh_token_enc" = NULL, "access_token_enc" = NULL, "token_expires_at" = NULL
WHERE "refresh_token_enc" IS NOT NULL OR "access_token_enc" IS NOT NULL OR "token_expires_at" IS NOT NULL;
