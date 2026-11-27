//! Đọc/ghi xlsx, pdf, xử lý ảnh.
//!
//! Phạm vi theo docs/rust/PLAN.md mục 4.1:
//! - [`xlsx`]: ghi bảng tính xuất dữ liệu (thay `exceljs` ở 13 chỗ xuất) và đọc tệp người dùng tải lên (nhập phiếu lương).
//! - [`grid`]: xlsx theo lưới tự do (gộp ô, tô nền, độ cao dòng) cho phiếu lương và danh sách lương.
//! - [`pdf`]: PDF A4 nhúng phông Tinos (phiếu lương) thay `pdfkit`.
//! - [`image`]: thu nhỏ ảnh tải lên (avatar, ảnh nhân viên, ảnh bảng tin) thay `sharp` của bản Node.

pub mod grid;
pub mod image;
pub mod pdf;
pub mod xlsx;
