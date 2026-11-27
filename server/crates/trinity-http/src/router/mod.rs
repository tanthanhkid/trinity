//! Router bắt buộc khai quyền (K14, docs/rust/PLAN.md mục 4.7).
//!
//! Route chỉ thêm được qua [`ApiRouter::route`], và hàm đó nhận một [`RouteSpec`] mà [`RouteSpec::new`] bắt buộc có
//! [`Access`] (`Can`, `CanAny`, `AuthOnly`, `Public`, `Internal`): thiếu khai báo thì không biên dịch được, không có cửa
//! sau (trường `axum::Router` bên trong là riêng tư). Phương thức HTTP lấy từ spec nên không lệch bảng route.
//!
//! ```compile_fail
//! // Thiếu `RouteSpec`/`Access`: không biên dịch.
//! use axum::routing::get;
//! async fn h() {}
//! fn f(r: trinity_http::router::ApiRouter) {
//!     let _ = r.route("/api/v1/x", get(h));
//! }
//! ```
//!
//! Mỗi route được bọc một lớp thực thi đúng thứ tự của `PermissionGuard` (xác thực → phân quyền, admin qua hết) rồi
//! cổng tính năng của tổ chức (`OrgFeatureGuard`, chạy sau, như guard cấp route của Nest). Bảng route đã khai được so với
//! `contracts/routes.json` lúc khởi động và trong CI ([`check`]).

pub mod check;
mod enforce;

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::Router;
use axum::handler::Handler;
use axum::http::Method;
use axum::middleware::from_fn_with_state;
use axum::routing::{MethodFilter, on};

pub use enforce::{
    AccessDeps, CurrentUser, FeatureFuture, GuardFuture, KeepStatus, NamedGuard, OrgFeatureGate,
    feature_disabled_message,
};

/// Loại truy cập của route, tương ứng `AccessMeta` của `@Can`/`@CanAny`/`@AuthOnly`/`@Public`/`@Internal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Cần mọi quyền trong danh sách (`mode: 'all'`).
    Can(&'static [&'static str]),
    /// Cần ít nhất một quyền (`mode: 'any'`).
    CanAny(&'static [&'static str]),
    /// Chỉ cần đăng nhập.
    AuthOnly,
    /// Không xác thực.
    Public,
    /// Chỉ giữa các tiến trình: header `x-service-secret`.
    Internal,
}

impl Access {
    /// Giá trị cột `access` của `routes.json`.
    pub fn kind(&self) -> &'static str {
        match self {
            Access::Can(_) | Access::CanAny(_) => "can",
            Access::AuthOnly => "auth",
            Access::Public => "public",
            Access::Internal => "internal",
        }
    }

    pub fn permissions(&self) -> &'static [&'static str] {
        match self {
            Access::Can(p) | Access::CanAny(p) => p,
            _ => &[],
        }
    }

    /// Giá trị cột `permission_mode` (`None` với route không đòi quyền).
    pub fn mode(&self) -> Option<&'static str> {
        match self {
            Access::Can(_) => Some("all"),
            Access::CanAny(_) => Some("any"),
            _ => None,
        }
    }
}

/// Khai báo một route; mọi trường so với một dòng của `routes.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteSpec {
    pub method: Method,
    /// Đường dẫn dạng Nest, đầy đủ tiền tố (`/api/v1/contacts/:id`), như trong `routes.json`.
    pub path: &'static str,
    pub access: Access,
    /// Mã trả về khi thành công; `None` = handler tự đặt (cột `status_ok` là `null`).
    pub status_ok: Option<u16>,
    /// Tính năng tổ chức cần bật; có thì route thêm guard `OrgFeatureGuard`.
    pub org_feature: Option<&'static str>,
    /// Guard riêng ngoài `OrgFeatureGuard` (ví dụ `ApiKeyGuard`).
    pub guards: &'static [&'static str],
    /// Pipe của tham số đường dẫn, dạng `param.id:ParseIntPipe`.
    pub param_pipes: &'static [&'static str],
}

impl RouteSpec {
    /// `access` là tham số bắt buộc duy nhất ngoài phương thức và đường dẫn.
    pub fn new(method: Method, path: &'static str, access: Access) -> Self {
        Self {
            method,
            path,
            access,
            status_ok: None,
            org_feature: None,
            guards: &[],
            param_pipes: &[],
        }
    }

