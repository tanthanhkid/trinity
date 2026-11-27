//! Thư viện media đăng bài (`social-media.service.ts`): tải multipart theo LUỒNG, nhập từ link, thư viện chung, xem trước, ẩn,
//! xác nhận khoá tệp do AI/web gửi lên, và mở tệp cho link công khai có chữ ký.
//!
//! - Tải lên đi thẳng từ luồng multipart xuống kho ([`MediaStore::put_reader`]); [`LimitReader`] đếm byte và chặn khi vượt trần
//!   nên video 200 MB KHÔNG nằm trọn trong RAM (bản Node ghi tệp tạm rồi mới đẩy lên). Vượt trần ⇒ 413 câu của Trinity
//!   ("Tệp quá lớn (tối đa N MB)."), tệp dở dang bị kho dọn (đĩa xoá tệp tạm, S3 huỷ multipart).
//! - Trần video MỚI đọc từ env `SOCIAL_MAX_VIDEO_MB` MỖI lần gọi ([`max_video_bytes`]; mặc định 200, sau Cloudflare đặt 95, PLAN 4.13).
//!   Video ĐÃ có trong kho dùng trần cứng 200 MB ([`MAX_STORED_VIDEO_BYTES`]).
//! - Nhập từ link đi qua `trinity_http::outbound::safe_get` (chống SSRF dùng chung K35); như bản Node video qua link tối đa 100 MB.
//! - Không giữ kết nối pool khi đọc/ghi kho tệp hay gọi mạng: mỗi bước DB xin một kết nối rồi nhả.
//! - Route `POST /social/media/upload-token` đã gỡ cùng Vercel Blob (G11), không có ở đây.

use std::collections::HashSet;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use mod_facebook::config::Env;
use mod_facebook::graph::utf16_prefix;
use mod_facebook::state::jwt_secret;
use serde::Serialize;
use sqlx::PgConnection;
use tokio::io::{AsyncRead, ReadBuf};
use trinity_db::pg_error::app_error;
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_http::outbound::safe_get::{SafeGetOptions, safe_get_media};
use trinity_kernel::error::{AppError, HttpError};
use trinity_storage::{LocalDiskDriver, S3Driver, StorageError};

use crate::media_link::verify_media_link;

/// Trần một ảnh.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Trần video mặc định (MB).
pub const DEFAULT_MAX_VIDEO_MB: u64 = 200;
/// Trần cứng của video ĐÃ có trong kho: luôn 200 MB, KHÔNG theo env.
pub const MAX_STORED_VIDEO_BYTES: u64 = DEFAULT_MAX_VIDEO_MB * 1024 * 1024;
/// Video tải từ link: thấp hơn tải trực tiếp vì cả tệp nằm trong RAM.
pub const MAX_IMPORT_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
/// Ảnh base64 trong thân request MCP.
pub const MAX_BASE64_BYTES: u64 = 3 * 1024 * 1024;
pub const MAX_LIBRARY_LIMIT: u64 = 100;
const DEFAULT_LIBRARY_LIMIT: u64 = 24;

const BAD_KIND: &str = "Chỉ nhận ảnh JPG/PNG/WebP/GIF hoặc video MP4/MOV/WebM.";

const LIBRARY_COLS: &str = "id, key, type, content_type, size, name, source, uploaded_by, created_at";

fn db_err(e: &sqlx::Error) -> AppError {
    app_error(e)
}

fn platform_db(d: trinity_db::DbError) -> AppError {
    HttpError::new(500, d.to_string()).into()
}

async fn acquire(db: &Db, company: CompanyRef) -> Result<TenantConn, AppError> {
    db.tenant(company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

// ───────────────────────────── loại tệp ─────────────────────────────

fn image_content_type(ext: &str) -> Option<&'static str> {
    match ext {
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".png" => Some("image/png"),
        ".webp" => Some("image/webp"),
        ".gif" => Some("image/gif"),
        _ => None,
    }
}

fn video_content_type(ext: &str) -> Option<&'static str> {
    match ext {
        ".mp4" => Some("video/mp4"),
        ".mov" => Some("video/quicktime"),
        ".webm" => Some("video/webm"),
        _ => None,
    }
}

