//! `ApiKeyGuard` của `POST /public/auth/login` (phạm vi `auth:login`), đăng ký theo tên vào `AccessDeps::guards`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::Request;
use trinity_db::CompanyRef;
use trinity_http::edge::client_ip::resolve_client_ip;
use trinity_http::router::{GuardFuture, NamedGuard};
use trinity_kernel::error::{AppError, HttpError};

use crate::ApiKeysCtx;
use crate::api_keys::validate;

/// Khoá đã xác thực, gắn vào extension của request (`req.apiKey` của bản TS).
#[derive(Debug, Clone)]
pub struct KeyInfo {
    pub owner_user_id: i32,
    pub company: CompanyRef,
}

fn http_of(e: AppError) -> HttpError {
    match e {
        AppError::Http(h) => h,
        other => {
            tracing::error!("[api-keys] {other:?}");
            HttpError::nest(500, None)
        }
    }
}

pub struct LoginKeyGuard(pub Arc<ApiKeysCtx>);

impl NamedGuard for LoginKeyGuard {
    fn check<'a>(&'a self, req: &'a mut Request) -> GuardFuture<'a> {
        Box::pin(async move {
            let ctx = &self.0;
            let raw = req
                .headers()
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            // IP khách từ hàm dùng chung (TRUSTED_PROXY); không tin được ⇒ không ghi IP sai vào `last_used_ip`.
            let ip = resolve_client_ip(&ctx.ip, req).ip.map(|i| i.to_string());
            let key = validate(&ctx.db, &ctx.platform, &raw, "auth:login", ip.as_deref())
                .await
                .map_err(http_of)?;
            req.extensions_mut().insert(KeyInfo {
                owner_user_id: key.owner_user_id,
                company: key.company,
            });
            Ok(())
        })
    }
}

/// Guard theo tên cho `AccessDeps::guards` của router này.
pub fn named_guards(ctx: &Arc<ApiKeysCtx>) -> BTreeMap<&'static str, Arc<dyn NamedGuard>> {
    let mut m: BTreeMap<&'static str, Arc<dyn NamedGuard>> = BTreeMap::new();
    m.insert("ApiKeyGuard", Arc::new(LoginKeyGuard(ctx.clone())));
    m
}
