-- Additive only: two new tables for Facebook Page comment automation. No existing table or column is touched.

-- CreateTable
CREATE TABLE "facebook_comments" (
    "id" BIGSERIAL NOT NULL,
    "comment_id" VARCHAR(80) NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "post_id" VARCHAR(80) NOT NULL,
    "parent_id" VARCHAR(80),
    "from_id" VARCHAR(40),
    "from_name" VARCHAR(200),
    "message" TEXT,
    "commented_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contact_id" INTEGER,
    "phone" VARCHAR(20),
    "rule_id" INTEGER,
    "status" VARCHAR(12) NOT NULL DEFAULT 'received',
    "note" VARCHAR(500),
    "actions" JSONB NOT NULL DEFAULT '{}',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_comment_rules" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "page_id" VARCHAR(40),
    "post_id" VARCHAR(80),
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclude_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "public_replies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "private_reply" TEXT,
    "hide_if_phone" BOOLEAN NOT NULL DEFAULT false,
    "once_per_user" BOOLEAN NOT NULL DEFAULT true,
    "mode" VARCHAR(8) NOT NULL DEFAULT 'test',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_comment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facebook_comments_comment_id_key" ON "facebook_comments"("comment_id");

-- CreateIndex
CREATE INDEX "facebook_comments_page_idx" ON "facebook_comments"("page_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "facebook_comments_post_from_idx" ON "facebook_comments"("post_id", "from_id");
