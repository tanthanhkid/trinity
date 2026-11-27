-- CreateTable
CREATE TABLE "facebook_flows" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "trigger" VARCHAR(16) NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "chat_link_id" INTEGER,
    "steps" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "starts" INTEGER NOT NULL DEFAULT 0,
    "completes" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "facebook_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_flow_runs" (
    "id" SERIAL NOT NULL,
    "flow_id" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "step_id" VARCHAR(16),
    "status" VARCHAR(16) NOT NULL,
    "due_at" TIMESTAMPTZ(3),
    "note" VARCHAR(300),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "facebook_flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facebook_flows_page_idx" ON "facebook_flows"("page_id", "is_active");

-- CreateIndex
CREATE INDEX "facebook_flow_runs_conv_idx" ON "facebook_flow_runs"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "facebook_flow_runs_due_idx" ON "facebook_flow_runs"("status", "due_at");

-- CreateIndex
CREATE INDEX "facebook_flow_runs_flow_idx" ON "facebook_flow_runs"("flow_id", "started_at" DESC);

