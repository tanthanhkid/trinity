//! Lớp thực thi `Access` cho từng route, theo `packages/rbac-nest/src/permission.guard.ts`:
//! `Public` qua; `Internal` so `x-service-secret`; `AuthOnly`/`Can`/`CanAny` xác thực rồi nạp quyền, admin qua hết,
//! thiếu quyền 403 `Bạn không có quyền thực hiện thao tác này`. Sau đó cổng tính năng của tổ chức (guard cấp route).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use trinity_auth::{AuthError, AuthUser, Authenticator};
use trinity_db::CompanyRef;
use trinity_kernel::error::HttpError;
use trinity_rbac::{GrantsResult, PermissionService, can, catalog};

use super::{Access, RouteSpec};
use crate::edge::body::error_response;

pub type FeatureFuture<'a> = Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

/// Công tắc tính năng của tổ chức (`OrgFeaturesService.isEnabled`); cài đặt thật ở K25. Đọc lỗi thì trả `true` (fail-open,
/// như bản TS).
pub trait OrgFeatureGate: Send + Sync {
    fn enabled<'a>(&'a self, company: CompanyRef, feature: &'a str) -> FeatureFuture<'a>;
}

/// Câu 403 khi tính năng tắt: `Tính năng "<nhãn>" chưa bật hoặc không có trong gói hiện tại.`
pub fn feature_disabled_message(feature: &str) -> String {
    let label = catalog().org_feature(feature).map_or(feature, |f| f.label.as_str());
    format!("Tính năng \"{label}\" chưa bật hoặc không có trong gói hiện tại.")
}

/// Thứ route cần để thực thi quyền.
pub struct AccessDeps {
    pub auth: Arc<Authenticator>,
    pub permissions: PermissionService,
    /// `None` = không có cổng tính năng (mọi tính năng coi như bật): chỉ dùng trong test.
    pub features: Option<Arc<dyn OrgFeatureGate>>,
}

/// Người dùng đã xác thực kèm quyền: handler lấy từ `Extension<CurrentUser>` (như `req.user` của bản Node).
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub user: AuthUser,
    pub grants: Arc<GrantsResult>,
}

impl CurrentUser {
    pub fn is_admin(&self) -> bool {
        self.grants.is_admin
    }
}

pub(super) struct RouteGuard {
    access: Access,
    org_feature: Option<&'static str>,
    deps: Arc<AccessDeps>,
}

impl RouteGuard {
    pub(super) fn new(spec: &RouteSpec, deps: Arc<AccessDeps>) -> Self {
        Self {
            access: spec.access,
            org_feature: spec.org_feature,
            deps,
        }
    }
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

pub(super) async fn enforce(State(g): State<Arc<RouteGuard>>, mut req: Request, next: Next) -> Response {
    match g.access {
        Access::Public => {}
        Access::Internal => {
            if let Err(e) = g
                .deps
                .auth
                .check_service_secret(header(&req, "x-service-secret").as_deref())
            {
                return error_response(&e.into());
            }
        }
        Access::AuthOnly | Access::Can(_) | Access::CanAny(_) => {
            let authorization = header(&req, "authorization");
            let user = match g.deps.auth.authenticate(authorization.as_deref()).await {
                Ok(u) => u,
                Err(e) => return error_response(&HttpError::from(e)),
            };
            let company = match CompanyRef::new(i64::from(user.company_id)) {
                Ok(c) => c,
                Err(_) => return error_response(&AuthError::InvalidToken.into()),
            };
            let grants = match g.deps.permissions.grants_for(company, user.user_id).await {
                Ok(v) => v,
                Err(e) => return error_response(&HttpError::from(AuthError::InvalidToken).tap_internal(&e)),
            };
            let allowed = grants.is_admin
                || match g.access {
                    Access::Can(ps) => ps.iter().all(|p| can(&grants.grants, p, None)),
                    Access::CanAny(ps) => ps.iter().any(|p| can(&grants.grants, p, None)),
                    _ => true,
                };
            if !allowed {
                return error_response(&HttpError::forbidden("Bạn không có quyền thực hiện thao tác này"));
            }
            // Cổng tính năng chạy SAU phân quyền (guard cấp route của Nest chạy sau APP_GUARD).
            if let (Some(feature), Some(gate)) = (g.org_feature, &g.deps.features)
                && !gate.enabled(company, feature).await
            {
                return error_response(&HttpError::forbidden(feature_disabled_message(feature)));
            }
            req.extensions_mut().insert(CurrentUser { user, grants });
        }
    }
    next.run(req).await
}

trait TapInternal {
    fn tap_internal(self, e: &dyn std::fmt::Display) -> Self;
}

impl TapInternal for HttpError {
    /// Lỗi DB khi nạp quyền: ghi log, trả câu 401 chung như `catch` của guard Node.
    fn tap_internal(self, e: &dyn std::fmt::Display) -> Self {
        tracing::error!("[router] nạp quyền lỗi: {e}");
        self
    }
}
