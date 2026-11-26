//! Giới hạn body, raw body, stream lớn và multipart (K16). Trùng `bootstrap-app.ts`: JSON và urlencoded tối đa
//! 5 MB, `rawBody` giữ lại cho JSON (HMAC webhook); tải lên lớn đọc theo luồng, không gom vào bộ nhớ.
//!
//! Lớp [`body_limit_layer`] chặn ngay từ `Content-Length` quá hạn mức rồi ghi hạn mức vào request; mọi bộ đọc ở đây
//! ([`read_limited`], [`ParsedBody`], [`limit_stream`]) cũng chặn khi body chunked vượt hạn mức. Lỗi trả đúng dạng
//! Nest (`{statusCode:413, message, error}`).

use axum::body::{Body, Bytes};
use axum::extract::{FromRequest, Multipart, Request, multipart::Field};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;

/// JSON và urlencoded: 5 MB.
pub const JSON_LIMIT: usize = 5 * 1024 * 1024;
/// Tải lên theo luồng (video, tệp lớn): 200 MB.
pub const STREAM_LIMIT: usize = 200 * 1024 * 1024;
/// Thông điệp của body-parser (`PayloadTooLargeError`).
pub const TOO_LARGE_MSG: &str = "request entity too large";

/// Hạn mức body của route, ghi vào extension của request bởi [`body_limit_layer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BodyLimit(pub usize);

