//! `POST /social/drafts/:id/publish` (`SocialDraftsService.publish`): đăng nháp thành bài thật, kiểm đầy đủ như `POST /social/posts`;
//! lỗi thì nháp giữ nguyên.
//!
//! - Giữ chỗ (`post_id = PUBLISHING`) CÓ ĐIỀU KIỆN theo đúng bản vừa đọc (`updated_at`): hai lượt đăng cùng lúc không tạo hai bài,
//!   và nội dung đăng là nội dung đã đọc. Giữ chỗ / trả chỗ không đổi `updated_at`.
//! - Gắn `post_id` thật NGAY TRONG giao dịch tạo bài ([`crate::posts::CreateExtra::draft`]): có bài thì nháp đã gắn.
//! - Lỗi thì chỉ trả chỗ khi bài CHƯA được tạo (điều kiện `post_id = PUBLISHING` không còn khớp sau khi bài đã gắn).
//! - Mỗi bước DB một kết nối, nhả trước khi bước sau (không giữ hai kết nối).

use trinity_db::models::SocialDraft;
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::js_iso_string;

use crate::drafts::{self, DraftMedia, DraftTarget, PUBLISHING};
use crate::dto::{DraftPublish, PostInput, TargetInput};
use crate::ports::CreateFailure;
use crate::posts::{CreateExtra, PostCtx, PostView, acquire, create_with, reload};

const CHANGED: &str = "Nháp đã được sửa sau khi xem trước — xem lại nháp rồi đăng lại.";
const BUSY: &str = "Nháp đang được đăng hoặc vừa được sửa — mở lại nháp rồi thử lại.";

/// Dựng đầu vào đăng bài từ nháp (`toPostInput`): ghi đè lúc đăng thắng giá trị lưu trong nháp; không ghi đè thì theo nháp
/// (giờ cụ thể hoặc cờ hàng đợi). Không ghi gì.
pub fn to_post_input(d: &SocialDraft, p: &DraftPublish, source: &str) -> PostInput {
    let media: Vec<DraftMedia> = serde_json::from_value(d.media.0.clone()).unwrap_or_default();
    let targets: Vec<DraftTarget> = serde_json::from_value(d.targets.0.clone()).unwrap_or_default();
    let queue = if p.use_queue {
        true
    } else if p.scheduled_at.is_some() {
        false
    } else {
        d.use_queue
    };
    let scheduled = match &p.scheduled_at {
        Some(v) => v.clone(),
        None => d.scheduled_at.map(|t| js_iso_string(t.0)),
    };
    PostInput {
        content: d.content.clone(),
        media_keys: media.into_iter().map(|m| m.key).collect(),
        targets: targets
            .into_iter()
            .map(|t| TargetInput {
                account_id: t.account_id,
                caption: t.caption,
                options: Some(t.options.unwrap_or_default()),
            })
            .collect(),
        scheduled_at: if queue { None } else { scheduled },
        use_queue: queue,
        utm: None,
        source: Some(source.to_owned()),
    }
}

fn conflict(m: &str) -> AppError {
    HttpError::new(409, m).into()
}

/// Trả chỗ giữ cho nháp khi bài chưa được tạo; lỗi ở bước này chỉ ghi log (không che lỗi gốc).
async fn release(c: &PostCtx<'_>, id: i32, keep: Timestamp) {
    let r = async {
        let mut conn = acquire(c.db, c.company).await?;
        sqlx::query(
            "UPDATE social_drafts SET post_id = NULL, publishing_at = NULL, updated_at = $3 \
             WHERE id = $1 AND post_id = $2",
        )
        .bind(id)
        .bind(PUBLISHING)
        .bind(keep)
        .execute(&mut *conn)
        .await
        .map(drop)
        .map_err(AppError::internal)
    }
    .await;
    if let Err(e) = r {
        tracing::warn!("Trả chỗ giữ của nháp {id} lỗi: {e:?}");
    }
}

