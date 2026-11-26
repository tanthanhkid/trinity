//! Extractor axum: `ValidJson<T>` (body JSON), `ValidQuery<T>` (query string), và `parse_int_param` (thay
//! `ParseIntPipe`). Lỗi trả body dạng Nest (`trinity_kernel::error`).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use axum::Json;
use axum::body::to_bytes;
use axum::extract::{FromRequest, FromRequestParts, OriginalUri, Request};
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

/// Đường dẫn ĐẦY ĐỦ của request: `OriginalUri` (axum `nest` cắt tiền tố khỏi `uri()`), không có thì `uri()`.
fn full_path(parts_ext: &axum::http::Extensions, uri: &axum::http::Uri) -> String {
    parts_ext
        .get::<OriginalUri>()
        .map_or_else(|| uri.path().to_owned(), |o| o.0.path().to_owned())
}

/// Hạn mức body JSON (như `bodyParser` của bản TS); hạn mức theo route do lớp giới hạn body của K16 đặt.
const JSON_BODY_LIMIT: usize = 5 * 1024 * 1024;

fn is_json_content_type(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .is_some_and(|ct| ct == "application/json" || ct.ends_with("+json"))
}

impl<T: Dto, S: Send + Sync> FromRequest<S> for ValidJson<T> {
    type Rejection = Response;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Response> {
        let mode = mode_for_path(&full_path(req.extensions(), req.uri()));
        // Như `body-parser` của Express: không phải JSON hoặc body rỗng ⇒ `{}` (DTO vẫn chạy, nên trường bắt buộc báo
        // lỗi bằng câu của class-validator, không phải câu lỗi của axum). Chế độ strict của body-parser: gốc phải là
        // `{` hoặc `[`. Giới hạn/lỗi đọc thuộc K16.
        let json = is_json_content_type(req.headers());
        let bytes = to_bytes(req.into_body(), JSON_BODY_LIMIT).await.map_err(|e| {
            let too_large = e.to_string().contains("length limit");
            error_response(if too_large {
                HttpError::payload_too_large("request entity too large").into()
            } else {
                HttpError::bad_request("Bad Request").into()
            })
        })?;
        let v = if json && !bytes.iter().all(u8::is_ascii_whitespace) {
            let first = bytes.iter().find(|b| !b.is_ascii_whitespace()).copied().unwrap_or(b' ');
            if first != b'{' && first != b'[' {
                return Err(error_response(
                    HttpError::bad_request("Unexpected token in JSON").into(),
                ));
            }
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|e| error_response(HttpError::bad_request(e.to_string()).into()))?
        } else {
            Value::Object(Map::new())
        };
        validate_into::<T>(&v, mode).map(ValidJson).map_err(error_response)
    }
}

/// Query string đã kiểm theo DTO `T`.
#[derive(Debug, Clone)]
pub struct ValidQuery<T>(pub T);

impl<T: Dto, S: Send + Sync> FromRequestParts<S> for ValidQuery<T> {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Response> {
        let mode = mode_for_path(&full_path(&parts.extensions, &parts.uri));
        let v = query_to_json(parts.uri.query().unwrap_or(""));
        validate_into::<T>(&v, mode).map(ValidQuery).map_err(error_response)
    }
}

/// Nút trung gian khi dựng cây từ query (như `qs`): mảng có thể thưa (`a[5]=x`) và được nén ở cuối (`qs.compact`).
#[derive(Debug, Clone)]
enum Node {
    Str(String),
    Arr(Vec<Option<Node>>),
    Obj(Vec<(String, Node)>),
}

const QS_ARRAY_LIMIT: usize = 20;
const QS_DEPTH: usize = 5;
const QS_PARAMETER_LIMIT: usize = 1000;

