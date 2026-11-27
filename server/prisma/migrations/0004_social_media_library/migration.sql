-- Additive only: media library for social posting. No existing table or column is touched.

-- CreateTable
CREATE TABLE "social_media_assets" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "content_type" VARCHAR(60) NOT NULL,
    "size" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'web',
    "uploaded_by" INTEGER NOT NULL,
    "hidden_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_media_assets_key_key" ON "social_media_assets"("key");

-- CreateIndex
CREATE INDEX "social_media_assets_created_idx" ON "social_media_assets"("created_at" DESC);
