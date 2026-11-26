//! Ghi khách: tạo, sửa, xoá mềm, khôi phục (`ContactsService`). Mỗi lần ghi và sự kiện outbox đi chung một giao dịch.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::TenantDb;
use trinity_db::outbox::{CreatedNotification, NewNotification, create_notification, publish_integration_event};
use trinity_db::types::NaiveTimestamp;
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::phone::{normalize_phone, phone_variants};
use trinity_rbac::{OwnerIds, mask_phone};

use crate::filter::parse_js_instant;
use crate::nullable::some_nullable;
use crate::read::{ContactDetail, DETAIL_SELECT};
use crate::snapshot::{DEAL_EVENT_COLS, DealEventRow, contact_event};
use crate::{Actor, RESTORE_WINDOW_MINUTES, Scopes, assert_in_scope, covers, db, http};

fn internal(e: impl std::error::Error + Send + Sync + 'static) -> AppError {
    AppError::internal(e)
}

fn bad(msg: impl Into<Message>) -> AppError {
    http(HttpError::bad_request(msg))
}

fn forbidden(msg: &str) -> AppError {
    http(HttpError::forbidden(msg))
}

fn not_found(msg: String) -> AppError {
    http(HttpError::not_found(msg))
}

fn date(field: &str, raw: &str) -> Result<DateTime<Utc>, AppError> {
    parse_js_instant(raw).ok_or_else(|| bad(format!("{field} không hợp lệ")))
}

/// Body `POST /contacts` (đã qua K15: SĐT `^(0|\+84)\d{9}$`, tên 1..100, email hợp lệ…).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateContact {
    pub phone: String,
    #[serde(default)]
    pub phone_2: Option<String>,
    #[serde(default)]
    pub zalo_account: Option<String>,
    pub full_name: String,
    pub source_id: i32,
    #[serde(default)]
    pub stage_id: Option<i32>,
    #[serde(default)]
    pub contact_status_id: Option<i32>,
    #[serde(default)]
    pub job_title: Option<String>,
    #[serde(default)]
    pub birthday: Option<String>,
    #[serde(default)]
    pub gender: Option<String>,
    #[serde(default)]
    pub current_address: Option<String>,
    #[serde(default)]
    pub company_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub reminder_notes: Option<String>,
    #[serde(default)]
    pub deal_assigned_to: Option<i32>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// Body `PATCH /contacts/:id`. Trường nhận NULL: không gửi = giữ nguyên, `null` = xoá giá trị.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateContact {
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub phone_2: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub zalo_account: Option<Option<String>>,
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default)]
    pub source_id: Option<i32>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub stage_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub contact_status_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub reminder_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub reminder_notes: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub job_title: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub birthday: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub gender: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub current_address: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub company_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub email: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub assigned_to: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub team_id: Option<Option<i32>>,
    #[serde(default)]
    pub custom_fields: Option<Value>,
}

/// Kết quả `POST /contacts`: `contact` là chi tiết (không che SĐT, như bản TS), `warning` luôn `null`.
#[derive(Debug, Serialize)]
pub struct Created {
    pub contact: ContactDetail,
    pub warning: Option<String>,
    pub deal: Option<DealEventRow>,
    /// Thông báo "được giao thương vụ" đã ghi (không đưa vào JSON): tầng route đẩy socket nội bộ sau commit.
    #[serde(skip)]
    pub notifications: Vec<CreatedNotification>,
}

#[derive(Debug, Serialize)]
pub struct Done {
    pub success: bool,
    pub message: &'static str,
}

/// Option trong `setting_options` phải tồn tại, đúng nhóm và đang bật.
async fn assert_option(conn: &mut PgConnection, id: i32, group: &str) -> Result<(), AppError> {
    let row: Option<(String, bool)> = sqlx::query_as("SELECT group_key, is_active FROM setting_options WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    match row {
        Some((g, active)) if g == group => {
            if active {
                Ok(())
            } else {
                Err(bad("Giá trị đã bị vô hiệu hoá"))
            }
        }
        _ => Err(bad(format!("Giá trị không thuộc nhóm \"{group}\""))),
    }
}

