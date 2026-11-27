//! Đăng bài lên Fanpage và lấy số liệu bài (`providers/facebook.provider.ts`: `publish`, `uploadVideo`, `fetchMetrics`).
//! Mọi lời gọi Graph đi qua [`mod_facebook::graph::GraphClient`] (một chỗ duy nhất gọi Meta, báo ChannelGuard). KHÔNG BAO GIỜ
//! log token. Hàm ở đây không giữ kết nối DB (chỉ đọc kho tệp và gọi Graph); mã gọi tự nhả kết nối trước.
//!
//! - Chữ: `POST {page}/feed` · một ảnh: `POST {page}/photos` · nhiều ảnh: từng ảnh `published=false` rồi `feed` + `attached_media`.
//! - Video: tải theo phiên (start, transfer từng phần, finish) qua host video; mỗi phần đọc từ kho theo luồng nên video
//!   200 MB không nằm trong RAM (bản Node đọc cả tệp vào bộ nhớ).

use bytes::Bytes;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use mod_facebook::graph::{GraphApiError, GraphClient, utf16_prefix};
use serde::Serialize;
use serde_json::{Map, Value};
use trinity_storage::StorageError;

use crate::accounts::AccountForPublish;
use crate::media::{MediaStore, SocialMedia};
use crate::multipart::Form;
use crate::provider::{PublishError, PublishErrorKind, classify_graph_error};
use crate::utm::js_trim;

/// Trần một ảnh đọc vào RAM (ảnh đã bị trần kích thước lúc tải lên; đây là chốt chặn thêm).
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Trần một phần video đọc vào RAM mỗi lần (Facebook thường đề nghị vài MB).
const MAX_CHUNK_BYTES: u64 = 64 * 1024 * 1024;
/// Số bước `transfer` tối đa cho một video (chặn vòng lặp vô hạn nếu Facebook trả offset không tiến).
const MAX_TRANSFER_STEPS: usize = 20_000;
/// Số lần liên tiếp offset không tiến thì bỏ.
const MAX_STALLS: usize = 3;
/// Tiêu đề video tối đa 255 ký tự (UTF-16).
const TITLE_MAX: usize = 255;

/// Kết quả đăng một bài.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub external_post_id: String,
    pub url: String,
}

/// Số của một bài (lượt xem, cảm xúc, bình luận, chia sẻ); `None` = mạng không có số này. Lưu thẳng vào cột `metrics`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostMetrics {
    pub views: Option<i64>,
    pub reactions: Option<i64>,
    pub comments: Option<i64>,
    pub shares: Option<i64>,
}

fn err(kind: PublishErrorKind, message: impl Into<String>) -> PublishError {
    PublishError {
        kind,
        message: message.into(),
    }
}

/// Lỗi Graph ⇒ lỗi đăng. "Bài không còn" khi ĐĂNG là lỗi vĩnh viễn (`invalid`, như `SocialPostGoneError`).
fn graph_err(e: &GraphApiError) -> PublishError {
    let mut p = classify_graph_error(e);
    if p.kind == PublishErrorKind::Gone {
        p.kind = PublishErrorKind::Invalid;
    }
    p
}

fn store_err(e: &StorageError) -> PublishError {
    match e {
        StorageError::NotFound(_) => err(PublishErrorKind::Invalid, "Không tìm thấy tệp trong thư viện"),
        other => err(
            PublishErrorKind::Temporary,
            format!("Không đọc được tệp đính kèm ({other})."),
        ),
    }
}

fn io_err(e: &std::io::Error) -> PublishError {
    err(
        PublishErrorKind::Temporary,
        format!("Không đọc được tệp đính kèm ({e})."),
    )
}

/// Đuôi tệp theo loại nội dung (`extOf`).
pub fn ext_of(content_type: &str) -> &'static str {
    match content_type {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "video/mp4" => ".mp4",
        "video/quicktime" => ".mov",
        "video/webm" => ".webm",
        _ => "",
    }
}

/// Đọc cả một ảnh vào RAM (có trần).
async fn read_all(store: &MediaStore, m: &SocialMedia) -> Result<Vec<u8>, PublishError> {
    let stored = store.get(&m.key).await.map_err(|e| store_err(&e))?;
    if stored.content_length.is_some_and(|n| n > MAX_IMAGE_BYTES) {
        return Err(err(PublishErrorKind::Invalid, "Ảnh quá lớn để đăng."));
    }
    let mut stream = stored.body.into_stream();
    let mut out: Vec<u8> = Vec::new();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|e| io_err(&e))?;
        if (out.len() + part.len()) as u64 > MAX_IMAGE_BYTES {
            return Err(err(PublishErrorKind::Invalid, "Ảnh quá lớn để đăng."));
        }
        out.extend_from_slice(&part);
    }
    Ok(out)
}

