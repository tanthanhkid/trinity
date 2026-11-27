//! X15b: xuất tệp dài chạy nền rồi tải về sau.
//!
//! Route xuất đồng bộ giữ kết nối tới khi dựng xong tệp; sau proxy Cloudflare kết nối quá 100 giây bị cắt. Module này
//! chuyển việc dựng tệp sang `platform.jobs` (K21): request chỉ xếp việc và trả ngay `202 { id }`, worker dựng tệp
//! bằng CHÍNH hàm xuất đồng bộ (nên tệp giống hệt), web hỏi tiến độ rồi tải.
//!
//! | Route | Việc |
//! |---|---|
//! | `POST /api/v1/exports/contacts` | xếp việc xuất danh bạ (cùng query và quyền `contacts.export` như `GET /contacts/export`) |
//! | `GET /api/v1/exports/:id` | trạng thái, tiến độ (chỉ của chính người xếp việc) |
//! | `GET /api/v1/exports/:id/download` | tải tệp khi `status = done` |
//!
//! Phạm vi dữ liệu (`Scopes`) chốt LÚC XẾP VIỆC rồi ghi vào payload, worker không tra lại quyền: tệp là ảnh chụp theo
//! quyền của người bấm tại thời điểm bấm. Tệp lưu trong `platform.export_files` (bytea), hết hạn sau
//! [`store::TTL_HOURS`] giờ và bị dọn mỗi lần có việc xuất mới.
//!
//! Thêm loại xuất mới: một nhánh trong [`worker::build`], một route xếp việc (`enqueue_*`), không đổi phần còn lại.
//! Các route này KHÔNG có trong `contracts/routes.json` (không thuộc phạm vi tương thích với bản TS) nên không vào
//! `declared_routes`; bảng sở hữu phải có tiền tố `/api/v1/exports` thuộc Rust.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod contacts;
pub mod routes;
pub mod store;
pub mod worker;

/// Loại việc trong `platform.jobs`.
pub const JOB_KIND: &str = "export.run";

/// Tệp đã dựng xong, chờ lưu.
#[derive(Debug)]
pub struct ExportFile {
    pub filename: String,
    pub content_type: &'static str,
    pub data: Vec<u8>,
}

pub const XLSX_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
