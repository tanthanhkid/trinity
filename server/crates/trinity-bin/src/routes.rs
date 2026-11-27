//! Bảng route đã khai của binary và kiểm với `contracts/routes.json` (K14).
//!
//! Mỗi module thêm hàm `routes()` vào [`declared_routes`] khi có route đầu tiên. Kiểm chạy ở: test đơn vị bên dưới (mọi
//! lần `cargo test -p trinity-bin`), `trinity check-config` (chạy thử lúc khởi động) và `trinity check-routes` /
//! `cargo xtask check-routes`; lệnh `serve` (chưa có) gọi [`boot_check`] trước khi mở cổng.

use trinity_http::router::RouteSpec;
use trinity_http::router::check::{Report, check_embedded};

pub fn declared_routes() -> Vec<RouteSpec> {
    let mut v = Vec::new();
    v.extend(mod_system::routes());
    v.extend(mod_users::specs());
    v.extend(mod_kanban::routes::routes());
    v
}

/// So bảng đã khai với hợp đồng nhúng. `require_all`: đòi khai đủ mọi route (cổng cuối X06).
pub fn check(require_all: bool) -> Report {
    check_embedded(&declared_routes(), require_all)
}

/// Lỗi lệch bảng route thì binary không được khởi động.
pub fn boot_check() -> Result<(), String> {
    let rep = check(false);
    if rep.ok() {
        Ok(())
    } else {
        Err(format!("bảng route lệch routes.json:\n- {}", rep.problems.join("\n- ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bang_route_da_khai_khop_routes_json() {
        let rep = check_embedded(&declared_routes(), false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert!(boot_check().is_ok());
    }
}
