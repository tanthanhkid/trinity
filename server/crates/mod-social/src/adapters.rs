//! Bản cài đặt thật của các cổng [`crate::ports`] bằng hàm của M55a: nháp ([`crate::drafts`]) và khung giờ hàng đợi
//! ([`crate::queue`]). Cổng bài đăng ([`crate::ports::PostsPort`]) bọc [`crate::posts`] (M54a).
//!
//! Mỗi lời gọi tự xin kết nối của mình và nhả trước khi gọi chỗ khác.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use mod_channel_guard::ChannelGuard;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use serde_json::{Value, json};
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::from_millis;
use trinity_kernel::vn_time::js_iso_string;

use crate::drafts::{self, DraftInput, MediaIn, TargetIn, UtmIn};
use crate::dto::{PostInput as DtoPostInput, TargetInput};
use crate::media::{MediaCtx, MediaStore};
use crate::ports::{CreateFailure, DraftsPort, PostInput, PostsPort, QueuePort, RecurrenceGuard, ValidatedPost};
use crate::posts::{CreateExtra, PostCtx, cancel, create_with, validate};

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

/// `PostsPort` bằng [`crate::posts`] (M54a): kiểm, tạo (cùng giao dịch với điều kiện lịch lặp và chống trùng khoá nguồn), huỷ.
pub struct PostsAdapter<'a> {
    pub db: &'a Db,
    pub company: CompanyRef,
    pub env: &'a Env,
    pub store: &'a MediaStore,
    pub graph: &'a GraphClient,
    pub guard: &'a ChannelGuard,
    pub now_ms: i64,
}

impl PostsAdapter<'_> {
    fn ctx(&self, user_id: i32) -> PostCtx<'_> {
        PostCtx {
            db: self.db,
            company: self.company,
            env: self.env,
            store: self.store,
            graph: self.graph,
            guard: self.guard,
            user_id,
            now_ms: self.now_ms,
        }
    }
}

/// `PostInput` của cổng → body bài đăng của M54a (`utm` chung cho mọi kênh).
pub fn post_dto(p: &PostInput) -> DtoPostInput {
    DtoPostInput {
        content: p.content.clone(),
        media_keys: p.media_keys.clone(),
        targets: p
            .targets
            .iter()
            .map(|t| TargetInput {
                account_id: t.account_id,
                caption: t.caption.clone(),
                options: t.options.clone(),
            })
            .collect(),
        scheduled_at: p.scheduled_at.map(js_iso_string),
        use_queue: p.use_queue,
        utm: p.utm.as_ref().map(|u| {
            let mut o = json!({ "campaign": u.campaign });
            if let Some(c) = &u.content {
                o["content"] = Value::String(c.clone());
            }
            o
        }),
        source: p.source.clone(),
    }
}

impl PostsPort for PostsAdapter<'_> {
    async fn validate(&self, user_id: i32, input: &PostInput) -> Result<ValidatedPost, AppError> {
        let v = validate(&self.ctx(user_id), &post_dto(input), None).await?;
        Ok(ValidatedPost {
            scheduled_at: v.scheduled_at.and_then(from_millis),
        })
    }

    async fn create(
        &self,
        user_id: i32,
        input: &PostInput,
        dedupe_source: &str,
        guard: Option<RecurrenceGuard>,
    ) -> Result<i32, CreateFailure> {
        let mut dto = post_dto(input);
        dto.source = Some(dedupe_source.to_owned());
        let extra = CreateExtra {
            guard: guard.as_ref(),
            dedupe: true,
        };
        create_with(&self.ctx(user_id), &dto, &extra).await
    }

    async fn cancel(&self, post_id: i32) -> Result<(), AppError> {
        cancel(&self.ctx(0), post_id).await.map(|_| ())
    }
}
