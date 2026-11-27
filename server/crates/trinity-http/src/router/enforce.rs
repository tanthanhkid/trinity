//! Lớp thực thi `Access` cho từng route, theo `packages/rbac-nest/src/permission.guard.ts` rồi các guard cấp route:
//! `Public` qua; `Internal` so `x-service-secret`; `AuthOnly`/`Can`/`CanAny` xác thực rồi nạp quyền, admin qua hết,
//! thiếu quyền 403 `Bạn không có quyền thực hiện thao tác này`. Sau đó (đúng thứ tự guard của Nest) cổng tính năng của
//! tổ chức và các guard riêng (`ApiKeyGuard`…), rồi pipe của tham số đường dẫn, và áp mã thành công đã khai.
//!
//! Mọi tên guard/pipe đã khai phải có cài đặt: thiếu thì [`ApiRouter::route`](super::ApiRouter::route) dừng lúc khởi động,
//! không để tên chỉ nằm trong bảng mà không chạy.

// `HttpError` (kiểu lỗi K05) lớn hơn ngưỡng của clippy; lỗi chỉ ở đường từ chối request nên không boxing.
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::{FromRequestParts, RawPathParams, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use trinity_auth::{AuthUser, Authenticator};
use trinity_db::CompanyRef;
use trinity_kernel::error::HttpError;
use trinity_rbac::{GrantsResult, PermissionService, can, catalog};

use super::{Access, RouteSpec};
use crate::edge::body::error_response;
use crate::validate::parse_int_param;

pub type FeatureFuture<'a> = Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
pub type GuardFuture<'a> = Pin<Box<dyn Future<Output = Result<(), HttpError>> + Send + 'a>>;

/// Công tắc tính năng của tổ chức (`OrgFeaturesService.isEnabled`); cài đặt thật ở K25. Đọc lỗi thì trả `true` (fail-open,
/// như bản TS).
pub trait OrgFeatureGate: Send + Sync {
    fn enabled<'a>(&'a self, company: CompanyRef, feature: &'a str) -> FeatureFuture<'a>;
}

/// Guard riêng của một route (`ApiKeyGuard`, `PublicApiRateLimiterGuard`, `PlanTokenGuard`…), đăng ký theo tên trong
/// [`AccessDeps::guards`]. `Err` trả nguyên cho client.
pub trait NamedGuard: Send + Sync {
    fn check<'a>(&'a self, req: &'a mut Request) -> GuardFuture<'a>;
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
    /// `None` = không có cổng tính năng (mọi tính năng coi như bật): chỉ dùng trong test. Route có `org_feature` mà không
    /// có cổng thì [`ApiRouter::route`](super::ApiRouter::route) dừng lúc khởi động.
    pub features: Option<Arc<dyn OrgFeatureGate>>,
    /// Guard riêng theo tên (trừ `OrgFeatureGuard`, do `org_feature` đảm nhiệm).
    pub guards: BTreeMap<&'static str, Arc<dyn NamedGuard>>,
}

/// Handler đặt vào `Response::extensions_mut()` để GIỮ mã 200 dù route khai `status_ok` khác (như `res.status(200)` của
/// Express với `@Res({ passthrough: true })`, vd `POST /hooks/in/:token`).
#[derive(Debug, Clone, Copy)]
pub struct KeepStatus;

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

/// Pipe của tham số đường dẫn đã có cài đặt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pipe {
    Int,
    Int4,
    Uuid,
}

const INT4_MAX: i64 = 2_147_483_647;

fn parse_pipe(spec: &str) -> Option<(String, Pipe)> {
    let (param, pipe) = spec.strip_prefix("param.")?.split_once(':')?;
    let p = match pipe {
        "ParseIntPipe" => Pipe::Int,
        "ParseInt4Pipe" => Pipe::Int4,
        "ParseUUIDPipe" => Pipe::Uuid,
        _ => return None,
    };
    Some((param.to_owned(), p))
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn apply_pipe(name: &str, pipe: Pipe, value: &str) -> Result<(), HttpError> {
    match pipe {
        Pipe::Int => parse_int_param(value).map(|_| ()),
        // `ParseInt4Pipe` của commerce: ParseIntPipe rồi trần INT4 và >= 1.
        Pipe::Int4 => {
            let n = parse_int_param(value)?;
            if !(1..=INT4_MAX).contains(&n) {
                return Err(HttpError::bad_request(format!("{name} vượt giới hạn số nguyên 32-bit")));
            }
            Ok(())
        }
        Pipe::Uuid => {
            if is_uuid(value) {
                Ok(())
            } else {
                Err(HttpError::bad_request("Validation failed (uuid is expected)"))
            }
        }
    }
}

pub(super) struct RouteGuard {
    method: Method,
    access: Access,
    org_feature: Option<&'static str>,
    status_ok: Option<StatusCode>,
    deps: Arc<AccessDeps>,
    guards: Vec<Arc<dyn NamedGuard>>,
    pipes: Vec<(String, Pipe)>,
    /// Tham số khai `:name(\d+)` (Express): giá trị không toàn chữ số thì route không khớp (404 trước mọi guard).
    digits: Vec<String>,
}

/// Chuỗi không rỗng toàn chữ số ASCII.
fn is_digits(v: &str) -> bool {
    !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())
}