/// `path.extname` của Node (kiểu posix), chữ thường: đuôi tính từ dấu chấm cuối của tên, tên bắt đầu bằng `.` không có đuôi.
pub fn extname(path: &str) -> String {
    let base = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// Trần video MỚI (byte) theo `SOCIAL_MAX_VIDEO_MB` (số MB nguyên 1–200; trống hoặc sai ⇒ 200).
pub fn max_video_bytes(env: &Env) -> u64 {
    video_bytes_from(env("SOCIAL_MAX_VIDEO_MB").as_deref())
}

fn video_bytes_from(raw: Option<&str>) -> u64 {
    let raw = raw.unwrap_or("").trim();
    let mb = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<u64>().unwrap_or(u64::MAX)
    } else {
        0
    };
    (if mb >= 1 {
        mb.min(DEFAULT_MAX_VIDEO_MB)
    } else {
        DEFAULT_MAX_VIDEO_MB
    }) * 1024
        * 1024
}

/// Loại tệp theo tên: đuôi, ảnh hay video, `Content-Type`, trần byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kind {
    pub ext: String,
    pub kind: &'static str,
    pub content_type: &'static str,
    pub max: u64,
}

/// `kindOf`: `video_max` là trần cho video (env cho tệp mới, [`MAX_STORED_VIDEO_BYTES`] cho tệp đã có).
pub fn kind_of(file_name: &str, video_max: u64) -> Result<Kind, AppError> {
    let ext = extname(file_name);
    if let Some(content_type) = image_content_type(&ext) {
        return Ok(Kind {
            ext,
            kind: "image",
            content_type,
            max: MAX_IMAGE_BYTES,
        });
    }
    if let Some(content_type) = video_content_type(&ext) {
        return Ok(Kind {
            ext,
            kind: "video",
            content_type,
            max: video_max,
        });
    }
    Err(HttpError::bad_request(BAD_KIND).into())
}

/// `Math.round(n / 1024 / 1024) MB`.
pub fn mb(n: u64) -> String {
    format!("{} MB", ((n as f64) / 1024.0 / 1024.0).round())
}

pub(crate) fn too_large(max: u64) -> String {
    format!("Tệp quá lớn (tối đa {}).", mb(max))
}

/// Tên hiển thị trong thư viện: bỏ đường dẫn, bỏ ký tự điều khiển, gọn ≤ 200 đơn vị UTF-16.
pub fn display_name(raw: Option<&str>, fallback: &str) -> String {
    let last = raw.unwrap_or("").rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().filter(|c| *c > '\u{1f}').collect();
    let n = cleaned.trim();
    utf16_prefix(if n.is_empty() { fallback } else { n }, 200)
}

/// Đuôi tệp theo content-type (ưu tiên), không thì theo tên/đường dẫn.
pub fn ext_for(content_type: &str, name_or_path: Option<&str>) -> Option<String> {
    let by_type = match content_type.to_lowercase().as_str() {
        "image/jpeg" => Some(".jpg"),
        "image/png" => Some(".png"),
        "image/webp" => Some(".webp"),
        "image/gif" => Some(".gif"),
        "video/mp4" => Some(".mp4"),
        "video/quicktime" => Some(".mov"),
        "video/webm" => Some(".webm"),
        _ => None,
    };
    if let Some(e) = by_type {
        return Some(e.to_owned());
    }
    let p = name_or_path.unwrap_or("");
    let p = p.split(['?', '#']).next().unwrap_or("");
    let e = extname(p);
    (image_content_type(&e).is_some() || video_content_type(&e).is_some()).then_some(e)
}

/// `^social/u(\d+)_\d+_[a-z0-9]+(\.[a-z0-9]+)$`: trả id người tải.
pub fn parse_key(key: &str) -> Option<u64> {
    let rest = key.strip_prefix("social/u")?;
    let mut parts = rest.splitn(3, '_');
    let (user, ts, tail) = (parts.next()?, parts.next()?, parts.next()?);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let alnum = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let (rand, ext) = tail.split_once('.')?;
    if digits(user) && digits(ts) && alnum(rand) && alnum(ext) {
        user.parse().ok()
    } else {
        None
    }
}

pub(crate) fn new_key(user_id: i32, ext: &str, now_ms: i64) -> String {
    let rand = uuid::Uuid::new_v4().simple().to_string();
    format!("social/u{user_id}_{now_ms}_{}{ext}", &rand[..6])
}

// ───────────────────────────── kho tệp ─────────────────────────────

