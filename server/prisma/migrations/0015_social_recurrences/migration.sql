-- Bài đăng đa kênh lặp lại (hằng ngày / tuần / tháng, giờ Việt Nam).
CREATE TABLE "social_recurrences" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "template" JSONB NOT NULL,
    "rule" JSONB NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "max_count" INTEGER,
    "count" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_error" TEXT,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_recurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_recurrences_active_next_idx" ON "social_recurrences"("active", "next_run_at");