/// Nhân viên đã nghỉ việc (`employees.status`/`deleted_at`) không nhận được thương vụ, dù `users.status` còn `active`.
async fn assert_not_resigned(conn: &mut PgConnection, user_id: i32) -> Result<(), AppError> {
    let row: Option<(String, Option<NaiveTimestamp>)> =
        sqlx::query_as("SELECT status, deleted_at::timestamp FROM employees WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    match row {
        Some((status, deleted)) if status == "resigned" || deleted.is_some() => {
            Err(bad("Nhân viên đã nghỉ việc, không thể gán thương vụ"))
        }
        _ => Ok(()),
    }
}

/// Số khách chưa xoá cùng SĐT (cả dạng `0…` lẫn `+84…`) của người phụ trách (`assigned_to` rỗng = chưa gán).
async fn duplicate_count(
    conn: &mut PgConnection,
    phone: &str,
    assigned_to: Option<i32>,
    except_id: Option<i32>,
) -> Result<i64, AppError> {
    sqlx::query_scalar(
        "SELECT count(*) FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL AND assigned_to IS NOT DISTINCT FROM $2
           AND ($3::int IS NULL OR id <> $3)",
    )
    .bind(phone_variants(phone))
    .bind(assigned_to)
    .bind(except_id)
    .fetch_one(conn)
    .await
    .map_err(db)
}

async fn publish(conn: &mut PgConnection, ty: &str, payload: &Value, id: i32, actor: &Actor) -> Result<(), AppError> {
    publish_integration_event(conn, ty, payload, id, Some(actor.user_id))
        .await
        .map_err(internal)
}

