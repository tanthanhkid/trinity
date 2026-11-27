//! Tải video theo phần (X15a, không thuộc phạm vi tương thích với bản TS): proxy Cloudflare (gói Free/Pro, cả Tunnel) cắt body
//! request ở 100 MB, nên video tới 200 MB đi thành các phần ≤ 50 MB (mặc định 16 MB) rồi ghép ở máy chủ.
//!
//! Luồng: [`init`] (khai tên + cỡ, nhận `upload_id`) → [`put_part`] từng phần (đặt lại cùng chỉ số là ghi đè, nên web gửi lại
//! phần lỗi mà không phải bắt đầu lại) → [`status`] (phần nào đã có, để tiếp tục sau khi rớt mạng) → [`complete`] (ghép các
//! phần theo luồng vào khoá cuối, ghi thư viện như `POST /social/media`) hoặc [`cancel`].
//!
//! Không thêm bảng: phiên là một tệp `social/chunks/<id>/meta.json` trong CHÍNH kho tệp, các phần là `p<chỉ số>` cùng thư mục.
//! Khoá `social/chunks/...` không khớp [`crate::media::parse_key`] nên không thể bị gắn vào bài như một media. Huỷ, ghép xong
//! hay phiên quá hạn (24 giờ) đều xoá cả thư mục phiên; [`sweep_local`] dọn phiên bị bỏ quên trên đĩa (S3 dùng luật vòng đời
//! của bucket cho tiền tố `social/chunks/`).
//!
//! Trần video ở đây là [`MAX_STORED_VIDEO_BYTES`] (200 MB), KHÔNG theo `SOCIAL_MAX_VIDEO_MB`: biến đó chỉ có để đặt 95 cho
//! đường multipart một lần sau proxy. Ảnh (≤ 10 MB) vẫn dùng `POST /social/media`.

use std::io;
use std::path::Path;

use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncRead;
use trinity_kernel::error::{AppError, HttpError};
use trinity_storage::StorageError;

use crate::media::{
    LimitReader, MAX_STORED_VIDEO_BYTES, MediaCtx, MediaStore, SocialMedia, display_name, kind_of, new_key, record_new,
    too_large,
};

/// Cỡ phần máy chủ đề nghị web dùng (nhỏ hơn nhiều so với 100 MB của proxy, đủ ít request).
pub const PART_BYTES: u64 = 16 * 1024 * 1024;
/// Trần cứng một phần (đã tính cả phần mà web có thể đổi cỡ trong tương lai): luôn thấp hơn 100 MB của proxy.
pub const MAX_PART_BYTES: u64 = 50 * 1024 * 1024;
/// Phiên tải sống 24 giờ kể từ lúc khai.
pub const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;

const PREFIX: &str = "social/chunks";
const GONE: &str = "Phiên tải không tồn tại hoặc đã hết hạn";

// ───────────────────────────── DTO ─────────────────────────────

/// Body `POST /social/media/uploads`: `file_name` chuỗi 1–255 ký tự, `size` số nguyên 1…`i32::MAX` (byte).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitBody {
    pub file_name: String,
    pub size: u64,
}

impl InitBody {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let o = v.as_object();
        let mut errors = Vec::new();
        let file_name = o
            .and_then(|o| o.get("file_name"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty() && s.chars().count() <= 255);
        if file_name.is_none() {
            errors.push("file_name phải là chuỗi từ 1 đến 255 ký tự".to_owned());
        }
        // `@IsInt`: số nguyên (5.0 của JS cũng tính), `null`/chuỗi/số lẻ ⇒ lỗi; ngoài int4 ⇒ lỗi.
        let size = o
            .and_then(|o| o.get("size"))
            .and_then(|n| {
                n.as_i64()
                    .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
            })
            .filter(|n| (1..=i64::from(i32::MAX)).contains(n))
            .and_then(|n| u64::try_from(n).ok());
        if size.is_none() {
            errors.push("size phải là số nguyên dương không vượt quá 2147483647".to_owned());
        }
        match (file_name, size) {
            (Some(f), Some(s)) if errors.is_empty() => Ok(Self {
                file_name: f.to_owned(),
                size: s,
            }),
            _ => Err(HttpError::validation(errors)),
        }
    }
}

/// Chỉ số phần trên đường dẫn (`ParseIntPipe`): số nguyên không âm, vừa `u32`.
pub fn parse_index(raw: &str) -> Result<u32, HttpError> {
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<u32>().map_err(|_| HttpError::parse_int_failed())
    } else {
        Err(HttpError::parse_int_failed())
    }
}

