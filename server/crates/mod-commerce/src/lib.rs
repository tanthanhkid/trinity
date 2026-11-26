//! Module commerce (M25 sản phẩm/danh mục/thuộc tính, M28 dự án), chuyển từ `services/commerce`.
//!
//! Mỗi hàm nhận `&mut PgConnection` đã gắn công ty (`TenantConn`/`TenantTx` của K06 deref ra kiểu này) và trả
//! `AppError` của K05, nên tầng route chỉ việc: extractor K15 → hàm ở đây → JSON. Route, quyền (`products.view`,
//! `products.manage`) và DTO được nối vào router khi K14/K11 có trên main; xem mô tả PR.

pub mod attribute_defs;
pub mod attributes;
pub mod categories;
pub mod image;
mod nullable;
pub mod products;
pub mod projects;

/// Người gọi, đủ cho các kiểm quyền theo dữ liệu (xoá, khôi phục, xoá hẳn). Do guard xác thực (K11) điền vào.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Actor {
    pub user_id: i32,
    pub is_admin: bool,
}
