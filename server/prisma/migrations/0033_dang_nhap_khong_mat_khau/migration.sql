-- Đăng nhập không mật khẩu (#675): mã 6 số + link một lần qua email, và liên kết tài khoản Google (OIDC).
-- Chạy cho từng công ty (schema). Chỉ lưu HMAC-SHA256 của mã/token (khoá suy từ JWT_SECRET), không lưu mã thô.

-- Một lượt gửi mã: hạn 10 phút, tối đa 5 lần nhập sai, dùng một lần (`consumed_at`), mã mới làm mã cũ mất hiệu lực
-- (`invalidated_at`). `purpose`: 'login' (đăng nhập) hoặc 'invite' (xác nhận email khi nhận lời mời `invitation_id`).
CREATE TABLE "login_challenges" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "purpose" VARCHAR(16) NOT NULL DEFAULT 'login',
    "invitation_id" INTEGER,
    "code_hash" VARCHAR(64) NOT NULL,
    "token_hash" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "login_challenges_token_hash_key" ON "login_challenges"("token_hash");
CREATE INDEX "login_challenges_email_created_at_idx" ON "login_challenges"("email", "created_at");

-- Danh tính ngoài gắn với một người dùng (hiện chỉ 'google': `subject` = claim `sub` của id_token).
CREATE TABLE "user_identities" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider", "subject");
CREATE UNIQUE INDEX "user_identities_user_id_provider_key" ON "user_identities"("user_id", "provider");

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
