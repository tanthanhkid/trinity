//! Kiểm dữ liệu vào theo chế độ strict và lenient như `ServiceAwareValidationPipe` của bản TS (K15).
//!
//! Bản TS kiểm body/query bằng `ValidationPipe({ whitelist: true, forbidNonWhitelisted, transform: true })` của Nest
//! trên DTO class-validator/class-transformer. Bản Rust không chép tay từng DTO mà đọc **metadata thật** của chúng do
//! `apps/monolith/src/__tests__/dto-validation-contract.spec.ts` xuất ra `server/contracts/dto/schema.json`, rồi chạy cùng
//! thuật toán (chuyển kiểu, @Transform, whitelist, luật theo thứ tự đăng ký, gom lỗi lồng) trên giá trị JSON thô. Kết
//! quả thành công được deserialize vào struct Rust của handler; struct khung sinh bằng `cargo xtask gen-dto <Dto>`.
//!
//! Lý do không dùng `garde` như PLAN 4.2 ghi: class-validator báo lỗi kiểu ("must be a string") như một câu lỗi
//! trong cùng mảng với các luật khác, theo thứ tự decorator, trước khi có kiểu Rust; garde chạy sau serde (lỗi kiểu
//! thành lỗi phân tích, mất mảng câu) và có câu riêng. Golden 340 ca của 20 DTO khớp từng câu (test `golden_*`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

mod conds;
mod engine;
pub mod extract;
pub mod js;
mod rules;
pub mod schema;
mod transforms;

use std::sync::LazyLock;

use serde::de::DeserializeOwned;
use serde_json::Value;
use trinity_kernel::error::{AppError, HttpError, Message};

pub use extract::{ValidJson, ValidQuery, parse_int_param, query_to_json};
use js::JsVal;
pub use schema::Registry;

/// Chế độ kiểm của route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Trường lạ ⇒ 400 "property x should not exist".
    Strict,
    /// Trường lạ bị bỏ lặng lẽ.
    Lenient,
}

/// Tiền tố route giữ chế độ lenient (bản TS: auth, payroll, notification). So bằng `startsWith` như bản TS.
pub const LENIENT_PREFIXES: &[&str] = &[
    "/api/v1/auth",
    "/api/v1/public/auth",
    "/api/v1/api-keys",
    "/api/v1/users",
    "/api/v1/roles",
    "/api/v1/teams",
    "/api/v1/employees",
    "/api/v1/kpi",
    "/api/v1/payslips",
    "/api/v1/salary-rules",
    "/api/v1/notifications",
    "/api/v1/templates",
];

/// Chế độ theo đường dẫn request.
pub fn mode_for_path(path: &str) -> Mode {
    if LENIENT_PREFIXES.iter().any(|p| path.starts_with(p)) {
        Mode::Lenient
    } else {
        Mode::Strict
    }
}

/// DTO có metadata trong `schema.json`.
pub trait Dto: DeserializeOwned {
    /// Tên class TS (khoá trong `schema.json`).
    const NAME: &'static str;
}

static SCHEMA: LazyLock<Result<Registry, String>> =
    LazyLock::new(|| Registry::from_json(include_str!("../../../../contracts/dto/schema.json")));

/// Registry nạp từ `schema.json` nhúng trong binary.
pub fn registry() -> Result<&'static Registry, &'static str> {
    SCHEMA.as_ref().map_err(String::as_str)
}

/// Kiểm và chuyển một giá trị JSON theo DTO `name`. Lỗi kiểm ⇒ 400 như Nest; schema hỏng/thiếu DTO ⇒ 500.
pub fn validate_value(name: &str, input: &Value, mode: Mode) -> Result<Value, AppError> {
    let reg = registry().map_err(|e| AppError::internal(format!("schema DTO không nạp được: {e}")))?;
    let class = reg
        .class(name)
        .ok_or_else(|| AppError::internal(format!("DTO {name} không có trong schema.json")))?;
    match engine::run(reg, class, &JsVal::from_json(input), mode) {
        Ok(v) => Ok(v.to_json().unwrap_or(Value::Object(serde_json::Map::new()))),
        Err(messages) => Err(HttpError::nest(400, Some(Message::Many(messages))).into()),
    }
}

/// [`validate_value`] rồi deserialize vào `T`. Lệch kiểu giữa struct và schema là lỗi máy chủ (500).
pub fn validate_into<T: Dto>(input: &Value, mode: Mode) -> Result<T, AppError> {
    let v = validate_value(T::NAME, input, mode)?;
    serde_json::from_value(v).map_err(|e| AppError::internal(format!("struct {} lệch schema: {e}", T::NAME)))
}

#[cfg(test)]
mod tests;
