//! Đọc/ghi xlsx, pdf, xử lý ảnh.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1:
//! - [`xlsx`]: ghi bảng tính xuất dữ liệu (thay `exceljs` ở 13 chỗ xuất) và đọc tệp người dùng tải lên (nhập phiếu lương).
//! - [`image`]: thu nhỏ ảnh tải lên (avatar, ảnh nhân viên, ảnh bảng tin) thay `sharp` của bản Node.

pub mod image;
pub mod xlsx;
