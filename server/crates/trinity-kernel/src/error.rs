//! Kiểu lỗi và phản hồi lỗi giống NestJS (PLAN 1.2, 4.4).
//!
//! Hình dạng body như `ElkExceptionFilter` (`packages/logger/src/elk-exception.filter.ts`):
//! `{ statusCode, message, error, errors? }`.
//!
//! - [`HttpError`] tương ứng `HttpException` và các lớp con có sẵn của Nest (`BadRequestException`…): cùng cách dựng
//!   `message` và `error` khi có hoặc không có câu, khi câu là mảng (ValidationPipe), khi có lỗi từng trường.
//! - Lỗi 5xx luôn trả `error: "Internal Server Error"`, không bao giờ kèm `errors`; lỗi không phải [`HttpError`] (DB,
//!   lỗi nội bộ) trả `message: "Internal server error"`, chi tiết chỉ vào log.
//! - Dịch lỗi ngữ cảnh công ty như `translateTenantError`: thiếu công ty ở request không đăng nhập ⇒ 404; lỗi trigger
//!   đa công ty (`TRINITY_EMAIL_TAKEN`, `TRINITY_ROUTE_TAKEN`) ⇒ 409 với câu tiếng Việt.
//! - [`DbError`]: bảng ánh xạ SQLSTATE sang mã Prisma của bản TS ở **một** chỗ (23505 ↔ P2002, 23503 ↔ P2003, cập
//!   nhật/xoá 0 dòng ↔ P2025). Chỗ nào bản TS bắt mã Prisma để trả 404/409 thì handler Rust bắt [`DbErrorKind`] tương
//!   ứng; không bắt thì thành 500 như bản TS.
//!
//! Golden của bản Node: `server/contracts/errors.golden.json` (sinh bằng `packages/logger/src/error-golden.spec.ts`).

use std::fmt;

use serde::Serialize;
use serde_json::Value;

/// `message` của body: một câu, hoặc danh sách câu (lỗi ValidationPipe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Message {
    One(String),
    Many(Vec<String>),
}

impl From<&str> for Message {
    fn from(s: &str) -> Self {
        Message::One(s.to_owned())
    }
}

impl From<String> for Message {
    fn from(s: String) -> Self {
        Message::One(s)
    }
}

impl From<Vec<String>> for Message {
    fn from(v: Vec<String>) -> Self {
        Message::Many(v)
    }
}

/// Body JSON của phản hồi lỗi, thứ tự khoá như bản Node.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ErrorBody {
    #[serde(rename = "statusCode")]
    pub status_code: u16,
    pub message: Message,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Value>,
}

/// Mô tả mặc định của các lớp lỗi có sẵn trong Nest (`description` của `HttpException`).
pub fn nest_description(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        418 => "I'm a teapot",
        421 => "Misdirected",
        422 => "Unprocessable Entity",
        // Không phải lớp có sẵn của Nest; câu của ThrottlerException.
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        _ => return None,
    })
}

/// Lỗi HTTP do mã nghiệp vụ chủ động trả (tương ứng `HttpException` của Nest).
#[derive(Debug, Clone, PartialEq)]
pub struct HttpError {
    status: u16,
    message: Message,
    /// Trường `error` của body gốc (Nest ghi mô tả của lớp lỗi); `None` ⇒ filter lấy `message`.
    label: Option<String>,
    /// Lỗi từng trường (`{ khoá: lý do }`), chỉ trả ra ngoài khi < 500.
    errors: Option<Value>,
}

