//! Module trang bán hàng (M56, docs/rust/PLAN.md mục 4.7), chuyển từ `services/crm/src/store`. 7 endpoint, 3 công khai:
//!
//! | Route | Quyền | Hàm |
//! |---|---|---|
//! | `GET`/`PUT /store/settings` | `pos.manage` + tính năng `online_store` | [`settings::load`] + [`settings::view`], [`settings::save`] |
//! | `GET /store/orders` | `deals.view` + `online_store` | [`shop::list_orders`] |
//! | `PATCH /store/orders/:id` | `deals.manage` + `online_store` | [`shop::update_order_status`] |
//! | `GET /store/public/:slug` | công khai | [`shop::public_store`] |
//! | `POST /store/public/:slug/orders` | công khai, 5 đơn/10 phút/IP | [`shop::place_order`] |
//! | `GET /store/public/:slug/orders/:code` | công khai (cần đúng SĐT) | [`shop::order_status`] |
//!
//! Thanh toán chỉ còn COD và QR VietQR tĩnh ([`vietqr`], bảng ca dùng chung với bản TS `server/contracts/cases/vietqr.json`);
//! không cổng thanh toán, không tự khớp tiền. Địa chỉ cửa hàng (`slug`) thuộc MỘT công ty ([`settings::save`] giữ chỗ bằng
//! `Platform::claim_route`), nên link công khai không cần `?cid=`. Chưa nối route (như M33–M35): tầng route lo cờ tính năng,
//! quyền và phạm vi (`deals.view`, `deals.manage`, `contacts.phone_full` do `ScopeService`), chọn công ty cho đường công khai
//! (`?cid=` hoặc `Platform::company_for_route(StoreSlug, slug)`, không có ⇒ 404 "Không có cửa hàng này."), IP khách
//! ([`shop::OrderLimits::client_key`]) và đẩy 429 kèm `Retry-After`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod routes;
pub mod settings;
pub mod shop;
pub mod vietqr;

pub use routes::specs;

pub(crate) fn db(e: sqlx::Error) -> trinity_kernel::error::AppError {
    trinity_db::pg_error::app_error(&e)
}