async fn audit(
    conn: &mut PgConnection,
    actor: &Actor,
    action: &str,
    id: i32,
    metadata: &Value,
) -> Result<(), AppError> {
    sqlx::query("INSERT INTO audit_logs (user_id, action, resource, resource_id, metadata) VALUES ($1, $2, 'contacts', $3, $4::text::jsonb)")
        .bind(actor.user_id)
        .bind(action)
        .bind(id)
        .bind(metadata.to_string())
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// `POST /contacts`: SĐT trùng khách CÙNG người phụ trách ⇒ 409 (khách của người khác không chặn). Khoá advisory theo SĐT
/// khép race hai request cùng lúc. `deal_assigned_to` cần `deals.manage` phủ người đó; khi có, người phụ trách là người
/// đó và thương vụ được tạo cùng, kèm thông báo.
pub async fn create(db_: &TenantDb, scopes: &Scopes, actor: &Actor, dto: &CreateContact) -> Result<Created, AppError> {
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;

    assert_option(conn, dto.source_id, "contact_source").await?;
    if let Some(to) = dto.deal_assigned_to
        && !covers(scopes.deals_manage.as_ref(), to)
    {
        return Err(forbidden(
            "Không có quyền gán thương vụ cho người được chọn (cần deals.manage phủ người này)",
        ));
    }
    let stage_id = match dto.stage_id.filter(|s| *s != 0) {
        Some(s) => {
            assert_option(conn, s, "contact_stage").await?;
            Some(s)
        }
        None => {
            sqlx::query_scalar("SELECT id FROM setting_options WHERE group_key = 'contact_stage' AND value = 'new'")
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?
        }
    };
    if let Some(s) = dto.contact_status_id.filter(|s| *s != 0) {
        assert_option(conn, s, "contact_detail_status").await?;
    }

    let (assigned_to, team_id): (i32, Option<i32>) = match dto.deal_assigned_to {
        Some(to) => {
            let row: Option<(i32, Option<i32>)> =
                sqlx::query_as("SELECT id, team_id FROM users WHERE id = $1 AND status = 'active'")
                    .bind(to)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(db)?;
            let Some((id, team)) = row else {
                return Err(bad(
                    "Không tìm thấy nhân viên với ID này hoặc tài khoản không hoạt động",
                ));
            };
            assert_not_resigned(conn, id).await?;
            (id, team)
        }
        None => {
            let team: Option<Option<i32>> = sqlx::query_scalar("SELECT team_id FROM users WHERE id = $1")
                .bind(actor.user_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
            (actor.user_id, team.flatten())
        }
    };

    let phone = normalize_phone(&dto.phone).unwrap_or_else(|| dto.phone.clone());
    let phone_2 = dto
        .phone_2
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| normalize_phone(p).unwrap_or_else(|| p.to_owned()));
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&phone)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    if duplicate_count(conn, &phone, Some(assigned_to), None).await? > 0 {
        return Err(http(HttpError::conflict(
            "Khách hàng đã có trong danh sách của bạn. Vui lòng sử dụng khách hàng hiện có hoặc liên hệ quản trị viên nếu cần hỗ trợ.",
        )));
    }

    let birthday = dto.birthday.as_deref().map(|d| date("Ngày sinh", d)).transpose()?;
    let reminder_at = dto.reminder_at.as_deref().map(|d| date("Ngày hẹn", d)).transpose()?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO contacts (phone, phone_2, zalo_account, full_name, source_id, stage_id, contact_status_id, job_title, birthday,
           reminder_at, reminder_notes, assigned_to, team_id, created_by_id, gender, current_address, company_name, email, avatar_url, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now()) RETURNING id",
    )
    .bind(&phone)
    .bind(phone_2)
    .bind(&dto.zalo_account)
    .bind(&dto.full_name)
    .bind(dto.source_id)
    .bind(stage_id)
    .bind(dto.contact_status_id.filter(|s| *s != 0))
    .bind(&dto.job_title)
    .bind(birthday)
    .bind(reminder_at)
    .bind(&dto.reminder_notes)
    .bind(assigned_to)
    .bind(team_id)
    .bind(actor.user_id)
    .bind(&dto.gender)
    .bind(&dto.current_address)
    .bind(&dto.company_name)
    .bind(&dto.email)
    .bind(&dto.avatar_url)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;

    let deal: Option<DealEventRow> = match dto.deal_assigned_to {
        Some(to) => Some(
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "INSERT INTO deals (title, assigned_to, created_by, contact_id, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING {DEAL_EVENT_COLS}"
            )))
            .bind(format!("Thương vụ từ khách hàng #{id}"))
            .bind(to)
            .bind(actor.user_id)
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?,
        ),
        None => None,
    };

    let snap = contact_event(conn, id).await?.snapshot();
    publish(
        conn,
        "contact.created",
        &json!({ "contact": snap, "origin": "manual" }),
        id,
        actor,
    )
    .await?;
    if let Some(d) = &deal {
        publish(conn, "deal.created", &json!({ "deal": d.snapshot() }), d.id, actor).await?;
    }
    let contact = detail(conn, id).await?;

    let notifications = match &deal {
        Some(d) => {
            let by = actor
                .email
                .clone()
                .unwrap_or_else(|| format!("Admin #{}", actor.user_id));
            let item = NewNotification {
                recipient_id: d.assigned_to,
                event_type: "deal.assigned".to_owned(),
                title: "Bạn được giao thương vụ mới".to_owned(),
                body: format!("\"{}\" — giao bởi {by}", d.title),
                action_url: Some(format!("/contacts/{id}")),
            };
            create_notification(&mut tx, &[item]).await.map_err(internal)?
        }
        None => Vec::new(),
    };
    tx.commit().await.map_err(internal)?;
    Ok(Created {
        contact,
        warning: None,
        deal,
        notifications,
    })
}

async fn detail(conn: &mut PgConnection, id: i32) -> Result<ContactDetail, AppError> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{DETAIL_SELECT} WHERE c.id = $1")))
        .bind(id)
        .fetch_one(conn)
        .await
        .map_err(db)
}

