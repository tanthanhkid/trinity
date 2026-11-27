//! `ApiKeyGuard` và `PublicApiRateLimiterGuard` (đăng ký theo tên vào `AccessDeps::guards`).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{MatchedPath, Request};
use trinity_http::edge::client_ip::resolve_client_ip;
use trinity_http::rate_limit::now_ms;
use trinity_http::router::{GuardFuture, NamedGuard};
use trinity_kernel::error::{AppError, HttpError};

use crate::PublicCtx;

/// Khoá đã xác thực, gắn vào extension của request.
#[derive(Debug, Clone)]
pub struct KeyInfo {
    pub id: i32,
    pub name: String,
    pub owner_user_id: i32,
    pub company: trinity_db::CompanyRef,
}

/// Giới hạn tốc độ bị vượt: handler trả 429 (`{ statusCode, message, retryAfter }`, không có trường `error`) trước khi đọc body.
#[derive(Debug, Clone, Copy)]
pub struct RateBlocked {
    pub retry_after_sec: u64,
}

/// Phạm vi mà từng route đòi (`@ApiKeyScopeRequired`).
pub fn scope_of(path: &str) -> Option<&'static str> {
    match path.trim_end_matches('/') {
        "/api/v1/public/contacts" | "/api/v1/public/contacts/sources" => Some("contacts:create"),
        "/api/v1/public/deals" => Some("deals:create"),
        "/api/v1/public/tasks" | "/api/v1/public/tasks/columns" => Some("tasks:create"),
        _ => None,
    }
}

fn http_of(e: AppError) -> HttpError {
    match e {
        AppError::Http(h) => h,
        other => {
            tracing::error!("[public-api] {other:?}");
            HttpError::nest(500, None)
        }
    }
}

pub struct ApiKeyGuard(pub Arc<PublicCtx>);

impl NamedGuard for ApiKeyGuard {
    fn check<'a>(&'a self, req: &'a mut Request) -> GuardFuture<'a> {
        Box::pin(async move {
            let ctx = &self.0;
            // Phạm vi theo mẫu route đã khớp (`MatchedPath`), không theo đường dẫn thô của request.
            let matched = req
                .extensions()
                .get::<MatchedPath>()
                .map(|m| m.as_str().to_owned())
                .unwrap_or_default();
            let scope = scope_of(&matched).ok_or_else(|| {
                tracing::error!("ApiKeyGuard áp vào route không có phạm vi: {matched}");
                HttpError::nest(500, Some("Cấu hình API key guard lỗi".to_owned().into()))
            })?;
            let raw = req
                .headers()
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            // IP khách từ hàm dùng chung (TRUSTED_PROXY); không tin được ⇒ không ghi IP sai vào `last_used_ip`.
            let ip = resolve_client_ip(&ctx.ip, req).ip.map(|i| i.to_string());
            let key = mod_apikeys::api_keys::validate(&ctx.db, &ctx.platform, &raw, scope, ip.as_deref())
                .await
                .map_err(http_of)?;
            // Chủ khoá bị khoá sau khi khoá được cấp ⇒ từ chối, tránh khoá "zombie" dùng danh nghĩa người đã khoá.
            let mut c = ctx
                .db
                .tenant(key.company)
                .await
                .map_err(|e| http_of(AppError::internal(e)))?
                .acquire()
                .await
                .map_err(|e| http_of(AppError::internal(e)))?;
            let status: Option<String> = sqlx::query_scalar("SELECT status FROM users WHERE id = $1")
                .bind(key.owner_user_id)
                .fetch_optional(&mut *c)
                .await
                .map_err(|e| http_of(AppError::internal(e)))?;
            if status.as_deref() != Some("active") {
                return Err(HttpError::unauthorized("Owner user của khoá API không còn hoạt động"));
            }
            req.extensions_mut().insert(KeyInfo {
                id: key.id,
                name: key.name,
                owner_user_id: key.owner_user_id,
                company: key.company,
            });
            Ok(())
        })
    }
}

pub struct RateGuard(pub Arc<PublicCtx>);

impl NamedGuard for RateGuard {
    fn check<'a>(&'a self, req: &'a mut Request) -> GuardFuture<'a> {
        Box::pin(async move {
            let Some(key) = req.extensions().get::<KeyInfo>().cloned() else {
                // ApiKeyGuard phải đứng trước; thiếu thì ghi log để thấy cấu hình lệch thay vì bỏ qua giới hạn trong im lặng.
                tracing::warn!(
                    "PublicApiRateLimiterGuard: request không có apiKey — kiểm tra thứ tự guard (ApiKeyGuard phải đứng trước)."
                );
                return Ok(());
            };
            // Id khoá lặp giữa các công ty: khoá đếm mang cả công ty (công ty 1 giữ nguyên).
            let k = if key.company.id() == 1 {
                format!("apikey:{}", key.id)
            } else {
                format!("apikey:c{}:{}", key.company.id(), key.id)
            };
            let hit = self.0.limiter.hit(&k, now_ms());
            if !hit.allowed {
                tracing::warn!("PublicApi rate limit hit api_key={} count={}", key.id, hit.count);
                req.extensions_mut().insert(RateBlocked {
                    retry_after_sec: hit.retry_after_sec,
                });
            }
            Ok(())
        })
    }
}

/// Hai guard theo tên cho `AccessDeps::guards`.
pub fn named_guards(ctx: &Arc<PublicCtx>) -> BTreeMap<&'static str, Arc<dyn NamedGuard>> {
    BTreeMap::from([
        ("ApiKeyGuard", Arc::new(ApiKeyGuard(ctx.clone())) as Arc<dyn NamedGuard>),
        (
            "PublicApiRateLimiterGuard",
            Arc::new(RateGuard(ctx.clone())) as Arc<dyn NamedGuard>,
        ),
    ])
}
