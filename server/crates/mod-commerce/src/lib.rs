//! Module commerce (M25 sản phẩm/danh mục/thuộc tính, M28 dự án), chuyển từ `services/commerce`.
//!
//! Mỗi hàm nhận `&mut PgConnection` đã gắn công ty (`TenantConn`/`TenantTx` của K06 deref ra kiểu này) và trả
//! `AppError` của K05, nên tầng route chỉ việc: extractor K15 → hàm ở đây → JSON. Route, quyền (`products.view`,
//! `products.manage`) và DTO được nối vào router khi K14/K11 có trên main; xem mô tả PR.

pub mod projects;