impl HttpError {
    /// `new HttpException('câu', status)`: body là chuỗi ⇒ `error` = câu.
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: Message::One(message.into()),
            label: None,
            errors: None,
        }
    }

    /// Lớp lỗi có sẵn của Nest, vd `new NotFoundException('câu')` hay `new NotFoundException()`:
    /// `error` = mô tả của lớp; không có câu thì `message` cũng là mô tả đó.
    ///
    /// Câu rỗng tính như không có câu (Nest kiểm `!objectOrError`). Mã không có lớp lỗi trong [`nest_description`]
    /// dùng mô tả chung (`Internal Server Error` cho 5xx, `Error` cho mã khác) — không panic: bản release biên dịch với
    /// `panic = "abort"`.
    pub fn nest(status: u16, message: Option<Message>) -> Self {
        let description = nest_description(status).unwrap_or(if status >= 500 {
            "Internal Server Error"
        } else {
            "Error"
        });
        let message = message.filter(|m| !matches!(m, Message::One(s) if s.is_empty()));
        Self {
            status,
            message: message.unwrap_or_else(|| Message::One(description.to_owned())),
            label: Some(description.to_owned()),
            errors: None,
        }
    }

    /// `new HttpException({ message, error }, status)`: body đối tượng có nhãn riêng.
    pub fn with_label(status: u16, message: impl Into<Message>, label: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            label: Some(label.into()),
            errors: None,
        }
    }

    /// `new BadRequestException({ statusCode: 400, message, errors })`: lỗi từng trường; không có nhãn nên `error` =
    /// `message`.
    pub fn field_errors(message: impl Into<String>, errors: Value) -> Self {
        Self {
            status: 400,
            message: Message::One(message.into()),
            label: None,
            errors: Some(errors),
        }
    }

    pub fn bad_request(message: impl Into<Message>) -> Self {
        Self::nest(400, Some(message.into()))
    }

    /// Lỗi của ValidationPipe: danh sách câu.
    pub fn validation(messages: Vec<String>) -> Self {
        Self::nest(400, Some(Message::Many(messages)))
    }

    /// Lỗi của `ParseIntPipe` khi tham số đường dẫn không phải số.
    pub fn parse_int_failed() -> Self {
        Self::bad_request("Validation failed (numeric string is expected)")
    }

    pub fn unauthorized(message: impl Into<Message>) -> Self {
        Self::nest(401, Some(message.into()))
    }

    pub fn forbidden(message: impl Into<Message>) -> Self {
        Self::nest(403, Some(message.into()))
    }

    pub fn not_found(message: impl Into<Message>) -> Self {
        Self::nest(404, Some(message.into()))
    }

    pub fn conflict(message: impl Into<Message>) -> Self {
        Self::nest(409, Some(message.into()))
    }

    pub fn payload_too_large(message: impl Into<Message>) -> Self {
        Self::nest(413, Some(message.into()))
    }

    pub fn service_unavailable(message: impl Into<Message>) -> Self {
        Self::nest(503, Some(message.into()))
    }

    pub fn status(&self) -> u16 {
        self.status
    }

    /// Body như `ElkExceptionFilter` dựng.
    pub fn body(&self) -> ErrorBody {
        let server = self.status >= 500;
        let error = if server {
            "Internal Server Error".to_owned()
        } else {
            match (&self.label, &self.message) {
                (Some(l), _) => l.clone(),
                (None, Message::Many(_)) => "Bad Request".to_owned(),
                (None, Message::One(m)) => m.clone(),
            }
        };
        ErrorBody {
            status_code: self.status,
            message: self.message.clone(),
            error,
            // Như bản Node: chỉ giữ `errors` là object/mảng (`typeof extra === 'object'`, khác null).
            errors: if server {
                None
            } else {
                self.errors.clone().filter(|e| e.is_object() || e.is_array())
            },
        }
    }
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.message {
            Message::One(m) => write!(f, "{} {m}", self.status),
            Message::Many(ms) => write!(f, "{} {}", self.status, ms.join("; ")),
        }
    }
}

impl std::error::Error for HttpError {}

/// Loại lỗi DB theo hành vi của bản TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbErrorKind {
    /// SQLSTATE 23505 ↔ Prisma `P2002`.
    UniqueViolation,
    /// SQLSTATE 23503 ↔ Prisma `P2003`.
    ForeignKeyViolation,
    /// Cập nhật/xoá theo khoá ảnh hưởng 0 dòng ↔ Prisma `P2025`.
    NotFound,
    /// Mọi lỗi khác (500 nếu không ai bắt).
    Other,
}

impl DbErrorKind {
    /// Bảng ánh xạ SQLSTATE (PLAN 4.4).
    pub fn from_sqlstate(code: &str) -> Self {
        match code {
            "23505" => Self::UniqueViolation,
            "23503" => Self::ForeignKeyViolation,
            _ => Self::Other,
        }
    }

    /// Mã Prisma tương ứng của bản TS.
    pub fn prisma_code(self) -> Option<&'static str> {
        match self {
            Self::UniqueViolation => Some("P2002"),
            Self::ForeignKeyViolation => Some("P2003"),
            Self::NotFound => Some("P2025"),
            Self::Other => None,
        }
    }
}

/// Lỗi DB đã phân loại. Crate `trinity-db` dựng từ `sqlx::Error` (SQLSTATE, tên ràng buộc, câu lỗi).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbError {
    pub kind: DbErrorKind,
    pub sqlstate: Option<String>,
    /// Tên ràng buộc (vd `products_code_key`), để chỗ bắt lỗi kiểm đúng ràng buộc như `err.meta.target` ở bản TS.
    pub constraint: Option<String>,
    /// Câu lỗi của Postgres; chỉ vào log, không bao giờ vào body.
    pub message: String,
}