/// Tách khoá `a[b][c]` thành các đoạn như `qs.parseKeys` (độ sâu 5; phần còn lại thành một đoạn `[phần còn lại]`).
/// Khoá rỗng ⇒ `None` (bị bỏ).
fn qs_segments(key: &str) -> Option<Vec<String>> {
    if key.is_empty() {
        return None;
    }
    let first = key.find('[');
    let base = &key[..first.unwrap_or(key.len())];
    let mut segs = Vec::new();
    if !base.is_empty() {
        segs.push(base.to_owned());
    } else if first.is_none() {
        return None;
    }
    let Some(mut i) = first else { return Some(segs) };
    let bytes = key.as_bytes();
    let mut depth = 0;
    while i < bytes.len() && depth < QS_DEPTH {
        // Nhóm ngoặc cân bằng bắt đầu tại i (`[` … `]`, cho phép `[` lồng bên trong).
        let mut level = 0;
        let mut end = None;
        for (j, &c) in bytes.iter().enumerate().skip(i) {
            match c {
                b'[' => level += 1,
                b']' => {
                    level -= 1;
                    if level == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else { break };
        segs.push(key[i..=end].to_owned());
        depth += 1;
        i = end + 1;
        if i < bytes.len() && bytes[i] != b'[' {
            break;
        }
    }
    if i < bytes.len() {
        segs.push(format!("[{}]", &key[i..]));
    }
    Some(segs)
}

fn qs_leaf_chain(segs: &[String], value: String) -> Node {
    let mut node = Node::Str(value);
    for seg in segs.iter().rev() {
        if seg == "[]" {
            node = Node::Arr(vec![Some(node)]);
            continue;
        }
        let clean = seg.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(seg);
        let idx = clean
            .parse::<usize>()
            .ok()
            .filter(|i| i.to_string() == clean && *i <= QS_ARRAY_LIMIT);
        node = match idx {
            Some(i) => {
                let mut v = vec![None; i + 1];
                v[i] = Some(node);
                Node::Arr(v)
            }
            None => Node::Obj(vec![(clean.to_owned(), node)]),
        };
    }
    node
}

/// `qs` `utils.merge`: gộp `src` vào `dst`.
fn qs_merge(dst: Node, src: Node) -> Node {
    match (dst, src) {
        (Node::Obj(mut a), Node::Obj(b)) => {
            for (k, v) in b {
                match a.iter().position(|(ak, _)| *ak == k) {
                    Some(p) => {
                        let old = std::mem::replace(&mut a[p].1, Node::Str(String::new()));
                        a[p].1 = qs_merge(old, v);
                    }
                    None => a.push((k, v)),
                }
            }
            Node::Obj(a)
        }
        (Node::Arr(mut a), Node::Arr(b)) => {
            for (i, item) in b.into_iter().enumerate() {
                let Some(item) = item else { continue };
                match a.get_mut(i) {
                    Some(slot @ Some(Node::Obj(_) | Node::Arr(_))) if matches!(item, Node::Obj(_) | Node::Arr(_)) => {
                        let old = slot.take().unwrap_or(Node::Str(String::new()));
                        *slot = Some(qs_merge(old, item));
                    }
                    Some(Some(_)) => a.push(Some(item)),
                    Some(slot @ None) => *slot = Some(item),
                    None => {
                        a.resize(i, None);
                        a.push(Some(item));
                    }
                }
            }
            Node::Arr(a)
        }
        (Node::Arr(a), obj @ Node::Obj(_)) => {
            let as_obj = Node::Obj(
                a.into_iter()
                    .enumerate()
                    .filter_map(|(i, v)| v.map(|v| (i.to_string(), v)))
                    .collect(),
            );
            qs_merge(as_obj, obj)
        }
        (Node::Obj(a), Node::Arr(b)) => {
            let as_obj = Node::Obj(
                b.into_iter()
                    .enumerate()
                    .filter_map(|(i, v)| v.map(|v| (i.to_string(), v)))
                    .collect(),
            );
            qs_merge(Node::Obj(a), as_obj)
        }
        // Chuỗi gặp chuỗi/mảng/đối tượng: `[].concat(target, source)`.
        (Node::Str(a), Node::Str(b)) => Node::Arr(vec![Some(Node::Str(a)), Some(Node::Str(b))]),
        (Node::Str(a), Node::Arr(b)) => {
            let mut v = vec![Some(Node::Str(a))];
            v.extend(b.into_iter().flatten().map(Some));
            Node::Arr(v)
        }
        (Node::Arr(mut a), Node::Str(b)) => {
            a.push(Some(Node::Str(b)));
            Node::Arr(a)
        }
        (Node::Str(a), obj @ Node::Obj(_)) => Node::Arr(vec![Some(Node::Str(a)), Some(obj)]),
        (Node::Obj(mut a), Node::Str(b)) => {
            a.push((b, Node::Str("true".into())));
            Node::Obj(a)
        }
    }
}

fn qs_to_value(n: Node) -> Value {
    match n {
        Node::Str(s) => Value::String(s),
        // `qs.compact`: bỏ ô trống của mảng thưa.
        Node::Arr(a) => Value::Array(a.into_iter().flatten().map(qs_to_value).collect()),
        Node::Obj(o) => Value::Object(o.into_iter().map(|(k, v)| (k, qs_to_value(v))).collect()),
    }
}

/// Query string → đối tượng JSON như `qs.parse` mặc định của Express (extended): `a=1`; khoá lặp và `a[]=1` thành
/// mảng; chỉ số `a[0]`…`a[20]` thành mảng (lớn hơn 20 thành khoá đối tượng) rồi nén ô trống; `a[b][c]=1` lồng tới
/// độ sâu 5; khoá rỗng bị bỏ; tối đa 1000 tham số. Giá trị luôn là chuỗi (như Express).
pub fn query_to_json(query: &str) -> Value {
    let mut root = Node::Obj(Vec::new());
    for (k, v) in form_urlencoded::parse(query.as_bytes()).take(QS_PARAMETER_LIMIT) {
        let Some(segs) = qs_segments(&k) else { continue };
        let chain = qs_leaf_chain(&segs, v.into_owned());
        // Gốc luôn là đối tượng: đoạn đầu là khoá thường, bọc lại thành đối tượng.
        let first = chain_root(&segs, chain);
        root = qs_merge(root, first);
    }
    qs_to_value(root)
}

/// `qs_leaf_chain` dựng cả đoạn đầu (khoá gốc) thành mảng/đối tượng như phần tử lồng; ở gốc cần luôn là đối tượng
/// với khoá đó (kể cả khi khoá gốc là chữ số, ví dụ `0=a`).
fn chain_root(segs: &[String], chain: Node) -> Node {
    match (segs.first(), chain) {
        (Some(base), Node::Arr(mut a)) if !base.starts_with('[') => {
            // Khoá gốc dạng chỉ số bị `qs_leaf_chain` đổi thành mảng: mở lại thành đối tượng một khoá.
            let inner = a.drain(..).flatten().next();
            Node::Obj(vec![(base.clone(), inner.unwrap_or(Node::Str(String::new())))])
        }
        (_, other) => other,
    }
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