/// Con trỏ đọc tuần tự một tệp trong kho theo từng phần (video). Facebook xin lại offset cũ thì mở lại luồng và bỏ qua.
struct Cursor<'a> {
    store: &'a MediaStore,
    key: &'a str,
    stream: BoxStream<'static, Result<Bytes, std::io::Error>>,
    pos: u64,
    rest: Bytes,
    /// Kích thước thật nếu kho báo.
    size: Option<u64>,
}

impl<'a> Cursor<'a> {
    async fn open(store: &'a MediaStore, key: &'a str) -> Result<Self, PublishError> {
        let stored = store.get(key).await.map_err(|e| store_err(&e))?;
        Ok(Self {
            store,
            key,
            size: stored.content_length,
            stream: stored.body.into_stream(),
            pos: 0,
            rest: Bytes::new(),
        })
    }

    async fn reopen(&mut self) -> Result<(), PublishError> {
        let stored = self.store.get(self.key).await.map_err(|e| store_err(&e))?;
        self.stream = stored.body.into_stream();
        self.pos = 0;
        self.rest = Bytes::new();
        Ok(())
    }

    /// Đọc tối đa `want` byte từ vị trí hiện tại; ít hơn khi hết tệp.
    async fn read(&mut self, want: u64) -> Result<Vec<u8>, PublishError> {
        let mut out: Vec<u8> = Vec::new();
        while (out.len() as u64) < want {
            if self.rest.is_empty() {
                match self.stream.next().await {
                    Some(Ok(b)) => self.rest = b,
                    Some(Err(e)) => return Err(io_err(&e)),
                    None => break,
                }
                continue;
            }
            let need = usize::try_from(want - out.len() as u64).unwrap_or(usize::MAX);
            let n = need.min(self.rest.len());
            out.extend_from_slice(&self.rest.split_to(n));
        }
        self.pos += out.len() as u64;
        Ok(out)
    }

    /// Phần `[from, from + len)`.
    async fn take(&mut self, from: u64, len: u64) -> Result<Vec<u8>, PublishError> {
        if from != self.pos {
            if from < self.pos {
                self.reopen().await?;
            }
            // Bỏ qua phần trước `from` (đọc rồi bỏ, theo từng phần nhỏ).
            while self.pos < from {
                let skipped = self.read((from - self.pos).min(MAX_CHUNK_BYTES)).await?;
                if skipped.is_empty() {
                    break;
                }
            }
        }
        let chunk = self.read(len.min(MAX_CHUNK_BYTES)).await?;
        if chunk.is_empty() {
            return Err(err(PublishErrorKind::Invalid, "Tệp video ngắn hơn kích thước đã khai."));
        }
        Ok(chunk)
    }
}

fn bad_shape() -> PublishError {
    err(
        PublishErrorKind::Temporary,
        "Facebook trả dữ liệu không đúng định dạng.",
    )
}

/// Trường chữ (Graph trả id dạng chuỗi).
fn str_field(v: &Value, key: &str) -> Result<String, PublishError> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(bad_shape)
}

/// Offset: Graph trả chuỗi số (`"0"`), chấp nhận cả số.
fn offset_field(v: &Value, key: &str) -> Result<u64, PublishError> {
    match v.get(key) {
        Some(Value::String(s)) => s.trim().parse::<u64>().map_err(|_| bad_shape()),
        Some(Value::Number(n)) => n.as_u64().ok_or_else(bad_shape),
        _ => Err(bad_shape()),
    }
}

/// Một bước tải lên qua host video.
async fn video_phase(graph: &GraphClient, token: &str, page: &str, form: Form) -> Result<Value, PublishError> {
    let (content_type, body) = form.finish();
    graph
        .post_multipart(
            token,
            &format!("{page}/videos"),
            "{page}/videos",
            true,
            &content_type,
            body,
        )
        .await
        .map_err(|e| graph_err(&e))
}