// ───────────────────────────── phiên ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    user_id: i32,
    company_id: i32,
    file_name: String,
    size: u64,
    part_size: u64,
    total: u32,
    expires_ms: i64,
}

impl Session {
    /// Số byte đúng của phần `index`: mọi phần bằng `part_size`, phần cuối là phần dư.
    fn part_len(&self, index: u32) -> u64 {
        if index + 1 == self.total {
            self.size - u64::from(self.total - 1) * self.part_size
        } else {
            self.part_size
        }
    }
}

/// Kết quả [`init`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Init {
    pub upload_id: String,
    pub part_size: u64,
    pub total_parts: u32,
    pub expires_at_ms: i64,
}

/// Kết quả [`put_part`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PartInfo {
    pub index: u32,
    pub size: u64,
}

/// Kết quả [`status`]: `received` là chỉ số các phần đã có đủ byte (tăng dần).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub upload_id: String,
    pub part_size: u64,
    pub total_parts: u32,
    pub received: Vec<u32>,
}

fn meta_key(id: &str) -> String {
    format!("{PREFIX}/{id}/meta.json")
}

fn part_key(id: &str, index: u32) -> String {
    format!("{PREFIX}/{id}/p{index}")
}

/// `upload_id` do máy chủ sinh (UUID 32 hex); chuỗi khác ⇒ 404 như phiên không có, không chạm kho.
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn gone() -> AppError {
    HttpError::not_found(GONE).into()
}

/// `None` khi không có tệp phiên.
async fn read_meta(store: &MediaStore, id: &str) -> Result<Option<Session>, AppError> {
    let f = match store.get(&meta_key(id)).await {
        Ok(f) => f,
        Err(StorageError::NotFound(_)) => return Ok(None),
        Err(e) => return Err(AppError::internal(e)),
    };
    let raw: Vec<Bytes> = f.body.into_stream().try_collect().await.map_err(AppError::internal)?;
    let raw = raw.concat();
    serde_json::from_slice(&raw).map(Some).map_err(AppError::internal)
}

/// Xoá mọi phần và tệp phiên (không lỗi nếu thiếu).
async fn cleanup(store: &MediaStore, id: &str, total: u32) {
    for i in 0..total {
        store.remove(&part_key(id, i)).await;
    }
    store.remove(&meta_key(id)).await;
}

/// Nạp phiên của ĐÚNG người và công ty đang gọi; người khác, công ty khác, sai định dạng, hết hạn ⇒ 404 (phiên quá hạn bị dọn).
async fn load(c: &MediaCtx<'_>, id: &str) -> Result<Session, AppError> {
    if !valid_id(id) {
        return Err(gone());
    }
    let s = read_meta(c.store, id).await?.ok_or_else(gone)?;
    if s.user_id != c.user_id || s.company_id != c.company.id() {
        return Err(gone());
    }
    if s.expires_ms < c.now_ms {
        cleanup(c.store, id, s.total).await;
        return Err(gone());
    }
    Ok(s)
}

// ───────────────────────────── thao tác ─────────────────────────────

/// `POST /social/media/uploads`: kiểm tên (chỉ video), cỡ ≤ 200 MB, ghi phiên. 400 nếu không phải video, 413 nếu quá trần.
pub async fn init(c: &MediaCtx<'_>, body: &InitBody) -> Result<Init, AppError> {
    let k = kind_of(&body.file_name, MAX_STORED_VIDEO_BYTES)?;
    if k.kind != "video" {
        return Err(
            HttpError::bad_request("Tải theo phần chỉ dùng cho video; ảnh gửi thẳng lên /social/media.").into(),
        );
    }
    if body.size > k.max {
        return Err(HttpError::payload_too_large(too_large(k.max)).into());
    }
    let total = u32::try_from(body.size.div_ceil(PART_BYTES)).map_err(|_| HttpError::bad_request("Tệp quá lớn."))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let s = Session {
        user_id: c.user_id,
        company_id: c.company.id(),
        file_name: body.file_name.clone(),
        size: body.size,
        part_size: PART_BYTES,
        total,
        expires_ms: c.now_ms + SESSION_TTL_MS,
    };
    let json = serde_json::to_vec(&s).map_err(AppError::internal)?;
    c.store
        .put_bytes(&meta_key(&id), &json, "application/json")
        .await
        .map_err(AppError::internal)?;
    Ok(Init {
        upload_id: id,
        part_size: s.part_size,
        total_parts: total,
        expires_at_ms: s.expires_ms,
    })
}

