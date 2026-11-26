//! Strangler proxy (K17, docs/rust/PLAN.md mục 4.14): Rust nghe cổng origin, route thuộc Rust chạy trong tiến trình,
//! phần còn lại chuyển tiếp sang Node (API) hoặc Next (trang) qua loopback.
//!
//! - [`OwnershipTable`]: bảng sở hữu route đọc từ **tệp** `TRINITY_OWNERSHIP_FILE`, nạp lại khi nhận `SIGHUP` mà không
//!   rớt kết nối; tệp hỏng thì giữ bảng cũ và ghi lỗi. `TRINITY_RUST_ROUTES` chỉ là giá trị khởi tạo khi chưa có tệp.
//! - [`NodeProxy`]: truyền body dạng stream không đệm, giữ nguyên từng byte, nâng cấp WebSocket, timeout 15 giây
//!   (120 giây cho `/export`). Xoá header IP do client gửi rồi chuyển IP đã xác định (K16) bằng `x-trinity-client-ip`
//!   ký ngay lúc gửi header.
//! - [`dispatcher`]: ghép hai bên. Lớp CORS của Rust chỉ nằm trong `rust` (route thuộc Node tự thêm CORS), nên preflight
//!   qua proxy chỉ có một `Access-Control-Allow-Origin`.

mod proxy;
mod table;

use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::middleware::from_fn_with_state;
use axum::response::Response;
use tower::ServiceExt;

use crate::edge::client_ip::{ClientIpResolver, client_ip_layer};

pub use proxy::{NodeProxy, ProxyTimeouts};
pub use table::{OwnershipTable, initial_from_routes_env, spawn_sighup_reloader};
pub use trinity_kernel::ownership::Owner;

struct Dispatch {
    table: Arc<OwnershipTable>,
    rust: Router,
    proxy: NodeProxy,
}

/// Router ngoài cùng: xác định IP khách MỘT lần (K16) rồi chia theo bảng sở hữu. `rust` đã gắn sẵn mọi lớp của Rust
/// (CORS, giới hạn body…) và không bao giờ nhận request thuộc Node.
pub fn dispatcher(table: Arc<OwnershipTable>, rust: Router, proxy: NodeProxy, ip: Arc<ClientIpResolver>) -> Router {
    let d = Arc::new(Dispatch { table, rust, proxy });
    Router::new()
        .fallback(dispatch)
        .with_state(d)
        .layer(from_fn_with_state(ip, client_ip_layer))
}

async fn dispatch(State(d): State<Arc<Dispatch>>, req: Request) -> Response {
    let owner = d.table.current().route(req.method().as_str(), req.uri().path()).owner;
    match owner {
        Owner::Rust => match d.rust.clone().oneshot(req).await {
            Ok(resp) => resp,
            Err(never) => match never {},
        },
        Owner::Node => d.proxy.forward(req).await,
    }
}
