//! Thương vụ (`DealsController`/`DealsService`): danh sách theo con trỏ, chi tiết, tạo, sửa, xoá, tìm người gán.
//!
//! Che SĐT khách gắn thương vụ theo TỪNG DÒNG ([`PhoneMasker`]), khoá theo chủ của khách (`assigned_to`/`created_by_id`) chứ
//! không theo chủ thương vụ, đúng như `maskDealPhone`: một SĐT không lộ qua thương vụ khi màn Khách hàng đã che nó. Ghi và
//! sự kiện outbox đi chung một giao dịch.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::TenantDb;
use trinity_db::outbox::{CreatedNotification, NewNotification, create_notification, publish_integration_event};
use trinity_db::types::{JsBigInt, JsonValue, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::{SQL_FOLD_FROM, SQL_FOLD_TO, escape_like, fold_contains, trim_js};
use trinity_rbac::{OwnerIds, PhoneMasker, push_scope};

use mod_contacts::snapshot::{DEAL_EVENT_COLS, DealEventRow};

use crate::nullable::some_nullable;
use crate::{Actor, Scopes, assert_in_scope, covers, db, http};

/// Trần số id tên khớp sau khi bỏ dấu (`FOLD_ID_CAP`).
const FOLD_ID_CAP: i64 = 5000;
const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;

fn internal(e: impl std::error::Error + Send + Sync + 'static) -> AppError {
    AppError::internal(e)
}

fn not_found() -> AppError {
    http(HttpError::not_found("Không tìm thấy thương vụ"))
}

/// Cột + quan hệ của `DEAL_SELECT` (người được giao, người tạo, khách).
const DEAL_SELECT: &str = "SELECT d.id, d.code, d.title, d.description, d.value, d.status, d.note, d.assigned_to, d.created_by,
       d.contact_id, d.created_at, d.updated_at,
       (SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) FROM users u WHERE u.id = d.assigned_to) AS assignee,
       (SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) FROM users u WHERE u.id = d.created_by) AS creator,
       c.id AS c_id, c.full_name AS c_full_name, c.phone AS c_phone, c.assigned_to AS c_assigned_to, c.created_by_id AS c_created_by_id
     FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id";

#[derive(Debug, sqlx::FromRow)]
struct DealRow {
    id: i32,
    code: Option<String>,
    title: String,
    description: Option<String>,
    value: Option<JsBigInt>,
    status: String,
    note: Option<String>,
    assigned_to: i32,
    created_by: i32,
    contact_id: Option<i32>,
    created_at: Timestamp,
    updated_at: Timestamp,
    assignee: Option<JsonValue>,
    creator: Option<JsonValue>,
    c_id: Option<i32>,
    c_full_name: Option<String>,
    c_phone: Option<String>,
    c_assigned_to: Option<i32>,
    c_created_by_id: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct DealContact {
    pub id: i32,
    pub full_name: Option<String>,
    pub phone: Option<String>,
    pub assigned_to: Option<i32>,
    pub created_by_id: Option<i32>,
}

/// Thương vụ như `DEAL_SELECT` với `value` là số (`Number(value)`), khoá theo đúng thứ tự bản TS.
#[derive(Debug, Serialize)]
pub struct Deal {
    pub id: i32,
    pub code: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub value: Option<JsBigInt>,
    pub status: String,
    pub note: Option<String>,
    pub assigned_to: i32,
    pub created_by: i32,
    pub contact_id: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub assignee: Option<JsonValue>,
    pub creator: Option<JsonValue>,
    pub contact: Option<DealContact>,
}

fn present(row: DealRow, masker: &PhoneMasker) -> Deal {
    let contact = row.c_id.map(|id| DealContact {
        id,
        full_name: row.c_full_name.clone(),
        phone: masker.mask(&[row.c_assigned_to, row.c_created_by_id], row.c_phone.as_deref()),
        assigned_to: row.c_assigned_to,
        created_by_id: row.c_created_by_id,
    });
    Deal {
        id: row.id,
        code: row.code,
        title: row.title,
        description: row.description,
        value: row.value,
        status: row.status,
        note: row.note,
        assigned_to: row.assigned_to,
        created_by: row.created_by,
        contact_id: row.contact_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        assignee: row.assignee,
        creator: row.creator,
        contact,
    }
}

async fn load(conn: &mut PgConnection, id: i32) -> Result<DealRow, AppError> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{DEAL_SELECT} WHERE d.id = $1")))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?
        .ok_or_else(not_found)
}

