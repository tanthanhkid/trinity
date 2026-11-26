-- Lời mời nhân viên bằng link (SaaS nhiều công ty): chủ công ty tạo link, người được mời mở link đặt tên + mật khẩu.
-- Chỉ THÊM bảng; token chỉ lưu dạng băm (SHA-256), link gốc chỉ hiện đúng lúc tạo.
CREATE TABLE "user_invitations" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "role_id" INTEGER,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_user_id" INTEGER,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_invitations_token_hash_key" ON "user_invitations"("token_hash");
CREATE INDEX "user_invitations_email_idx" ON "user_invitations"("email");

-- Bỏ ràng buộc "mỗi công ty đúng một người dùng" (trigger do ensurePlatform/provisionCompany dựng ở các schema công ty ≥ 2).
-- Giới hạn số người nay do máy chủ kiểm theo `maxUsers` của gói. Schema nào không có trigger thì lệnh này không làm gì.
DROP TRIGGER IF EXISTS trinity_single_user ON "users";
DROP FUNCTION IF EXISTS trinity_single_user();
