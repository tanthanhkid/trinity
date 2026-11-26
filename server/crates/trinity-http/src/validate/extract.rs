//! Extractor axum: `ValidJson<T>` (body JSON), `ValidQuery<T>` (query string), và `parse_int_param` (thay
//! `ParseIntPipe`). Lỗi trả body dạng Nest (`trinity_kernel::error`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use axum::Json;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use trinity_kernel::error::{AppError, HttpError};

use super::{Dto, mode_for_path, validate_into};

/// Phản hồi lỗi JSON dạng Nest.
pub fn error_response(e: AppError) -> Response {
    let (status, body) = e.response(false);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

/// Body JSON đã kiểm theo DTO `T` (chế độ theo đường dẫn).
#[derive(Debug, Clone)]
pub struct ValidJson<T>(pub T);

impl<T: Dto, S: Send + Sync> FromRequest<S> for ValidJson<T> {
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Response> {
        let mode = mode_for_path(req.uri().path());
        // Phân tích body (giới hạn, lỗi cú pháp, Content-Type) thuộc K16; ở đây body hỏng ⇒ 400.
        let Json(v) = Json::<Value>::from_request(req, state)
            .await
            .map_err(|e| error_response(HttpError::bad_request(e.body_text()).into()))?;
        validate_into::<T>(&v, mode).map(ValidJson).map_err(error_response)
    }
}

/// Query string đã kiểm theo DTO `T`.
#[derive(Debug, Clone)]
pub struct ValidQuery<T>(pub T);

impl<T: Dto, S: Send + Sync> FromRequestParts<S> for ValidQuery<T> {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Response> {
        let mode = mode_for_path(parts.uri.path());
        let v = query_to_json(parts.uri.query().unwrap_or(""));
        validate_into::<T>(&v, mode).map(ValidQuery).map_err(error_response)
    }
}

/// Query string → đối tượng JSON như `qs` của Express ở các dạng hay gặp: `a=1`, khoá lặp `a=1&a=2` và `a[]=1` thành
/// mảng chuỗi, `a[b]=1` thành đối tượng một cấp. Giá trị luôn là chuỗi (như Express).
pub fn query_to_json(query: &str) -> Value {
    let mut out = Map::new();
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        let (key, sub) = match k.split_once('[') {
            Some((base, rest)) if rest.ends_with(']') && !base.is_empty() => {
                (base.to_owned(), Some(rest[..rest.len() - 1].to_owned()))
            }
            _ => (k.into_owned(), None),
        };
        let val = Value::String(v.into_owned());
        match sub {
            Some(s) if !s.is_empty() => {
                let entry = out.entry(key).or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(m) = entry {
                    m.insert(s, val);
                }
            }
            Some(_) => match out.entry(key).or_insert_with(|| Value::Array(Vec::new())) {
                Value::Array(a) => a.push(val),
                other => *other = Value::Array(vec![other.clone(), val]),
            },
            None => match out.get_mut(&key) {
                None => {
                    out.insert(key, val);
                }
                Some(Value::Array(a)) => a.push(val),
                Some(other) => *other = Value::Array(vec![other.clone(), val]),
            },
        }
    }
    Value::Object(out)
}

/// `ParseIntPipe`: `/^-?\d+$/` ⇒ số, không thì 400 "Validation failed (numeric string is expected)". Số vượt i64 cũng
/// 400 (bản TS nhận và mất chính xác; id không bao giờ lớn tới đó).
pub fn parse_int_param(s: &str) -> Result<i64, HttpError> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(HttpError::parse_int_failed());
    }
    s.parse::<i64>().map_err(|_| HttpError::parse_int_failed())
}
