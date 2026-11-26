//! Bảng mọi biến môi trường bản Rust biết tên (PLAN 4.13).
//!
//! Mỗi biến thuộc một trong ba loại:
//! - [`VarKind::Server`]: binary `trinity` đọc (giữ nguyên tên của bản Node; biến mới của bản Rust cũng ở đây);
//! - [`VarKind::Elsewhere`]: thuộc tiến trình khác (web Next, compose, test e2e), binary biết tên nhưng không đọc;
//! - [`VarKind::Retired`]: không còn dùng, đặt thì bị bỏ qua kèm một dòng cảnh báo lúc khởi động.
//!
//! Test bảng ở `config::tests` kiểm mọi biến trong `.env.example` có mặt ở đây.

/// Loại của một biến môi trường.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarKind {
    /// Binary `trinity` đọc.
    Server,
    /// Tiến trình khác đọc (ghi tên nơi đọc).
    Elsewhere(&'static str),
    /// Không còn dùng; đặt thì cảnh báo (ghi lý do).
    Retired(&'static str),
}

/// Một biến môi trường đã biết tên.
#[derive(Debug, Clone, Copy)]
pub struct EnvVar {
    pub name: &'static str,
    pub kind: VarKind,
}

const fn server(name: &'static str) -> EnvVar {
    EnvVar {
        name,
        kind: VarKind::Server,
    }
}
const fn elsewhere(name: &'static str, place: &'static str) -> EnvVar {
    EnvVar {
        name,
        kind: VarKind::Elsewhere(place),
    }
}
const fn retired(name: &'static str, why: &'static str) -> EnvVar {
    EnvVar {
        name,
        kind: VarKind::Retired(why),
    }
}

const WEB: &str = "web (Next.js)";
const COMPOSE: &str = "docker-compose";
const E2E: &str = "test e2e (Playwright)";

const R_REDIS: &str = "bản Rust không dùng Redis";
const R_NODE_URL: &str = "địa chỉ nội bộ của bản Node; bản Rust dùng NODE_FALLBACK_URL trong cấu hình lai";
const R_PORT: &str =
    "cổng chính đọc từ TRINITY_HTTP_PORT (mặc định 3000), cổng tương thích từ COMPAT_API_PORT (mặc định 4000)";
const R_POOL: &str = "bản Rust dùng một pool chung cho mọi công ty (DB_POOL_SIZE)";
const R_SERVERLESS: &str = "đường chạy Vercel serverless đã bỏ";
const R_BLOB: &str = "driver lưu trữ Vercel Blob đã bỏ (dùng local hoặc s3)";
const R_ELASTIC: &str = "log ra stdout dạng JSON, không đẩy Elasticsearch";
const R_GOOGLE: &str = "đồng bộ Google Sheets đã gỡ";
const R_SOCIAL: &str = "đăng bài YouTube, TikTok, Google Business, Instagram đã gỡ (chỉ còn Fanpage)";
const R_CONNECTOR: &str = "kết nối sàn và phần mềm bán hàng đã gỡ";
const R_EXT: &str = "chương trình con (extensions) đã gỡ";

/// Mọi biến đã biết tên. Thứ tự theo nhóm của `.env.example`; biến mới của bản Rust ở cuối.
pub const ENV_VARS: &[EnvVar] = &[
    // 1. Lõi
    server("NODE_ENV"),
    retired("PORT", R_PORT),
    elsewhere("POSTGRES_USER", COMPOSE),
    // Compose dựng DATABASE_URL từ đây; bản Rust chỉ đọc để chặn mật khẩu mẫu ở production.
    server("POSTGRES_PASSWORD"),
    elsewhere("POSTGRES_DB", COMPOSE),
    server("DATABASE_URL"),
    // Tên cũ của DB_POOL_SIZE, vẫn nhận khi DB_POOL_SIZE không đặt (PLAN 4.4).
    server("PRISMA_CONNECTION_LIMIT"),
    // Bản Node đọc; bản Rust chưa có cache đọc nên chưa dùng.
    elsewhere("TRINITY_DISABLE_READ_CACHE", "bản Node (cache đọc trong bộ nhớ)"),
    retired("REDIS_URL", R_REDIS),
    server("JWT_SECRET"),
    server("INTERNAL_SERVICE_SECRET"),
    server("SERVICE_SECRET"),
    server("CORS_ORIGIN"),
    // 2. Dữ liệu khởi tạo (`trinity seed`)
    server("SEED_ADMIN_EMAIL"),
    server("SEED_ADMIN_PASSWORD"),
    server("SEED_DEMO_DATA"),
    // 3. Web
    elsewhere("NEXT_PUBLIC_API_URL", WEB),
    elsewhere("NEXT_PUBLIC_REALTIME_MODE", WEB),
    retired("BACKEND_URL", R_NODE_URL),
    retired("MONOLITH_INTERNAL_URL", R_NODE_URL),
    retired("AUTH_SERVICE_URL", R_NODE_URL),
    retired("ELASTICSEARCH_URL", R_ELASTIC),
    // 4. Lưu trữ tệp
    server("STORAGE_DRIVER"),
    server("STORAGE_LOCAL_ROOT"),
    server("UPLOADS_LOCAL_ROOT"),
    server("EMPLOYEE_AVATAR_DIR"),
    server("MINIO_ENDPOINT"),
    server("MINIO_ACCESS_KEY"),
    server("MINIO_SECRET_KEY"),
    server("MINIO_BUCKET"),
    server("MINIO_REGION"),
    retired("BLOB_READ_WRITE_TOKEN", R_BLOB),
    retired("BLOB_ACCESS", R_BLOB),
    // 5. Kết nối AI, webhook, tích hợp
    server("INTEGRATIONS_WEBHOOKS_ENABLED"),
    server("INTEGRATIONS_MCP_ENABLED"),
    server("INTEGRATIONS_PUBLIC_BASE_URL"),
    server("INTEGRATIONS_SECRET_KEY"),
    server("INTEGRATIONS_MCP_ALLOWED_ORIGINS"),
    server("INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS"),
    server("INTEGRATIONS_ALLOW_PRIVATE_TARGETS"),
    retired("CRON_SECRET", R_SERVERLESS),
    server("TRINITY_PLAN_ADMIN_TOKEN"),
    retired("GOOGLE_OAUTH_CLIENT_ID", R_GOOGLE),
    retired("GOOGLE_OAUTH_CLIENT_SECRET", R_GOOGLE),
    retired("GOOGLE_OAUTH_REDIRECT_URI", R_GOOGLE),
    server("WEB_BASE_URL"),
    server("FACEBOOK_APP_ID"),
    server("FACEBOOK_APP_SECRET"),
    server("FACEBOOK_WEBHOOK_VERIFY_TOKEN"),
    server("FACEBOOK_WEBHOOK_FORWARD_URL"),
    server("FACEBOOK_GRAPH_VERSION"),
    server("FACEBOOK_COMMENT_AUTOMATION"),
    retired("GOOGLE_SOCIAL_CLIENT_ID", R_SOCIAL),
    retired("GOOGLE_SOCIAL_CLIENT_SECRET", R_SOCIAL),
    retired("TIKTOK_CLIENT_KEY", R_SOCIAL),
    retired("TIKTOK_CLIENT_SECRET", R_SOCIAL),
    retired("GOOGLE_BUSINESS_ENABLED", R_SOCIAL),
    retired("INSTAGRAM_PUBLISH_ENABLED", R_SOCIAL),
    elsewhere("LEGAL_CONTACT_EMAIL", WEB),
    elsewhere("LEGAL_COMPANY_NAME", WEB),
    elsewhere("LEGAL_COMPANY_NAME_EN", WEB),
    elsewhere("LEGAL_COMPANY_TAX_ID", WEB),
    elsewhere("LEGAL_COMPANY_ADDRESS", WEB),
    elsewhere("LEGAL_COMPANY_PHONE", WEB),
    server("ZALO_OA_APP_ID"),
    server("ZALO_OA_APP_SECRET"),
    server("ZALO_WEBHOOK_SECRET"),
    server("ZALO_OA_REDIRECT_URI"),
    server("ZALO_OA_POST_CONNECT_URL"),
    server("ZALO_ZNS_MODE"),
    elsewhere("STORE_DOMAIN", WEB),
    retired("MISA_APP_ID", R_CONNECTOR),
    retired("SHOPEE_PARTNER_ID", R_CONNECTOR),
    retired("SHOPEE_PARTNER_KEY", R_CONNECTOR),
    retired("SHOPEE_SANDBOX", R_CONNECTOR),
    retired("LAZADA_APP_KEY", R_CONNECTOR),
    retired("LAZADA_APP_SECRET", R_CONNECTOR),
    retired("EXTENSIONS_ENABLED", R_EXT),
    // 6. Lương
    server("PAYROLL_COMPANY_NAME"),
    // 7. Đăng nhập, chấm công
    server("LOGIN_WIFI_CHECK_ENABLED"),
    server("LOGIN_WIFI_CHECK_BYPASS_EMAILS"),
    server("LOGIN_WIFI_TRUST_CF_IP"),
    server("ATTENDANCE_TRUST_CF_IP"),
    server("ATTENDANCE_TRUST_PROXY_HEADERS"),
    server("LOGIN_WIFI_TRUST_PROXY_HEADERS"),
    server("SINGLE_SESSION_ENABLED"),
    // 8. Job nền
    server("LEAD_SCORING_ENABLED"),
    server("STALE_REMINDERS_ENABLED"),
    server("BRIEFING_CRON_ENABLED"),
    // 9. Serverless
    retired("TRINITY_RUNTIME", R_SERVERLESS),
    retired("TRINITY_MONOLITH_ENTRY", R_SERVERLESS),
    retired("TRINITY_TRACE_HOST_ENGINE", R_SERVERLESS),
    retired("VERCEL", R_SERVERLESS),
    // 10. Test e2e
    elsewhere("E2E_BASE_URL", E2E),
    elsewhere("E2E_ALLOW_WRITE", E2E),
    elsewhere("E2E_PHASE", E2E),
    elsewhere("E2E_WORKERS", E2E),
    elsewhere("E2E_BROWSER_CHANNEL", E2E),
    // 11. Giám sát
    server("SENTRY_DSN"),
    server("SENTRY_DSN_WEB"),
    server("SENTRY_ENVIRONMENT"),
    server("SENTRY_TRACES_SAMPLE_RATE"),
    server("TRINITY_RELEASE"),
    server("APP_ROOT"),
    server("POSTHOG_KEY"),
    server("POSTHOG_HOST"),
    server("POSTHOG_REPLAY"),
    server("MONITORING_HASH_SECRET"),
    server("SWAGGER_ENABLED"),
    // Nhiều công ty
    server("MULTI_TENANT"),
    server("SIGNUP_ENABLED"),
    server("DEFAULT_COMPANY_NAME"),
    retired("TENANT_MAX_CLIENTS", R_POOL),
    retired("TENANT_CONNECTION_LIMIT", R_POOL),
    // Biến thêm ở bản TS trước (G15)
    server("FACEBOOK_GRAPH_BASE_URL"),
    server("ZALO_OAUTH_BASE_URL"),
    server("ZALO_OPENAPI_BASE_URL"),
    server("ZALO_ZNS_BASE_URL"),
    server("SOCIAL_MAX_VIDEO_MB"),
    // Biến mới của bản Rust (PLAN 4.13, 4.14)
    server("TRINITY_HTTP_PORT"),
    server("COMPAT_API_PORT"),
    server("DB_POOL_SIZE"),
    server("WORKER_THREADS"),
    server("TLS_MODE"),
    server("TLS_CERT_FILE"),
    server("TLS_KEY_FILE"),
    server("WEB_DIR"),
    server("NODE_FALLBACK_URL"),
    server("TRINITY_OWNERSHIP_FILE"),
    server("TRINITY_RUST_ROUTES"),
    server("SHADOW_SAMPLE_RATE"),
    server("TRUSTED_PROXY"),
    server("CLOUDFLARE_IP_RANGES"),
    // Thêm ở #283 (G16a): địa chỉ nghe của API (bắt buộc 127.0.0.1 với cloudflare-tunnel) và TRUSTED_PROXY riêng của
    // container api trong Docker Compose.
    server("LISTEN_HOST"),
    elsewhere("API_TRUSTED_PROXY", COMPOSE),
    elsewhere("WEB_BIND", COMPOSE),
    elsewhere("API_PORT", COMPOSE),
    elsewhere("HOSTNAME", WEB),
    elsewhere("NODE_OPTIONS", WEB),
];

/// Tra một biến theo tên.
pub fn lookup(name: &str) -> Option<&'static EnvVar> {
    ENV_VARS.iter().find(|v| v.name == name)
}
