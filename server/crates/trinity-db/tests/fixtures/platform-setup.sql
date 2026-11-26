-- Dàn dựng chung cho ảnh chụp schema `platform` (scripts/gen-platform-fixture.cjs với mã Node, tests/platform.rs với
-- mã Rust), chạy trên một DB TRỐNG. Chỉ tạo các bảng/cột mà ensurePlatform và trigger đồng bộ đọc; schema `public`
-- thật do Prisma migrate không ảnh hưởng tới phần được chụp (platform.*, hàm và trigger trinity_platform_sync_*).
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
CREATE SCHEMA c_2;
CREATE TABLE c_2.users (LIKE public.users INCLUDING ALL);
CREATE TABLE c_2.facebook_pages (LIKE public.facebook_pages INCLUDING ALL);
CREATE TABLE c_2.zalo_oa_connections (LIKE public.zalo_oa_connections INCLUDING ALL);
CREATE TABLE c_2.settings (LIKE public.settings INCLUDING ALL);
CREATE TABLE c_2.connector_accounts (LIKE public.connector_accounts INCLUDING ALL);
-- Dữ liệu có trước trigger của công ty 1: ensurePlatform chép bù (email về chữ thường).
INSERT INTO public.users (email) VALUES ('Owner@Example.com'), ('staff@example.com');
INSERT INTO public.facebook_pages (page_id) VALUES ('page-public-1');
INSERT INTO public.zalo_oa_connections (oa_id) VALUES ('oa-public-1');
-- Sau ensurePlatform: công ty 2 (cài trigger bằng installSyncTriggers / install_sync_triggers).