/// Kho tệp: đĩa cục bộ hoặc S3/MinIO (cùng khoá), như `ContractStore` của mod-hr.
pub enum MediaStore {
    Local(LocalDiskDriver),
    S3(S3Driver),
}

/// Tệp mở ra để trả về: thân là luồng, không đọc cả tệp vào RAM.
pub enum MediaBody {
    File(tokio::fs::File),
    Stream(BoxStream<'static, Result<Bytes, StorageError>>),
}

impl MediaBody {
    /// Luồng byte cho body HTTP.
    pub fn into_stream(self) -> BoxStream<'static, Result<Bytes, std::io::Error>> {
        match self {
            Self::File(f) => tokio_util::io::ReaderStream::new(f).boxed(),
            Self::Stream(s) => s.map_err(std::io::Error::other).boxed(),
        }
    }
}

pub struct StoredFile {
    pub body: MediaBody,
    pub content_length: Option<u64>,
}

fn store_err(e: StorageError) -> AppError {
    match e {
        StorageError::NotFound(_) => HttpError::not_found("Không tìm thấy tệp trong thư viện").into(),
        other => AppError::internal(other),
    }
}

impl MediaStore {
    /// Đẩy theo luồng (đĩa ghi nguyên tử, S3 theo từng phần).
    pub async fn put_reader<R>(&self, key: &str, body: &mut R, content_type: &str) -> Result<(), StorageError>
    where
        R: AsyncRead + Unpin + Send + ?Sized,
    {
        match self {
            Self::Local(d) => d.upload_reader(key, body, content_type).await.map(drop),
            Self::S3(d) => d.upload_reader(key, body, content_type).await.map(drop),
        }
    }

    pub async fn put_bytes(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), StorageError> {
        match self {
            Self::Local(d) => d.upload(key, body, content_type).await.map(drop),
            Self::S3(d) => d
                .upload(key, Bytes::copy_from_slice(body), content_type)
                .await
                .map(drop),
        }
    }

    pub async fn get(&self, key: &str) -> Result<StoredFile, StorageError> {
        match self {
            Self::Local(d) => {
                let o = d.get(key).await?;
                Ok(StoredFile {
                    body: MediaBody::File(o.file),
                    content_length: Some(o.size),
                })
            }
            Self::S3(d) => {
                let o = d.get(key).await?;
                Ok(StoredFile {
                    body: MediaBody::Stream(o.stream),
                    content_length: Some(o.size),
                })
            }
        }
    }

    /// Kích thước tệp, không đọc nội dung (một request `Range: bytes=0-0`).
    pub async fn size_of(&self, key: &str) -> Result<u64, StorageError> {
        match self {
            Self::Local(d) => Ok(d.get_range(key, Some("bytes=0-0")).await?.size),
            Self::S3(d) => Ok(d.get_range(key, Some("bytes=0-0")).await?.size),
        }
    }

    pub(crate) async fn remove(&self, key: &str) {
        let r = match self {
            Self::Local(d) => d.delete(key).await,
            Self::S3(d) => d.delete(key).await,
        };
        if let Err(e) = r {
            tracing::warn!("Xoá tệp social {key} lỗi: {e}");
        }
    }
}

// ───────────────────────────── đếm byte khi chuyển luồng ─────────────────────────────

/// Bọc luồng đọc: đếm byte đã qua và báo lỗi khi vượt `max` (kho dọn phần dở). Không đệm.
pub struct LimitReader<R> {
    inner: R,
    max: u64,
    count: Arc<AtomicU64>,
    exceeded: Arc<AtomicBool>,
}

impl<R> LimitReader<R> {
    /// Trả luồng đã bọc cùng bộ đếm byte và cờ "vượt trần" (đọc sau khi chuyển xong).
    pub fn new(inner: R, max: u64) -> (Self, Arc<AtomicU64>, Arc<AtomicBool>) {
        let count = Arc::new(AtomicU64::new(0));
        let exceeded = Arc::new(AtomicBool::new(false));
        let r = Self {
            inner,
            max,
            count: Arc::clone(&count),
            exceeded: Arc::clone(&exceeded),
        };
        (r, count, exceeded)
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for LimitReader<R> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let res = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = res {
            let n = (buf.filled().len() - before) as u64;
            let total = self.count.fetch_add(n, Ordering::Relaxed) + n;
            if total > self.max {
                self.exceeded.store(true, Ordering::Relaxed);
                return Poll::Ready(Err(std::io::Error::other("vượt trần kích thước")));
            }
        }
        res
    }
}