/// `PUT /social/media/uploads/:id/parts/:index`: `reader` là thân request. Phần phải ĐÚNG số byte phiên đã tính
/// (thừa ⇒ 413, thiếu ⇒ 400, kho dọn phần dở); gửi lại cùng chỉ số thì ghi đè.
pub async fn put_part<R>(c: &MediaCtx<'_>, id: &str, index: u32, reader: R) -> Result<PartInfo, AppError>
where
    R: AsyncRead + Unpin + Send,
{
    let s = load(c, id).await?;
    if index >= s.total {
        return Err(HttpError::bad_request(format!("Chỉ số phần phải từ 0 đến {}.", s.total - 1)).into());
    }
    let want = s.part_len(index);
    let key = part_key(id, index);
    let (mut limited, count, exceeded) = LimitReader::new(reader, want);
    let put = c.store.put_reader(&key, &mut limited, "application/octet-stream").await;
    if exceeded.load(std::sync::atomic::Ordering::Relaxed) {
        c.store.remove(&key).await;
        return Err(HttpError::payload_too_large(format!("Phần {index} quá lớn (đúng {want} byte).")).into());
    }
    put.map_err(AppError::internal)?;
    let got = count.load(std::sync::atomic::Ordering::Relaxed);
    if got != want {
        c.store.remove(&key).await;
        return Err(HttpError::bad_request(format!("Phần {index} phải đúng {want} byte, nhận {got}.")).into());
    }
    Ok(PartInfo { index, size: got })
}

/// Các phần đã đủ byte (kiểm kích thước trong kho, không đọc nội dung).
async fn received(c: &MediaCtx<'_>, id: &str, s: &Session) -> Result<Vec<u32>, AppError> {
    let mut have = Vec::new();
    for i in 0..s.total {
        match c.store.size_of(&part_key(id, i)).await {
            Ok(n) if n == s.part_len(i) => have.push(i),
            Ok(_) | Err(StorageError::NotFound(_)) => {}
            Err(e) => return Err(AppError::internal(e)),
        }
    }
    Ok(have)
}

/// `GET /social/media/uploads/:id`: để web tiếp tục sau khi rớt mạng (chỉ gửi các phần chưa có).
pub async fn status(c: &MediaCtx<'_>, id: &str) -> Result<Status, AppError> {
    let s = load(c, id).await?;
    Ok(Status {
        upload_id: id.to_owned(),
        part_size: s.part_size,
        total_parts: s.total,
        received: received(c, id, &s).await?,
    })
}

/// `POST /social/media/uploads/:id/complete`: ghép các phần theo luồng (không đọc cả tệp vào RAM) vào khoá cuối, ghi thư viện
/// với `source = 'web'`, rồi xoá phiên. Thiếu phần ⇒ 400 kèm danh sách, phiên còn nguyên để gửi nốt.
pub async fn complete(c: &MediaCtx<'_>, id: &str) -> Result<SocialMedia, AppError> {
    let s = load(c, id).await?;
    let have = received(c, id, &s).await?;
    if have.len() != s.total as usize {
        let missing: Vec<String> = (0..s.total)
            .filter(|i| !have.contains(i))
            .map(|i| i.to_string())
            .collect();
        return Err(HttpError::bad_request(format!("Còn thiếu phần: {}.", missing.join(", "))).into());
    }
    let k = kind_of(&s.file_name, MAX_STORED_VIDEO_BYTES)?;
    let key = new_key(c.user_id, &k.ext, c.now_ms);
    let store = c.store;
    let parts = futures_util::stream::iter((0..s.total).map(|i| part_key(id, i)))
        .then(move |pk| async move { store.get(&pk).await })
        .map(|r| r.map(|f| f.body.into_stream()).map_err(io::Error::other))
        .try_flatten()
        .boxed();
    let (mut limited, count, exceeded) = LimitReader::new(tokio_util::io::StreamReader::new(parts), k.max);
    let put = store.put_reader(&key, &mut limited, k.content_type).await;
    if exceeded.load(std::sync::atomic::Ordering::Relaxed) {
        store.remove(&key).await;
        return Err(HttpError::payload_too_large(too_large(k.max)).into());
    }
    if let Err(e) = put {
        store.remove(&key).await;
        return Err(AppError::internal(e));
    }
    let size = count.load(std::sync::atomic::Ordering::Relaxed);
    if size != s.size {
        store.remove(&key).await;
        return Err(HttpError::bad_request("Tổng kích thước các phần không khớp cỡ đã khai.").into());
    }
    let m = SocialMedia {
        key: key.clone(),
        r#type: k.kind.to_owned(),
        content_type: k.content_type.to_owned(),
        size,
    };
    let name = display_name(Some(&s.file_name), &key);
    // Ghi thư viện lỗi thì `record_new` đã xoá tệp cuối; các phần giữ nguyên để thử ghép lại.
    record_new(c, &m, &name, "web").await?;
    cleanup(store, id, s.total).await;
    Ok(m)
}

/// `DELETE /social/media/uploads/:id` (204): xoá mọi phần. Không có phiên (đã ghép, đã huỷ, quá hạn) vẫn coi là xong; phiên của
/// người khác ⇒ cũng 204 mà không chạm gì, để không dò được `upload_id`.
pub async fn cancel(c: &MediaCtx<'_>, id: &str) -> Result<(), AppError> {
    if !valid_id(id) {
        return Ok(());
    }
    if let Some(s) = read_meta(c.store, id).await?
        && s.user_id == c.user_id
        && s.company_id == c.company.id()
    {
        cleanup(c.store, id, s.total).await;
    }
    Ok(())
}

/// Dọn phiên bị bỏ quên trên kho ĐĨA: thư mục phiên đã quá hạn, hoặc mất `meta.json` mà cũ hơn [`SESSION_TTL_MS`]. Gọi định kỳ
/// (job nền). Trả số thư mục đã xoá.
pub async fn sweep_local(root: &Path, now_ms: i64) -> usize {
    let dir = root.join(PREFIX);
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
        return 0;
    };
    let mut removed = 0;
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if !valid_id(&name) {
            continue;
        }
        let expired = match tokio::fs::read(e.path().join("meta.json")).await {
            Ok(raw) => !serde_json::from_slice::<Session>(&raw).is_ok_and(|s| s.expires_ms >= now_ms),
            Err(_) => {
                let age = e
                    .metadata()
                    .await
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map_or(0, |d| d.as_millis());
                age > u128::from(SESSION_TTL_MS.unsigned_abs())
            }
        };
        if expired && tokio::fs::remove_dir_all(e.path()).await.is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kiem_body_khai_phien() {
        let ok = InitBody::from_json(&json!({"file_name":"a.mp4","size":209_715_200})).unwrap();
        assert_eq!((ok.file_name.as_str(), ok.size), ("a.mp4", 209_715_200));
        assert!(InitBody::from_json(&json!({"file_name":"a.mp4","size":5.0})).is_ok());
        for bad in [
            json!({}),
            json!({"file_name":null,"size":1}),
            json!({"file_name":"","size":1}),
            json!({"file_name":"a.mp4","size":null}),
            json!({"file_name":"a.mp4","size":0}),
            json!({"file_name":"a.mp4","size":1.5}),
            json!({"file_name":"a.mp4","size":"10"}),
            json!({"file_name":"a.mp4","size":2_147_483_648_i64}),
            json!([]),
        ] {
            assert_eq!(InitBody::from_json(&bad).unwrap_err().status(), 400, "{bad}");
        }
    }

    #[test]
    fn chi_so_phan() {
        assert_eq!(parse_index("0").unwrap(), 0);
        assert_eq!(parse_index("12").unwrap(), 12);
        for bad in ["", "-1", "1.5", "x", "99999999999"] {
            assert_eq!(parse_index(bad).unwrap_err().status(), 400, "{bad}");
        }
    }

    #[test]
    fn do_dai_tung_phan() {
        let s = Session {
            user_id: 1,
            company_id: 1,
            file_name: "a.mp4".into(),
            size: 2 * PART_BYTES + 5,
            part_size: PART_BYTES,
            total: 3,
            expires_ms: 0,
        };
        assert_eq!(
            (s.part_len(0), s.part_len(1), s.part_len(2)),
            (PART_BYTES, PART_BYTES, 5)
        );
        let one = Session {
            size: PART_BYTES,
            total: 1,
            ..s
        };
        assert_eq!(one.part_len(0), PART_BYTES);
    }

    #[test]
    fn id_phien_chi_nhan_uuid_hex() {
        assert!(valid_id(&uuid::Uuid::new_v4().simple().to_string()));
        for bad in ["", "../x", "ABCDEF0123456789ABCDEF0123456789", "abc"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn so_phan_200mb() {
        assert_eq!((200 * 1024 * 1024_u64).div_ceil(PART_BYTES), 13);
        const _: () = assert!(MAX_PART_BYTES < 100 * 1024 * 1024 && PART_BYTES <= MAX_PART_BYTES);
    }
}