#[derive(sqlx::FromRow)]
struct Existing {
    assigned_to: Option<i32>,
    created_by_id: Option<i32>,
    full_name: Option<String>,
    source_id: Option<i32>,
    source_locked: bool,
    phone: String,
    stage_id: Option<i32>,
}

/// Quyền đổi người phụ trách: cần `contacts.transfer` phủ cả người đang phụ trách và người nhận (bỏ gán cũng là chuyển).
async fn validate_assignment(
    conn: &mut PgConnection,
    scopes: &Scopes,
    dto: &UpdateContact,
    current: Option<i32>,
) -> Result<(), AppError> {
    let transfer = scopes.transfer.as_ref();
    match dto.assigned_to {
        Some(None) => {
            if let Some(cur) = current
                && !covers(transfer, cur)
            {
                return Err(forbidden(
                    "Cần quyền contacts.transfer phủ người đang phụ trách để bỏ gán",
                ));
            }
        }
        Some(Some(to)) => {
            if let Some(cur) = current
                && cur != to
                && !covers(transfer, cur)
            {
                return Err(forbidden(
                    "Cần quyền contacts.transfer phủ người đang phụ trách để đổi phụ trách",
                ));
            }
            if !covers(transfer, to) {
                return Err(forbidden(
                    "Cần quyền contacts.transfer phủ người được chọn để đổi phụ trách",
                ));
            }
            let target: Option<(String, bool)> =
                sqlx::query_as("SELECT status, deleted_at IS NOT NULL FROM users WHERE id = $1")
                    .bind(to)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(db)?;
            if !matches!(&target, Some((status, false)) if status == "active") {
                return Err(not_found(format!("Không tìm thấy user ID {to}")));
            }
        }
        None => {}
    }
    if let Some(Some(team)) = dto.team_id {
        let found: Option<i32> = sqlx::query_scalar("SELECT id FROM teams WHERE id = $1")
            .bind(team)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
        if found.is_none() {
            return Err(not_found(format!("Không tìm thấy team ID {team}")));
        }
    }
    Ok(())
}

