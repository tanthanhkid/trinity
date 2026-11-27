//! `POST /facebook/tick` (phần gửi hàng loạt): web đang mở gọi định kỳ để lượt hẹn giờ hoặc đang gửi dở chạy tiếp sớm, bổ sung
//! cho job nền. Phần kịch bản nhắn tin (`flows.kickIfDue`, `flows.nextDueAt`) thuộc M50 phần 2 nên chưa có ở đây.

#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use trinity_db::CompanyRef;
use trinity_db::types::Timestamp;
use trinity_kernel::error::AppError;

use crate::ingest::{FacebookIngest, db};

impl FacebookIngest {
    /// `(due, next_at)` của gửi hàng loạt: `due` = có lượt đang gửi hoặc lượt hẹn giờ đã tới giờ; `next_at` = bây giờ nếu có lượt
    /// đang gửi, không thì giờ hẹn sớm nhất (`nextDueAt`).
    pub async fn broadcasts_due(
        &self,
        company: CompanyRef,
        now: DateTime<Utc>,
    ) -> Result<(bool, Option<DateTime<Utc>>), AppError> {
        let mut c = self.acquire(company).await?;
        let sending: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM facebook_broadcasts WHERE status = 'sending')")
                .fetch_one(&mut *c)
                .await
                .map_err(db)?;
        let ready: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM facebook_broadcasts WHERE status = 'scheduled' AND scheduled_at <= $1)",
        )
        .bind(now)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
        let next = if sending {
            Some(now)
        } else {
            let min: Option<Timestamp> =
                sqlx::query_scalar("SELECT min(scheduled_at) FROM facebook_broadcasts WHERE status = 'scheduled'")
                    .fetch_one(&mut *c)
                    .await
                    .map_err(db)?;
            min.map(|t| t.0)
        };
        Ok((sending || ready, next))
    }
}
