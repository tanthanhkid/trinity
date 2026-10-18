-- SPIKE (nhánh spike/rls-tenant, PR draft — KHÔNG deploy): nhiều khách thuê trên một DB bằng Postgres Row-Level Security.
-- Phạm vi: tenants + 6 bảng (contacts, activities, deals, facebook_pages, facebook_conversations, facebook_messages).
--
-- Cách chặn:
--   * Mỗi bảng có `tenant_id uuid NOT NULL DEFAULT trinity_current_tenant()` — app không cần truyền khi INSERT.
--   * ENABLE + FORCE ROW LEVEL SECURITY, một policy cho mọi lệnh: USING + WITH CHECK `tenant_id = trinity_current_tenant()`.
--   * `trinity_current_tenant()` đọc `app.tenant_id` (đặt bằng `set_config('app.tenant_id', $1, true)` = SET LOCAL trong
--     transaction). Chưa đặt ⇒ NULL ⇒ đọc ra 0 dòng, INSERT vỡ NOT NULL / WITH CHECK (fail closed).
--   * Role app phải là role thường (không SUPERUSER, không BYPASSRLS). Superuser và role có BYPASSRLS bỏ qua mọi policy,
--     kể cả FORCE — migration chạy bằng role đó (chủ bảng) nên backfill phía dưới không bị chặn.

-- 1. Bảng khách thuê + tenant mặc định cho dữ liệu đang có.
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
INSERT INTO "tenants" ("id", "slug", "name") VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Mặc định');

-- 2. Tenant của transaction hiện tại. '' (biến đã từng SET LOCAL trên kết nối pool rồi hết transaction) cũng coi là chưa đặt.
CREATE OR REPLACE FUNCTION trinity_current_tenant() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- 3. Thêm cột, backfill tenant mặc định, rồi mới NOT NULL + DEFAULT.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'activities', 'deals', 'facebook_pages', 'facebook_conversations', 'facebook_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN "tenant_id" UUID', t);
    EXECUTE format('UPDATE %I SET "tenant_id" = %L', t, '00000000-0000-0000-0000-000000000001');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "tenant_id" SET NOT NULL, ALTER COLUMN "tenant_id" SET DEFAULT trinity_current_tenant()', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT', t, t || '_tenant_fkey');
    EXECUTE format('CREATE INDEX %I ON %I ("tenant_id")', t || '_tenant_idx', t);
  END LOOP;
END $$;

-- 4. Mã chung (KH001, DL001) duy nhất TRONG một tenant. Dãy số vẫn dùng chung sequence (tenant mới có mã nhảy cóc —
--    xem mục "chỗ vỡ" của PR). Khoá ngoài từ hệ thống ngoài (page_id+psid, mid của Meta) giữ duy nhất toàn cục:
--    một Page chỉ nối vào một tenant.
DROP INDEX IF EXISTS "contacts_code_uq";
CREATE UNIQUE INDEX "contacts_code_uq" ON "contacts"("tenant_id", "code" varchar_pattern_ops);
DROP INDEX IF EXISTS "deals_code_uq";
CREATE UNIQUE INDEX "deals_code_uq" ON "deals"("tenant_id", "code" varchar_pattern_ops);

-- 5. Khoá ngoài cùng tenant: kiểm FK chạy NGOÀI RLS, nên chỉ FK theo id thì tenant A gắn được activity/deal vào
--    contact của tenant B (đoán id). FK ghép (tenant_id, contact_id) chặn việc đó ở DB.
CREATE UNIQUE INDEX "contacts_tenant_id_id_key" ON "contacts"("tenant_id", "id");
ALTER TABLE "activities" ADD CONSTRAINT "activities_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON UPDATE CASCADE;

-- 6. RLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'activities', 'deals', 'facebook_pages', 'facebook_conversations', 'facebook_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenant_id" = trinity_current_tenant()) WITH CHECK ("tenant_id" = trinity_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "tenants" FOR SELECT USING ("id" = trinity_current_tenant());

-- 7. Định tuyến webhook: Meta chỉ gửi page_id, lúc đó chưa biết tenant ⇒ chưa đọc được facebook_pages (RLS).
--    Hàm SECURITY DEFINER trả ĐÚNG một uuid. Chủ hàm (role migration) phải bỏ qua được RLS (superuser/BYPASSRLS),
--    nếu không hàm cũng bị FORCE RLS lọc và luôn trả NULL.
CREATE OR REPLACE FUNCTION trinity_tenant_for_facebook_page(p_page_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM facebook_pages WHERE page_id = p_page_id AND is_active LIMIT 1
$$;
REVOKE ALL ON FUNCTION trinity_tenant_for_facebook_page(text) FROM PUBLIC;
