//! Health, cấu hình telemetry, build id, cấu hình trang và tài liệu API (K27, PLAN 4.12, 4.10 và mục "web đọc cấu hình lúc chạy").
//!
//! - `GET /api/v1/health`, `/ready`, `/live`: gộp 5 bộ health trùng đường dẫn của 5 service cũ thành một. Trong monolith Nest
//!   `AuthModule` đứng đầu nên bản TS thực sự trả `service: "auth-service"`; giữ nguyên.
//! - `GET /api/v1/telemetry/config` (public) và `/identity` (đăng nhập): giữ hình dạng của `telemetry-config.ts`; `identity` trả mã
//!   người dùng băm HMAC (không bao giờ id thật; id công ty khác 1 băm kèm công ty như `tenantKey`).
//! - `GET /api/v1/site-config` (public, **chỉ có ở Rust**): thông tin pháp lý và cờ lúc chạy (`realtime_mode`, `ds_v2`) để một binary
//!   dùng được cho nhiều bản cài (W03 đọc từ đây thay cho biến lúc build). Route này thuộc đợt a trong tệp sở hữu
//!   (`server/contracts/ownership-wave-a.json`, chỉ các route dưới `/api/v1`; `/api/build-id` còn do Next và `/docs` do Node phục vụ tới khi nhả); không có trong `routes.json` nên được liệt kê ở `trinity_http::router::check::RUST_ONLY_ROUTES`.
//! - `POST /api/fe-logging` (public, ngoài `/api/v1`): nhận lỗi frontend, xem [`fe_logging`].
//! - `GET /api/build-id` (ngoài `/api/v1`): `{"buildId": …}` với `Cache-Control: no-store, must-revalidate`; mã lấy từ
//!   `TRINITY_BUILD_ID` lúc chạy, rồi lúc biên dịch (`TRINITY_BUILD_ID` khi build), rồi `"unknown"` (client bỏ qua, không bật cảnh báo nhầm).
//! - `GET /docs` và `/docs-json`: tài liệu OpenAPI do `utoipa` sinh, chỉ khi ngoài production hoặc `SWAGGER_ENABLED=true`
//!   (cùng điều kiện `bootstrap-app.ts`); ngoài ra 404.
//!
//! `declared_routes()` của `trinity-bin` lấy [`routes`]; chưa có `serve` để lắp, nên `api_router`/`extra_router` được test ở đây.

pub mod bootstrap;
pub mod fe_logging;
pub mod kanban_overview;
pub mod retired;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Extension, Request};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use serde_json::{Map, Number, Value, json};
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_obs::log::UserIdHasher;
use trinity_obs::resolve_release;
use utoipa::OpenApi;

const BUILD_ID_COMPILED: Option<&str> = option_env!("TRINITY_BUILD_ID");

/// Mọi cấu hình đọc một lần lúc khởi động từ biến môi trường.
#[derive(Debug, Clone)]
pub struct SystemConfig {
    telemetry: Value,
    hasher: Option<UserIdHasher>,
    site: Value,
    build_id: String,
    docs_enabled: bool,
}

fn trimmed(get: &impl Fn(&str) -> Option<String>, k: &str) -> Option<String> {
    get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// `Number(x)` của JS cho chuỗi (rỗng ⇒ 0, không đọc được ⇒ NaN).
fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    // Số nguyên tiền tố `0x`/`0b`/`0o` (không dấu, không rỗng), như `Number('0x1')`.
    let radix = match t.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0b" | "0B") => Some(2),
        Some("0o" | "0O") => Some(8),
        _ => None,
    };
    if let Some(r) = radix {
        let digits = &t[2..];
        return if digits.bytes().all(|b| b.is_ascii_alphanumeric()) {
            u128::from_str_radix(digits, r).map_or(f64::NAN, |n| n as f64)
        } else {
            f64::NAN
        };
    }
    // Rust nhận `inf`/`nan` (không phân biệt hoa thường) còn JS chỉ nhận `Infinity`: cả hai không hữu hạn nên cùng rơi về mặc định.
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Số JSON như `JSON.stringify`: số nguyên in không có `.0`.
fn json_number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::Number(Number::from(x as i64))
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