/// Phản hồi lỗi theo dạng Nest.
pub fn error_response(e: &HttpError) -> Response {
    let body = serde_json::to_vec(&e.body()).unwrap_or_default();
    let status = StatusCode::from_u16(e.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

fn declared_length(h: &HeaderMap) -> Option<u64> {
    h.get(header::CONTENT_LENGTH)?.to_str().ok()?.trim().parse().ok()
}

/// `from_fn` cho từng nhóm route: `middleware::from_fn(|req, next| body_limit_layer(JSON_LIMIT, req, next))`, hoặc
/// [`json_limit`] / [`stream_limit`] dựng sẵn. `Content-Length` vượt hạn mức ⇒ 413 trước khi đọc một byte body.
pub async fn body_limit_layer(max: usize, mut req: Request, next: Next) -> Response {
    if declared_length(req.headers()).is_some_and(|n| n > max as u64) {
        return error_response(&HttpError::payload_too_large(TOO_LARGE_MSG));
    }
    req.extensions_mut().insert(BodyLimit(max));
    next.run(req).await
}

pub async fn json_limit(req: Request, next: Next) -> Response {
    body_limit_layer(JSON_LIMIT, req, next).await
}

pub async fn stream_limit(req: Request, next: Next) -> Response {
    body_limit_layer(STREAM_LIMIT, req, next).await
}

/// Hạn mức body của request (mặc định [`JSON_LIMIT`]).
pub fn limit_of(req: &Request) -> usize {
    req.extensions().get::<BodyLimit>().map_or(JSON_LIMIT, |l| l.0)
}

/// Đọc cả body vào bộ nhớ, tối đa `max` byte.
pub async fn read_limited(body: Body, max: usize) -> Result<Bytes, HttpError> {
    let mut body = body;
    let mut buf = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| HttpError::bad_request("Bad Request"))?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > max {
                return Err(HttpError::payload_too_large(TOO_LARGE_MSG));
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(Bytes::from(buf))
}

/// Bọc body thành luồng có hạn mức: vượt `max` byte thì luồng trả lỗi (handler đổi thành 413). Không đệm.
pub fn limit_stream(body: Body, max: usize) -> LimitedStream {
    LimitedStream {
        inner: body,
        remaining: max,
    }
}

/// Lỗi của [`LimitedStream`]: vượt hạn mức hoặc lỗi đọc.
#[derive(Debug, PartialEq, Eq)]
pub enum StreamError {
    TooLarge,
    Read,
}

impl From<StreamError> for HttpError {
    fn from(e: StreamError) -> Self {
        match e {
            StreamError::TooLarge => HttpError::payload_too_large(TOO_LARGE_MSG),
            StreamError::Read => HttpError::bad_request("Bad Request"),
        }
    }
}

pub struct LimitedStream {
    inner: Body,
    remaining: usize,
}

impl LimitedStream {
    /// Lấy mảnh dữ liệu kế tiếp (`None` = hết body).
    pub async fn next_chunk(&mut self) -> Option<Result<Bytes, StreamError>> {
        loop {
            match self.inner.frame().await? {
                Err(_) => return Some(Err(StreamError::Read)),
                Ok(frame) => {
                    let Ok(data) = frame.into_data() else { continue };
                    if data.len() > self.remaining {
                        self.remaining = 0;
                        return Some(Err(StreamError::TooLarge));
                    }
                    self.remaining -= data.len();
                    return Some(Ok(data));
                }
            }
        }
    }
}

/// Body JSON hoặc urlencoded đã phân tích, kèm `raw` (byte nguyên văn của body JSON, để kiểm HMAC webhook; `None` với
/// urlencoded, body rỗng hay kiểu khác — như `rawBody` của bản Node).
///
/// - `application/json` (và `*+json`): phân tích JSON; body rỗng ⇒ `{}`; JSON sai ⇒ 400.
/// - `application/x-www-form-urlencoded`: khoá lặp ⇒ mảng; `a[b]=c` thành đối tượng lồng nhau (một mức cho `a[]`).
/// - Kiểu khác: bỏ qua body (`{}`), giống Express.
#[derive(Debug)]
pub struct ParsedBody<T> {
    pub value: T,
    pub raw: Option<Bytes>,
}

fn content_type(h: &HeaderMap) -> String {
    h.get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default()
}

/// urlencoded theo `qs` extended (chung bộ phân tích với query string của K15): chỉ số mảng ≤ 20, ngoặc lồng ≤ 5,
/// khoá trùng gộp thành mảng/đối tượng thay vì ghi đè.
pub fn parse_urlencoded(bytes: &[u8]) -> Value {
    crate::validate::query_to_json(&String::from_utf8_lossy(bytes))
}

impl<S, T> FromRequest<S> for ParsedBody<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = Response;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let max = limit_of(&req);
        let ct = content_type(req.headers());
        let is_json = ct == "application/json";
        let is_form = ct == "application/x-www-form-urlencoded";
        let empty = || {
            serde_json::from_value::<T>(Value::Object(Map::new()))
                .map_err(|e| error_response(&HttpError::bad_request(e.to_string())))
        };
        if !is_json && !is_form {
            return Ok(ParsedBody {
                value: empty()?,
                raw: None,
            });
        }
        // Không giải nén: Content-Encoding khác identity ⇒ 415 (body-parser mặc định của Nest có giải nén, nhưng web/Caddy
        // không gửi body nén tới API; từ chối rõ ràng tốt hơn đọc rác).
        if let Some(enc) = req
            .headers()
            .get(header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            && !enc.trim().is_empty()
            && !enc.trim().eq_ignore_ascii_case("identity")
        {
            return Err(error_response(&HttpError::with_label(
                415,
                "unsupported content encoding",
                "Unsupported Media Type",
            )));
        }
        let bytes = read_limited(req.into_body(), max)
            .await
            .map_err(|e| error_response(&e))?;
        if is_json {
            // Chế độ strict của body-parser: gốc phải là đối tượng hoặc mảng.
            if !bytes.is_empty()
                && !matches!(
                    bytes.iter().find(|b| !b.is_ascii_whitespace()),
                    Some(b'{' | b'[') | None
                )
            {
                return Err(error_response(&HttpError::bad_request("Unexpected token in JSON")));
            }
            let value = if bytes.is_empty() {
                empty()?
            } else {
                serde_json::from_slice::<T>(&bytes)
                    .map_err(|e| error_response(&HttpError::bad_request(e.to_string())))?
            };
            return Ok(ParsedBody {
                value,
                raw: (!bytes.is_empty()).then_some(bytes),
            });
        }
        let value = serde_json::from_value::<T>(parse_urlencoded(&bytes))
            .map_err(|e| error_response(&HttpError::bad_request(e.to_string())))?;
        Ok(ParsedBody { value, raw: None })
    }
}

/// Đọc một trường tệp của multipart theo từng mảnh, tối đa `max` byte (như `limits.fileSize` của multer): vượt ⇒ 413
/// `File too large`. Dùng cùng `axum::extract::DefaultBodyLimit::max(<tổng>)` ở route multipart (mặc định của axum là 2 MB).
pub async fn read_field_limited(field: &mut Field<'_>, max: usize) -> Result<Bytes, HttpError> {
    let mut buf = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|_| HttpError::bad_request("Bad Request"))? {
        if buf.len() + chunk.len() > max {
            return Err(HttpError::payload_too_large("File too large"));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(buf))
}

/// Tiện ích: gom mọi trường của một yêu cầu multipart thành (tên, tên tệp, byte), mỗi trường tối đa `max_field` byte.
pub async fn collect_multipart(
    mut mp: Multipart,
    max_field: usize,
) -> Result<Vec<(String, Option<String>, Bytes)>, HttpError> {
    let mut out = Vec::new();
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        let name = f.name().unwrap_or("").to_owned();
        let file = f.file_name().map(str::to_owned);
        let data = read_field_limited(&mut f, max_field).await?;
        out.push((name, file, data));
    }
    Ok(out)
}
