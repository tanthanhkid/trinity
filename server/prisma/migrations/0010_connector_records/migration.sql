-- Bản ghi đồng bộ từ phần mềm bán hàng / sàn (KiotViet, Sapo…).
CREATE TABLE "connector_records" (
    "id" SERIAL NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "account" VARCHAR(80) NOT NULL DEFAULT '',
    "kind" VARCHAR(16) NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "code" VARCHAR(64),
    "name" VARCHAR(255),
    "contact_id" INTEGER,
    "amount" BIGINT,
    "status" VARCHAR(40),
    "data" JSONB NOT NULL DEFAULT '{}',
    "external_updated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "connector_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "connector_records_provider_account_kind_external_id_key" ON "connector_records"("provider", "account", "kind", "external_id");
CREATE INDEX "connector_records_kind_external_updated_at_idx" ON "connector_records"("kind", "external_updated_at");
CREATE INDEX "connector_records_contact_id_idx" ON "connector_records"("contact_id");
