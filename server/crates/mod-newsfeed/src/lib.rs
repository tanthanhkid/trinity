//! Bảng tin nội bộ (M22): bài đăng theo nhóm, ảnh/video, thích, bình luận, thông báo bài mới.
//!
//! Chuyển từ `services/crm/src/newsfeed` (13 endpoint). Lớp logic nằm ở đây, router axum ở [`routes`]:
//! mỗi hàm tương ứng một endpoint, nhận [`TenantDb`] của công ty, người gọi ([`Actor`]) và đầu vào đã qua kiểm dữ liệu
//! (các hàm `validate_*` giữ nguyên câu lỗi của class-validator). Trả JSON đúng hình và thứ tự khoá của bản Node
//! (`POST_SELECT`/`COMMENT_SELECT` của Prisma), ngày là chuỗi ISO có mili giây.
//!
//! | Endpoint | Hàm |
//! |---|---|
//! | `GET /newsfeed` | [`list`] |
//! | `GET /newsfeed/permissions/me` | [`permissions_me`] |
//! | `POST /newsfeed` | [`create`] (không tệp) |
//! | `POST /newsfeed/upload` | [`create`] (ảnh, video) |
//! | `POST /newsfeed/video-upload-token` | [`video_upload_token_gone`] (luôn 400) |
//! | `GET /newsfeed/:id/image`, `/images/:index` | [`media`] |
//! | `PATCH /newsfeed/:id` | [`update`], [`update_post`] (đổi «Mục») |
//! | `POST /newsfeed/:id/upload` | [`update_with_media`] (sửa bài + thêm ảnh/video) |
//! | `DELETE /newsfeed/:id` | [`delete`] |
//! | `POST /newsfeed/:id/like` | [`toggle_like`] |
//! | `GET/POST /newsfeed/:id/comments` | [`list_comments`], [`create_comment`] |
//! | `DELETE /newsfeed/comments/:id` | [`delete_comment`] |
//!
//! Ảnh nén WebP ở `trinity-docgen` (cạnh dài ≤ 1920, chất lượng 80); video lưu nguyên, đọc từ tệp tạm theo luồng
//! (không nạp cả video vào RAM). Thông báo "bài mới" đi qua cổng chung K36 (`trinity_db::outbox`), không có bản riêng.

pub mod routes;
mod text;

use std::future::Future;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sqlx::{PgConnection, Row};
use trinity_db::outbox::{CreatedNotification, NewNotification, create_notification};
use trinity_db::types::Timestamp;
use trinity_db::{DbError, TenantDb};
use trinity_kernel::error::HttpError;
use trinity_storage::{LocalDiskDriver, S3Driver, StorageError};

pub use text::strip_html_to_text;

/// Nhóm bài đăng.
pub const CATEGORIES: [&str; 3] = ["announcement", "training", "pr"];
pub const CONTENT_MAX_LEN: usize = 20_000;
pub const COMMENT_MAX_LEN: usize = 2_000;
pub const MAX_IMAGE_SIZE: u64 = 10 * 1024 * 1024;
pub const MAX_IMAGES_PER_POST: usize = 10;
pub const MAX_VIDEO_SIZE: u64 = 40 * 1024 * 1024;
pub const MAX_VIDEOS_PER_POST: usize = 5;
const NOTIFY_PREVIEW_LEN: usize = 120;
const ALLOWED_IMAGE_TYPES: [&str; 4] = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
/// Loại sự kiện thông báo của bài mới.
pub const EVENT_POST_CREATED: &str = "newsfeed.post.created";

fn category_label(category: &str) -> &'static str {
    match category {
        "pr" => "Truyền thông",
        "training" => "Đào tạo",
        "announcement" => "Thông báo",
        _ => "Bảng tin",
    }
}

fn video_content_type(ext: &str) -> Option<&'static str> {
    match ext {
        ".mp4" => Some("video/mp4"),
        ".webm" => Some("video/webm"),
        ".mov" => Some("video/quicktime"),
        _ => None,
    }
}

/// Lỗi của lớp logic: `Http` là lỗi nghiệp vụ (đã đúng mã và câu như bản Node); `Internal` ⇒ tầng HTTP trả 500.
#[derive(Debug)]
pub enum Error {
    Http(Box<HttpError>),
    Internal(String),
}

