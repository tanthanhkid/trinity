-- Khung connector chung (SePay, VNPay, MoMo…) + yêu cầu thanh toán tự khớp.
CREATE TABLE "connector_accounts" (
    "id" SERIAL NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "credentials_enc" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_error" VARCHAR(300),
    "last_event_at" TIMESTAMPTZ(3),
    "connected_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "connector_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "connector_accounts_provider_key" ON "connector_accounts"("provider");

CREATE TABLE "connector_events" (
    "id" SERIAL NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "external_id" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "amount" BIGINT,
    "content" VARCHAR(500),
    "reference" VARCHAR(100),
    "status" VARCHAR(16) NOT NULL,
    "payment_intent_id" INTEGER,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "connector_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "connector_events_provider_external_id_key" ON "connector_events"("provider", "external_id");
CREATE INDEX "connector_events_status_created_at_idx" ON "connector_events"("status", "created_at");

CREATE TABLE "payment_intents" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "amount" BIGINT NOT NULL,
    "description" VARCHAR(200),
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "source_type" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "source_id" INTEGER,
    "contact_id" INTEGER,
    "paid_amount" BIGINT,
    "paid_via" VARCHAR(32),
    "paid_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_intents_code_key" ON "payment_intents"("code");
CREATE INDEX "payment_intents_status_created_at_idx" ON "payment_intents"("status", "created_at");
CREATE INDEX "payment_intents_source_type_source_id_idx" ON "payment_intents"("source_type", "source_id");
