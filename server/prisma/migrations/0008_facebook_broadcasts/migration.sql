-- Gửi tin hàng loạt qua Messenger (chỉ khách còn trong cửa sổ 24h).
CREATE TABLE "facebook_broadcasts" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "text" TEXT NOT NULL,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMPTZ(3),
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "source" VARCHAR(20) NOT NULL DEFAULT 'web',
    "created_by" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "facebook_broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "facebook_broadcasts_status_idx" ON "facebook_broadcasts"("status", "scheduled_at");

CREATE TABLE "facebook_broadcast_recipients" (
    "id" SERIAL NOT NULL,
    "broadcast_id" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "note" VARCHAR(300),
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    CONSTRAINT "facebook_broadcast_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "facebook_broadcast_recipients_uniq" ON "facebook_broadcast_recipients"("broadcast_id", "conversation_id");
CREATE INDEX "facebook_broadcast_recipients_status_idx" ON "facebook_broadcast_recipients"("broadcast_id", "status");
