-- Bộ hashtag và chữ ký dùng lại khi soạn bài đăng đa kênh.
CREATE TABLE "social_snippets" (
    "id" SERIAL NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "content" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_snippets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_snippets_kind_position_idx" ON "social_snippets"("kind", "position");