/// Đăng nháp `id`; trả bài vừa tạo (kèm các kênh). Người gọi `kick` việc đăng nếu bài không hẹn giờ.
pub async fn publish(c: &PostCtx<'_>, id: i32, p: &DraftPublish) -> Result<PostView, AppError> {
    let d = {
        let mut conn = acquire(c.db, c.company).await?;
        drafts::get(&mut conn, id, c.now_ms).await?
    };
    if let Some(at) = p.expected_updated_at
        && at.timestamp_millis() != d.updated_at.0.timestamp_millis()
    {
        return Err(conflict(CHANGED));
    }
    let keep = d.updated_at;
    let claimed = {
        let mut conn = acquire(c.db, c.company).await?;
        sqlx::query(
            "UPDATE social_drafts SET post_id = $4, publishing_at = now(), updated_at = $3 \
             WHERE id = $1 AND post_id IS NOT DISTINCT FROM $2::int4 AND updated_at = $3",
        )
        .bind(id)
        .bind(d.post_id)
        .bind(keep)
        .bind(PUBLISHING)
        .execute(&mut *conn)
        .await
        .map_err(AppError::internal)?
        .rows_affected()
    };
    if claimed == 0 {
        return Err(conflict(if p.expected_updated_at.is_some() { CHANGED } else { BUSY }));
    }
    let input = to_post_input(&d, p, "web");
    let extra = CreateExtra {
        draft: Some(id),
        ..CreateExtra::default()
    };
    match create_with(c, &input, &extra).await {
        Ok(post_id) => reload(c, post_id).await,
        Err(failure) => {
            release(c, id, keep).await;
            Err(match failure {
                CreateFailure::Failed(e) => e,
                CreateFailure::Changed => conflict("Nháp đang được đăng hoặc đã đăng."),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use trinity_db::types::JsonValue;

    fn draft(use_queue: bool, scheduled: Option<&str>) -> SocialDraft {
        SocialDraft {
            id: 1,
            title: None,
            content: "Xin chào".to_owned(),
            media: JsonValue(json!([
                {"key": "social/a.jpg", "type": "image", "content_type": "image/jpeg", "size": 3}
            ])),
            targets: JsonValue(json!([
                {"account_id": 7, "caption": "c"},
                {"account_id": 8, "options": {"k": 1}}
            ])),
            scheduled_at: scheduled.map(|s| Timestamp(s.parse().unwrap())),
            use_queue,
            ui: None,
            post_id: None,
            publishing_at: None,
            source: "web".to_owned(),
            created_by: 1,
            created_at: Timestamp(chrono::Utc::now()),
            updated_at: Timestamp(chrono::Utc::now()),
        }
    }

    #[test]
    fn theo_nhap_khi_khong_ghi_de() {
        let i = to_post_input(&draft(false, Some("2030-01-02T03:04:05Z")), &DraftPublish::default(), "web");
        assert_eq!(i.scheduled_at.as_deref(), Some("2030-01-02T03:04:05.000Z"));
        assert!(!i.use_queue);
        assert_eq!(i.media_keys, vec!["social/a.jpg".to_owned()]);
        assert_eq!(i.targets.len(), 2);
        assert_eq!(i.targets[0].caption.as_deref(), Some("c"));
        assert_eq!(i.targets[1].options.as_ref().unwrap().len(), 1);
        let q = to_post_input(&draft(true, None), &DraftPublish::default(), "web");
        assert!(q.use_queue && q.scheduled_at.is_none());
    }

    #[test]
    fn ghi_de_thang_nhap() {
        let now = DraftPublish {
            scheduled_at: Some(None),
            ..DraftPublish::default()
        };
        let i = to_post_input(&draft(true, None), &now, "web");
        // `null` = đăng ngay, bỏ cờ hàng đợi của nháp.
        assert!(!i.use_queue && i.scheduled_at.is_none());
        let at = DraftPublish {
            scheduled_at: Some(Some("2031-05-06T00:00:00Z".to_owned())),
            ..DraftPublish::default()
        };
        let i = to_post_input(&draft(true, None), &at, "web");
        assert_eq!(i.scheduled_at.as_deref(), Some("2031-05-06T00:00:00Z"));
        let queue = DraftPublish {
            scheduled_at: Some(Some("2031-05-06T00:00:00Z".to_owned())),
            use_queue: true,
            ..DraftPublish::default()
        };
        let i = to_post_input(&draft(false, Some("2030-01-02T03:04:05Z")), &queue, "csv");
        assert!(i.use_queue && i.scheduled_at.is_none());
        assert_eq!(i.source.as_deref(), Some("csv"));
    }
}
