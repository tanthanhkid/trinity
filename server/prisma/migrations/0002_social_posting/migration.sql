-- Additive only: three new tables for multi-channel posting. No existing table or column is touched.

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" SERIAL NOT NULL,
    "network" VARCHAR(16) NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "avatar_url" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_error" VARCHAR(500),
    "connected_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_posts" (
    "id" SERIAL NOT NULL,
    "content" TEXT NOT NULL,
    "media" JSONB NOT NULL DEFAULT '[]',
    "scheduled_at" TIMESTAMPTZ(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'scheduled',
    "source" VARCHAR(80) NOT NULL DEFAULT 'web',
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_post_targets" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "network" VARCHAR(16) NOT NULL,
    "caption" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(3),
    "external_post_id" VARCHAR(120),
    "url" TEXT,
    "last_error" VARCHAR(500),
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_post_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_network_external_uniq" ON "social_accounts"("network", "external_id");

-- CreateIndex
CREATE INDEX "social_posts_scheduled_idx" ON "social_posts"("scheduled_at");

-- CreateIndex
CREATE INDEX "social_posts_created_idx" ON "social_posts"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "social_post_targets_post_account_uniq" ON "social_post_targets"("post_id", "account_id");

-- CreateIndex
CREATE INDEX "social_post_targets_status_next_idx" ON "social_post_targets"("status", "next_attempt_at");