/// Query `GET /deals` (đã qua K15: `status` ∈ open|won|lost; `assigned_to`, `cursor` số nguyên; `limit` kẹp 1..50).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DealQuery {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assigned_to: Option<i32>,
    #[serde(default)]
    pub cursor: Option<i32>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Meta {
    pub next_cursor: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct DealList {
    pub data: Vec<Deal>,
    pub meta: Meta,
}

/// `GET /deals`: theo phạm vi `deals.view` (chủ = người được giao hoặc người tạo), mới nhất trước, con trỏ theo `id`.
pub async fn find_all(conn: &mut PgConnection, scopes: &Scopes, query: &DealQuery) -> Result<DealList, AppError> {
    let limit = query.limit.map_or(DEFAULT_LIMIT, |l| l.clamp(1, MAX_LIMIT));
    let owner = scopes.deals_view.clone().unwrap_or(OwnerIds::Ids(Vec::new()));

    // Con trỏ trỏ vào deal không tồn tại ⇒ trang rỗng (Prisma không tìm được điểm bắt đầu).
    let cursor_key: Option<(Timestamp, i32)> = match query.cursor {
        Some(c) => {
            let row: Option<(Timestamp,)> = sqlx::query_as("SELECT created_at FROM deals WHERE id = $1")
                .bind(c)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
            match row {
                Some((t,)) => Some((t, c)),
                None => {
                    return Ok(DealList {
                        data: Vec::new(),
                        meta: Meta { next_cursor: None },
                    });
                }
            }
        }
        None => None,
    };

    let mut qb = QueryBuilder::<Postgres>::new(format!("{DEAL_SELECT} WHERE "));
    push_scope(&mut qb, &owner, &["d.assigned_to", "d.created_by"]);
    if let Some(s) = query.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND d.status = ").push_bind(s.to_owned());
    }
    if let Some(search) = query.search.as_deref().filter(|s| !s.is_empty()) {
        let term = trim_js(search);
        qb.push(" AND (d.title ILIKE ")
            .push_bind(format!("%{}%", escape_like(term)))
            .push(" ESCAPE '\\' OR d.id IN (SELECT id FROM deals WHERE translate(lower(title), ")
            .push_bind(SQL_FOLD_FROM)
            .push(", ")
            .push_bind(SQL_FOLD_TO)
            .push(") LIKE ")
            .push_bind(fold_contains(term))
            .push(" ESCAPE '\\' ORDER BY id DESC LIMIT ")
            .push_bind(FOLD_ID_CAP)
            .push("))");
    }
    if let Some(a) = query.assigned_to {
        qb.push(" AND d.assigned_to = ").push_bind(a);
    }
    if let Some((t, id)) = cursor_key {
        qb.push(" AND (d.created_at, d.id) < (")
            .push_bind(t)
            .push(", ")
            .push_bind(id)
            .push(")");
    }
    qb.push(" ORDER BY d.created_at DESC, d.id DESC LIMIT ")
        .push_bind(limit + 1);
    let mut rows: Vec<DealRow> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;

    let mut next_cursor = None;
    if i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit {
        rows.pop();
        next_cursor = rows.last().map(|r| r.id);
    }
    let masker = scopes.masker();
    Ok(DealList {
        data: rows.into_iter().map(|r| present(r, &masker)).collect(),
        meta: Meta { next_cursor },
    })
}

/// `GET /deals/:id`: ngoài phạm vi `deals.view` ⇒ 404.
pub async fn find_one(conn: &mut PgConnection, scopes: &Scopes, id: i32) -> Result<Deal, AppError> {
    let row = load(conn, id).await?;
    assert_in_scope(
        scopes.deals_view.as_ref(),
        &[Some(row.assigned_to), Some(row.created_by)],
    )?;
    Ok(present(row, &scopes.masker()))
}

/// Body `POST /deals` (đã qua K15: tên 1..255, mô tả ≤1000, giá trị nguyên ≥0, ghi chú ≤2000, `status` ∈ open|won|lost).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateDeal {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub value: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    pub assigned_to: i32,
    #[serde(default)]
    pub contact_id: Option<i32>,
}

/// Kết quả tạo: thương vụ cho response, thông báo "được giao" để tầng route đẩy socket sau commit.
#[derive(Debug)]
pub struct Created {
    pub deal: Deal,
    pub notifications: Vec<CreatedNotification>,
}