impl SystemConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        // telemetry: như `buildTelemetryConfig`.
        let rate = js_number(&get("SENTRY_TRACES_SAMPLE_RATE").unwrap_or_else(|| "0.1".to_owned()));
        let rate = if rate.is_finite() && (0.0..=1.0).contains(&rate) {
            rate
        } else {
            0.1
        };
        let sentry = trimmed(&get, "SENTRY_DSN_WEB").map_or(Value::Null, |dsn| {
            let environment = get("SENTRY_ENVIRONMENT")
                .filter(|v| !v.is_empty())
                .or_else(|| get("NODE_ENV").filter(|v| !v.is_empty()))
                .unwrap_or_else(|| "production".to_owned());
            json!({
                "dsn": dsn,
                "environment": environment,
                "release": resolve_release(&get),
                "traces_sample_rate": json_number(rate),
            })
        });
        let posthog = trimmed(&get, "POSTHOG_KEY").map_or(Value::Null, |key| {
            json!({
                "key": key,
                "host": trimmed(&get, "POSTHOG_HOST").unwrap_or_else(|| "https://us.i.posthog.com".to_owned()),
                "replay": get("POSTHOG_REPLAY").as_deref() == Some("true"),
            })
        });
        // Khoá băm: `MONITORING_HASH_SECRET`, rồi `JWT_SECRET` (như `monitoring.ts`); rỗng ⇒ identity trả null.
        // KHÔNG cắt khoảng trắng: `env.MONITORING_HASH_SECRET || env.JWT_SECRET` của TS dùng nguyên chuỗi (chỉ chuỗi rỗng mới bỏ),
        // cắt đi thì mã băm lệch với Node và với log/Sentry/PostHog.
        let hasher = get("MONITORING_HASH_SECRET")
            .filter(|s| !s.is_empty())
            .or_else(|| get("JWT_SECRET").filter(|s| !s.is_empty()))
            .and_then(|s| UserIdHasher::new(&s).ok());

        let legal = |k: &str| trimmed(&get, k).map_or(Value::Null, Value::String);
        let realtime = trimmed(&get, "REALTIME_MODE")
            .or_else(|| trimmed(&get, "NEXT_PUBLIC_REALTIME_MODE"))
            .unwrap_or_default();
        let ds_v2 = trimmed(&get, "DS_V2_ENABLED")
            .or_else(|| trimmed(&get, "NEXT_PUBLIC_DS_V2"))
            .is_some_and(|v| v == "true");
        let site = json!({
            "legal": {
                "contact_email": legal("LEGAL_CONTACT_EMAIL"),
                "company_name": legal("LEGAL_COMPANY_NAME"),
                "company_name_en": legal("LEGAL_COMPANY_NAME_EN"),
                "company_tax_id": legal("LEGAL_COMPANY_TAX_ID"),
                "company_address": legal("LEGAL_COMPANY_ADDRESS"),
                "company_phone": legal("LEGAL_COMPANY_PHONE"),
            },
            "realtime_mode": if realtime == "poll" { "poll" } else { "socket" },
            "ds_v2": ds_v2,
        });

        let build_id = trimmed(&get, "TRINITY_BUILD_ID")
            .or_else(|| {
                BUILD_ID_COMPILED
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "unknown".to_owned());
        // Cùng điều kiện `bootstrap-app.ts`: ngoài production, hoặc `SWAGGER_ENABLED=true`.
        let docs_enabled =
            get("NODE_ENV").as_deref() != Some("production") || get("SWAGGER_ENABLED").as_deref() == Some("true");
        Self {
            telemetry: json!({"sentry": sentry, "posthog": posthog}),
            hasher,
            site,
            build_id,
            docs_enabled,
        }
    }

    pub fn docs_enabled(&self) -> bool {
        self.docs_enabled
    }

    pub fn build_id(&self) -> &str {
        &self.build_id
    }

    pub fn site_config(&self) -> &Value {
        &self.site
    }

    /// Kết quả của `GET /api/v1/telemetry/config`.
    pub fn telemetry(&self) -> &Value {
        &self.telemetry
    }
}

/// Bảng route của module (cho `trinity_bin::routes::declared_routes`).
pub fn routes() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::GET, "/api/v1/health", Access::Public).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/ready", Access::Public).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/live", Access::Public).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/telemetry/config", Access::Public).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/telemetry/identity", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/site-config", Access::Public).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/bootstrap", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::GET, "/api/v1/kanban/overview", Access::AuthOnly).status_ok(200),
        RouteSpec::new(Method::POST, "/api/fe-logging", Access::Public).status_ok(204),
    ]
}

