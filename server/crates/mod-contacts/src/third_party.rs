//! Lõi tạo khách của bên thứ ba (`PublicApiService.createContactInTx`): dùng chung cho `POST /public/contacts` (khoá API) và
//! webhook vào (M35). Gán `assigned_to = owner`, kế thừa `team_id` của owner, ghi outbox `contact.created` (origin = kênh)
//! trong CHÍNH giao dịch của người gọi. KHÔNG tự mở giao dịch (người gọi còn việc ghi cùng giao dịch: idempotency, activity).

use serde_json::json;
use sqlx::PgConnection;
use trinity_db::outbox::publish_integration_event;
use trinity_kernel::error::AppError;

use crate::db;
use crate::snapshot::contact_event;

/// Dữ liệu khách của bên thứ ba (`phone` đã chuẩn hoá `0xxxxxxxxx`).
#[derive(Debug, Clone)]
pub struct ThirdPartyContact<'a> {
    pub phone: &'a str,
    pub full_name: &'a str,
    pub source_id: Option<i32>,
    pub email: Option<&'a str>,
    pub project_id: Option<i32>,
}

/// Người sở hữu khách mới.
#[derive(Debug, Clone, Copy)]
pub struct Owner {
    pub id: i32,
    pub team_id: Option<i32>,
}

/// Tạo khách và ghi `contact.created` (`origin` là kênh: `public_api`, `webhook_in`). Trả id khách.
pub async fn create_in_tx(
    conn: &mut PgConnection,
    data: &ThirdPartyContact<'_>,
    owner: Owner,
    origin: &str,
) -> Result<i32, AppError> {
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO contacts (phone, full_name, source_id, email, project_id, assigned_to, team_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id",
    )
    .bind(data.phone)
    .bind(data.full_name)
    .bind(data.source_id)
    .bind(data.email)
    .bind(data.project_id)
    .bind(owner.id)
    .bind(owner.team_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let snap = contact_event(conn, id).await?.snapshot();
    publish_integration_event(
        conn,
        "contact.created",
        &json!({ "contact": snap, "origin": origin }),
        id,
        None,
    )
    .await
    .map_err(AppError::internal)?;
    Ok(id)
}
