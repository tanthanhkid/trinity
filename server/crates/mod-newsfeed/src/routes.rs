//! Router axum của `/api/v1/newsfeed` (14 route, khớp `contracts/routes.json`): danh sách, quyền của tôi, đăng bài (JSON và
//! multipart), phát tệp (ảnh, video có `Range`), sửa/xoá bài, thích, bình luận.
//!
//! Thân của `CreatePostDto`, `CreatePostMultipartDto`, `UpdatePostDto`, `CreatePostCommentDto` và query `QueryPostsDto` kiểm
//! tay đúng câu của class-validator (strict: khoá lạ ⇒ `property x should not exist`; chưa có trong `contracts/dto/schema.json`
//! nên cần golden). Multipart đọc như `FileFieldsInterceptor` của multer: trường tệp `images` (≤ 10) và `videos` (≤ 5), tệp
//! khác tên hoặc quá số lượng ⇒ 400 `Unexpected field`; ảnh sai MIME và video sai đuôi bị bỏ im lặng (`fileFilter`); video ghi
//! ra tệp tạm theo luồng (không giữ trong RAM), mỗi tệp ≤ 40 MB (413 `File too large`).

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::multipart::Field;
use axum::extract::{DefaultBodyLimit, Extension, FromRequest, Multipart, Path, Query, Request, State};
use axum::handler::Handler;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use trinity_db::outbox::CreatedNotification;
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_http::edge::body::read_field_limited;
use trinity_http::router::{Access, AccessDeps, ApiRouter, CurrentUser, RouteSpec};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_storage::{LocalDiskDriver, RangedObject, S3Driver, S3RangedObject, StorageError};

use crate::{
    Actor, CATEGORIES, COMMENT_MAX_LEN, CONTENT_MAX_LEN, Error, ImageUpload, MAX_IMAGE_SIZE, MAX_IMAGES_PER_POST,
    MAX_VIDEO_SIZE, MAX_VIDEOS_PER_POST, MediaFile, MediaStore, VideoUpload,
};

const BASE: &str = "/api/v1/newsfeed";
const NEEDS_POST: Access = Access::Can(&["newsfeed.post"]);
/// Trần từng tệp ở tầng multer (`UPLOAD_FIELD_SIZE_MAX`); mức đúng theo loại do `create` kiểm tiếp (ảnh 10 MB, video 40 MB).
const UPLOAD_FIELD_MAX: usize = 40 * 1024 * 1024;
/// Trần trường chữ của multer (`fieldSize` mặc định 1 MB).
const TEXT_FIELD_MAX: usize = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Kho tệp: đĩa cục bộ hoặc S3 (chọn lúc khởi động theo `STORAGE_DRIVER`)

pub enum Store {
    Local(LocalDiskDriver),
    S3(S3Driver),
}

pub enum Ranged {
    Local(RangedObject),
    S3(S3RangedObject),
}

impl MediaStore for Store {
    type Ranged = Ranged;

    async fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), StorageError> {
        match self {
            Self::Local(d) => MediaStore::put(d, key, body, content_type).await,
            Self::S3(d) => MediaStore::put(d, key, body, content_type).await,
        }
    }

    async fn put_file(&self, key: &str, path: &std::path::Path, content_type: &str) -> Result<(), StorageError> {
        match self {
            Self::Local(d) => MediaStore::put_file(d, key, path, content_type).await,
            Self::S3(d) => MediaStore::put_file(d, key, path, content_type).await,
        }
    }

    async fn remove(&self, key: &str) -> Result<(), StorageError> {
        match self {
            Self::Local(d) => MediaStore::remove(d, key).await,
            Self::S3(d) => MediaStore::remove(d, key).await,
        }
    }

    async fn get_range(&self, key: &str, range: Option<&str>) -> Result<Ranged, StorageError> {
        match self {
            Self::Local(d) => MediaStore::get_range(d, key, range).await.map(Ranged::Local),
            Self::S3(d) => MediaStore::get_range(d, key, range).await.map(Ranged::S3),
        }
    }
}

