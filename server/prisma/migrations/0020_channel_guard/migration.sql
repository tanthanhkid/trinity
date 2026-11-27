-- Chống lạm dụng kênh theo công ty: bộ đếm hạn mức + nhật ký sự kiện an toàn.
CREATE TABLE "channel_usage" (
    "kind" VARCHAR(32) NOT NULL,
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "channel_usage_pkey" PRIMARY KEY ("kind","bucket")
);

CREATE TABLE "channel_events" (
    "id" SERIAL NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_events_kind_id_idx" ON "channel_events"("kind", "id");

-- CreateIndex
CREATE INDEX "channel_events_created_idx" ON "channel_events"("created_at");