// ───────────────────────────── view ─────────────────────────────

/// Mô tả tệp đã kiểm (`SocialMedia`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SocialMedia {
    pub key: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub content_type: String,
    pub size: u64,
}

/// Một dòng thư viện (`LIBRARY_SELECT`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct LibraryItem {
    pub id: i32,
    pub key: String,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub r#type: String,
    pub content_type: String,
    pub size: i32,
    pub name: String,
    pub source: String,
    pub uploaded_by: i32,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LibraryPage {
    pub data: Vec<LibraryItem>,
    pub next_cursor: Option<i32>,
}

/// Query `GET /social/media`: không có DTO nên tham số rác bị bỏ qua (`n()` chỉ nhận chuỗi toàn chữ số).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LibraryQuery {
    pub kind: Option<&'static str>,
    pub q: Option<String>,
    pub limit: u64,
    pub cursor: Option<i32>,
}

impl LibraryQuery {
    pub fn from_query(
        kind: Option<&str>,
        q: Option<&str>,
        limit: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Self, HttpError> {
        fn digits(v: Option<&str>) -> Option<&str> {
            v.filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        }
        let limit = digits(limit)
            .map(|s| s.parse::<u64>().unwrap_or(u64::MAX))
            .unwrap_or(DEFAULT_LIBRARY_LIMIT)
            .clamp(1, MAX_LIBRARY_LIMIT);
        // `cursor` 0 là falsy ⇒ không lọc; ngoài int4 ⇒ 400 (Prisma sẽ báo lỗi cột).
        let cursor = match digits(cursor) {
            None => None,
            Some(s) => match s.parse::<i32>() {
                Ok(0) => None,
                Ok(n) => Some(n),
                Err(_) => return Err(HttpError::bad_request("cursor không hợp lệ")),
            },
        };
        let kind = match kind {
            Some("image") => Some("image"),
            Some("video") => Some("video"),
            _ => None,
        };
        let q = q.map(str::trim).filter(|s| !s.is_empty()).map(|s| utf16_prefix(s, 100));
        Ok(Self { kind, q, limit, cursor })
    }
}

/// `%`, `_`, `\` thành ký tự thường trong `ILIKE ... ESCAPE '\'`.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// ───────────────────────────── DB ─────────────────────────────

/// Ghi tệp vào thư viện (đã có khoá thì giữ nguyên dòng cũ, `upsert` với `update: {}`).
pub async fn record(
    conn: &mut PgConnection,
    user_id: i32,
    m: &SocialMedia,
    name: &str,
    source: &str,
) -> Result<LibraryItem, AppError> {
    let size = i32::try_from(m.size).map_err(|_| HttpError::bad_request("Tệp quá lớn."))?;
    sqlx::query_as::<_, LibraryItem>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO social_media_assets (key, type, content_type, size, name, source, uploaded_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (key) DO UPDATE SET key = social_media_assets.key RETURNING {LIBRARY_COLS}"
    )))
    .bind(&m.key)
    .bind(&m.r#type)
    .bind(&m.content_type)
    .bind(size)
    .bind(name)
    .bind(source)
    .bind(user_id)
    .fetch_one(conn)
    .await
    .map_err(|e| db_err(&e))
}

/// `GET /social/media` ⇒ `{ data, next_cursor }`, mới nhất trước.
pub async fn list(conn: &mut PgConnection, q: &LibraryQuery) -> Result<LibraryPage, AppError> {
    let pattern = q.q.as_deref().map(|s| format!("%{}%", escape_like(s)));
    let take = i64::try_from(q.limit + 1).unwrap_or(i64::MAX);
    let mut rows = sqlx::query_as::<_, LibraryItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {LIBRARY_COLS} FROM social_media_assets \
         WHERE hidden_at IS NULL AND ($1::text IS NULL OR type = $1::text) \
         AND ($2::text IS NULL OR name ILIKE $2::text ESCAPE '\\') AND ($3::int4 IS NULL OR id < $3::int4) \
         ORDER BY id DESC LIMIT $4"
    )))
    .bind(q.kind)
    .bind(pattern)
    .bind(q.cursor)
    .bind(take)
    .fetch_all(conn)
    .await
    .map_err(|e| db_err(&e))?;
    let limit = q.limit as usize;
    let next_cursor = (rows.len() > limit).then(|| rows[limit - 1].id);
    rows.truncate(limit);
    Ok(LibraryPage {
        data: rows,
        next_cursor,
    })
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Asset {
    pub id: i32,
    pub key: String,
    pub content_type: String,
    pub size: i32,
    pub name: String,
}