/// Đẩy `notification:new` và số chưa đọc cho các thông báo "bài mới" vừa tạo (socket cùng tiến trình do `serve` cài).
pub type Push = Arc<dyn Fn(CompanyRef, Vec<CreatedNotification>) + Send + Sync>;

/// Cài [`Push`] bằng socket `/notif-ws` của tiến trình này: mỗi thông báo "bài mới" đẩy `notification:new` rồi số chưa đọc
/// của người nhận (tin `NOTIFY bell` bị lọc khỏi chính tiến trình phát). Chạy nền, lỗi chỉ ghi log ở tầng socket.
pub fn socket_push(socket: trinity_realtime::NotifSocket, db: Db) -> Push {
    Arc::new(move |company: CompanyRef, created: Vec<CreatedNotification>| {
        let (socket, db) = (socket.clone(), db.clone());
        tokio::spawn(async move {
            let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            for n in created {
                let payload = trinity_realtime::NotificationPayload {
                    id: Some(n.id),
                    title: n.title,
                    body: n.body,
                    channel: "in_app".to_owned(),
                    event_type: Some(n.event_type),
                    action_url: n.action_url,
                    is_read: false,
                    created_at: created_at.clone(),
                };
                socket
                    .push_local(&db, i64::from(company.id()), i64::from(n.recipient_id), &payload)
                    .await;
            }
        });
    })
}

/// Phụ thuộc của router.
pub struct Ctx {
    pub db: Db,
    pub store: Store,
    pub push: Push,
}

// ---------------------------------------------------------------------------------------------------------------------
// Bảng route

/// Bảng route (14 dòng) so với `routes.json`.
pub fn specs() -> Vec<RouteSpec> {
    let auth = || Access::AuthOnly;
    let id = &["param.id:ParseIntPipe"];
    vec![
        RouteSpec::new(Method::GET, BASE, auth()).status_ok(200),
        RouteSpec::new(Method::POST, BASE, NEEDS_POST).status_ok(201),
        RouteSpec::new(Method::GET, "/api/v1/newsfeed/permissions/me", auth()).status_ok(200),
        RouteSpec::new(Method::POST, "/api/v1/newsfeed/upload", NEEDS_POST).status_ok(201),
        RouteSpec::new(Method::POST, "/api/v1/newsfeed/video-upload-token", NEEDS_POST).status_ok(201),
        RouteSpec::new(Method::DELETE, "/api/v1/newsfeed/comments/:id", auth())
            .status_ok(200)
            .param_pipes(id),
        RouteSpec::new(Method::GET, "/api/v1/newsfeed/:id/image", auth()).param_pipes(id),
        RouteSpec::new(Method::GET, "/api/v1/newsfeed/:id/images/:index", auth())
            .param_pipes(&["param.id:ParseIntPipe", "param.index:ParseIntPipe"]),
        RouteSpec::new(Method::PATCH, "/api/v1/newsfeed/:id", auth())
            .status_ok(200)
            .param_pipes(id),
        RouteSpec::new(Method::DELETE, "/api/v1/newsfeed/:id", auth())
            .status_ok(200)
            .param_pipes(id),
        RouteSpec::new(Method::POST, "/api/v1/newsfeed/:id/upload", auth())
            .status_ok(201)
            .param_pipes(id),
        RouteSpec::new(Method::POST, "/api/v1/newsfeed/:id/like", auth())
            .status_ok(201)
            .param_pipes(id),
        RouteSpec::new(Method::GET, "/api/v1/newsfeed/:id/comments", auth())
            .status_ok(200)
            .param_pipes(id),
        RouteSpec::new(Method::POST, "/api/v1/newsfeed/:id/comments", auth())
            .status_ok(201)
            .param_pipes(id),
    ]
}

// ---------------------------------------------------------------------------------------------------------------------
// Tiện ích chung

fn fail(e: impl Into<AppError>) -> Response {
    let (status, body) = e.into().response(true);
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}

