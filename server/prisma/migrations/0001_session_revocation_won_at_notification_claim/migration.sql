-- Additive only: new nullable columns and one new table. No existing column is dropped or retyped.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "tokens_valid_after" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "deals" ADD COLUMN "won_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN "webhook_url" TEXT,
ADD COLUMN "claimed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "revoked_sessions" (
    "session_id" VARCHAR(64) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE INDEX "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "revoked_sessions_user_id_idx" ON "revoked_sessions"("user_id");

-- CreateIndex
CREATE INDEX "deals_status_won_at_idx" ON "deals"("status", "won_at");
