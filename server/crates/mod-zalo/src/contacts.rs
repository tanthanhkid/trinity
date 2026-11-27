//! Ghép hội thoại OA với khách CRM (`zalo-oa-contact-linker.service.ts`): (1) `contacts.zalo_account` = user_id Zalo; (2) trùng
//! SĐT (`0…`, `84…`, `+84…`); (3) có SĐT mà chưa có khách ⇒ TẠO khách mới giao cho người đã kết nối OA (qua lõi tạo khách chung của
//! `mod-public-api`, phát `contact.created`). Không có SĐT ⇒ KHÔNG tạo (`contacts.phone` bắt buộc): hội thoại để trống
//! `contact_id`, gán tay bằng API `link`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use mod_public_api::service::{NewContact, Owner, create_contact_in_tx};
use sqlx::{Acquire, PgConnection};
use trinity_db::pg_error::app_error;
use trinity_kernel::error::AppError;
use trinity_kernel::phone::phone_variants;

use crate::config::{to_local_phone, to_zalo_phone};

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Các dạng lưu của một SĐT Zalo (`84…`) trong bảng khách.
pub fn zalo_phone_variants(zalo_phone: &str) -> Vec<String> {
    phone_variants(&to_local_phone(zalo_phone))
}

/// Khách đã có: theo `zalo_account`, rồi theo SĐT (khách cũ nhất trước).
pub async fn find(conn: &mut PgConnection, zalo_user_id: &str, phone: Option<&str>) -> Result<Option<i32>, AppError> {
    let by_account: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM contacts WHERE zalo_account = $1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
    )
    .bind(zalo_user_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if by_account.is_some() {
        return Ok(by_account);
    }
    let Some(z) = phone.and_then(to_zalo_phone) else {
        return Ok(None);
    };
    sqlx::query_scalar("SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1")
        .bind(zalo_phone_variants(&z))
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// (id, trạng thái, nhóm, ngày xoá) của người phụ trách.
type OwnerRow = (i32, String, Option<i32>, Option<chrono::DateTime<chrono::Utc>>);

/// Đầu vào [`find_or_create`].
#[derive(Debug, Clone)]
pub struct LinkInput<'a> {
    pub zalo_user_id: &'a str,
    pub phone: Option<&'a str>,
    pub name: Option<&'a str>,
    /// Người phụ trách (người đã kết nối OA); phải còn hoạt động mới được giao khách mới.
    pub owner_user_id: i32,
}

/// Tìm, không có thì tạo (cần SĐT hợp lệ và người phụ trách còn hoạt động). Trả id khách hoặc `None`. Kiểm trùng và tạo nằm
/// trong một giao dịch dưới khoá advisory theo (schema, SĐT): hai webhook đồng thời cùng SĐT chỉ tạo một khách.
pub async fn find_or_create(conn: &mut PgConnection, p: &LinkInput<'_>) -> Result<Option<i32>, AppError> {
    if let Some(id) = find(&mut *conn, p.zalo_user_id, p.phone).await? {
        return Ok(Some(id));
    }
    let Some(z) = p.phone.and_then(to_zalo_phone) else {
        return Ok(None);
    };
    let owner: Option<OwnerRow> = sqlx::query_as("SELECT id, status, team_id, deleted_at FROM users WHERE id = $1")
        .bind(p.owner_user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some((owner_id, _, team_id, _)) = owner.filter(|o| o.1 == "active" && o.3.is_none()) else {
        tracing::warn!(
            "Không tạo khách từ Zalo OA: người phụ trách {} không còn hoạt động",
            p.owner_user_id
        );
        return Ok(None);
    };
    let local = to_local_phone(&z);
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.zalo_oa_contact.' || $1))")
        .bind(&local)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let dup: Option<i32> =
        sqlx::query_scalar("SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL LIMIT 1")
            .bind(zalo_phone_variants(&z))
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    if let Some(id) = dup {
        return Ok(Some(id));
    }
    let (id, _) = create_contact_in_tx(
        &mut tx,
        &NewContact {
            phone: &local,
            full_name: p.name,
            source_id: None,
            email: None,
            job_title: None,
            reminder_notes: None,
            zalo_account: Some(p.zalo_user_id),
        },
        &Owner { id: owner_id, team_id },
        "zalo_oa",
    )
    .await?;
    tx.commit().await.map_err(db)?;
    Ok(Some(id))
}

/// Người được giao khách (`assigned_to`), hoặc `None`.
pub async fn assigned_to(conn: &mut PgConnection, contact_id: Option<i32>) -> Result<Option<i32>, AppError> {
    let Some(id) = contact_id else { return Ok(None) };
    let r: Option<Option<i32>> = sqlx::query_scalar("SELECT assigned_to FROM contacts WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    Ok(r.flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dang_luu_cua_sdt_zalo() {
        let v = zalo_phone_variants("84912345678");
        assert!(
            v.contains(&"0912345678".to_owned())
                && v.contains(&"84912345678".to_owned())
                && v.contains(&"+84912345678".to_owned()),
            "{v:?}"
        );
    }
}