/// `PATCH /contacts/:id`. `phone` cần thêm `contacts.phone_full` phủ chủ khách; `full_name` và `source_id` chỉ điền khi
/// đang trống (Quản trị được ghi đè); đổi `assigned_to` cần `contacts.transfer`; `custom_fields` chỉ chủ hồ sơ hoặc Quản
/// trị. Ghi và sự kiện `contact.updated`/`stage_changed`/`assigned` cùng giao dịch; đổi giai đoạn ghi thêm hoạt động
/// `stage_change`. Trả chi tiết đã che SĐT theo `contacts.phone_full`.
pub async fn update(
    db_: &TenantDb,
    scopes: &Scopes,
    actor: &Actor,
    id: i32,
    dto: &UpdateContact,
) -> Result<ContactDetail, AppError> {
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;
    let existing: Existing = sqlx::query_as(
        "SELECT assigned_to, created_by_id, full_name, source_id, source_locked, phone, stage_id FROM contacts WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| not_found(format!("Không tìm thấy contact ID {id}")))?;
    let owners = [existing.assigned_to, existing.created_by_id];
    assert_in_scope(scopes.update.as_ref(), &owners)?;

    if dto.phone.is_some() {
        let ok = match &scopes.phone_full {
            Some(OwnerIds::All) => true,
            Some(OwnerIds::Ids(ids)) => owners.iter().flatten().any(|o| ids.contains(o)),
            None => false,
        };
        if !ok {
            return Err(forbidden(
                "Cần quyền contacts.phone_full phủ khách hàng này để sửa số điện thoại",
            ));
        }
    }
    if dto.custom_fields.is_some() && !actor.is_admin && existing.assigned_to != Some(actor.user_id) {
        return Err(forbidden("Chỉ chủ hồ sơ hoặc Quản trị được chỉnh custom field"));
    }
    if dto.assigned_to.is_some() || dto.team_id.is_some() {
        validate_assignment(conn, scopes, dto, existing.assigned_to).await?;
    }
    if let Some(Some(s)) = dto.stage_id.filter(|s| s.is_some_and(|v| v != 0)) {
        assert_option(conn, s, "contact_stage").await?;
    }
    if let Some(Some(s)) = dto.contact_status_id.filter(|s| s.is_some_and(|v| v != 0)) {
        assert_option(conn, s, "contact_detail_status").await?;
    }

    if dto.source_id.is_some() && existing.source_locked && !actor.is_admin {
        return Err(bad("Không thể sửa Nguồn: Nguồn của contact này đã khoá."));
    }
    let has_name = existing.full_name.as_deref().is_some_and(|n| !trim_js_empty(n));
    let name_write = dto.full_name.is_some() && (!has_name || actor.is_admin);
    let source_write = dto.source_id.is_some()
        && ((existing.source_id.is_none() && !existing.source_locked)
            || (dto.source_id != existing.source_id && actor.is_admin));
    if source_write && let Some(s) = dto.source_id {
        assert_option(conn, s, "contact_source").await?;
    }

    let new_phone = dto.phone.as_deref().map(|p| {
        let t = trinity_kernel::vi::trim_js(p);
        normalize_phone(t).unwrap_or_else(|| t.to_owned())
    });
    let phone_changed = new_phone.as_deref().is_some_and(|p| p != existing.phone);
    let assignee_changed = matches!(dto.assigned_to, Some(Some(to)) if Some(to) != existing.assigned_to);
    if phone_changed || assignee_changed {
        let phone = if phone_changed {
            new_phone.as_deref().unwrap_or(&existing.phone)
        } else {
            &existing.phone
        };
        let owner = match dto.assigned_to {
            Some(Some(to)) if assignee_changed => Some(to),
            _ => existing.assigned_to,
        };
        if duplicate_count(conn, phone, owner, Some(id)).await? > 0 {
            return Err(http(HttpError::conflict(format!(
                "SĐT {} đã có trong danh sách khách của người phụ trách này",
                mask_phone(Some(phone)).unwrap_or_default()
            ))));
        }
    }

    let mut qb = QueryBuilder::<Postgres>::new("UPDATE contacts SET updated_at = now()");
    let mut changed: Vec<&'static str> = Vec::new();
    let mut set = |qb: &mut QueryBuilder<Postgres>, col: &'static str| {
        changed.push(col);
        qb.push(", ").push(col).push(" = ");
    };
    if phone_changed && let Some(p) = &new_phone {
        set(&mut qb, "phone");
        qb.push_bind(p.clone());
    }
    if let Some(v) = &dto.phone_2 {
        set(&mut qb, "phone_2");
        qb.push_bind(
            v.as_deref()
                .filter(|p| !p.is_empty())
                .map(|p| normalize_phone(p).unwrap_or_else(|| p.to_owned())),
        );
    }
    if let Some(v) = &dto.zalo_account {
        set(&mut qb, "zalo_account");
        qb.push_bind(v.clone());
    }
    for (col, v) in [
        ("stage_id", dto.stage_id),
        ("contact_status_id", dto.contact_status_id),
        ("assigned_to", dto.assigned_to),
        ("team_id", dto.team_id),
    ] {
        if let Some(v) = v {
            set(&mut qb, col);
            qb.push_bind(v.filter(|x| *x != 0));
        }
    }
    for (col, v) in [
        ("job_title", &dto.job_title),
        ("reminder_notes", &dto.reminder_notes),
        ("gender", &dto.gender),
        ("current_address", &dto.current_address),
        ("company_name", &dto.company_name),
    ] {
        if let Some(v) = v {
            set(&mut qb, col);
            qb.push_bind(v.clone());
        }
    }
    for (col, label, v) in [
        ("reminder_at", "Ngày hẹn", &dto.reminder_at),
        ("birthday", "Ngày sinh", &dto.birthday),
    ] {
        if let Some(v) = v {
            set(&mut qb, col);
            qb.push_bind(v.as_deref().map(|d| date(label, d)).transpose()?);
        }
    }
    if let Some(v) = &dto.email {
        set(&mut qb, "email");
        qb.push_bind(v.clone().filter(|e| !e.is_empty()));
    }
    if let Some(v) = &dto.custom_fields {
        set(&mut qb, "custom_fields");
        qb.push_bind(v.to_string()).push("::text::jsonb");
    }
    if name_write && let Some(n) = &dto.full_name {
        set(&mut qb, "full_name");
        qb.push_bind(trinity_kernel::vi::trim_js(n).to_owned());
    }
    if source_write && let Some(s) = dto.source_id {
        set(&mut qb, "source_id");
        qb.push_bind(s);
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.build().execute(&mut *conn).await.map_err(db)?;
    changed.sort_unstable();

    let after = contact_event(conn, id).await?;
    let snap = after.snapshot();
    if !changed.is_empty() {
        publish(
            conn,
            "contact.updated",
            &json!({ "contact": snap, "changed_fields": changed }),
            id,
            actor,
        )
        .await?;
    }
    if existing.stage_id != after.stage_id {
        publish(
            conn,
            "contact.stage_changed",
            &json!({ "contact": snap, "from_stage_id": existing.stage_id, "to_stage_id": after.stage_id }),
            id,
            actor,
        )
        .await?;
        record_stage_change(conn, actor, id, existing.stage_id, after.stage_id).await?;
    }
    if existing.assigned_to != after.assigned_to {
        publish(
            conn,
            "contact.assigned",
            &json!({ "contact": snap, "from_user_id": existing.assigned_to, "to_user_id": after.assigned_to }),
            id,
            actor,
        )
        .await?;
    }
    if phone_changed {
        let metadata = json!({
            "old_phone": mask_phone(Some(&existing.phone)),
            "new_phone": new_phone.as_deref().and_then(|p| mask_phone(Some(p))),
        });
        audit(conn, actor, "contact.phone_changed", id, &metadata).await?;
    }
    let mut out = detail(conn, id).await?;
    tx.commit().await.map_err(internal)?;
    out.mask(scopes);
    Ok(out)
}

fn trim_js_empty(s: &str) -> bool {
    trinity_kernel::vi::trim_js(s).is_empty()
}

/// Hoạt động `stage_change` khi giai đoạn thật sự đổi: nguồn của tab "Lịch sử" và số "đổi giai đoạn" trong bản tin.
async fn record_stage_change(
    conn: &mut PgConnection,
    actor: &Actor,
    id: i32,
    from: Option<i32>,
    to: Option<i32>,
) -> Result<(), AppError> {
    let ids: Vec<i32> = [from, to].into_iter().flatten().collect();
    let opts: Vec<(i32, String)> = sqlx::query_as("SELECT id, label FROM setting_options WHERE id = ANY($1)")
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let label = |s: Option<i32>| match s {
        None => "(chưa có)".to_owned(),
        Some(s) => opts
            .iter()
            .find(|(i, _)| *i == s)
            .map_or_else(|| format!("#{s}"), |(_, l)| l.clone()),
    };
    let (fl, tl) = (label(from), label(to));
    let details = json!({
        "description": format!("Đổi giai đoạn: {fl} → {tl}"),
        "from_stage_id": from, "to_stage_id": to, "from_label": fl, "to_label": tl,
    });
    sqlx::query("INSERT INTO activities (contact_id, action, details, metadata, created_by) VALUES ($1, 'stage_change', $2::text::jsonb, '{}'::jsonb, $3)")
        .bind(id)
        .bind(details.to_string())
        .bind(actor.user_id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Trash {
    phone: String,
    full_name: Option<String>,
    deleted_at: Option<NaiveTimestamp>,
    deleted_by_id: Option<i32>,
    assigned_to: Option<i32>,
    created_by_id: Option<i32>,
    expired: bool,
}

async fn load_any(conn: &mut PgConnection, id: i32) -> Result<Option<Trash>, AppError> {
    sqlx::query_as(
        "SELECT phone, full_name, deleted_at, deleted_by_id, assigned_to, created_by_id,
           COALESCE((now() AT TIME ZONE 'UTC') - deleted_at > make_interval(mins => $2), false) AS expired
         FROM contacts WHERE id = $1",
    )
    .bind(id)
    .bind(RESTORE_WINDOW_MINUTES)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

/// `DELETE /contacts/:id`: xoá mềm (bảng lớn, nhiều khoá ngoại, hoạt động giữ liên kết). Khách đã xoá hoặc ngoài phạm
/// vi `contacts.delete` là 404. Ghi nhật ký kiểm toán cùng giao dịch.
pub async fn remove(db_: &TenantDb, scopes: &Scopes, actor: &Actor, id: i32) -> Result<Done, AppError> {
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;
    let existing = load_any(conn, id).await?.filter(|t| t.deleted_at.is_none());
    let Some(existing) = existing else {
        return Err(not_found(format!("Không tìm thấy contact ID {id}")));
    };
    assert_in_scope(scopes.delete.as_ref(), &[existing.assigned_to, existing.created_by_id])?;
    let done = sqlx::query(
        "UPDATE contacts SET deleted_at = (now() AT TIME ZONE 'UTC'), deleted_by_id = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(actor.user_id)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    if done.rows_affected() == 0 {
        return Err(not_found(format!("Không tìm thấy contact ID {id}")));
    }
    let snap = contact_event(conn, id).await?.snapshot();
    publish(conn, "contact.deleted", &json!({ "contact": snap }), id, actor).await?;
    audit(
        conn,
        actor,
        "contact.delete",
        id,
        &json!({ "phone": existing.phone, "full_name": existing.full_name }),
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(Done {
        success: true,
        message: "Đã xoá contact thành công",
    })
}

/// `POST /contacts/:id/restore` (nút Hoàn tác): người đã xoá hoặc Quản trị, trong 10 phút (quá hạn ⇒ 410), vẫn trong
/// phạm vi `contacts.delete`. SĐT trùng khách đang có của cùng người phụ trách ⇒ 409.
pub async fn restore(db_: &TenantDb, scopes: &Scopes, actor: &Actor, id: i32) -> Result<Done, AppError> {
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;
    let existing = load_any(conn, id).await?.filter(|t| t.deleted_at.is_some());
    let Some(existing) = existing else {
        return Err(not_found(format!("Không có khách ID {id} đang chờ khôi phục")));
    };
    if existing.deleted_by_id != Some(actor.user_id) && !actor.is_admin {
        return Err(forbidden("Chỉ người đã xoá hoặc Quản trị mới khôi phục được khách này"));
    }
    if existing.expired {
        return Err(http(HttpError::nest(
            410,
            Some(Message::One(
                "Đã quá thời gian hoàn tác — khách này không khôi phục được nữa".to_owned(),
            )),
        )));
    }
    assert_in_scope(scopes.delete.as_ref(), &[existing.assigned_to, existing.created_by_id])?;
    if !existing.phone.is_empty() && duplicate_count(conn, &existing.phone, existing.assigned_to, None).await? > 0 {
        return Err(http(HttpError::conflict(format!(
            "SĐT {} đã có ở một khách khác của người phụ trách — không khôi phục được",
            mask_phone(Some(&existing.phone)).unwrap_or_default()
        ))));
    }
    sqlx::query("UPDATE contacts SET deleted_at = NULL, deleted_by_id = NULL, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let snap = contact_event(conn, id).await?.snapshot();
    publish(conn, "contact.restored", &json!({ "contact": snap }), id, actor).await?;
    audit(
        conn,
        actor,
        "contact.restore",
        id,
        &json!({ "phone": existing.phone, "full_name": existing.full_name }),
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(Done {
        success: true,
        message: "Đã khôi phục khách hàng",
    })
}