    #[must_use]
    pub fn status_ok(mut self, code: u16) -> Self {
        self.status_ok = Some(code);
        self
    }

    #[must_use]
    pub fn org_feature(mut self, feature: &'static str) -> Self {
        self.org_feature = Some(feature);
        self
    }

    #[must_use]
    pub fn guards(mut self, guards: &'static [&'static str]) -> Self {
        self.guards = guards;
        self
    }

    #[must_use]
    pub fn param_pipes(mut self, pipes: &'static [&'static str]) -> Self {
        self.param_pipes = pipes;
        self
    }

    /// Danh sách guard như cột `guards`: `OrgFeatureGuard` (nếu có `org_feature`) rồi guard riêng.
    pub fn guard_list(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.org_feature.is_some() {
            v.push("OrgFeatureGuard");
        }
        v.extend_from_slice(self.guards);
        v
    }

    /// Đường dẫn của axum: `:id` thành `{id}`.
    pub fn axum_path(&self) -> String {
        self.path
            .split('/')
            .map(|seg| match seg.strip_prefix(':') {
                // `:id(\d+)` (Express) thành `{id}`; việc kiểm toàn chữ số làm ở lớp thực thi.
                Some(name) => format!("{{{}}}", name.split('(').next().unwrap_or(name)),
                None => seg.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("/")
    }
}

/// Bảng route đã khai, để so với hợp đồng.
pub type RouteTable = Vec<RouteSpec>;

/// Đường dẫn không khớp route nào: 404 dạng Nest.
async fn fallback_404(req: axum::extract::Request) -> axum::response::Response {
    enforce::not_found(req.method(), req.uri().path())
}

/// Router chỉ nhận route kèm khai báo quyền.
pub struct ApiRouter<S = ()> {
    router: Router<S>,
    table: RouteTable,
    seen: BTreeSet<(String, String)>,
    deps: Arc<AccessDeps>,
}

impl<S: Clone + Send + Sync + 'static> ApiRouter<S> {
    pub fn new(deps: Arc<AccessDeps>) -> Self {
        Self {
            router: Router::new().fallback(fallback_404),
            table: Vec::new(),
            seen: BTreeSet::new(),
            deps,
        }
    }

    /// Thêm một route. Phương thức lấy từ `spec`. Khai trùng (phương thức, đường dẫn) hoặc phương thức HTTP lạ là lỗi
    /// lập trình: dừng ngay lúc khởi động.
    #[must_use]
    pub fn route<H, T>(mut self, spec: RouteSpec, handler: H) -> Self
    where
        H: Handler<T, S>,
        T: 'static,
    {
        let Ok(filter) = MethodFilter::try_from(spec.method.clone()) else {
            panic!("phương thức {} không hỗ trợ ({})", spec.method, spec.path);
        };
        assert!(
            self.seen.insert((spec.method.to_string(), spec.path.to_owned())),
            "route khai hai lần: {} {}",
            spec.method,
            spec.path
        );
        let guard = Arc::new(enforce::RouteGuard::new(&spec, Arc::clone(&self.deps)));
        let method_router = on(filter, handler).layer(from_fn_with_state(guard, enforce::enforce));
        self.router = self.router.route(&spec.axum_path(), method_router);
        self.table.push(spec);
        self
    }

    /// Gộp router con (cũng là `ApiRouter`, nên mọi route đều đã khai).
    #[must_use]
    pub fn merge(mut self, other: ApiRouter<S>) -> Self {
        for spec in &other.table {
            assert!(
                self.seen.insert((spec.method.to_string(), spec.path.to_owned())),
                "route khai hai lần: {} {}",
                spec.method,
                spec.path
            );
        }
        self.table.extend(other.table);
        self.router = self.router.merge(other.router);
        self
    }

    pub fn table(&self) -> &[RouteSpec] {
        &self.table
    }

    /// Lấy router của axum (để gắn state, lớp CORS/IP/body…) cùng bảng route đã khai.
    pub fn into_parts(self) -> (Router<S>, RouteTable) {
        (self.router, self.table)
    }
}