async fn asset(conn: &mut PgConnection, id: i32) -> Result<Asset, AppError> {
    sqlx::query_as::<_, Asset>(
        "SELECT id, key, content_type, size, name FROM social_media_assets WHERE id = $1 AND hidden_at IS NULL",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(|e| db_err(&e))?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy tệp trong thư viện").into())
}

/// `POST /social/media/:id/hide` ⇒ `{ id, hidden: true }`. KHÔNG xoá tệp (bài đã đăng / đã hẹn vẫn dùng).
pub async fn hide(conn: &mut PgConnection, id: i32) -> Result<serde_json::Value, AppError> {
    asset(&mut *conn, id).await?;
    sqlx::query("UPDATE social_media_assets SET hidden_at = now() WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(|e| db_err(&e))?;
    Ok(serde_json::json!({ "id": id, "hidden": true }))
}

/// Tệp mở để phát: thân luồng và đầu đề.
pub struct MediaFile {
    pub body: MediaBody,
    pub content_type: String,
    pub content_length: Option<u64>,
    pub name: Option<String>,
}

/// `GET /social/media/:id/file`: xem trước tệp trong thư viện (stream qua BE). Kết nối nhả trước khi đọc kho.
pub async fn open(db: &Db, company: CompanyRef, store: &MediaStore, id: i32) -> Result<MediaFile, AppError> {
    let a = {
        let mut conn = acquire(db, company).await?;
        asset(&mut conn, id).await?
    };
    let f = store.get(&a.key).await.map_err(store_err)?;
    Ok(MediaFile {
        body: f.body,
        content_type: a.content_type,
        content_length: Some(u64::try_from(a.size).unwrap_or(0)),
        name: Some(a.name),
    })
}

/// `GET /social/media-link/:token/:name` (công khai): token phải hợp lệ và công ty trong token trùng công ty route; không thì 404.
pub async fn open_link(
    env: &Env,
    company: CompanyRef,
    store: &MediaStore,
    token: &str,
    now_ms: i64,
) -> Result<MediaFile, AppError> {
    let not_found = || AppError::from(HttpError::not_found("Not Found"));
    let secret = jwt_secret(env).map_err(|e| HttpError::new(500, e.to_string()))?;
    let v = verify_media_link(&secret, token, now_ms).ok_or_else(not_found)?;
    if v.company_id != company.id() {
        return Err(not_found());
    }
    let f = store.get(&v.key).await.map_err(|_| not_found())?;
    Ok(MediaFile {
        body: f.body,
        content_type: v.content_type,
        content_length: f.content_length,
        name: None,
    })
}

// ───────────────────────────── tải lên / nhập ─────────────────────────────

/// Ngữ cảnh chung của các hàm ghi: DB, công ty, kho tệp, env, người gọi, giờ hiện tại (mili giây).
pub struct MediaCtx<'a> {
    pub db: &'a Db,
    pub company: CompanyRef,
    pub store: &'a MediaStore,
    pub env: &'a Env,
    pub user_id: i32,
    pub now_ms: i64,
}

/// `POST /social/media` (multipart, trường `file`): `reader` là luồng của trường tệp; thiếu tệp thì route đã trả 400
/// "Thiếu tệp". Trả `SocialMedia` (không có tên), đã ghi vào thư viện với `source = 'web'`.
pub async fn upload_stream<R>(c: &MediaCtx<'_>, file_name: &str, reader: R) -> Result<SocialMedia, AppError>
where
    R: AsyncRead + Unpin + Send,
{
    let k = kind_of(file_name, max_video_bytes(c.env))?;
    let key = new_key(c.user_id, &k.ext, c.now_ms);
    let (mut limited, count, exceeded) = LimitReader::new(reader, k.max);
    let put = c.store.put_reader(&key, &mut limited, k.content_type).await;
    if exceeded.load(Ordering::Relaxed) {
        // Đĩa đã xoá tệp tạm, S3 đã huỷ multipart; xoá thêm cho chắc (khoá chưa có thì không sao).
        c.store.remove(&key).await;
        return Err(HttpError::payload_too_large(too_large(k.max)).into());
    }
    put.map_err(AppError::internal)?;
    let m = SocialMedia {
        key: key.clone(),
        r#type: k.kind.to_owned(),
        content_type: k.content_type.to_owned(),
        size: count.load(Ordering::Relaxed),
    };
    let name = display_name(Some(file_name), &key);
    record_new(c, &m, &name, "web").await?;
    Ok(m)
}

/// Ghi vào thư viện bằng một kết nối riêng; lỗi thì xoá tệp vừa đưa lên kho.
pub(crate) async fn record_new(c: &MediaCtx<'_>, m: &SocialMedia, name: &str, source: &str) -> Result<LibraryItem, AppError> {
    let rec = async {
        let mut conn = acquire(c.db, c.company).await?;
        record(&mut conn, c.user_id, m, name, source).await
    }
    .await;
    if rec.is_err() {
        c.store.remove(&m.key).await;
    }
    rec
}

fn import_error(code: &str) -> String {
    match code {
        "blocked_target" => "Link phải là https công khai (không nhận địa chỉ nội bộ).".to_owned(),
        "redirect_not_followed" => "Link chuyển hướng sang chỗ khác — đưa link trực tiếp tới tệp.".to_owned(),
        "not_media" => "Link không trả về ảnh hay video.".to_owned(),
        "too_large" => "Tệp quá lớn.".to_owned(),
        "timeout" => "Tải tệp quá lâu (quá 30 giây).".to_owned(),
        "network_error" => "Không tải được tệp từ link này.".to_owned(),
        other => format!("Không tải được tệp ({other})."),
    }
}

/// `decodeURIComponent`: `None` khi `%` hỏng hoặc không phải UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let hi = hex(*b.get(i + 1)?)?;
            let lo = hex(*b.get(i + 2)?)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Tên tệp cuối của đường dẫn trong URL (đã giải mã); hỏng ⇒ rỗng.
fn name_from_url(url: &str) -> String {
    let after = url.split_once("://").map_or(url, |(_, r)| r);
    let path = after.find('/').map_or("", |i| &after[i..]);
    let path = path.split(['?', '#']).next().unwrap_or("");
    percent_decode(path.rsplit('/').next().unwrap_or("")).unwrap_or_default()
}

/// AI đưa link ảnh/video công khai ⇒ tải về kho của Trinity, vào thư viện (`source = 'mcp'`). Qua lớp chống SSRF dùng chung.
pub async fn import_from_url(c: &MediaCtx<'_>, url: &str, name: Option<&str>) -> Result<LibraryItem, AppError> {
    let opts = SafeGetOptions::media_defaults(MAX_IMAGE_BYTES.max(MAX_IMPORT_VIDEO_BYTES) as usize)
        .map_err(AppError::internal)?;
    let got = safe_get_media(url, &opts)
        .await
        .map_err(|e| HttpError::bad_request(import_error(&e.0)))?;
    let ext = ext_for(&got.content_type, Some(url)).ok_or_else(|| HttpError::bad_request(BAD_KIND))?;
    let from_path = name_from_url(url);
    let fallback = if from_path.is_empty() {
        "tep-tu-link"
    } else {
        &from_path
    };
    store_bytes(c, &got.body, &ext, &display_name(name, fallback)).await
}

/// Ảnh nhỏ gửi thẳng dạng base64 (≤ 3 MB) ⇒ vào thư viện.
pub async fn import_base64(
    c: &MediaCtx<'_>,
    data: &str,
    file_name: &str,
    name: Option<&str>,
) -> Result<LibraryItem, AppError> {
    use base64::Engine;
    let stripped = match data.strip_prefix("data:").and_then(|r| r.split_once(";base64,")) {
        Some((mime, b)) if !mime.is_empty() && !mime.contains([';', ',']) => b,
        _ => data,
    };
    let raw: String = stripped.chars().filter(|c| !c.is_whitespace()).collect();
    let body_part = raw.trim_end_matches('=');
    let pad = raw.len() - body_part.len();
    let valid = !body_part.is_empty()
        && pad <= 2
        && body_part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/');
    if !valid {
        return Err(HttpError::bad_request("data_base64 không phải base64 hợp lệ.").into());
    }
    if (raw.len() as u64) * 3 / 4 > MAX_BASE64_BYTES + 4 {
        let m = format!(
            "Gửi base64 tối đa {} — tệp lớn hơn thì đưa link (url).",
            mb(MAX_BASE64_BYTES)
        );
        return Err(HttpError::bad_request(m).into());
    }
    let ext = ext_for("", Some(file_name))
        .ok_or_else(|| HttpError::bad_request("file_name phải có đuôi .jpg/.png/.webp/.gif/.mp4/.mov/.webm."))?;
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(body_part)
        .map_err(|_| HttpError::bad_request("data_base64 không phải base64 hợp lệ."))?;
    let shown = display_name(Some(name.unwrap_or(file_name)), file_name);
    store_bytes(c, &bytes, &ext, &shown).await
}

async fn store_bytes(c: &MediaCtx<'_>, body: &[u8], ext: &str, name: &str) -> Result<LibraryItem, AppError> {
    let k = kind_of(&format!("x{ext}"), max_video_bytes(c.env))?;
    if body.is_empty() {
        return Err(HttpError::bad_request("Tệp rỗng.").into());
    }
    let max = if k.kind == "video" {
        k.max.min(MAX_IMPORT_VIDEO_BYTES)
    } else {
        k.max
    };
    if body.len() as u64 > max {
        return Err(HttpError::bad_request(too_large(max)).into());
    }
    let key = new_key(c.user_id, &k.ext, c.now_ms);
    c.store
        .put_bytes(&key, body, k.content_type)
        .await
        .map_err(AppError::internal)?;
    let m = SocialMedia {
        key,
        r#type: k.kind.to_owned(),
        content_type: k.content_type.to_owned(),
        size: body.len() as u64,
    };
    record_new(c, &m, name, "mcp").await
}

/// Khoá do AI/FE gửi lên ⇒ mô tả tệp đã kiểm: đúng dạng, có thật trong kho, và của chính người dùng HOẶC đang có trong
/// thư viện chung (người khác tải lên, chưa ẩn). Lỗi ⇒ 400.
pub async fn resolve(c: &MediaCtx<'_>, keys: &[String]) -> Result<Vec<SocialMedia>, AppError> {
    let shared: HashSet<String> = {
        let mut conn = acquire(c.db, c.company).await?;
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT key FROM social_media_assets WHERE key = ANY($1) AND hidden_at IS NULL")
                .bind(keys)
                .fetch_all(&mut *conn)
                .await
                .map_err(|e| db_err(&e))?;
        rows.into_iter().map(|r| r.0).collect()
    };
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let bad = || {
            AppError::from(HttpError::bad_request(format!(
                "Tệp không hợp lệ: {}",
                utf16_prefix(key, 80)
            )))
        };
        let owner = parse_key(key).ok_or_else(bad)?;
        if owner != c.user_id as u64 && !shared.contains(key) {
            return Err(bad());
        }
        let k = kind_of(key, MAX_STORED_VIDEO_BYTES)?;
        let size = match c.store.size_of(key).await {
            Ok(n) => n,
            Err(StorageError::NotFound(_)) => {
                return Err(HttpError::bad_request("Tệp chưa được tải lên hoặc đã hết hạn").into());
            }
            Err(e) => return Err(AppError::internal(e)),
        };
        if size > k.max {
            return Err(HttpError::bad_request(too_large(k.max)).into());
        }
        out.push(SocialMedia {
            key: key.clone(),
            r#type: k.kind.to_owned(),
            content_type: k.content_type.to_owned(),
            size,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn dau_tep() {
        assert_eq!(extname("a/b.PNG"), ".png");
        assert_eq!(extname(".png"), "");
        assert_eq!(extname("x"), "");
        assert_eq!(extname("a.b.mp4"), ".mp4");
        assert_eq!(kind_of("a.MOV", 5).unwrap().max, 5);
        assert_eq!(kind_of("a.jpeg", 5).unwrap().content_type, "image/jpeg");
        assert!(kind_of("a.pdf", 5).is_err());
        assert_eq!(ext_for("IMAGE/JPEG", None).as_deref(), Some(".jpg"));
        assert_eq!(ext_for("", Some("https://x/a.webp?x=1#y")).as_deref(), Some(".webp"));
        assert_eq!(ext_for("application/octet-stream", Some("a.exe")), None);
    }

    #[test]
    fn tran_video_theo_env() {
        let m = 1024 * 1024;
        assert_eq!(video_bytes_from(None), 200 * m);
        assert_eq!(video_bytes_from(Some("95")), 95 * m);
        assert_eq!(video_bytes_from(Some(" 95 ")), 95 * m);
        assert_eq!(video_bytes_from(Some("999")), 200 * m);
        assert_eq!(video_bytes_from(Some("0")), 200 * m);
        assert_eq!(video_bytes_from(Some("abc")), 200 * m);
        assert_eq!(video_bytes_from(Some("-5")), 200 * m);
        assert_eq!(video_bytes_from(Some("99999999999999999999999")), 200 * m);
        assert_eq!(mb(95 * m), "95 MB");
        assert_eq!(too_large(10 * m), "Tệp quá lớn (tối đa 10 MB).");
    }

    #[test]
    fn khoa_tep() {
        assert_eq!(parse_key("social/u12_1700000000000_ab12cd.mp4"), Some(12));
        for bad in [
            "social/u_1_a.png",
            "social/u1_1_.png",
            "social/u1_1_a",
            "social/u1_x_a.png",
            "social/u1_1_A.png",
            "social/u1_1_a.b.c",
            "../social/u1_1_a.png",
            "social/u1_1_a.png/x",
        ] {
            assert_eq!(parse_key(bad), None, "{bad}");
        }
        let k = new_key(7, ".png", 5);
        assert_eq!(parse_key(&k), Some(7), "{k}");
    }

    #[test]
    fn ten_hien_thi() {
        assert_eq!(display_name(Some("C:\\a\\b/ảnh đẹp.png"), "f"), "ảnh đẹp.png");
        assert_eq!(display_name(Some("  \u{1}\u{2} "), "dự phòng"), "dự phòng");
        assert_eq!(display_name(None, "x"), "x");
        assert_eq!(display_name(Some(&"a".repeat(300)), "x").len(), 200);
        assert_eq!(name_from_url("https://h.example/p/a%20b.png?x=1"), "a b.png");
        assert_eq!(name_from_url("https://h.example/p/%E0%A4%A.png"), "");
        assert_eq!(name_from_url("https://h.example"), "");
    }

    #[test]
    fn query_thu_vien() {
        let q = LibraryQuery::from_query(Some("video"), Some("  Ab%  "), Some("5"), Some("0")).unwrap();
        assert_eq!(
            (q.kind, q.q.as_deref(), q.limit, q.cursor),
            (Some("video"), Some("Ab%"), 5, None)
        );
        let q = LibraryQuery::from_query(Some("x"), Some("   "), Some("abc"), Some("12")).unwrap();
        assert_eq!((q.kind, q.q, q.limit, q.cursor), (None, None, 24, Some(12)));
        assert_eq!(LibraryQuery::from_query(None, None, Some("0"), None).unwrap().limit, 1);
        assert_eq!(
            LibraryQuery::from_query(None, None, Some("99999999999999999999"), None)
                .unwrap()
                .limit,
            100
        );
        assert!(LibraryQuery::from_query(None, None, None, Some("3000000000")).is_err());
        assert_eq!(escape_like(r"a%b_c\d"), r"a\%b\_c\\d");
    }

    #[tokio::test]
    async fn limit_reader_chan_khi_vuot_tran() {
        let data = [7_u8; 100];
        let (mut r, count, exceeded) = LimitReader::new(&data[..], 100);
        let mut out = Vec::new();
        r.read_to_end(&mut out).await.unwrap();
        assert_eq!(
            (
                out.len(),
                count.load(Ordering::Relaxed),
                exceeded.load(Ordering::Relaxed)
            ),
            (100, 100, false)
        );
        let (mut r, _, exceeded) = LimitReader::new(&data[..], 99);
        let mut out = Vec::new();
        assert!(r.read_to_end(&mut out).await.is_err());
        assert!(exceeded.load(Ordering::Relaxed));
    }

    #[test]
    fn loi_nhap_link() {
        assert_eq!(import_error("not_media"), "Link không trả về ảnh hay video.");
        assert_eq!(import_error("http_404"), "Không tải được tệp (http_404).");
    }
}