/// `POST /deals`: người được giao phải active và nằm trong phạm vi `deals.manage` của người tạo; `contact_id` (nếu có)
/// phải nằm trong phạm vi `contacts.view` (chặn đọc ké PII qua `GET /deals/:id`). Deal tạo thẳng ở `won`/`lost` cũng bắn
/// `deal.won`/`deal.lost`.
pub async fn create(db_: &TenantDb, scopes: &Scopes, actor: &Actor, dto: &CreateDeal) -> Result<Created, AppError> {
    if !covers(scopes.deals_manage.as_ref(), dto.assigned_to) {
        return Err(http(HttpError::forbidden("Không có quyền tạo thương vụ cho người này")));
    }
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;
    let active: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1 AND status = 'active'")
        .bind(dto.assigned_to)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if active.is_none() {
        return Err(http(HttpError::bad_request(
            "Không tìm thấy nhân viên với ID này hoặc tài khoản không hoạt động",
        )));
    }
    if let Some(cid) = dto.contact_id {
        let owners: Option<(Option<i32>, Option<i32>)> =
            sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1")
                .bind(cid)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        let Some((a, c)) = owners else {
            return Err(http(HttpError::bad_request("Không tìm thấy khách hàng với ID này")));
        };
        assert_in_scope(scopes.contacts_view.as_ref(), &[a, c])?;
    }

    let status = dto.status.as_deref().unwrap_or("open");
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO deals (title, description, value, status, won_at, note, assigned_to, created_by, contact_id, updated_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'won' THEN now() ELSE NULL END, $5, $6, $7, $8, now()) RETURNING id",
    )
    .bind(&dto.title)
    .bind(&dto.description)
    .bind(dto.value)
    .bind(status)
    .bind(&dto.note)
    .bind(dto.assigned_to)
    .bind(actor.user_id)
    .bind(dto.contact_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let snap = snapshot(conn, id).await?;
    publish_integration_event(conn, "deal.created", &json!({ "deal": snap }), id, Some(actor.user_id))
        .await
        .map_err(internal)?;
    if status == "won" || status == "lost" {
        publish_integration_event(
            conn,
            &format!("deal.{status}"),
            &json!({ "deal": snap }),
            id,
            Some(actor.user_id),
        )
        .await
        .map_err(internal)?;
    }
    let row = load(conn, id).await?;
    let by = actor
        .email
        .clone()
        .unwrap_or_else(|| format!("Admin #{}", actor.user_id));
    let item = NewNotification {
        recipient_id: dto.assigned_to,
        event_type: "deal.assigned".to_owned(),
        title: "Bạn được giao thương vụ mới".to_owned(),
        body: format!("\"{}\" — giao bởi {by}", row.title),
        action_url: Some(
            row.contact_id
                .map_or_else(|| "/contacts".to_owned(), |c| format!("/contacts/{c}")),
        ),
    };
    // Thông báo KHÔNG được làm hỏng việc tạo: chạy trong SAVEPOINT, lỗi thì rollback to savepoint, ghi log và không có thông báo.
    let notifications = notify_in_savepoint(&mut tx, &item).await;
    tx.commit().await.map_err(internal)?;
    Ok(Created {
        deal: present(row, &scopes.masker()),
        notifications,
    })
}

async fn notify_in_savepoint(tx: &mut trinity_db::TenantTx, item: &NewNotification) -> Vec<CreatedNotification> {
    if sqlx::query("SAVEPOINT deal_notify").execute(&mut **tx).await.is_err() {
        return Vec::new();
    }
    match create_notification(tx, std::slice::from_ref(item)).await {
        Ok(created) => {
            let _ = sqlx::query("RELEASE SAVEPOINT deal_notify").execute(&mut **tx).await;
            created
        }
        Err(e) => {
            tracing::warn!(
                "Gửi thông báo giao thương vụ cho người dùng {} lỗi: {e}",
                item.recipient_id
            );
            let _ = sqlx::query("ROLLBACK TO SAVEPOINT deal_notify")
                .execute(&mut **tx)
                .await;
            let _ = sqlx::query("RELEASE SAVEPOINT deal_notify").execute(&mut **tx).await;
            Vec::new()
        }
    }
}

async fn snapshot(conn: &mut PgConnection, id: i32) -> Result<Value, AppError> {
    let row: DealEventRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {DEAL_EVENT_COLS} FROM deals WHERE id = $1"
    )))
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    Ok(row.snapshot())
}

/// Body `PATCH /deals/:id`. `description`, `value`, `note` nhận `null` (xoá giá trị); `title`, `status` chỉ nhận giá trị.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateDeal {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub value: Option<Option<i64>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub note: Option<Option<String>>,
}