/// Tên các tham số khai dạng `:name(\d+)` trong đường dẫn.
fn digit_params(path: &str) -> Vec<String> {
    path.split('/')
        .filter_map(|seg| seg.strip_prefix(':'))
        .filter_map(|rest| rest.strip_suffix(r"(\d+)"))
        .map(str::to_owned)
        .collect()
}

impl RouteGuard {
    /// Dựng lớp thực thi cho một route. Tên guard/pipe chưa có cài đặt, `org_feature` không có cổng, hoặc `org_feature` trên
    /// route không có công ty (`Public`/`Internal`) là lỗi lập trình: dừng lúc khởi động.
    pub(super) fn new(spec: &RouteSpec, deps: Arc<AccessDeps>) -> Self {
        let route = format!("{} {}", spec.method, spec.path);
        if spec.org_feature.is_some() {
            assert!(
                matches!(spec.access, Access::Can(_) | Access::CanAny(_) | Access::AuthOnly),
                "{route}: org_feature trên route {} chưa hỗ trợ: cần công ty đã resolve của route công khai/nội bộ",
                spec.access.kind()
            );
            assert!(
                deps.features.is_some(),
                "{route}: có org_feature nhưng AccessDeps không có cổng tính năng"
            );
        }
        let guards = spec
            .guards
            .iter()
            .map(|name| {
                deps.guards
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| panic!("{route}: guard {name} chưa có cài đặt trong AccessDeps.guards"))
            })
            .collect();
        let pipes = spec
            .param_pipes
            .iter()
            .map(|p| parse_pipe(p).unwrap_or_else(|| panic!("{route}: param_pipe {p} chưa có cài đặt")))
            .collect();
        let status_ok = spec
            .status_ok
            .map(|c| StatusCode::from_u16(c).unwrap_or_else(|_| panic!("{route}: status_ok {c} không hợp lệ")));
        Self {
            method: spec.method.clone(),
            access: spec.access,
            org_feature: spec.org_feature,
            status_ok,
            deps,
            guards,
            pipes,
            digits: digit_params(spec.path),
        }
    }
}

fn header(req: &Request, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// 404 như Nest khi không có route khớp (phương thức không khai báo trên một đường dẫn đã có, hoặc đường dẫn lạ): trả
/// TRƯỚC mọi guard, không lộ việc đường dẫn tồn tại hay không với người chưa đăng nhập.
pub(super) fn not_found(method: &Method, path: &str) -> Response {
    error_response(&HttpError::with_label(
        404,
        format!("Cannot {method} {path}"),
        "Not Found",
    ))
}

pub(super) async fn enforce(State(g): State<Arc<RouteGuard>>, mut req: Request, next: Next) -> Response {
    // `MethodRouter::layer` bọc cả nhánh "phương thức không khớp" (405) bằng guard của route: phương thức khác phương thức
    // đã khai thì không phải route này.
    if req.method() != g.method {
        return not_found(req.method(), req.uri().path());
    }
    if !g.digits.is_empty() {
        let (mut parts, body) = req.into_parts();
        let params = RawPathParams::from_request_parts(&mut parts, &()).await;
        let mismatch = params.is_ok_and(|p| p.iter().any(|(k, v)| g.digits.iter().any(|d| d == k) && !is_digits(v)));
        req = Request::from_parts(parts, body);
        if mismatch {
            return not_found(req.method(), req.uri().path());
        }
    }
    let mut company = None;
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
            let Ok(co) = CompanyRef::new(i64::from(user.company_id)) else {
                return error_response(&HttpError::from(trinity_auth::AuthError::InvalidToken));
            };
            // Ngoài try/catch của JwtAuthGuard: lỗi DB khi nạp quyền là 500 như Node (không đội lốt 401).
            let grants = match g.deps.permissions.grants_for(co, user.user_id).await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("[router] nạp quyền lỗi: {e}");
                    return error_response(&HttpError::nest(500, None));
                }
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
            company = Some(co);
            req.extensions_mut().insert(CurrentUser { user, grants });
        }
    }
    // Guard cấp route chạy SAU APP_GUARD, theo thứ tự khai (`OrgFeatureGuard` đứng đầu danh sách guard).
    if let (Some(feature), Some(co), Some(gate)) = (g.org_feature, company, &g.deps.features)
        && !gate.enabled(co, feature).await
    {
        return error_response(&HttpError::forbidden(feature_disabled_message(feature)));
    }
    for guard in &g.guards {
        if let Err(e) = guard.check(&mut req).await {
            return error_response(&e);
        }
    }
    // Pipe của tham số đường dẫn (sau guard, trước handler như Nest).
    if !g.pipes.is_empty() {
        let (mut parts, body) = req.into_parts();
        let params = RawPathParams::from_request_parts(&mut parts, &()).await;
        if let Ok(params) = params {
            for (name, pipe) in &g.pipes {
                if let Some((_, value)) = params.iter().find(|(k, _)| k == name)
                    && let Err(e) = apply_pipe(name, *pipe, value)
                {
                    return error_response(&e);
                }
            }
        }
        req = Request::from_parts(parts, body);
    }
    let mut resp = next.run(req).await;
    // `@HttpCode`: handler trả 200 mặc định thì đổi sang mã thành công đã khai; handler tự trả mã khác thì giữ.
    if let Some(code) = g.status_ok
        && resp.status() == StatusCode::OK
        && resp.extensions().get::<KeepStatus>().is_none()
    {
        *resp.status_mut() = code;
    }
    resp
}
