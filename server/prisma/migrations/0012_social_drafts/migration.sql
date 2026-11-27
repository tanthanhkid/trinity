-- Bài nháp đăng đa kênh.
CREATE TABLE "social_drafts" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(120),
    "content" TEXT NOT NULL DEFAULT '',
    "media" JSONB NOT NULL DEFAULT '[]',
    "targets" JSONB NOT NULL DEFAULT '[]',
    "scheduled_at" TIMESTAMPTZ(3),
    "ui" JSONB,
    "post_id" INTEGER,
    "publishing_at" TIMESTAMPTZ(3),
    "source" VARCHAR(80) NOT NULL DEFAULT 'web',
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_drafts_user_updated_idx" ON "social_drafts"("created_by", "updated_at" DESC);
