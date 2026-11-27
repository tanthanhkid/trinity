//! Bản cài đặt thật của các cổng [`crate::ports`] bằng hàm của M55a: nháp ([`crate::drafts`]) và khung giờ hàng đợi
//! ([`crate::queue`]). Cổng bài đăng ([`crate::ports::PostsPort`]) do M54a cài khi gộp.
//!
//! Mỗi lời gọi tự xin kết nối của mình và nhả trước khi gọi chỗ khác.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use mod_facebook::config::Env;
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::js_iso_string;

use crate::drafts::{self, DraftInput, MediaIn, TargetIn, UtmIn};
use crate::media::{MediaCtx, MediaStore};
use crate::ports::{DraftsPort, PostInput, QueuePort};

/// `DraftsPort` bằng [`drafts::check`] / [`drafts::create`].
pub struct DraftsAdapter<'a> {
    pub db: &'a Db,
    pub company: CompanyRef,
    pub store: &'a MediaStore,
    pub env: &'a Env,
    pub now_ms: i64,
}

impl DraftsAdapter<'_> {
    fn ctx(&self, user_id: i32) -> MediaCtx<'_> {
        MediaCtx {
            db: self.db,
            company: self.company,
            store: self.store,
            env: self.env,
            user_id,
            now_ms: self.now_ms,
        }
    }
}

/// `PostInput` → `DraftInput` (mọi trường đều "có gửi"; giờ hẹn rỗng thì gửi `null`).
pub fn draft_input(p: &PostInput) -> DraftInput {
    DraftInput {
        title: None,
        content: Some(Some(p.content.clone())),
        media: Some(
            p.media_keys
                .iter()
                .map(|k| MediaIn {
                    key: k.clone(),
                    name: None,
                })
                .collect(),
        ),
        targets: Some(
            p.targets
                .iter()
                .map(|t| TargetIn {
                    account_id: t.account_id,
                    caption: t.caption.clone(),
                    options: t.options.clone(),
                })
                .collect(),
        ),
        scheduled_at: Some(p.scheduled_at.map(js_iso_string)),
        use_queue: Some(p.use_queue),
        utm: p.utm.as_ref().map(|u| {
            Some(UtmIn {
                campaign: u.campaign.clone(),
                content: u.content.clone(),
            })
        }),
        ui: None,
    }
}

impl DraftsPort for DraftsAdapter<'_> {
    async fn check(&self, user_id: i32, input: &PostInput) -> Result<(), AppError> {
        drafts::check(&self.ctx(user_id), &draft_input(input)).await
    }

    async fn create(&self, user_id: i32, input: &PostInput, source: &str, dedupe: &str) -> Result<i32, AppError> {
        let d = drafts::create(&self.ctx(user_id), &draft_input(input), source, Some(dedupe)).await?;
        Ok(d.id)
    }
}

/// `QueuePort` bằng [`crate::queue::next_free`].
pub struct QueueAdapter<'a> {
    pub db: &'a TenantDb,
    pub now_ms: i64,
}

impl QueuePort for QueueAdapter<'_> {
    async fn next_free(&self, n: usize) -> Result<Vec<DateTime<Utc>>, AppError> {
        let mut conn = self.db.acquire().await.map_err(AppError::internal)?;
        crate::queue::next_free(&mut conn, n, self.now_ms).await
    }
}
