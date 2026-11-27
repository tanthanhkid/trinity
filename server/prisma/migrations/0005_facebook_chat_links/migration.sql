-- AlterTable
ALTER TABLE "facebook_conversations" ADD COLUMN     "entry_link_id" INTEGER;

-- CreateTable
CREATE TABLE "facebook_chat_links" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "source_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "chats" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "facebook_chat_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facebook_chat_links_code_key" ON "facebook_chat_links"("code");

-- CreateIndex
CREATE INDEX "facebook_chat_links_page_idx" ON "facebook_chat_links"("page_id");