/// Lỗi của lớp logic ⇒ phản hồi (`Http` giữ nguyên mã và câu, `Internal` ⇒ 500).
fn nf(e: Error) -> Response {
    match e {
        Error::Http(h) => fail(AppError::Http(*h)),
        Error::Internal(m) => fail(AppError::internal(m)),
    }
}

fn ok<T: serde::Serialize>(r: crate::Result<T>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => nf(e),
    }
}

fn invalid(msgs: Vec<String>) -> Response {
    fail(HttpError::validation(msgs))
}

/// Công ty của token không hợp lệ ⇒ 401 (không rơi về công ty mặc định).
fn company_of(u: &CurrentUser) -> Result<CompanyRef, Response> {
    CompanyRef::new(i64::from(u.user.company_id))
        .map_err(|_| fail(HttpError::unauthorized("Token không hợp lệ hoặc đã hết hạn")))
}

async fn tenant(c: &Ctx, u: &CurrentUser) -> Result<TenantDb, Response> {
    let company = company_of(u)?;
    c.db.tenant(company).await.map_err(|e| fail(AppError::internal(e)))
}

fn actor(u: &CurrentUser) -> Actor {
    let can = |p: &str| trinity_rbac::can(&u.grants.grants, p, None);
    Actor {
        user_id: u.user.user_id,
        can_post: can("newsfeed.post"),
        can_moderate: can("newsfeed.moderate"),
    }
}

/// Số nguyên của `:id` đã qua `ParseIntPipe`; ngoài int4 thì không có đối tượng nào (404 như `post_author`).
fn id_of(raw: &str, msg: &str) -> Result<i32, Response> {
    raw.parse::<i32>().map_err(|_| fail(HttpError::not_found(msg)))
}

/// Body JSON như `body-parser` của Express: không phải JSON hoặc rỗng ⇒ `{}`.
struct JsonBody(Value);

impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = Response;

    async fn from_request(req: Request, _s: &S) -> Result<Self, Response> {
        let is_json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| {
                ct.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        let bytes: Bytes = to_bytes(req.into_body(), 5 * 1024 * 1024)
            .await
            .map_err(|_| fail(HttpError::payload_too_large("request entity too large")))?;
        if !is_json || bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(Value::Object(Map::new())));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Self(v)),
            _ => Err(fail(HttpError::bad_request("Unexpected token in JSON"))),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Kiểm thân request (câu của class-validator; khoá lạ trước, rồi từng thuộc tính theo thứ tự khai)

fn unknown_keys<'a>(keys: impl Iterator<Item = &'a String>, known: &[&str], out: &mut Vec<String>) {
    for k in keys.filter(|k| !known.contains(&k.as_str())) {
        out.push(format!("property {k} should not exist"));
    }
}

fn category_msg(v: Option<&Value>, out: &mut Vec<String>) {
    if !matches!(v, Some(Value::String(s)) if CATEGORIES.contains(&s.as_str())) {
        out.push(format!(
            "category must be one of the following values: {}",
            CATEGORIES.join(", ")
        ));
    }
}

/// `@IsString() @IsNotEmpty() @MaxLength(max)` (decorator khai sau chạy trước).
fn content_msgs(v: Option<&Value>, max: usize, out: &mut Vec<String>) {
    let short = matches!(v, Some(Value::String(s)) if s.chars().map(char::len_utf16).sum::<usize>() <= max);
    if !short {
        out.push(format!("content must be shorter than or equal to {max} characters"));
    }
    let empty = matches!(v, None | Some(Value::Null)) || matches!(v, Some(Value::String(s)) if s.is_empty());
    if empty {
        out.push("content should not be empty".to_owned());
    }
    if !matches!(v, Some(Value::String(_))) {
        out.push("content must be a string".to_owned());
    }
}

fn object_of(body: &Value) -> Map<String, Value> {
    body.as_object().cloned().unwrap_or_default()
}