/// Video tải theo phiên (start, transfer từng phần, finish): mỗi phần một request ngắn vì một request chứa cả video hay bị
/// Facebook trả HTTP 408 khi đường lên chậm. Trả id video.
async fn upload_video(
    graph: &GraphClient,
    store: &MediaStore,
    token: &str,
    page: &str,
    video: &SocialMedia,
    fields: &[(&str, String)],
) -> Result<String, PublishError> {
    let mut cur = Cursor::open(store, &video.key).await?;
    let size = cur.size.unwrap_or(video.size);
    let start = video_phase(
        graph,
        token,
        page,
        Form::new()
            .text("upload_phase", "start")
            .text("file_size", &size.to_string()),
    )
    .await?;
    let session = str_field(&start, "upload_session_id")?;
    let video_id = str_field(&start, "video_id")?;
    let mut from = offset_field(&start, "start_offset")?;
    let mut to = offset_field(&start, "end_offset")?;
    let file_name = format!("video{}", ext_of(&video.content_type));
    let (mut steps, mut stalls) = (0_usize, 0_usize);
    while from < to {
        steps += 1;
        if steps > MAX_TRANSFER_STEPS {
            return Err(err(PublishErrorKind::Temporary, "Tải video lên quá nhiều bước."));
        }
        let chunk = cur.take(from, to - from).await?;
        let form = Form::new()
            .text("upload_phase", "transfer")
            .text("upload_session_id", &session)
            .text("start_offset", &from.to_string())
            .file("video_file_chunk", &file_name, &video.content_type, &chunk);
        drop(chunk);
        let r = video_phase(graph, token, page, form).await?;
        let (next_from, next_to) = (offset_field(&r, "start_offset")?, offset_field(&r, "end_offset")?);
        stalls = if next_from <= from { stalls + 1 } else { 0 };
        if stalls > MAX_STALLS {
            return Err(err(
                PublishErrorKind::Temporary,
                "Facebook không nhận tiếp phần video đã gửi.",
            ));
        }
        (from, to) = (next_from, next_to);
    }
    let mut finish = Form::new()
        .text("upload_phase", "finish")
        .text("upload_session_id", &session);
    for (k, v) in fields {
        finish = finish.text(k, v);
    }
    video_phase(graph, token, page, finish).await?;
    Ok(video_id)
}

/// Ảnh tải lên một lần: `published = false` khi dùng cho bài nhiều ảnh. Trả thân JSON của Graph.
async fn upload_photo(
    graph: &GraphClient,
    store: &MediaStore,
    token: &str,
    page: &str,
    image: &SocialMedia,
    text: Option<&str>,
    unpublished: bool,
) -> Result<Value, PublishError> {
    let data = read_all(store, image).await?;
    let mut form = Form::new();
    if let Some(t) = text.filter(|t| !t.is_empty()) {
        form = form.text("message", t);
    }
    if unpublished {
        form = form.text("published", "false");
    }
    let name = format!("image{}", ext_of(&image.content_type));
    let (content_type, body) = form.file("source", &name, &image.content_type, &data).finish();
    drop(data);
    graph
        .post_multipart(
            token,
            &format!("{page}/photos"),
            "{page}/photos",
            false,
            &content_type,
            body,
        )
        .await
        .map_err(|e| graph_err(&e))
}

/// Tiêu đề video từ `options.title` (đã cắt khoảng trắng, tối đa 255 ký tự); rỗng ⇒ không gửi.
fn video_title(options: &Map<String, Value>) -> Option<String> {
    match options.get("title") {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(utf16_prefix(js_trim(s), TITLE_MAX)),
        _ => None,
    }
}

/// `publish`: đăng một bài lên Page của `account` (video > một ảnh > nhiều ảnh > chữ).
pub async fn publish(
    graph: &GraphClient,
    store: &MediaStore,
    account: &AccountForPublish,
    text: &str,
    media: &[SocialMedia],
    options: &Map<String, Value>,
) -> Result<Published, PublishError> {
    let page = account.external_id.as_str();
    let token = account.access_token.as_str();
    if let Some(video) = media.iter().find(|m| m.r#type == "video") {
        let mut fields = vec![("description", text.to_owned())];
        if let Some(title) = video_title(options) {
            fields.push(("title", title));
        }
        let id = upload_video(graph, store, token, page, video, &fields).await?;
        return Ok(Published {
            url: format!("https://www.facebook.com/{page}/videos/{id}"),
            external_post_id: id,
        });
    }
    let images: Vec<&SocialMedia> = media.iter().filter(|m| m.r#type == "image").collect();
    if let [only] = images.as_slice() {
        let r = upload_photo(graph, store, token, page, only, Some(text), false).await?;
        // `post_id` là id bài chứa ảnh; vắng thì dùng id ảnh.
        let id = str_field(&r, "post_id").or_else(|_| str_field(&r, "id"))?;
        return Ok(Published {
            url: format!("https://www.facebook.com/{id}"),
            external_post_id: id,
        });
    }
    let mut ids: Vec<String> = Vec::new();
    for image in &images {
        let r = upload_photo(graph, store, token, page, image, None, true).await?;
        ids.push(str_field(&r, "id")?);
    }
    let id = graph
        .publish_feed(token, page, text, &ids)
        .await
        .map_err(|e| graph_err(&e))?;
    Ok(Published {
        url: format!("https://www.facebook.com/{id}"),
        external_post_id: id,
    })
}

fn count(v: &Value, path: &[&str]) -> Option<i64> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_i64()
}

