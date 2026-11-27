-- G12b: trạng thái bảo mật phải sống qua khởi động lại và tin NOTIFY bị mất (không chỉ nằm trong RAM).
CREATE TABLE "token_blacklist" (
    "user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_blacklist_pkey" PRIMARY KEY ("user_id")
);
CREATE INDEX "token_blacklist_expires_at_idx" ON "token_blacklist"("expires_at");

CREATE TABLE "active_sessions" (
    "user_id" INTEGER NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "active_sessions_pkey" PRIMARY KEY ("user_id")
);
