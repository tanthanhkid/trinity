//! Chuyển quyền phụ trách khách (`ContactTransferService`): một khách, nhiều khách, và danh sách người nhận.
//!
//! Người nhận phải active và nằm trong phạm vi `contacts.transfer` của người gọi; khách hiện tại cũng phải do người trong
//! phạm vi đó phụ trách. Chỉ đổi `contacts.assigned_to`, ghi hoạt động `contact_transfer` làm dấu vết.

use serde::Serialize;
use serde_json::json;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::TenantDb;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::OwnerIds;

use crate::read::UserBrief;
use crate::snapshot::contact_event;
use crate::{Actor, Scopes, covers, db, error_message, http};
use trinity_db::outbox::publish_integration_event;

/// Trần một lần chuyển hàng loạt (an toàn kết nối DB).
pub const BULK_TRANSFER_MAX: usize = 500;

/// Khoá viết camelCase như bản TS.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TransferResult {
    #[serde(rename = "contactId")]
    pub contact_id: i32,
    #[serde(rename = "fromUserId")]
    pub from_user_id: Option<i32>,
    #[serde(rename = "toUserId")]
    pub to_user_id: i32,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Failed {
    #[serde(rename = "contactId")]
    pub contact_id: i32,
    pub error: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct BulkResult {
    #[serde(rename = "transferredIds")]
    pub transferred_ids: Vec<i32>,
    pub failed: Vec<Failed>,
}

fn internal(e: impl std::error::Error + Send + Sync + 'static) -> AppError {
    AppError::internal(e)
}

/// `POST /contacts/:id/transfer`. Mỗi lần chuyển một giao dịch riêng; hai lần chuyển song song cùng một khách thì lần sau
/// thấy người phụ trách đã đổi ⇒ 409 (không bắn sự kiện với `from_user_id` cũ).
pub async fn transfer(
    db_: &TenantDb,
    scopes: &Scopes,
    actor: &Actor,
    contact_id: i32,
    new_assigned_to: i32,
    reason: &str,
) -> Result<TransferResult, AppError> {
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;
    let contact: Option<(Option<i32>, Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT c.assigned_to, c.full_name, c.phone, u.full_name FROM contacts c LEFT JOIN users u ON u.id = c.assigned_to
         WHERE c.id = $1 AND c.deleted_at IS NULL",
    )
    .bind(contact_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let Some((assigned_to, full_name, phone, prev_name)) = contact else {
        return Err(http(HttpError::not_found(format!(
            "Không tìm thấy khách hàng ID {contact_id}"
        ))));
    };

    let allowed = scopes.transfer.clone().unwrap_or(OwnerIds::Ids(Vec::new()));
    if !assigned_to.is_some_and(|a| covers(Some(&allowed), a)) && allowed != OwnerIds::All {
        return Err(http(HttpError::forbidden("Bạn không có quyền chuyển khách hàng này")));
    }
    if Some(new_assigned_to) == assigned_to {
        return Err(http(HttpError::bad_request(
            "Sale được chọn đang là người phụ trách hiện tại. Không thực hiện cập nhật.",
        )));
    }
    let target: Option<(Option<String>, String, bool)> =
        sqlx::query_as("SELECT full_name, status, deleted_at IS NOT NULL FROM users WHERE id = $1")
            .bind(new_assigned_to)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((target_name, _, _)) = target.filter(|(_, status, deleted)| status == "active" && !deleted) else {
        return Err(http(HttpError::bad_request(
            "Người được chọn không hợp lệ, đã bị khoá hoặc nghỉ việc",
        )));
    };
    if !covers(Some(&allowed), new_assigned_to) {
        return Err(http(HttpError::forbidden(
            "Chỉ được chuyển khách hàng cho người thuộc phạm vi contacts.transfer của bạn",
        )));
    }

    if !phone.is_empty() {
        let dupe: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM contacts WHERE phone = $1 AND deleted_at IS NULL AND id <> $2 AND assigned_to = $3",
        )
        .bind(&phone)
        .bind(contact_id)
        .bind(new_assigned_to)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        if dupe > 0 {
            return Err(http(HttpError::conflict(
                "Người nhận đã có khách hàng trùng số điện thoại với khách này",
            )));
        }
    }

    let moved = sqlx::query(
        "UPDATE contacts SET assigned_to = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL AND assigned_to IS NOT DISTINCT FROM $3",
    )
    .bind(contact_id)
    .bind(new_assigned_to)
    .bind(assigned_to)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    if moved.rows_affected() != 1 {
        return Err(http(HttpError::conflict(
            "Khách hàng vừa được người khác chuyển, tải lại rồi thử lại",
        )));
    }
    let reason_json = if reason.is_empty() { None } else { Some(reason) };
    let snap = contact_event(conn, contact_id).await?.snapshot();
    publish_integration_event(
        conn,
        "contact.assigned",
        &json!({ "contact": snap, "from_user_id": assigned_to, "to_user_id": new_assigned_to, "reason": reason_json }),
        contact_id,
        Some(actor.user_id),
    )
    .await
    .map_err(internal)?;

    let customer = full_name
        .as_deref()
        .map(trinity_kernel::vi::trim_js)
        .filter(|n| !n.is_empty())
        .map_or_else(|| format!("khách hàng #{contact_id}"), str::to_owned);
    let previous = prev_name.unwrap_or_else(|| "chưa gán".to_owned());
    let details = json!({
        "description": format!(
            "Chuyển quyền phụ trách khách hàng {customer} từ {previous} sang {}",
            target_name.unwrap_or_default()
        ),
        "reason": reason_json,
    });
    sqlx::query(
        "INSERT INTO activities (contact_id, action, details, metadata, created_by) VALUES ($1, 'contact_transfer', $2::text::jsonb, $3::text::jsonb, $4)",
    )
    .bind(contact_id)
    .bind(details.to_string())
    .bind(json!({ "from_user_id": assigned_to, "to_user_id": new_assigned_to }).to_string())
    .bind(actor.user_id)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(internal)?;
    Ok(TransferResult {
        contact_id,
        from_user_id: assigned_to,
        to_user_id: new_assigned_to,
    })
}

/// `POST /contacts/bulk-transfer`: tuần tự từng khách (tránh dồn kết nối); một khách lỗi không chặn cả lô. Không chuyển
/// được khách nào ⇒ 400 kèm lỗi đầu tiên.
pub async fn bulk_transfer(
    db_: &TenantDb,
    scopes: &Scopes,
    actor: &Actor,
    contact_ids: &[i32],
    new_assigned_to: i32,
    reason: &str,
) -> Result<BulkResult, AppError> {
    let mut transferred_ids = Vec::new();
    let mut failed = Vec::new();
    for &contact_id in contact_ids {
        match transfer(db_, scopes, actor, contact_id, new_assigned_to, reason).await {
            Ok(r) => transferred_ids.push(r.contact_id),
            Err(e) => failed.push(Failed {
                contact_id,
                error: error_message(&e),
            }),
        }
    }
    if transferred_ids.is_empty()
        && let Some(first) = failed.first()
    {
        return Err(http(HttpError::bad_request(format!(
            "Không chuyển được khách hàng nào. Lỗi đầu tiên: {}",
            first.error
        ))));
    }
    Ok(BulkResult {
        transferred_ids,
        failed,
    })
}

/// `GET /contacts/assignable-sales`: nhân sự active trong phạm vi `contacts.transfer`, sắp theo tên, tối đa 500.
pub async fn assignable_sales(conn: &mut PgConnection, scopes: &Scopes) -> Result<Vec<UserBrief>, AppError> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, full_name, email FROM users WHERE deleted_at IS NULL AND status = 'active' AND ",
    );
    match scopes.transfer.clone().unwrap_or(OwnerIds::Ids(Vec::new())) {
        OwnerIds::All => {
            qb.push("TRUE");
        }
        OwnerIds::Ids(ids) if ids.is_empty() => return Ok(Vec::new()),
        OwnerIds::Ids(ids) => {
            qb.push("id = ANY(").push_bind(ids).push(")");
        }
    }
    qb.push(" ORDER BY full_name ASC LIMIT 500");
    qb.build_query_as().fetch_all(conn).await.map_err(db)
}
