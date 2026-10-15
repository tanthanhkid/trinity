-- Khung giờ đăng hàng đợi hằng tuần (giờ Việt Nam).
CREATE TABLE "social_queue_slots" (
    "id" SERIAL NOT NULL,
    "weekday" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_queue_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_queue_slots_weekday_minute_key" ON "social_queue_slots"("weekday", "minute");

-- Nháp chọn "Vào hàng đợi": khi đăng lấy khung trống gần nhất (không lưu giờ cụ thể).
ALTER TABLE "social_drafts" ADD COLUMN "use_queue" BOOLEAN NOT NULL DEFAULT false;
