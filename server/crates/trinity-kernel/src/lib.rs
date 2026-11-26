//! Nền dùng chung: cấu hình, lỗi → JSON, giờ Việt Nam, fold_vi, số điện thoại, tiền, serializer JSON, trait cổng giữa các module.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1:
//! - [`config`], [`ownership`]: cấu hình từ env, tệp sở hữu route (K03); [`error`]: lỗi → JSON kiểu NestJS (K05);
//! - hàm thuần chuyển từ bản TS (K26), khớp từng byte qua bảng ca dùng chung `server/contracts/cases/kernel.json` (TS
//!   sinh kết quả, Rust chạy cùng bảng ở `tests/shared_cases.rs`): [`vi`] bỏ dấu tiếng Việt (`fold_vi`, bảng `translate`
//!   của Postgres) và so sánh chuỗi như `localeCompare`; [`phone`] số điện thoại Việt Nam; [`vn_time`] giờ Việt Nam,
//!   khoảng ngày lọc, định dạng ngày giờ; [`number`] định dạng số.

pub mod config;
pub mod error;
pub mod number;
pub mod ownership;
pub mod phone;
pub mod vi;
pub mod vn_time;