impl From<HttpError> for Error {
    fn from(e: HttpError) -> Self {
        Error::Http(Box::new(e))
    }
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

impl From<DbError> for Error {
    fn from(e: DbError) -> Self {
        Error::Internal(e.to_string())
    }
}

impl From<StorageError> for Error {
    fn from(e: StorageError) -> Self {
        Error::Internal(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

fn not_found(msg: &str) -> Error {
    Error::Http(Box::new(HttpError::not_found(msg)))
}

fn bad_request(msg: &str) -> Error {
    Error::Http(Box::new(HttpError::bad_request(msg)))
}

fn forbidden(msg: &str) -> Error {
    Error::Http(Box::new(HttpError::forbidden(msg)))
}

/// Người gọi: id và hai quyền của module (`newsfeed.post`, `newsfeed.moderate`).
#[derive(Debug, Clone, Copy)]
pub struct Actor {
    pub user_id: i32,
    pub can_post: bool,
    pub can_moderate: bool,
}

// ---------------------------------------------------------------------------------------------------------------------
// Kho tệp

/// Phần kho tệp mà module cần; cài cho đĩa cục bộ và S3.
pub trait MediaStore: Sync {
    type Ranged: Send;
    fn put(
        &self,
        key: &str,
        body: &[u8],
        content_type: &str,
    ) -> impl Future<Output = std::result::Result<(), StorageError>> + Send;
    /// Đẩy theo luồng từ tệp tạm (video), không đọc cả tệp vào RAM.
    fn put_file(
        &self,
        key: &str,
        path: &Path,
        content_type: &str,
    ) -> impl Future<Output = std::result::Result<(), StorageError>> + Send;
    fn remove(&self, key: &str) -> impl Future<Output = std::result::Result<(), StorageError>> + Send;
    fn get_range(
        &self,
        key: &str,
        range: Option<&str>,
    ) -> impl Future<Output = std::result::Result<Self::Ranged, StorageError>> + Send;
}

impl MediaStore for LocalDiskDriver {
    type Ranged = trinity_storage::RangedObject;
    async fn put(&self, key: &str, body: &[u8], content_type: &str) -> std::result::Result<(), StorageError> {
        self.upload(key, body, content_type).await.map(drop)
    }
    async fn put_file(&self, key: &str, path: &Path, content_type: &str) -> std::result::Result<(), StorageError> {
        let mut f = tokio::fs::File::open(path).await?;
        self.upload_reader(key, &mut f, content_type).await.map(drop)
    }
    async fn remove(&self, key: &str) -> std::result::Result<(), StorageError> {
        self.delete(key).await
    }
    async fn get_range(&self, key: &str, range: Option<&str>) -> std::result::Result<Self::Ranged, StorageError> {
        LocalDiskDriver::get_range(self, key, range).await
    }
}

impl MediaStore for S3Driver {
    type Ranged = trinity_storage::S3RangedObject;
    async fn put(&self, key: &str, body: &[u8], content_type: &str) -> std::result::Result<(), StorageError> {
        self.upload(key, bytes::Bytes::copy_from_slice(body), content_type)
            .await
            .map(drop)
    }
    async fn put_file(&self, key: &str, path: &Path, content_type: &str) -> std::result::Result<(), StorageError> {
        let mut f = tokio::fs::File::open(path).await?;
        self.upload_reader(key, &mut f, content_type).await.map(drop)
    }
    async fn remove(&self, key: &str) -> std::result::Result<(), StorageError> {
        self.delete(key).await
    }
    async fn get_range(&self, key: &str, range: Option<&str>) -> std::result::Result<Self::Ranged, StorageError> {
        S3Driver::get_range(self, key, range).await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Kiểm dữ liệu vào (câu lỗi như class-validator của bản Node)

fn validation(messages: Vec<String>) -> Error {
    Error::Http(Box::new(HttpError::validation(messages)))
}

/// `category` phải thuộc [`CATEGORIES`].
pub fn validate_category(category: &str) -> Result<()> {
    if CATEGORIES.contains(&category) {
        Ok(())
    } else {
        Err(validation(vec![format!(
            "category must be one of the following values: {}",
            CATEGORIES.join(", ")
        )]))
    }
}

fn validate_text(field: &str, value: &str, max: usize, required: bool) -> Result<()> {
    let mut msgs = Vec::new();
    if required && value.is_empty() {
        msgs.push(format!("{field} should not be empty"));
    }
    if value.chars().map(|c| c.len_utf16()).sum::<usize>() > max {
        msgs.push(format!("{field} must be shorter than or equal to {max} characters"));
    }
    if msgs.is_empty() { Ok(()) } else { Err(validation(msgs)) }
}

/// Nội dung bài (tối đa 20.000, không rỗng) — `POST /newsfeed`, `PATCH /newsfeed/:id`. Bài multipart cho phép rỗng.
pub fn validate_post_content(content: &str, required: bool) -> Result<()> {
    validate_text("content", content, CONTENT_MAX_LEN, required)
}

/// Nội dung bình luận (không rỗng, tối đa 2.000).
pub fn validate_comment_content(content: &str) -> Result<()> {
    validate_text("content", content, COMMENT_MAX_LEN, true)
}

/// `GET /newsfeed/:id/comments` không có kiểm DTO: tham số rác thành `None` (như `Number('abc')` bị bỏ qua ở tầng dưới).
fn clamp(limit: Option<i64>, default: i64, max: i64) -> i64 {
    limit.unwrap_or(default).clamp(1, max)
}

// ---------------------------------------------------------------------------------------------------------------------
// Hình JSON trả ra

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UserBrief {
    pub id: i32,
    pub full_name: String,
    pub email: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MediaItem {
    pub id: i32,
    pub image_url: String,
    pub media_type: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Counts {
    pub likes: i64,
    pub comments: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Post {
    pub id: i32,
    pub category: String,
    pub author_id: i32,
    pub content: String,
    pub image_url: Option<String>,
    pub edited_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub author: UserBrief,
    pub images: Vec<MediaItem>,
    #[serde(rename = "_count")]
    pub count: Counts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liked_by_me: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Comment {
    pub id: i32,
    pub post_id: i32,
    pub user_id: i32,
    pub content: String,
    pub created_at: Timestamp,
    pub user: UserBrief,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Page<T> {
    pub data: Vec<T>,
    pub next_cursor: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Permissions {
    pub can_post: bool,
    pub can_moderate: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LikeState {
    pub liked: bool,
    pub like_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub message: &'static str,
}

macro_rules! post_sql {
    () => {
        "SELECT p.id, p.category, p.author_id, p.content, p.image_url, p.edited_at, p.created_at,
        u.id AS u_id, u.full_name AS u_full_name, u.email AS u_email, u.avatar_url AS u_avatar_url,
        (SELECT count(*) FROM newsfeed_post_likes l WHERE l.post_id = p.id) AS likes,
        (SELECT count(*) FROM newsfeed_post_comments c WHERE c.post_id = p.id) AS comments
    FROM newsfeed_posts p JOIN users u ON u.id = p.author_id"
    };
}

fn user_from(r: &sqlx::postgres::PgRow, prefix: &str) -> std::result::Result<UserBrief, sqlx::Error> {
    Ok(UserBrief {
        id: r.try_get(format!("{prefix}id").as_str())?,
        full_name: r.try_get(format!("{prefix}full_name").as_str())?,
        email: r.try_get(format!("{prefix}email").as_str())?,
        avatar_url: r.try_get(format!("{prefix}avatar_url").as_str())?,
    })
}

async fn load_posts(conn: &mut PgConnection, rows: Vec<sqlx::postgres::PgRow>) -> Result<Vec<Post>> {
    let ids: Vec<i32> = rows.iter().map(|r| r.get::<i32, _>("id")).collect();
    let media = sqlx::query(
        "SELECT id, post_id, image_url, media_type::text AS media_type, sort_order
         FROM newsfeed_post_images WHERE post_id = ANY($1) ORDER BY sort_order, id",
    )
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let id: i32 = r.get("id");
        let images = media
            .iter()
            .filter(|m| m.get::<i32, _>("post_id") == id)
            .map(|m| MediaItem {
                id: m.get("id"),
                image_url: m.get("image_url"),
                media_type: m.get("media_type"),
                sort_order: m.get("sort_order"),
            })
            .collect();
        out.push(Post {
            id,
            category: r.get("category"),
            author_id: r.get("author_id"),
            content: r.get("content"),
            image_url: r.get("image_url"),
            edited_at: r.get("edited_at"),
            created_at: r.get("created_at"),
            author: user_from(r, "u_")?,
            images,
            count: Counts {
                likes: r.get("likes"),
                comments: r.get("comments"),
            },
            liked_by_me: None,
        });
    }
    Ok(out)
}

async fn post_by_id(conn: &mut PgConnection, id: i32) -> Result<Option<Post>> {
    let rows = sqlx::query(concat!(post_sql!(), " WHERE p.id = $1"))
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
    Ok(load_posts(conn, rows).await?.pop())
}

/// Con trỏ của Prisma (`cursor: {id}, skip: 1`): id không còn thì trang trống (không "nhảy" sang bài kế).
async fn cursor_exists(conn: &mut PgConnection, table: &str, cursor: i64) -> Result<bool> {
    let sql = match table {
        "posts" => "SELECT EXISTS (SELECT 1 FROM newsfeed_posts WHERE id = $1)",
        _ => "SELECT EXISTS (SELECT 1 FROM newsfeed_post_comments WHERE id = $1)",
    };
    let Ok(id) = i32::try_from(cursor) else {
        return Ok(false);
    };
    Ok(sqlx::query_scalar(sql).bind(id).fetch_one(&mut *conn).await?)
}

// ---------------------------------------------------------------------------------------------------------------------
// Endpoint

/// `GET /newsfeed` (`AuthOnly`): trang bài theo `id` giảm dần; `cursor` 0 hoặc thiếu = trang đầu; `limit` 1–50 (mặc định 10),
/// đã kiểm ở [`validate_list_query`].
///
/// Khác biệt đã biết khi có `category` kèm `cursor`: con trỏ chỉ cần là id của MỘT bài còn tồn tại (bất kể nhóm) rồi lấy tiếp
/// các bài cùng nhóm có `id` nhỏ hơn; id không còn thì trang trống như Prisma. Prisma định vị con trỏ trong tập đã lọc theo
/// nhóm, nên với con trỏ thuộc nhóm khác kết quả có thể khác ở mép trang; con trỏ do chính API này phát ra (id cuối của một
/// trang cùng bộ lọc) luôn cho kết quả giống nhau.
pub async fn list(db: &TenantDb, actor: &Actor, q: &ListQuery) -> Result<Page<Post>> {
    let (category, cursor) = (q.category.as_deref(), q.cursor);
    let take = q.limit.unwrap_or(10);
    let mut conn = db.acquire().await?;
    let cursor = cursor.filter(|c| *c != 0);
    if let Some(c) = cursor
        && !cursor_exists(&mut conn, "posts", c).await?
    {
        return Ok(Page {
            data: Vec::new(),
            next_cursor: None,
        });
    }
    let rows = sqlx::query(concat!(
        post_sql!(),
        " WHERE ($1::text IS NULL OR p.category = $1) AND ($2::int4 IS NULL OR p.id < $2) ORDER BY p.id DESC LIMIT $3"
    ))
    .bind(category)
    .bind(cursor.map(|c| c as i32))
    .bind(take + 1)
    .fetch_all(&mut *conn)
    .await?;
    let mut posts = load_posts(&mut conn, rows).await?;
    let has_more = posts.len() as i64 > take;
    if has_more {
        posts.truncate(take as usize);
    }
    let ids: Vec<i32> = posts.iter().map(|p| p.id).collect();
    let liked: Vec<i32> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar("SELECT post_id FROM newsfeed_post_likes WHERE post_id = ANY($1) AND user_id = $2")
            .bind(&ids)
            .bind(actor.user_id)
            .fetch_all(&mut *conn)
            .await?
    };
    for p in &mut posts {
        p.liked_by_me = Some(liked.contains(&p.id));
    }
    let next_cursor = if has_more { posts.last().map(|p| p.id) } else { None };
    Ok(Page {
        data: posts,
        next_cursor,
    })
}

/// Tham số đã kiểm của `GET /newsfeed` (`QueryPostsDto`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ListQuery {
    pub category: Option<String>,
    pub cursor: Option<i64>,
    pub limit: Option<i64>,
}

/// `Number(chuỗi)` của `@Type(() => Number)`: chuỗi rỗng là 0, rác là NaN; trả `Err(())` nếu không phải số nguyên.
fn query_int(raw: &str) -> std::result::Result<i64, ()> {
    let t = raw.trim();
    let n: f64 = if t.is_empty() { 0.0 } else { t.parse().map_err(|_| ())? };
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Ok(n as i64)
    } else {
        Err(())
    }
}

/// Kiểm query của `GET /newsfeed` đúng câu của class-validator: `category` thuộc [`CATEGORIES`]; `cursor` nguyên;
/// `limit` nguyên trong 1–50. Giá trị ngoài khoảng bị từ chối 400 (không kẹp). Tham số là chuỗi thô của query string.
pub fn validate_list_query(category: Option<&str>, cursor: Option<&str>, limit: Option<&str>) -> Result<ListQuery> {
    let mut msgs = Vec::new();
    if let Some(c) = category
        && !CATEGORIES.contains(&c)
    {
        msgs.push(format!(
            "category must be one of the following values: {}",
            CATEGORIES.join(", ")
        ));
    }
    let cursor = cursor.and_then(|c| match query_int(c) {
        Ok(v) => Some(v),
        Err(()) => {
            msgs.push("cursor must be an integer number".to_owned());
            None
        }
    });
    let limit = limit.and_then(|l| match query_int(l) {
        Ok(v) => {
            if v < 1 {
                msgs.push("limit must not be less than 1".to_owned());
            }
            if v > 50 {
                msgs.push("limit must not be greater than 50".to_owned());
            }
            Some(v)
        }
        Err(()) => {
            msgs.push("limit must be an integer number".to_owned());
            msgs.push("limit must not be less than 1".to_owned());
            msgs.push("limit must not be greater than 50".to_owned());
            None
        }
    });
    if !msgs.is_empty() {
        return Err(validation(msgs));
    }
    Ok(ListQuery {
        category: category.map(str::to_owned),
        cursor,
        limit,
    })
}

/// `GET /newsfeed/permissions/me`.
pub fn permissions_me(actor: &Actor) -> Permissions {
    Permissions {
        can_post: actor.can_post,
        can_moderate: actor.can_moderate,
    }
}

/// `POST /newsfeed/video-upload-token`: đã ngừng, luôn 400 (bundle cũ tự chuyển sang multipart).
pub fn video_upload_token_gone() -> HttpError {
    HttpError::bad_request("Môi trường này không dùng upload trực tiếp — gửi video qua /newsfeed/upload")
}

/// Ảnh nhận từ multipart (đã nằm trong bộ nhớ, trần 10 MB mỗi ảnh).
#[derive(Debug)]
pub struct ImageUpload {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Video nhận từ multipart: tệp tạm trên đĩa (router ghi), module đọc theo luồng rồi xoá tệp tạm.
#[derive(Debug)]
pub struct VideoUpload {
    pub file_name: String,
    pub size: u64,
    pub path: PathBuf,
}

fn media_key(ext: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let rand = uuid::Uuid::new_v4().simple().to_string();
    format!("newsfeed/{now}_{}{ext}", &rand[..6])
}

async fn put_image<S: MediaStore>(store: &S, img: ImageUpload) -> Result<String> {
    if !ALLOWED_IMAGE_TYPES.contains(&img.content_type.as_str()) {
        return Err(bad_request("Chỉ hỗ trợ JPG, PNG, WEBP"));
    }
    if img.bytes.len() as u64 > MAX_IMAGE_SIZE {
        return Err(bad_request("Kích thước ảnh tối đa 10MB"));
    }
    // Nén nặng CPU: tách khỏi luồng async.
    let bytes = img.bytes;
    let encoded = tokio::task::spawn_blocking(move || trinity_docgen::image::newsfeed_webp(&bytes))
        .await
        .map_err(|e| Error::Internal(e.to_string()))?
        .map_err(|e| match e {
            trinity_docgen::image::ImageError::NotImage(_) => bad_request("Chỉ hỗ trợ JPG, PNG, WEBP"),
            trinity_docgen::image::ImageError::Encode(m) => Error::Internal(m),
        })?;
    let key = media_key(".webp");
    store.put(&key, &encoded.bytes, "image/webp").await?;
    Ok(key)
}

async fn put_video<S: MediaStore>(store: &S, v: &VideoUpload) -> Result<String> {
    let ext = Path::new(&v.file_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let content_type = video_content_type(&ext).ok_or_else(|| bad_request("Chỉ hỗ trợ video MP4, WebM, MOV"))?;
    if v.size > MAX_VIDEO_SIZE {
        return Err(Error::Http(Box::new(HttpError::bad_request(format!(
            "Kích thước video tối đa {}MB",
            MAX_VIDEO_SIZE / (1024 * 1024)
        )))));
    }
    let key = media_key(&ext);
    store.put_file(&key, &v.path, content_type).await?;
    Ok(key)
}

/// `POST /newsfeed` và `POST /newsfeed/upload` (`Can('newsfeed.post')`): đăng bài, có thể kèm ảnh/video. Tệp tạm của
/// video luôn được dọn, kể cả khi lỗi.
///
/// Thông báo cho mọi nhân viên đang hoạt động trừ người đăng chạy NỀN (`tokio::spawn`, như `runInBackground` của bản Node)
/// SAU khi bài đã commit; lỗi chỉ ghi log, không làm hỏng việc đăng. Khi tạo xong (đã commit), `on_notified` được gọi với các
/// dòng thông báo đã tạo để router đẩy socket NỘI BỘ cùng tiến trình (tin `NOTIFY bell` bị lọc khỏi chính tiến trình phát,
/// xem `trinity_db::outbox::CreatedNotification`); không có người nhận thì không gọi.
#[allow(clippy::too_many_arguments)] // tương ứng các trường của một lần đăng bài; router dựng từ multipart
pub async fn create<S, N>(
    db: &TenantDb,
    store: &S,
    actor: &Actor,
    category: &str,
    content: &str,
    images: Vec<ImageUpload>,
    videos: &[VideoUpload],
    on_notified: N,
) -> Result<Post>
where
    S: MediaStore,
    N: FnOnce(Vec<CreatedNotification>) + Send + 'static,
{
    let res = create_inner(db, store, actor, category, content, images, videos).await;
    for v in videos {
        let _ = tokio::fs::remove_file(&v.path).await;
    }
    let post = res?;
    let (db, bg_post) = (db.clone(), post.clone());
    tokio::spawn(async move {
        match notify_new_post(&db, &bg_post).await {
            Ok(created) if !created.is_empty() => on_notified(created),
            Ok(_) => {}
            Err(e) => tracing::warn!("notifyNewPost failed for post {}: {}", bg_post.id, describe(&e)),
        }
    });
    Ok(post)
}

fn describe(e: &Error) -> String {
    match e {
        Error::Internal(m) => m.clone(),
        Error::Http(h) => format!("{h:?}"),
    }
}

async fn create_inner<S: MediaStore>(
    db: &TenantDb,
    store: &S,
    actor: &Actor,
    category: &str,
    content: &str,
    images: Vec<ImageUpload>,
    videos: &[VideoUpload],
) -> Result<Post> {
    let trimmed = content.trim();
    if trimmed.is_empty() && images.is_empty() && videos.is_empty() {
        return Err(bad_request("Vui lòng nhập nội dung hoặc đính kèm ảnh/video"));
    }
    check_media_room((0, 0), (images.len(), videos.len()))?;
    let mut uploaded: Vec<(String, &'static str)> = Vec::new();
    let result = async {
        for img in images {
            uploaded.push((put_image(store, img).await?, "image"));
        }
        for v in videos {
            uploaded.push((put_video(store, v).await?, "video"));
        }
        let mut tx = db.begin().await?;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO newsfeed_posts (category, author_id, content, updated_at) VALUES ($1, $2, $3, now()) RETURNING id",
        )
        .bind(category)
        .bind(actor.user_id)
        .bind(trimmed)
        .fetch_one(&mut *tx)
        .await?;
        for (i, (key, kind)) in uploaded.iter().enumerate() {
            sqlx::query("INSERT INTO newsfeed_post_images (post_id, image_url, media_type, sort_order) VALUES ($1, $2, $3::text::\"NewsfeedMediaType\", $4)")
                .bind(id)
                .bind(key)
                .bind(*kind)
                .bind(i as i32)
                .execute(&mut *tx)
                .await?;
        }
        let post = post_by_id(&mut tx, id).await?.ok_or_else(|| Error::Internal("bài vừa tạo biến mất".to_owned()))?;
        tx.commit().await?;
        Ok::<Post, Error>(Post { liked_by_me: Some(false), ..post })
    }
    .await;
    if result.is_err() {
        // Tránh tệp mồ côi khi ghi DB (hoặc tệp sau) lỗi.
        for (key, _) in &uploaded {
            let _ = store.remove(key).await;
        }
    }
    result
}

async fn notify_new_post(db: &TenantDb, post: &Post) -> Result<Vec<CreatedNotification>> {
    let mut tx = db.begin().await?;
    let recipients: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM users WHERE status = 'active' AND id <> $1 ORDER BY id")
            .bind(post.author_id)
            .fetch_all(&mut *tx)
            .await?;
    if recipients.is_empty() {
        return Ok(Vec::new());
    }
    let author = post.author.full_name.trim();
    let author = if author.is_empty() { "Một nhân viên" } else { author };
    let text = strip_html_to_text(&post.content);
    let preview: String = if text.is_empty() {
        "Đã đăng hình ảnh/video mới".to_owned()
    } else {
        // `slice(0, 120)` đếm đơn vị UTF-16; ký tự ngoài BMP chiếm 2.
        let mut n = 0;
        text.chars()
            .take_while(|c| {
                n += c.len_utf16();
                n <= NOTIFY_PREVIEW_LEN
            })
            .collect()
    };
    let title = format!("Bài đăng mới • {}", category_label(&post.category));
    let body = format!("{author}: {preview}");
    let url = format!("/newsfeed?post={}", post.id);
    let items: Vec<NewNotification> = recipients
        .into_iter()
        .map(|recipient_id| NewNotification {
            recipient_id,
            event_type: EVENT_POST_CREATED.to_owned(),
            title: title.clone(),
            body: body.clone(),
            action_url: Some(url.clone()),
        })
        .collect();
    let created = create_notification(&mut tx, &items)
        .await
        .map_err(|e| Error::Internal(e.to_string()))?;
    tx.commit().await?;
    Ok(created)
}

async fn post_author(conn: &mut PgConnection, id: i32) -> Result<i32> {
    sqlx::query_scalar("SELECT author_id FROM newsfeed_posts WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| not_found("Không tìm thấy bài đăng"))
}

/// `PATCH /newsfeed/:id` (`AuthOnly`; cổng thật: tác giả hoặc `newsfeed.moderate`).
pub async fn update(db: &TenantDb, actor: &Actor, post_id: i32, content: &str) -> Result<Post> {
    update_post(db, actor, post_id, content, None).await
}

/// `PATCH /newsfeed/:id` có thể kèm `category` (đổi «Mục»; đã kiểm thuộc [`CATEGORIES`] ở router). Đổi mục không gửi lại
/// thông báo "bài mới".
pub async fn update_post(
    db: &TenantDb,
    actor: &Actor,
    post_id: i32,
    content: &str,
    category: Option<&str>,
) -> Result<Post> {
    let mut conn = db.acquire().await?;
    let author = post_author(&mut conn, post_id).await?;
    if author != actor.user_id && !actor.can_moderate {
        return Err(forbidden("Bạn không có quyền sửa bài này"));
    }
    sqlx::query(
        "UPDATE newsfeed_posts SET content = $2, category = COALESCE($3, category), edited_at = now(), updated_at = now() \
         WHERE id = $1",
    )
    .bind(post_id)
    .bind(content.trim())
    .bind(category)
    .execute(&mut *conn)
    .await?;
    post_by_id(&mut conn, post_id)
        .await?
        .ok_or_else(|| not_found("Không tìm thấy bài đăng"))
}

/// Số ảnh và số video đang gắn với bài.
async fn media_counts(conn: &mut PgConnection, post_id: i32) -> Result<(usize, usize, i32)> {
    let (images, videos, next): (i64, i64, i32) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE media_type::text = 'image'), count(*) FILTER (WHERE media_type::text = 'video'), \
         COALESCE(max(sort_order) + 1, 0) FROM newsfeed_post_images WHERE post_id = $1",
    )
    .bind(post_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok((images as usize, videos as usize, next))
}

fn check_media_room(have: (usize, usize), add: (usize, usize)) -> Result<()> {
    if have.0 + add.0 > MAX_IMAGES_PER_POST {
        return Err(Error::Http(Box::new(HttpError::bad_request(format!(
            "Tối đa {MAX_IMAGES_PER_POST} ảnh mỗi bài"
        )))));
    }
    if have.1 + add.1 > MAX_VIDEOS_PER_POST {
        return Err(Error::Http(Box::new(HttpError::bad_request(format!(
            "Tối đa {MAX_VIDEOS_PER_POST} video mỗi bài"
        )))));
    }
    Ok(())
}

/// Cổng sửa bài: tác giả hoặc `newsfeed.moderate` (404 khi không có bài). Router gọi TRƯỚC khi đọc thân multipart, để người
/// không có quyền không đẩy được hàng trăm MB vào RAM/đĩa tạm.
pub async fn check_can_edit(db: &TenantDb, actor: &Actor, post_id: i32) -> Result<()> {
    let mut conn = db.acquire().await?;
    let author = post_author(&mut conn, post_id).await?;
    if author != actor.user_id && !actor.can_moderate {
        return Err(forbidden("Bạn không có quyền sửa bài này"));
    }
    Ok(())
}

/// `POST /newsfeed/:id/upload` (`AuthOnly`; cổng thật: tác giả hoặc `newsfeed.moderate`): sửa bài (nội dung, «Mục») và thêm
/// ảnh/video vào cuối bài trong một lần lưu. `content`/`category` là `None` thì giữ nguyên; nội dung rỗng chỉ được khi bài
/// còn ảnh/video (như lúc đăng). Trần 10 ảnh, 5 video tính cả tệp đã có. Tệp tạm của video luôn được dọn; lỗi sau khi đã
/// ghi kho thì gỡ tệp vừa ghi. Không gửi lại thông báo "bài mới".
#[allow(clippy::too_many_arguments)] // tương ứng các trường của một lần sửa bài; router dựng từ multipart
pub async fn update_with_media<S: MediaStore>(
    db: &TenantDb,
    store: &S,
    actor: &Actor,
    post_id: i32,
    content: Option<&str>,
    category: Option<&str>,
    images: Vec<ImageUpload>,
    videos: &[VideoUpload],
) -> Result<Post> {
    let res = update_with_media_inner(db, store, actor, post_id, content, category, images, videos).await;
    for v in videos {
        let _ = tokio::fs::remove_file(&v.path).await;
    }
    res
}

#[allow(clippy::too_many_arguments)]
async fn update_with_media_inner<S: MediaStore>(
    db: &TenantDb,
    store: &S,
    actor: &Actor,
    post_id: i32,
    content: Option<&str>,
    category: Option<&str>,
    images: Vec<ImageUpload>,
    videos: &[VideoUpload],
) -> Result<Post> {
    let add = (images.len(), videos.len());
    let content = content.map(str::trim);
    // Kiểm quyền và chỗ trống trước khi nén/ghi tệp (rẻ); kiểm lại trong giao dịch có khoá dòng bài.
    {
        check_can_edit(db, actor, post_id).await?;
        let mut conn = db.acquire().await?;
        let (i, v, _) = media_counts(&mut conn, post_id).await?;
        check_media_room((i, v), add)?;
        if content == Some("") && i + v + add.0 + add.1 == 0 {
            return Err(bad_request("Vui lòng nhập nội dung hoặc đính kèm ảnh/video"));
        }
    }
    let mut uploaded: Vec<(String, &'static str)> = Vec::new();
    let result = async {
        for img in images {
            uploaded.push((put_image(store, img).await?, "image"));
        }
        for v in videos {
            uploaded.push((put_video(store, v).await?, "video"));
        }
        let mut tx = db.begin().await?;
        let author: i32 = sqlx::query_scalar("SELECT author_id FROM newsfeed_posts WHERE id = $1 FOR UPDATE")
            .bind(post_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| not_found("Không tìm thấy bài đăng"))?;
        if author != actor.user_id && !actor.can_moderate {
            return Err(forbidden("Bạn không có quyền sửa bài này"));
        }
        let (i, v, next) = media_counts(&mut tx, post_id).await?;
        check_media_room((i, v), add)?;
        if content == Some("") && i + v + add.0 + add.1 == 0 {
            return Err(bad_request("Vui lòng nhập nội dung hoặc đính kèm ảnh/video"));
        }
        for (k, (key, kind)) in uploaded.iter().enumerate() {
            sqlx::query("INSERT INTO newsfeed_post_images (post_id, image_url, media_type, sort_order) VALUES ($1, $2, $3::text::\"NewsfeedMediaType\", $4)")
                .bind(post_id)
                .bind(key)
                .bind(*kind)
                .bind(next + k as i32)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "UPDATE newsfeed_posts SET content = COALESCE($2, content), category = COALESCE($3, category), \
             edited_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(post_id)
        .bind(content)
        .bind(category)
        .execute(&mut *tx)
        .await?;
        let post = post_by_id(&mut tx, post_id).await?.ok_or_else(|| not_found("Không tìm thấy bài đăng"))?;
        tx.commit().await?;
        Ok::<Post, Error>(post)
    }
    .await;
    if result.is_err() {
        for (key, _) in &uploaded {
            let _ = store.remove(key).await;
        }
    }
    result
}

/// `DELETE /newsfeed/:id`: xoá bài (ảnh, thích, bình luận xoá theo khoá ngoại) rồi xoá tệp khỏi kho, lỗi kho chỉ ghi log.
pub async fn delete<S: MediaStore>(db: &TenantDb, store: &S, actor: &Actor, post_id: i32) -> Result<Message> {
    let mut conn = db.acquire().await?;
    // Một lần đọc (tác giả + ảnh cũ): bài bị xoá giữa chừng thì 404, không phải lỗi 500.
    let (author, legacy): (i32, Option<String>) =
        sqlx::query_as("SELECT author_id, image_url FROM newsfeed_posts WHERE id = $1")
            .bind(post_id)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(|| not_found("Không tìm thấy bài đăng"))?;
    if author != actor.user_id && !actor.can_moderate {
        return Err(forbidden("Bạn không có quyền xoá bài này"));
    }
    let keys: Vec<String> =
        sqlx::query_scalar("SELECT image_url FROM newsfeed_post_images WHERE post_id = $1 ORDER BY sort_order, id")
            .bind(post_id)
            .fetch_all(&mut *conn)
            .await?;
    sqlx::query("DELETE FROM newsfeed_posts WHERE id = $1")
        .bind(post_id)
        .execute(&mut *conn)
        .await?;
    for key in legacy.into_iter().chain(keys) {
        if store.remove(&key).await.is_err() {
            tracing::warn!("Failed to delete storage key: {key}");
        }
    }
    Ok(Message {
        message: "Đã xoá bài đăng",
    })
}

/// `POST /newsfeed/:id/like`: bật/tắt thích; trả trạng thái mới và tổng số thích.
pub async fn toggle_like(db: &TenantDb, actor: &Actor, post_id: i32) -> Result<LikeState> {
    let mut conn = db.acquire().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM newsfeed_posts WHERE id = $1)")
        .bind(post_id)
        .fetch_one(&mut *conn)
        .await?;
    if !exists {
        return Err(not_found("Không tìm thấy bài đăng"));
    }
    let removed = sqlx::query("DELETE FROM newsfeed_post_likes WHERE post_id = $1 AND user_id = $2")
        .bind(post_id)
        .bind(actor.user_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    let liked = if removed > 0 {
        false
    } else {
        // Hai lượt cùng lúc: bản ghi thứ hai vướng khoá duy nhất ⇒ vẫn coi là đã thích (như bắt P2002 của bản Node).
        sqlx::query("INSERT INTO newsfeed_post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(post_id)
            .bind(actor.user_id)
            .execute(&mut *conn)
            .await?;
        true
    };
    let like_count: i64 = sqlx::query_scalar("SELECT count(*) FROM newsfeed_post_likes WHERE post_id = $1")
        .bind(post_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(LikeState { liked, like_count })
}

macro_rules! comment_sql {
    () => {
        "SELECT c.id, c.post_id, c.user_id, c.content, c.created_at,
        u.id AS u_id, u.full_name AS u_full_name, u.email AS u_email, u.avatar_url AS u_avatar_url
    FROM newsfeed_post_comments c JOIN users u ON u.id = c.user_id"
    };
}

fn comment_from(r: &sqlx::postgres::PgRow) -> Result<Comment> {
    Ok(Comment {
        id: r.get("id"),
        post_id: r.get("post_id"),
        user_id: r.get("user_id"),
        content: r.get("content"),
        created_at: r.get("created_at"),
        user: user_from(r, "u_")?,
    })
}

/// `GET /newsfeed/:id/comments`: `id` tăng dần; `limit` 1–100 (mặc định 20).
pub async fn list_comments(
    db: &TenantDb,
    post_id: i32,
    cursor: Option<i64>,
    limit: Option<i64>,
) -> Result<Page<Comment>> {
    let take = clamp(limit, 20, 100);
    let mut conn = db.acquire().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM newsfeed_posts WHERE id = $1)")
        .bind(post_id)
        .fetch_one(&mut *conn)
        .await?;
    if !exists {
        return Err(not_found("Không tìm thấy bài đăng"));
    }
    let cursor = cursor.filter(|c| *c != 0);
    if let Some(c) = cursor
        && !cursor_exists(&mut conn, "comments", c).await?
    {
        return Ok(Page {
            data: Vec::new(),
            next_cursor: None,
        });
    }
    let rows = sqlx::query(concat!(
        comment_sql!(),
        " WHERE c.post_id = $1 AND ($2::int4 IS NULL OR c.id > $2) ORDER BY c.id ASC LIMIT $3"
    ))
    .bind(post_id)
    .bind(cursor.map(|c| c as i32))
    .bind(take + 1)
    .fetch_all(&mut *conn)
    .await?;
    let has_more = rows.len() as i64 > take;
    let mut data = rows.iter().map(comment_from).collect::<Result<Vec<_>>>()?;
    if has_more {
        data.truncate(take as usize);
    }
    let next_cursor = if has_more { data.last().map(|c| c.id) } else { None };
    Ok(Page { data, next_cursor })
}

/// `POST /newsfeed/:id/comments`.
pub async fn create_comment(db: &TenantDb, actor: &Actor, post_id: i32, content: &str) -> Result<Comment> {
    let mut conn = db.acquire().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM newsfeed_posts WHERE id = $1)")
        .bind(post_id)
        .fetch_one(&mut *conn)
        .await?;
    if !exists {
        return Err(not_found("Không tìm thấy bài đăng"));
    }
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO newsfeed_post_comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(post_id)
    .bind(actor.user_id)
    .bind(content.trim())
    .fetch_one(&mut *conn)
    .await?;
    let row = sqlx::query(concat!(comment_sql!(), " WHERE c.id = $1"))
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    comment_from(&row)
}

/// `DELETE /newsfeed/comments/:id`: tác giả bình luận hoặc `newsfeed.moderate`.
pub async fn delete_comment(db: &TenantDb, actor: &Actor, comment_id: i32) -> Result<Message> {
    let mut conn = db.acquire().await?;
    let owner: Option<i32> = sqlx::query_scalar("SELECT user_id FROM newsfeed_post_comments WHERE id = $1")
        .bind(comment_id)
        .fetch_optional(&mut *conn)
        .await?;
    let owner = owner.ok_or_else(|| not_found("Không tìm thấy bình luận"))?;
    if owner != actor.user_id && !actor.can_moderate {
        return Err(forbidden("Bạn không có quyền xoá bình luận này"));
    }
    sqlx::query("DELETE FROM newsfeed_post_comments WHERE id = $1")
        .bind(comment_id)
        .execute(&mut *conn)
        .await?;
    Ok(Message {
        message: "Đã xoá bình luận",
    })
}

/// Một tệp media để stream.
#[derive(Debug)]
pub struct MediaFile<R> {
    pub object: R,
    /// Tên tệp (đoạn cuối của khoá, mặc định `video.mp4`/`image.webp`).
    pub file_name: String,
    pub is_video: bool,
}

/// `GET /newsfeed/:id/image` (`index` 0) và `GET /newsfeed/:id/images/:index`: ảnh hoặc video thứ `index`. `range` chỉ
/// áp dụng cho video (206); ảnh luôn trả cả tệp. Bài cũ (trước bảng media) dùng `image_url` ở vị trí 0 và luôn là ảnh.
pub async fn media<S: MediaStore>(
    db: &TenantDb,
    store: &S,
    post_id: i32,
    index: i64,
    range: Option<&str>,
) -> Result<MediaFile<S::Ranged>> {
    let mut conn = db.acquire().await?;
    let legacy: Option<Option<String>> = sqlx::query_scalar("SELECT image_url FROM newsfeed_posts WHERE id = $1")
        .bind(post_id)
        .fetch_optional(&mut *conn)
        .await?;
    let legacy = legacy.ok_or_else(|| not_found("Không tìm thấy bài đăng"))?;
    let items = sqlx::query("SELECT image_url, media_type::text AS media_type FROM newsfeed_post_images WHERE post_id = $1 ORDER BY sort_order, id")
        .bind(post_id)
        .fetch_all(&mut *conn)
        .await?;
    drop(conn);
    let (key, is_video) = if !items.is_empty() {
        match usize::try_from(index).ok().and_then(|i| items.get(i)) {
            Some(r) => (
                Some(r.get::<String, _>("image_url")),
                r.get::<String, _>("media_type") == "video",
            ),
            None => (None, false),
        }
    } else if index == 0 {
        (legacy, false)
    } else {
        (None, false)
    };
    let key = key.ok_or_else(|| not_found("Không tìm thấy hình ảnh"))?;
    let effective = if is_video { range } else { None };
    let object = store.get_range(&key, effective).await.map_err(|e| match e {
        StorageError::NotFound(_) => not_found("Không tìm thấy hình ảnh"),
        other => Error::from(other),
    })?;
    let file_name = key.rsplit('/').next().filter(|s| !s.is_empty()).map_or_else(
        || if is_video { "video.mp4" } else { "image.webp" }.to_owned(),
        str::to_owned,
    );
    Ok(MediaFile {
        object,
        file_name,
        is_video,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiem_nhom_va_noi_dung() {
        assert!(validate_category("pr").is_ok());
        assert!(validate_category("x").is_err());
        assert!(validate_post_content("", true).is_err());
        assert!(validate_post_content("", false).is_ok());
        assert!(validate_post_content(&"a".repeat(20_001), true).is_err());
        assert!(validate_comment_content(&"a".repeat(2_001)).is_err());
        assert!(validate_comment_content("ok").is_ok());
    }

    #[test]
    fn gioi_han_trang() {
        assert_eq!(clamp(None, 10, 50), 10);
        assert_eq!(clamp(Some(0), 10, 50), 1);
        assert_eq!(clamp(Some(999), 10, 50), 50);
    }

    #[test]
    fn khoa_media_dung_dang() {
        let k = media_key(".webp");
        assert!(k.starts_with("newsfeed/") && k.ends_with(".webp"));
    }
}