fn spec(path: &str) -> RouteSpec {
    routes().into_iter().find(|r| r.path == path).expect("route đã khai")
}

/// `tenantKey` của bản Node: id người dùng lặp giữa các công ty ⇒ khoá mang công ty; công ty 1 giữ nguyên mã cũ.
pub fn tenant_key(company_id: i32, user_id: i32) -> String {
    if company_id == 1 {
        user_id.to_string()
    } else {
        format!("c{company_id}:{user_id}")
    }
}

/// `Date.prototype.toISOString()`: mili giây, hậu tố `Z`.
fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Router của các route dưới `/api/v1` (đi qua lớp thực thi quyền như mọi route).
pub fn api_router(deps: Arc<AccessDeps>, cfg: Arc<SystemConfig>) -> ApiRouter {
    api_router_with(deps, cfg, bootstrap::new_slot())
}

/// Như [`api_router`] nhưng `bootstrap` dùng `slot` do tầng serve gắn router đã dựng xong vào.
pub fn api_router_with(deps: Arc<AccessDeps>, cfg: Arc<SystemConfig>, slot: bootstrap::BootstrapSlot) -> ApiRouter {
    let telemetry = cfg.telemetry.clone();
    let site = cfg.site.clone();
    let hasher = cfg.hasher.clone();
    let fe_limiter = fe_logging::limiter();
    ApiRouter::new(deps)
        .route(spec("/api/v1/health"), || async {
            Json(json!({"status": "ok", "service": "auth-service", "timestamp": iso_now()}))
        })
        .route(spec("/api/v1/ready"), || async {
            Json(json!({"status": "ready", "service": "auth-service"}))
        })
        .route(spec("/api/v1/live"), || async { Json(json!({"status": "alive"})) })
        .route(spec("/api/v1/telemetry/config"), move || {
            let v = telemetry.clone();
            async move { Json(v) }
        })
        .route(
            spec("/api/v1/telemetry/identity"),
            move |Extension(u): Extension<CurrentUser>| {
                let hasher = hasher.clone();
                async move {
                    // Công ty hiện hành của request (đã xác thực và resolve ở guard, như `currentCompany()`), không phải giá trị tự khai.
                    let key = tenant_key(u.user.company_id, u.user.user_id);
                    let mut m = Map::new();
                    m.insert(
                        "user".into(),
                        hasher.map_or(Value::Null, |h| Value::String(h.hash(&key))),
                    );
                    Json(Value::Object(m))
                }
            },
        )
        .route(spec("/api/v1/site-config"), move || {
            let v = site.clone();
            async move { Json(v) }
        })
        .route(spec("/api/v1/bootstrap"), {
            let slot = slot.clone();
            move |req: Request| bootstrap::handle(slot.clone(), req)
        })
        .route(spec("/api/v1/kanban/overview"), move |req: Request| {
            kanban_overview::handle(slot.clone(), req)
        })
        .route(
            spec("/api/fe-logging"),
            move |client: Option<Extension<trinity_http::edge::client_ip::ClientIp>>, req: Request| {
                fe_logging::handle(fe_limiter.clone(), client, req)
            },
        )
}

/// Route ngoài `/api/v1` (không có trong `routes.json`): `/api/build-id`, và `/docs` + `/docs-json` khi được bật. Tất cả công khai.
pub fn extra_router(cfg: &SystemConfig) -> Router {
    let id = cfg.build_id.clone();
    let mut r = Router::new().route(
        "/api/build-id",
        get(move || {
            let id = id.clone();
            async move {
                let mut res = Json(json!({ "buildId": id })).into_response();
                res.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("no-store, must-revalidate"),
                );
                res
            }
        }),
    );
    if cfg.docs_enabled {
        r = r
            .route("/docs", get(|| async { Html(DOCS_HTML) }))
            .route("/docs-json", get(docs_json));
    }
    r
}

async fn docs_json() -> Response {
    match ApiDoc::openapi().to_json() {
        Ok(s) => (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], s).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("không sinh được OpenAPI: {e}"),
        )
            .into_response(),
    }
}