fn text_of(o: &Map<String, Value>, k: &str) -> String {
    o.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn check(errs: Vec<String>) -> Result<(), Response> {
    if errs.is_empty() { Ok(()) } else { Err(invalid(errs)) }
}

/// `CreatePostDto`: (category, content).
fn post_dto(body: &Value) -> Result<(String, String), Response> {
    let o = object_of(body);
    let mut errs = Vec::new();
    unknown_keys(o.keys(), &["category", "content"], &mut errs);
    category_msg(o.get("category"), &mut errs);
    content_msgs(o.get("content"), CONTENT_MAX_LEN, &mut errs);
    check(errs)?;
    Ok((text_of(&o, "category"), text_of(&o, "content")))
}

/// `UpdatePostDto`: `content` bắt buộc, `category` tuỳ chọn (đổi «Mục»).
fn update_dto(body: &Value) -> Result<(String, Option<String>), Response> {
    let o = object_of(body);
    let mut errs = Vec::new();
    unknown_keys(o.keys(), &["category", "content"], &mut errs);
    if o.contains_key("category") {
        category_msg(o.get("category"), &mut errs);
    }
    content_msgs(o.get("content"), CONTENT_MAX_LEN, &mut errs);
    check(errs)?;
    let category = o.get("category").and_then(Value::as_str).map(str::to_owned);
    Ok((text_of(&o, "content"), category))
}

/// Trường chữ của multipart `POST /newsfeed/:id/upload`: `content`, `category` đều tuỳ chọn (trường lặp: lấy giá trị cuối).
fn update_multipart_dto(fields: &[(String, String)]) -> Result<(Option<String>, Option<String>), Response> {
    let mut errs = Vec::new();
    let mut seen: Vec<&String> = Vec::new();
    for (k, _) in fields {
        if !seen.contains(&k) {
            seen.push(k);
        }
    }
    unknown_keys(seen.into_iter(), &["category", "content"], &mut errs);
    let last = |k: &str| fields.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let category = last("category");
    let content = last("content");
    if let Some(c) = &category {
        category_msg(Some(&Value::String(c.clone())), &mut errs);
    }
    if let Some(c) = &content {
        let len: usize = c.chars().map(char::len_utf16).sum();
        if len > CONTENT_MAX_LEN {
            errs.push(format!(
                "content must be shorter than or equal to {CONTENT_MAX_LEN} characters"
            ));
        }
    }
    check(errs)?;
    Ok((content, category))
}

/// `CreatePostCommentDto`: chỉ `content`.
fn content_dto(body: &Value, max: usize) -> Result<String, Response> {
    let o = object_of(body);
    let mut errs = Vec::new();
    unknown_keys(o.keys(), &["content"], &mut errs);
    content_msgs(o.get("content"), max, &mut errs);
    check(errs)?;
    Ok(text_of(&o, "content"))
}

/// `CreatePostMultipartDto` từ các trường chữ của multipart (trường lặp: lấy giá trị cuối).
fn multipart_dto(fields: &[(String, String)]) -> Result<(String, String), Response> {
    let mut errs = Vec::new();
    let mut seen: Vec<&String> = Vec::new();
    for (k, _) in fields {
        if !seen.contains(&k) {
            seen.push(k);
        }
    }
    unknown_keys(seen.into_iter(), &["category", "content"], &mut errs);
    let last = |k: &str| fields.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let category = last("category");
    let content = last("content");
    category_msg(category.clone().map(Value::String).as_ref(), &mut errs);
    if let Some(c) = &content {
        let len: usize = c.chars().map(char::len_utf16).sum();
        if len > CONTENT_MAX_LEN {
            errs.push(format!(
                "content must be shorter than or equal to {CONTENT_MAX_LEN} characters"
            ));
        }
    }
    check(errs)?;
    Ok((category.unwrap_or_default(), content.unwrap_or_default()))
}

// ---------------------------------------------------------------------------------------------------------------------
// Đọc multipart

#[derive(Default)]
struct Upload {
    images: Vec<ImageUpload>,
    videos: Vec<VideoUpload>,
    fields: Vec<(String, String)>,
}

fn unexpected() -> AppError {
    HttpError::bad_request("Unexpected field").into()
}

fn mime_of(f: &Field<'_>) -> String {
    f.content_type()
        .unwrap_or("text/plain")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Ghi một video ra tệp tạm theo từng mảnh (tối đa [`UPLOAD_FIELD_MAX`]).
async fn spool_video(f: &mut Field<'_>, file_name: &str) -> Result<VideoUpload, AppError> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let rand = uuid::Uuid::new_v4().simple().to_string();
    let path = std::env::temp_dir().join(format!("newsfeed_{millis}_{}_videos", &rand[..6]));
    let mut file = tokio::fs::File::create(&path).await.map_err(AppError::internal)?;
    let mut size: u64 = 0;
    let res: Result<(), AppError> = async {
        while let Some(chunk) = f.chunk().await.map_err(|_| HttpError::bad_request("Bad Request"))? {
            size += chunk.len() as u64;
            if size > UPLOAD_FIELD_MAX as u64 {
                return Err(HttpError::payload_too_large("File too large").into());
            }
            file.write_all(&chunk).await.map_err(AppError::internal)?;
        }
        file.flush().await.map_err(AppError::internal)
    }
    .await;
    drop(file);
    if let Err(e) = res {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(e);
    }
    Ok(VideoUpload {
        file_name: file_name.to_owned(),
        size,
        path,
    })
}

async fn collect_upload(mp: &mut Multipart, up: &mut Upload) -> Result<(), AppError> {
    while let Some(mut f) = mp
        .next_field()
        .await
        .map_err(|_| HttpError::bad_request("Bad Request"))?
    {
        let name = f.name().unwrap_or("").to_owned();
        let Some(file_name) = f.file_name().map(str::to_owned) else {
            let data = read_field_limited(&mut f, TEXT_FIELD_MAX).await?;
            up.fields.push((name, String::from_utf8_lossy(&data).into_owned()));
            continue;
        };
        match name.as_str() {
            "images" => {
                let content_type = mime_of(&f);
                // `fileFilter`: sai MIME thì bỏ tệp, không báo lỗi.
                if !matches!(
                    content_type.as_str(),
                    "image/jpeg" | "image/jpg" | "image/png" | "image/webp"
                ) {
                    continue;
                }
                if up.images.len() >= MAX_IMAGES_PER_POST {
                    return Err(unexpected());
                }
                let bytes = read_field_limited(&mut f, UPLOAD_FIELD_MAX).await?;
                up.images.push(ImageUpload {
                    content_type,
                    bytes: bytes.to_vec(),
                });
            }
            "videos" => {
                let ext = std::path::Path::new(&file_name)
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                    .unwrap_or_default();
                if !matches!(ext.as_str(), ".mp4" | ".webm" | ".mov") {
                    continue;
                }
                if up.videos.len() >= MAX_VIDEOS_PER_POST {
                    return Err(unexpected());
                }
                let v = spool_video(&mut f, &file_name).await?;
                up.videos.push(v);
            }
            _ => return Err(unexpected()),
        }
    }
    Ok(())
}

async fn cleanup(videos: &[VideoUpload]) {
    for v in videos {
        let _ = tokio::fs::remove_file(&v.path).await;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Handler

type S = State<Arc<Ctx>>;
type U = Extension<CurrentUser>;

async fn list(State(c): S, Extension(u): U, Query(q): Query<HashMap<String, String>>) -> Response {
    let mut keys: Vec<&String> = q.keys().collect();
    keys.sort();
    let mut msgs = Vec::new();
    unknown_keys(keys.into_iter(), &["category", "cursor", "limit"], &mut msgs);
    let get = |k: &str| q.get(k).map(String::as_str);
    let parsed = match crate::validate_list_query(get("category"), get("cursor"), get("limit")) {
        Ok(p) => p,
        Err(Error::Http(h)) => {
            return match h.body().message {
                Message::Many(m) => {
                    msgs.extend(m);
                    invalid(msgs)
                }
                Message::One(_) => nf(Error::Http(h)),
            };
        }
        Err(e) => return nf(e),
    };
    if !msgs.is_empty() {
        return invalid(msgs);
    }
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::list(&t, &actor(&u), &parsed).await)
}

async fn permissions_me(Extension(u): U) -> Response {
    Json(crate::permissions_me(&actor(&u))).into_response()
}

/// Chung cho `POST /newsfeed` và `POST /newsfeed/upload`: tạo bài rồi đẩy chuông sau khi commit.
async fn create_post(
    c: &Ctx,
    u: &CurrentUser,
    category: &str,
    content: &str,
    images: Vec<ImageUpload>,
    videos: &[VideoUpload],
) -> Response {
    let t = match tenant(c, u).await {
        Ok(t) => t,
        Err(r) => {
            cleanup(videos).await;
            return r;
        }
    };
    let company = match company_of(u) {
        Ok(co) => co,
        Err(r) => {
            cleanup(videos).await;
            return r;
        }
    };
    let push = c.push.clone();
    let on_notified = move |created: Vec<CreatedNotification>| push(company, created);
    ok(crate::create(&t, &c.store, &actor(u), category, content, images, videos, on_notified).await)
}

async fn create(State(c): S, Extension(u): U, JsonBody(body): JsonBody) -> Response {
    let (category, content) = match post_dto(&body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    create_post(&c, &u, &category, &content, Vec::new(), &[]).await
}

async fn upload(State(c): S, Extension(u): U, mut mp: Multipart) -> Response {
    let mut up = Upload::default();
    if let Err(e) = collect_upload(&mut mp, &mut up).await {
        cleanup(&up.videos).await;
        return fail(e);
    }
    let (category, content) = match multipart_dto(&up.fields) {
        Ok(v) => v,
        Err(r) => {
            cleanup(&up.videos).await;
            return r;
        }
    };
    create_post(&c, &u, &category, &content, up.images, &up.videos).await
}

async fn video_upload_token() -> Response {
    fail(crate::video_upload_token_gone())
}

fn media_response(f: MediaFile<Ranged>) -> Response {
    let MediaFile { object, file_name, .. } = f;
    let (status, content_type, len, content_range, body) = match object {
        Ranged::Local(o) => {
            let (status, content_range) = (o.status(), o.content_range());
            let (len, content_type) = (o.len, o.content_type);
            let body = Body::from_stream(tokio_util::io::ReaderStream::new(o.file.take(len)));
            (status, content_type, len, content_range, body)
        }
        Ranged::S3(o) => {
            let (status, content_range) = (o.status(), o.content_range());
            (
                status,
                o.content_type,
                o.len,
                content_range,
                Body::from_stream(o.stream),
            )
        }
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    let h = resp.headers_mut();
    let mut put = |name: header::HeaderName, value: String| {
        if let Ok(v) = HeaderValue::from_str(&value) {
            h.insert(name, v);
        }
    };
    put(header::CONTENT_TYPE, content_type);
    put(
        header::CONTENT_DISPOSITION,
        format!("inline; filename=\"{}\"", file_name.replace('"', "")),
    );
    put(header::CACHE_CONTROL, "private, max-age=300".to_owned());
    put(header::ACCEPT_RANGES, "bytes".to_owned());
    if len > 0 {
        put(header::CONTENT_LENGTH, len.to_string());
    }
    if let Some(cr) = content_range {
        put(header::CONTENT_RANGE, cr);
    }
    resp
}

async fn stream_media(c: &Ctx, u: &CurrentUser, post: &str, index: i64, headers: &HeaderMap) -> Response {
    let post_id = match id_of(post, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(c, u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match crate::media(&t, &c.store, post_id, index, range).await {
        Ok(f) => media_response(f),
        Err(e) => nf(e),
    }
}

async fn image(State(c): S, Extension(u): U, Path(id): Path<String>, headers: HeaderMap) -> Response {
    stream_media(&c, &u, &id, 0, &headers).await
}

async fn image_at(
    State(c): S,
    Extension(u): U,
    Path((id, index)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Ok(index) = index.parse::<i64>() else {
        return fail(HttpError::not_found("Không tìm thấy hình ảnh"));
    };
    stream_media(&c, &u, &id, index, &headers).await
}

async fn update(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let (content, category) = match update_dto(&body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let id = match id_of(&id, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::update_post(&t, &actor(&u), id, &content, category.as_deref()).await)
}

/// `POST /newsfeed/:id/upload`: sửa bài (nội dung, «Mục» tuỳ chọn) và thêm ảnh/video vào bài đã đăng.
async fn update_upload(State(c): S, Extension(u): U, Path(id): Path<String>, mut mp: Multipart) -> Response {
    let mut up = Upload::default();
    if let Err(e) = collect_upload(&mut mp, &mut up).await {
        cleanup(&up.videos).await;
        return fail(e);
    }
    let (content, category) = match update_multipart_dto(&up.fields) {
        Ok(v) => v,
        Err(r) => {
            cleanup(&up.videos).await;
            return r;
        }
    };
    let id = match id_of(&id, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => {
            cleanup(&up.videos).await;
            return r;
        }
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => {
            cleanup(&up.videos).await;
            return r;
        }
    };
    ok(crate::update_with_media(
        &t,
        &c.store,
        &actor(&u),
        id,
        content.as_deref(),
        category.as_deref(),
        up.images,
        &up.videos,
    )
    .await)
}

async fn remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let id = match id_of(&id, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::delete(&t, &c.store, &actor(&u), id).await)
}

async fn like(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let id = match id_of(&id, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::toggle_like(&t, &actor(&u), id).await)
}

/// `cursor ? Number(cursor) : undefined`: chuỗi rỗng ⇒ bỏ; rác (NaN) ⇒ bỏ như lớp logic mong đợi.
fn number_param(raw: Option<&String>) -> Option<i64> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    s.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f as i64)
}

async fn comments(
    State(c): S,
    Extension(u): U,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let id = match id_of(&id, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::list_comments(&t, id, number_param(q.get("cursor")), number_param(q.get("limit"))).await)
}

async fn comment_create(State(c): S, Extension(u): U, Path(id): Path<String>, JsonBody(body): JsonBody) -> Response {
    let content = match content_dto(&body, COMMENT_MAX_LEN) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let id = match id_of(&id, "Không tìm thấy bài đăng") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::create_comment(&t, &actor(&u), id, &content).await)
}

async fn comment_remove(State(c): S, Extension(u): U, Path(id): Path<String>) -> Response {
    let id = match id_of(&id, "Không tìm thấy bình luận") {
        Ok(i) => i,
        Err(r) => return r,
    };
    let t = match tenant(&c, &u).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    ok(crate::delete_comment(&t, &actor(&u), id).await)
}

/// Router của module (14 route). Route multipart nhận thân tới tổng trần của 10 ảnh và 5 video (+ 1 MB), như multer chỉ giới
/// hạn từng tệp (mặc định 2 MB của axum không đủ).
pub fn api_router(deps: Arc<AccessDeps>) -> ApiRouter<Arc<Ctx>> {
    let s = specs();
    let spec = |m: &Method, p: &str| {
        s.iter()
            .find(|x| x.method == *m && x.path == p)
            .cloned()
            .unwrap_or_else(|| panic!("thiếu spec {m} {p}"))
    };
    // Trần tổng như Node: ≤ 10 ảnh × 10 MB + ≤ 5 video × 40 MB = 300 MB (+ 1 MB cho trường chữ). Từng tệp do `lib.rs` kiểm theo loại.
    let body_max =
        MAX_VIDEOS_PER_POST * MAX_VIDEO_SIZE as usize + MAX_IMAGES_PER_POST * MAX_IMAGE_SIZE as usize + 1024 * 1024;
    ApiRouter::new(deps)
        .route(spec(&Method::GET, BASE), list)
        .route(spec(&Method::POST, BASE), create)
        .route(spec(&Method::GET, "/api/v1/newsfeed/permissions/me"), permissions_me)
        .route(
            spec(&Method::POST, "/api/v1/newsfeed/upload"),
            upload.layer(DefaultBodyLimit::max(body_max)),
        )
        .route(
            spec(&Method::POST, "/api/v1/newsfeed/video-upload-token"),
            video_upload_token,
        )
        .route(spec(&Method::DELETE, "/api/v1/newsfeed/comments/:id"), comment_remove)
        .route(spec(&Method::GET, "/api/v1/newsfeed/:id/image"), image)
        .route(spec(&Method::GET, "/api/v1/newsfeed/:id/images/:index"), image_at)
        .route(spec(&Method::PATCH, "/api/v1/newsfeed/:id"), update)
        .route(spec(&Method::DELETE, "/api/v1/newsfeed/:id"), remove)
        .route(
            spec(&Method::POST, "/api/v1/newsfeed/:id/upload"),
            update_upload.layer(DefaultBodyLimit::max(body_max)),
        )
        .route(spec(&Method::POST, "/api/v1/newsfeed/:id/like"), like)
        .route(spec(&Method::GET, "/api/v1/newsfeed/:id/comments"), comments)
        .route(spec(&Method::POST, "/api/v1/newsfeed/:id/comments"), comment_create)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn content_errors(v: Option<Value>, max: usize) -> Vec<String> {
        let mut out = Vec::new();
        content_msgs(v.as_ref(), max, &mut out);
        out
    }

    #[test]
    fn bang_route_du_14_dong_khop_routes_json() {
        let table = specs();
        assert_eq!(table.len(), 14);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 14);
    }

    #[test]
    fn sua_bai_nhan_muc_tuy_chon() {
        assert_eq!(update_dto(&json!({"content": "a"})).unwrap(), ("a".to_owned(), None));
        assert_eq!(
            update_dto(&json!({"content": "a", "category": "pr"})).unwrap(),
            ("a".to_owned(), Some("pr".to_owned()))
        );
        assert!(update_dto(&json!({"content": "a", "category": "x"})).is_err());
        assert!(update_dto(&json!({"content": "a", "category": null})).is_err());
        assert!(update_dto(&json!({"content": "a", "x": 1})).is_err());
        let f = |k: &str, v: &str| (k.to_owned(), v.to_owned());
        assert_eq!(update_multipart_dto(&[]).unwrap(), (None, None));
        assert_eq!(
            update_multipart_dto(&[f("category", "training"), f("content", "b")]).unwrap(),
            (Some("b".to_owned()), Some("training".to_owned()))
        );
        assert!(update_multipart_dto(&[f("category", "x")]).is_err());
        assert!(update_multipart_dto(&[f("lạ", "x")]).is_err());
    }

    #[test]
    fn noi_dung_dung_thu_tu_cau_loi() {
        assert!(content_errors(Some(json!("ok")), 10).is_empty());
        assert_eq!(content_errors(Some(json!("")), 10), ["content should not be empty"]);
        assert_eq!(
            content_errors(None, 10),
            [
                "content must be shorter than or equal to 10 characters",
                "content should not be empty",
                "content must be a string"
            ]
        );
        assert_eq!(
            content_errors(Some(json!(5)), 10),
            [
                "content must be shorter than or equal to 10 characters",
                "content must be a string"
            ]
        );
        assert_eq!(
            content_errors(Some(json!("a".repeat(11))), 10),
            ["content must be shorter than or equal to 10 characters"]
        );
    }

    #[test]
    fn loai_khoa_la_va_nhom() {
        let mut out = Vec::new();
        let keys = ["z".to_owned(), "category".to_owned(), "a".to_owned()];
        unknown_keys(keys.iter(), &["category", "content"], &mut out);
        assert_eq!(out, ["property z should not exist", "property a should not exist"]);
        let mut out = Vec::new();
        category_msg(Some(&json!("x")), &mut out);
        assert_eq!(
            out,
            ["category must be one of the following values: announcement, training, pr"]
        );
        let mut out = Vec::new();
        category_msg(Some(&json!("pr")), &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn tham_so_so_cua_binh_luan() {
        let s = |v: &str| v.to_owned();
        assert_eq!(number_param(None), None);
        assert_eq!(number_param(Some(&s(""))), None);
        assert_eq!(number_param(Some(&s("abc"))), None);
        assert_eq!(number_param(Some(&s("12"))), Some(12));
    }
}