/// Số của bài từ thân Graph (`reactions`, `comments`, `shares`); Graph bỏ hẳn `shares` khi chưa ai chia sẻ ⇒ 0.
pub fn metrics_from_post(r: &Value, views: Option<i64>) -> PostMetrics {
    PostMetrics {
        views,
        reactions: Some(count(r, &["reactions", "summary", "total_count"]).unwrap_or(0)),
        comments: Some(count(r, &["comments", "summary", "total_count"]).unwrap_or(0)),
        shares: Some(count(r, &["shares", "count"]).unwrap_or(0)),
    }
}

/// Lỗi lấy số: KHÔNG đổi "bài không còn" thành `invalid`; mã gọi cần nhận ra [`PublishErrorKind::Gone`].
fn metrics_err(e: &GraphApiError) -> PublishError {
    classify_graph_error(e)
}

/// `fetchMetrics`: bài (id `{page}_{post}`) lấy cảm xúc, bình luận, chia sẻ; video (id số) lấy lượt xem rồi số của bài chứa
/// video. Lượt tiếp cận/hiển thị cần quyền `read_insights` (chưa xin) nên để `None`.
pub async fn fetch_metrics(
    graph: &GraphClient,
    account: &AccountForPublish,
    external_post_id: &str,
) -> Result<PostMetrics, PublishError> {
    let token = account.access_token.as_str();
    let mut post_id = external_post_id.to_owned();
    let mut views: Option<i64> = None;
    if !external_post_id.contains('_') {
        let v = graph
            .get_object(token, external_post_id, "views,post_id")
            .await
            .map_err(|e| metrics_err(&e))?;
        views = v.get("views").and_then(Value::as_i64);
        let Some(inner) = v.get("post_id").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return Ok(PostMetrics {
                views,
                reactions: None,
                comments: None,
                shares: None,
            });
        };
        post_id = format!("{}_{inner}", account.external_id);
    }
    let r = graph
        .get_object(
            token,
            &post_id,
            "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares",
        )
        .await
        .map_err(|e| metrics_err(&e))?;
    Ok(metrics_from_post(&r, views))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn duoi_tep() {
        assert_eq!(ext_of("image/jpeg"), ".jpg");
        assert_eq!(ext_of("video/quicktime"), ".mov");
        assert_eq!(ext_of("application/x"), "");
    }

    #[test]
    fn tieu_de_video() {
        let o = |v: Value| v.as_object().cloned().unwrap_or_default();
        assert_eq!(video_title(&o(json!({}))), None);
        assert_eq!(video_title(&o(json!({"title": "   "}))), None);
        assert_eq!(video_title(&o(json!({"title": 5}))), None);
        assert_eq!(video_title(&o(json!({"title": "  Chào  "}))).as_deref(), Some("Chào"));
        let long = "a".repeat(300);
        assert_eq!(video_title(&o(json!({ "title": long }))).unwrap().len(), 255);
    }

    #[test]
    fn offset_la_chuoi_hoac_so() {
        let v = json!({"a": "1048576", "b": 7, "c": "x", "d": -1});
        assert_eq!(offset_field(&v, "a").unwrap(), 1_048_576);
        assert_eq!(offset_field(&v, "b").unwrap(), 7);
        assert!(offset_field(&v, "c").is_err());
        assert!(offset_field(&v, "d").is_err());
        assert!(offset_field(&v, "zz").is_err());
        assert!(str_field(&json!({"id": ""}), "id").is_err());
    }

    #[test]
    fn so_lieu_bai() {
        let full = json!({
            "reactions": {"summary": {"total_count": 12}},
            "comments": {"summary": {"total_count": 3}},
            "shares": {"count": 2}
        });
        let m = metrics_from_post(&full, Some(100));
        assert_eq!(
            (m.views, m.reactions, m.comments, m.shares),
            (Some(100), Some(12), Some(3), Some(2))
        );
        // Chưa ai chia sẻ: Graph bỏ trường `shares` ⇒ 0, không phải null.
        let none = json!({"reactions": {"summary": {"total_count": 1}}, "comments": {"summary": {}}});
        let m = metrics_from_post(&none, None);
        assert_eq!(
            (m.views, m.reactions, m.comments, m.shares),
            (None, Some(1), Some(0), Some(0))
        );
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({"views": null, "reactions": 1, "comments": 0, "shares": 0})
        );
    }

    #[test]
    fn bai_khong_con_khi_dang_la_loi_vinh_vien() {
        let e = GraphApiError {
            http_status: 400,
            code: Some(100),
            subcode: Some(33),
            message: "x".to_owned(),
            config_error: false,
        };
        assert_eq!(graph_err(&e).kind, PublishErrorKind::Invalid);
        // Còn khi lấy số thì giữ `Gone` để đánh dấu đã xoá.
        assert_eq!(metrics_err(&e).kind, PublishErrorKind::Gone);
    }
}
