-- Đơn từ trang bán hàng online.
CREATE TABLE "store_orders" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'new',
    "customer_name" VARCHAR(120) NOT NULL,
    "customer_phone" VARCHAR(20) NOT NULL,
    "customer_address" VARCHAR(300),
    "note" VARCHAR(500),
    "items" JSONB NOT NULL DEFAULT '[]',
    "total" BIGINT NOT NULL,
    "payment_method" VARCHAR(16) NOT NULL,
    "payment_intent_id" INTEGER,
    "contact_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_orders_code_key" ON "store_orders"("code");
CREATE INDEX "store_orders_status_created_at_idx" ON "store_orders"("status", "created_at");