/// `PATCH /deals/:id`: ngoài phạm vi `deals.manage` ⇒ 404. Sang `won` (từ trạng thái khác) ghi ngày thắng, rời `won` xoá;
/// lưu lại `won` không đổi mốc cũ. Đổi `status` ⇒ `deal.stage_changed` (+ `deal.won`/`deal.lost`) cùng giao dịch.
pub async fn update(
    db_: &TenantDb,
    scopes: &Scopes,
    actor: &Actor,
    id: i32,
    dto: &UpdateDeal,
) -> Result<Deal, AppError> {
    let mut tx = db_.begin().await.map_err(internal)?;
    let conn: &mut PgConnection = &mut tx;
    let current: Option<(i32, i32, String)> =
        sqlx::query_as("SELECT created_by, assigned_to, status FROM deals WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((created_by, assigned_to, prev_status)) = current else {
        return Err(not_found());
    };
    assert_in_scope(scopes.deals_manage.as_ref(), &[Some(assigned_to), Some(created_by)])?;

    let mut qb = QueryBuilder::<Postgres>::new("UPDATE deals SET updated_at = now()");
    if let Some(t) = &dto.title {
        qb.push(", title = ").push_bind(t.clone());
    }
    if let Some(d) = &dto.description {
        qb.push(", description = ").push_bind(d.clone());
    }
    if let Some(v) = dto.value {
        qb.push(", value = ").push_bind(v);
    }
    if let Some(s) = &dto.status {
        qb.push(", status = ").push_bind(s.clone());
        if s == "won" && prev_status != "won" {
            qb.push(", won_at = now()");
        } else if s != "won" {
            qb.push(", won_at = NULL");
        }
    }
    if let Some(n) = &dto.note {
        qb.push(", note = ").push_bind(n.clone());
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.build().execute(&mut *conn).await.map_err(db)?;

    if let Some(s) = dto.status.as_deref().filter(|s| *s != prev_status) {
        let snap = snapshot(conn, id).await?;
        publish_integration_event(
            conn,
            "deal.stage_changed",
            &json!({ "deal": snap, "from_status": prev_status, "to_status": s }),
            id,
            Some(actor.user_id),
        )
        .await
        .map_err(internal)?;
        if s == "won" || s == "lost" {
            publish_integration_event(
                conn,
                &format!("deal.{s}"),
                &json!({ "deal": snap }),
                id,
                Some(actor.user_id),
            )
            .await
            .map_err(internal)?;
        }
    }
    let row = load(conn, id).await?;
    tx.commit().await.map_err(internal)?;
    Ok(present(row, &scopes.masker()))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Removed {
    pub success: bool,
}

/// `DELETE /deals/:id`: ngoài phạm vi `deals.delete` ⇒ 404.
pub async fn remove(conn: &mut PgConnection, scopes: &Scopes, id: i32) -> Result<Removed, AppError> {
    let row: Option<(i32, i32)> = sqlx::query_as("SELECT assigned_to, created_by FROM deals WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some((assigned_to, created_by)) = row else {
        return Err(not_found());
    };
    assert_in_scope(scopes.deals_delete.as_ref(), &[Some(assigned_to), Some(created_by)])?;
    sqlx::query("DELETE FROM deals WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(Removed { success: true })
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Sale {
    pub id: i32,
    pub full_name: Option<String>,
    pub email: String,
}

/// `GET /deals/search-sales`: nhân sự active trong phạm vi `deals.manage` khớp tên/email (không phân biệt hoa thường),
/// tối đa 10; từ khoá ngắn hơn 2 ký tự ⇒ rỗng.
pub async fn search_sales(conn: &mut PgConnection, scopes: &Scopes, q: Option<&str>) -> Result<Vec<Sale>, AppError> {
    let Some(term) = q.map(trim_js).filter(|t| t.encode_utf16().count() >= 2) else {
        return Ok(Vec::new());
    };
    let owner = match scopes.deals_manage.clone() {
        Some(OwnerIds::Ids(ids)) if ids.is_empty() => return Ok(Vec::new()),
        None => return Ok(Vec::new()),
        Some(o) => o,
    };
    let like = format!("%{}%", escape_like(term));
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, full_name, email FROM users WHERE status = 'active' AND (full_name ILIKE ",
    );
    qb.push_bind(like.clone())
        .push(" ESCAPE '\\' OR email ILIKE ")
        .push_bind(like)
        .push(" ESCAPE '\\')");
    if let OwnerIds::Ids(ids) = owner {
        qb.push(" AND id = ANY(").push_bind(ids).push(")");
    }
    qb.push(" ORDER BY id LIMIT 10");
    qb.build_query_as().fetch_all(conn).await.map_err(db)
}