/// Trang tài liệu tối giản, không phụ thuộc tài nguyên ngoài: đọc `/docs-json` và liệt kê đường dẫn.
const DOCS_HTML: &str = r#"<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Trinity API</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px system-ui;margin:2rem auto;max-width:56rem;padding:0 1rem}
code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}li{margin:.4rem 0}</style></head><body><h1>Trinity API</h1>
<p>Tài liệu OpenAPI (JSON): <a href="/docs-json"><code>/docs-json</code></a></p><ul id="l"></ul>
<script>fetch('/docs-json').then(r=>r.json()).then(d=>{const l=document.getElementById('l');for(const [p,m] of Object.entries(d.paths||{}))for(const [v,o] of Object.entries(m)){const li=document.createElement('li');li.textContent=v.toUpperCase()+' '+p+(o.summary?' — '+o.summary:'');l.appendChild(li)}})</script></body></html>"#;

#[allow(dead_code)]
mod doc {
    /// Health check
    #[utoipa::path(get, path = "/api/v1/health", tag = "Health", summary = "Health check", responses((status = 200, description = "Còn sống kèm giờ máy chủ")))]
    pub fn health() {}
    /// Readiness check
    #[utoipa::path(get, path = "/api/v1/ready", tag = "Health", summary = "Readiness check", responses((status = 200, description = "Sẵn sàng")))]
    pub fn ready() {}
    /// Liveness check
    #[utoipa::path(get, path = "/api/v1/live", tag = "Health", summary = "Liveness check", responses((status = 200, description = "Còn sống")))]
    pub fn live() {}
    /// Cấu hình Sentry/PostHog cho trình duyệt
    #[utoipa::path(get, path = "/api/v1/telemetry/config", tag = "Telemetry", summary = "Cấu hình Sentry/PostHog cho trình duyệt (null khi chưa bật)", responses((status = 200, description = "Cấu hình")))]
    pub fn telemetry_config() {}
    /// Mã người dùng đã băm
    #[utoipa::path(get, path = "/api/v1/telemetry/identity", tag = "Telemetry", summary = "Mã người dùng đã băm HMAC để gắn vào Sentry/PostHog", responses((status = 200, description = "Mã băm hoặc null")))]
    pub fn telemetry_identity() {}
    /// Cấu hình trang
    #[utoipa::path(get, path = "/api/v1/site-config", tag = "Site", summary = "Thông tin pháp lý và cờ lúc chạy cho web (chỉ có ở bản Rust)", responses((status = 200, description = "Cấu hình trang")))]
    pub fn site_config() {}
    /// Bootstrap layout
    #[utoipa::path(get, path = "/api/v1/bootstrap", tag = "Site", summary = "Gộp các lời gọi layout/Tổng quan của web thành một lượt (phần lỗi trả null)", params(("include" = Option<String>, Query, description = "`dashboard` để thêm phần Tổng quan"), ("cc_from" = Option<String>, Query, description = "YYYY-MM-DD, đầu khoảng Trung tâm điều hành"), ("cc_to" = Option<String>, Query, description = "YYYY-MM-DD, cuối khoảng")), responses((status = 200, description = "Object khoá → phản hồi của endpoint gốc hoặc null")))]
    pub fn bootstrap() {}
    /// Kanban overview
    #[utoipa::path(get, path = "/api/v1/kanban/overview", tag = "Kanban", summary = "Board mặc định kèm cột, trang đầu thẻ mỗi cột và roster tối giản trong một lượt (phần lỗi trả null)", params(("limit" = Option<i64>, Query, description = "Thẻ mỗi cột, 1..=100, mặc định 30")), responses((status = 200, description = "{boards, board, cards: {columnId: trang}, users}")))]
    pub fn kanban_overview() {}
    /// Build id
    #[utoipa::path(get, path = "/api/build-id", tag = "Site", summary = "Mã bản dựng của web", responses((status = 200, description = "{buildId}")))]
    pub fn build_id() {}
}

/// Tài liệu OpenAPI của module này; module khác bổ sung path của mình khi có route đầu tiên.
#[derive(OpenApi)]
#[openapi(
    info(title = "Trinity API", version = "0.3.0"),
    paths(
        doc::health,
        doc::ready,
        doc::live,
        doc::telemetry_config,
        doc::telemetry_identity,
        doc::site_config,
        doc::build_id
    )
)]
pub struct ApiDoc;

#[cfg(test)]
mod tests;