impl DbError {
    /// Lỗi từ Postgres.
    pub fn from_postgres(sqlstate: Option<&str>, constraint: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            kind: sqlstate.map_or(DbErrorKind::Other, DbErrorKind::from_sqlstate),
            sqlstate: sqlstate.map(str::to_owned),
            constraint: constraint.map(str::to_owned),
            message: message.into(),
        }
    }

    /// Hàm repository `update_*`/`delete_*` ảnh hưởng 0 dòng (↔ `P2025`).
    pub fn not_found() -> Self {
        Self {
            kind: DbErrorKind::NotFound,
            sqlstate: None,
            constraint: None,
            message: "Không có dòng nào được cập nhật hoặc xoá".to_owned(),
        }
    }

    /// Đúng loại và (nếu có) đúng ràng buộc — dùng ở chỗ bản TS bắt `P2002` của một unique index cụ thể.
    pub fn is(&self, kind: DbErrorKind, constraint: Option<&str>) -> bool {
        self.kind == kind && constraint.is_none_or(|c| self.constraint.as_deref() == Some(c))
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.sqlstate {
            Some(s) => write!(f, "lỗi DB {s}: {}", self.message),
            None => write!(f, "lỗi DB: {}", self.message),
        }
    }
}

impl std::error::Error for DbError {}

/// Lỗi của một request.
#[derive(Debug)]
pub enum AppError {
    /// Lỗi HTTP chủ động trả.
    Http(HttpError),
    /// Lỗi DB không được bắt ở chỗ gọi.
    Db(DbError),
    /// Không xác định được công ty của request (`MissingCompanyContextError`).
    MissingCompanyContext,
    /// Lỗi nội bộ khác (500, chi tiết chỉ vào log).
    Internal(Box<dyn std::error::Error + Send + Sync>),
}

impl From<HttpError> for AppError {
    fn from(e: HttpError) -> Self {
        Self::Http(e)
    }
}

impl From<DbError> for AppError {
    fn from(e: DbError) -> Self {
        Self::Db(e)
    }
}

const EMAIL_TAKEN: &str = "Email này đã được dùng cho một công ty khác trên Trinity";
const ROUTE_TAKEN: &str = "Trang/kênh này đã được một công ty khác kết nối với Trinity";

impl AppError {
    /// Lỗi nội bộ từ một giá trị lỗi bất kỳ. Nếu bên trong thực ra là [`HttpError`], [`DbError`] hay [`AppError`] (vd
    /// đi qua `?` của một hàm trả `Box<dyn Error>`) thì giữ nguyên loại đó, không biến thành 500.
    pub fn internal(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        let e = e.into();
        let e = match e.downcast::<AppError>() {
            Ok(app) => return *app,
            Err(e) => e,
        };
        let e = match e.downcast::<HttpError>() {
            Ok(h) => return Self::Http(*h),
            Err(e) => e,
        };
        match e.downcast::<DbError>() {
            Ok(d) => Self::Db(*d),
            Err(e) => Self::Internal(e),
        }
    }

    /// Dịch lỗi ngữ cảnh công ty như `translateTenantError()`. `authenticated`: request mang thông tin đăng nhập
    /// (JWT, API key, bearer MCP) — thiếu công ty ở đó là lỗi máy chủ (500), không phải "không tìm thấy".
    pub fn translate_tenant(self, authenticated: bool) -> Self {
        let text = match &self {
            Self::Http(_) => return self,
            Self::MissingCompanyContext => {
                return if authenticated {
                    self
                } else {
                    HttpError::new(404, "Không tìm thấy").into()
                };
            }
            Self::Db(e) => e.message.clone(),
            Self::Internal(e) => e.to_string(),
        };
        if text.contains("TRINITY_EMAIL_TAKEN") {
            HttpError::new(409, EMAIL_TAKEN).into()
        } else if text.contains("TRINITY_ROUTE_TAKEN") {
            HttpError::new(409, ROUTE_TAKEN).into()
        } else {
            self
        }
    }

    /// Mã trạng thái và body trả cho client (sau [`Self::translate_tenant`]).
    pub fn response(self, authenticated: bool) -> (u16, ErrorBody) {
        match self.translate_tenant(authenticated) {
            Self::Http(h) => (h.status(), h.body()),
            Self::Db(_) | Self::MissingCompanyContext | Self::Internal(_) => (
                500,
                ErrorBody {
                    status_code: 500,
                    message: Message::One("Internal server error".to_owned()),
                    error: "Internal Server Error".to_owned(),
                    errors: None,
                },
            ),
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(e) => e.fmt(f),
            Self::Db(e) => e.fmt(f),
            Self::MissingCompanyContext => f.write_str("không có ngữ cảnh công ty"),
            Self::Internal(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests;
