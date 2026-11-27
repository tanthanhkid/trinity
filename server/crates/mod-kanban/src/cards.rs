//! Thẻ (M16): 9 endpoint `/api/v1/kanban/cards` (danh sách, chi tiết, tạo, sửa, chuyển, xoá, khôi phục; lịch sử và bình
//! luận ở [`crate::activities`]). Bản TS: `cards/kanban-cards.service.ts`, `kanban-card-move.service.ts`,
//! `kanban-card-assignee.helper.ts`, `kanban-card-query.helper.ts`, `kanban-card.mapper.ts`, `common/kanban-rbac.helper.ts`,
//! `common/kanban-contact.helper.ts`.
//!
//! Quyền xem thẻ = board hiển thị với người gọi VÀ thẻ trong phạm vi `kanban.view` (người tạo hoặc người phụ trách thuộc tập
//! chủ sở hữu); ngoài phạm vi luôn là 404 (không 403, không lộ thẻ có tồn tại). Mã thẻ (`CV…`) do trigger của DB sinh.
//!
//! Chưa làm (module khác): đồng bộ thẻ `@` trong mô tả với "Được nhắc tới ở" của bản ghi tuỳ biến (`RecordLinksService`,
//! thuộc M17/M18) — tầng route gọi sau [`create`]/[`update`] khi M18 có trên main.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{KanbanBoard, KanbanCard, KanbanColumn, KanbanFieldDef};
use trinity_db::types::{JsNumber, JsonValue, PgList, Timestamp};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_rbac::{OwnerIds, PhoneMasker, push_scope};

use crate::activities::log_activity;
use crate::attributes;
use crate::boards::is_visible;
use crate::nullable::some_nullable;
use crate::position::{append, between, renormalized};
use crate::{
    Actor, BOARD_COLS, CARD_ASSIGNEES_MAX, CARD_COLS, CARDS_DEFAULT_LIMIT, CARDS_MAX_LIMIT, RESTORE_WINDOW_MINUTES,
    bad_request, board_not_found, db, forbidden, not_found,
};

const SELECT: &str = "SELECT c.id, c.code, c.board_id, c.column_id, c.position, c.title, c.description, c.contact_id, c.assignee_id, \
  c.created_by, c.due_at, c.priority, c.labels, c.attributes, c.completed_at, c.due_completed_at, c.created_at, c.updated_at, \
  c.deleted_at, c.deleted_by,
  COALESCE((SELECT array_agg(a.user_id ORDER BY a.id) FROM kanban_card_assignees a WHERE a.card_id = c.id), '{}'::int4[]) AS assignee_user_ids,
  (SELECT count(*) FROM kanban_checklist_items i WHERE i.card_id = c.id) AS checklist_total,
  (SELECT count(*) FROM kanban_checklist_items i WHERE i.card_id = c.id AND i.is_done) AS checklist_done,
  (SELECT count(*) FROM kanban_card_activities x WHERE x.card_id = c.id AND x.action = 'comment') AS comment_count,
  (SELECT count(*) FROM kanban_card_attachments t WHERE t.card_id = c.id) AS attachment_count
FROM kanban_cards c";

#[derive(sqlx::FromRow)]
struct Row {
    #[sqlx(flatten)]
    card: KanbanCard,
    assignee_user_ids: Vec<i32>,
    checklist_total: i64,
    checklist_done: i64,
    comment_count: i64,
    attachment_count: i64,
}

/// Khách hiển thị trên thẻ; `masked` khi SĐT bị che theo `contacts.phone_full`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContactDisplay {
    pub id: i32,
    pub full_name: Option<String>,
    pub phone: String,
    pub masked: bool,
}

/// Thẻ trả về (khoá theo `toKanbanCardDto`). `contact_id` thành `null` khi người gọi không được xem khách đó: "không hiện gì"
/// nghĩa là không lộ cả con số id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardDto {
    pub id: i32,
    pub code: Option<String>,
    pub board_id: i32,
    pub column_id: i32,
    pub position: JsNumber,
    pub title: String,
    pub description: Option<String>,
    pub contact_id: Option<i32>,
    pub assignee_id: Option<i32>,
    pub created_by: i32,
    pub due_at: Option<Timestamp>,
    pub due_completed_at: Option<Timestamp>,
    pub priority: Option<String>,
    pub labels: PgList<String>,
    pub attributes: JsonValue,
    pub completed_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub contact: Option<ContactDisplay>,
    pub is_overdue: bool,
    pub assignee_ids: Vec<i32>,
    pub checklist_total: i64,
    pub checklist_done: i64,
    pub comment_count: i64,
    pub attachment_count: i64,
}

fn to_dto(row: Row, contact: Option<ContactDisplay>) -> CardDto {
    let Row {
        card: c,
        assignee_user_ids,
        checklist_total,
        checklist_done,
        comment_count,
        attachment_count,
    } = row;
    // Quá hạn: có hạn, chưa đánh dấu hoàn thành hạn, chưa xong cột "hoàn thành", và hạn đã qua.
    let is_overdue =
        c.due_at.is_some_and(|d| d.0 < Utc::now()) && c.due_completed_at.is_none() && c.completed_at.is_none();
    let mut ids: Vec<i32> = c.assignee_id.into_iter().collect();
    for u in assignee_user_ids {
        if !ids.contains(&u) {
            ids.push(u);
        }
    }
    CardDto {
        contact_id: contact.as_ref().and(c.contact_id),
        id: c.id,
        code: c.code,
        board_id: c.board_id,
        column_id: c.column_id,
        position: c.position,
        title: c.title,
        description: c.description,
        assignee_id: c.assignee_id,
        created_by: c.created_by,
        due_at: c.due_at,
        due_completed_at: c.due_completed_at,
        priority: c.priority,
        labels: c.labels,
        attributes: c.attributes,
        completed_at: c.completed_at,
        created_at: c.created_at,
        updated_at: c.updated_at,
        contact,
        is_overdue,
        assignee_ids: ids,
        checklist_total,
        checklist_done,
        comment_count,
        attachment_count,
    }
}

// ───────────────────────────── phạm vi và khách ─────────────────────────────

fn card_in_scope(actor: &Actor, created_by: i32, assignee: Option<i32>, assignees: &[i32]) -> bool {
    match &actor.card_owner {
        Some(OwnerIds::All) => true,
        Some(OwnerIds::Ids(ids)) => {
            ids.contains(&created_by)
                || assignee.is_some_and(|a| ids.contains(&a))
                || assignees.iter().any(|a| ids.contains(a))
        }
        None => false,
    }
}

/// Thẻ (chưa xoá) cùng người phụ trách, sau khi kiểm board hiển thị và phạm vi thẻ: 404 `Không tìm thấy card ID …`.
pub struct Scoped {
    pub card: KanbanCard,
    pub board: KanbanBoard,
    pub assignee_ids: Vec<i32>,
}

async fn assignees_of(conn: &mut PgConnection, card_id: i32) -> Result<Vec<i32>, AppError> {
    sqlx::query_scalar("SELECT user_id FROM kanban_card_assignees WHERE card_id = $1 ORDER BY id")
        .bind(card_id)
        .fetch_all(conn)
        .await
        .map_err(db)
}

async fn board_of(conn: &mut PgConnection, id: i32) -> Result<Option<KanbanBoard>, AppError> {
    sqlx::query_as::<_, KanbanBoard>(AssertSqlSafe(format!(
        "SELECT {BOARD_COLS} FROM kanban_boards WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

fn card_not_found(id: i32) -> AppError {
    not_found(format!("Không tìm thấy card ID {id}"))
}

/// `loadScopedCardOrNotFound`: mọi endpoint con (checklist, đính kèm, lịch sử, bình luận) gọi lại cổng này.
pub async fn load_scoped(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<Scoped, AppError> {
    let card = sqlx::query_as::<_, KanbanCard>(AssertSqlSafe(format!(
        "SELECT {CARD_COLS} FROM kanban_cards c WHERE c.id = $1 AND c.deleted_at IS NULL"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| card_not_found(id))?;
    let board = board_of(conn, card.board_id).await?.ok_or_else(|| card_not_found(id))?;
    if !is_visible(&actor.access, &board) {
        return Err(card_not_found(id));
    }
    let assignee_ids = assignees_of(conn, id).await?;
    if !card_in_scope(actor, card.created_by, card.assignee_id, &assignee_ids) {
        return Err(card_not_found(id));
    }
    Ok(Scoped {
        card,
        board,
        assignee_ids,
    })
}

/// Khách gắn thẻ: người gọi không có `contacts.view` ⇒ mọi khách ẩn; khách ngoài phạm vi `contacts.view` ẩn; SĐT che theo
/// `contacts.phone_full`. Khách không tồn tại/đã xoá không có khoá trong kết quả.
async fn contact_displays(
    conn: &mut PgConnection,
    actor: &Actor,
    ids: &[i32],
) -> Result<HashMap<i32, Option<ContactDisplay>>, AppError> {
    let mut uniq: Vec<i32> = ids.to_vec();
    uniq.sort_unstable();
    uniq.dedup();
    let mut out = HashMap::new();
    if uniq.is_empty() {
        return Ok(out);
    }
    if !actor.can_view_contacts {
        return Ok(uniq.into_iter().map(|i| (i, None)).collect());
    }
    let rows: Vec<(i32, Option<String>, String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT id, full_name, phone, assigned_to, created_by_id FROM contacts WHERE id = ANY($1) AND deleted_at IS NULL",
    )
    .bind(&uniq)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    let masker = PhoneMasker::new(actor.contact_phone_full.clone());
    for (id, full_name, phone, assigned, created_by) in rows {
        let owners = [assigned, created_by];
        let visible = actor.contact_view.as_ref().is_some_and(|o| o.contains_any(&owners));
        if !visible {
            out.insert(id, None);
            continue;
        }
        let shown = masker.mask(&owners, Some(&phone)).unwrap_or_default();
        out.insert(
            id,
            Some(ContactDisplay {
                id,
                full_name,
                masked: shown != phone,
                phone: shown,
            }),
        );
    }
    Ok(out)
}

async fn assert_contact_linkable(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<(), AppError> {
    let row: Option<(Option<i32>, Option<i32>, bool)> =
        sqlx::query_as("SELECT assigned_to, created_by_id, deleted_at IS NOT NULL FROM contacts WHERE id = $1")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    match row {
        Some((a, c, false)) if actor.contact_view.as_ref().is_some_and(|o| o.contains_any(&[a, c])) => Ok(()),
        _ => Err(not_found(format!("Không tìm thấy khách hàng ID {id}"))),
    }
}

fn assert_contact_mutable(actor: &Actor) -> Result<(), AppError> {
    if actor.can_view_contacts {
        Ok(())
    } else {
        Err(forbidden("Bạn không có quyền gắn/gỡ khách hàng trên card"))
    }
}

async fn attach_contacts(conn: &mut PgConnection, actor: &Actor, rows: Vec<Row>) -> Result<Vec<CardDto>, AppError> {
    let ids: Vec<i32> = rows.iter().filter_map(|r| r.card.contact_id).collect();
    let mut map = contact_displays(conn, actor, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let contact = r.card.contact_id.and_then(|id| map.remove(&id)).flatten();
            to_dto(r, contact)
        })
        .collect())
}

async fn fetch_row(conn: &mut PgConnection, id: i32) -> Result<Row, AppError> {
    sqlx::query_as::<_, Row>(AssertSqlSafe(format!("{SELECT} WHERE c.id = $1")))
        .bind(id)
        .fetch_one(conn)
        .await
        .map_err(db)
}

// ───────────────────────────── người phụ trách ─────────────────────────────

/// `assignee_ids` (mảng, THAY THẾ toàn bộ) thắng `assignee_id` khi gửi cả hai. `None` = không đụng; mảng rỗng = gỡ hết.
fn resolve_assignee_ids(ids: Option<&Vec<i32>>, single: Option<Option<i32>>) -> Result<Option<Vec<i32>>, AppError> {
    if let Some(list) = ids {
        let mut uniq: Vec<i32> = Vec::new();
        for i in list {
            if !uniq.contains(i) {
                uniq.push(*i);
            }
        }
        if uniq.len() > CARD_ASSIGNEES_MAX {
            return Err(bad_request(format!("Tối đa {CARD_ASSIGNEES_MAX} người phụ trách/card")));
        }
        return Ok(Some(uniq));
    }
    Ok(single.map(|s| s.into_iter().collect()))
}

/// Mọi id phải là user có thật, chưa xoá và đang active (`kanban_card_assignees.user_id` không có khoá ngoại).
async fn assert_assignable(conn: &mut PgConnection, ids: &[i32]) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    let found: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE id = ANY($1) AND deleted_at IS NULL AND status = 'active'",
    )
    .bind(ids)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    let mut uniq = ids.to_vec();
    uniq.sort_unstable();
    uniq.dedup();
    if usize::try_from(found).ok() != Some(uniq.len()) {
        return Err(bad_request(
            "Người phụ trách không tồn tại hoặc tài khoản không hoạt động",
        ));
    }
    Ok(())
}

async fn sync_assignees(conn: &mut PgConnection, card_id: i32, ids: &[i32]) -> Result<(), AppError> {
    sqlx::query("DELETE FROM kanban_card_assignees WHERE card_id = $1")
        .bind(card_id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    if !ids.is_empty() {
        sqlx::query(
            "INSERT INTO kanban_card_assignees (card_id, user_id) SELECT $1, u FROM unnest($2::int4[]) AS u ON CONFLICT DO NOTHING",
        )
        .bind(card_id)
        .bind(ids)
        .execute(conn)
        .await
        .map_err(db)?;
    }
    Ok(())
}

// ───────────────────────────── DTO ─────────────────────────────

/// Query `GET /cards` (đã qua K15: số nguyên ≥ 1, `limit` 1..100, `overdue` `true|false`, `search` đã cắt khoảng trắng).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListCards {
    #[serde(default)]
    pub board_id: Option<i32>,
    #[serde(default)]
    pub column_id: Option<i32>,
    #[serde(default)]
    pub contact_id: Option<i32>,
    #[serde(default)]
    pub assignee_id: Option<i32>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub overdue: Option<bool>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub cursor: Option<i32>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// Body `POST /cards` (K15: tiêu đề 1..500, mô tả ≤ 10.000, nhãn ≤ 20 phần tử ≤ 64, người phụ trách ≤ 20…).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateCard {
    pub column_id: i32,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub contact_id: Option<i32>,
    #[serde(default)]
    pub assignee_id: Option<i32>,
    #[serde(default)]
    pub assignee_ids: Option<Vec<i32>>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub attributes: Option<Value>,
}

/// Body `PATCH /cards/:id`. Trường nhận NULL: không gửi = giữ nguyên, `null` = xoá giá trị. `fields` là danh sách khoá có
/// mặt trong body theo đúng thứ tự gửi (vào hoạt động `updated`).
#[derive(Debug, Clone, Default)]
pub struct UpdateCard {
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub contact_id: Option<Option<i32>>,
    pub assignee_id: Option<Option<i32>>,
    pub assignee_ids: Option<Vec<i32>>,
    pub due_at: Option<Option<String>>,
    pub due_completed_at: Option<Option<String>>,
    pub priority: Option<Option<String>>,
    pub labels: Option<Option<Vec<String>>>,
    pub attributes: Option<Option<Value>>,
    pub fields: Vec<String>,
}

#[derive(Deserialize, Default)]
struct UpdateRaw {
    #[serde(default)]
    title: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    contact_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    assignee_id: Option<Option<i32>>,
    #[serde(default)]
    assignee_ids: Option<Vec<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    due_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    due_completed_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    priority: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    labels: Option<Option<Vec<String>>>,
    #[serde(default, deserialize_with = "some_nullable")]
    attributes: Option<Option<Value>>,
}

const UPDATE_KEYS: [&str; 10] = [
    "title",
    "description",
    "contact_id",
    "assignee_id",
    "assignee_ids",
    "due_at",
    "due_completed_at",
    "priority",
    "labels",
    "attributes",
];

impl<'de> Deserialize<'de> for UpdateCard {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(d)?;
        // Thứ tự khoá = thứ tự trong body (serde_json giữ thứ tự chèn); khoá lạ bị bỏ như `whitelist` của Nest.
        let fields = map
            .keys()
            .filter(|k| UPDATE_KEYS.contains(&k.as_str()))
            .cloned()
            .collect();
        let raw: UpdateRaw = serde_json::from_value(Value::Object(map)).map_err(serde::de::Error::custom)?;
        Ok(Self {
            title: raw.title,
            description: raw.description,
            contact_id: raw.contact_id,
            assignee_id: raw.assignee_id,
            assignee_ids: raw.assignee_ids,
            due_at: raw.due_at,
            due_completed_at: raw.due_completed_at,
            priority: raw.priority,
            labels: raw.labels,
            attributes: raw.attributes,
            fields,
        })
    }
}

/// Body `POST /cards/:id/move`.
#[derive(Debug, Clone, Deserialize)]
pub struct MoveCard {
    pub column_id: i32,
    #[serde(default)]
    pub before_card_id: Option<i32>,
    #[serde(default)]
    pub after_card_id: Option<i32>,
}

/// Ngày giờ ISO 8601 như `new Date(s)`: có múi giờ thì theo múi giờ, không có thì UTC; `YYYY-MM-DD` là 00:00 UTC.
fn parse_instant(label: &str, s: &str) -> Result<DateTime<Utc>, AppError> {
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Ok(d.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Ok(n.and_utc());
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|d| d.and_time(NaiveTime::MIN).and_utc())
        .map_err(|_| bad_request(format!("{label} phải là ngày ISO 8601 hợp lệ")))
}

// ───────────────────────────── đọc ─────────────────────────────

#[derive(Debug, Serialize)]
pub struct CardList {
    pub cards: Vec<CardDto>,
    pub next_cursor: Option<i32>,
    pub has_more: bool,
}

/// `GET /cards`: board hiển thị AND phạm vi thẻ AND bộ lọc (bộ lọc không bao giờ ghi đè điều kiện phạm vi). Theo cột thì
/// `position, id` tăng dần; xuyên board thì `id` giảm dần (mới nhất trước).
pub async fn list(conn: &mut PgConnection, actor: &Actor, q: &ListCards) -> Result<CardList, AppError> {
    let limit = q.limit.unwrap_or(CARDS_DEFAULT_LIMIT).clamp(1, CARDS_MAX_LIMIT);
    let mut qb = QueryBuilder::<Postgres>::new(SELECT);
    qb.push(" JOIN kanban_boards b ON b.id = c.board_id WHERE c.deleted_at IS NULL AND b.deleted_at IS NULL");
    if !actor.access.can_manage_boards {
        qb.push(" AND b.is_active AND (cardinality(b.visibility_role_ids) = 0 OR b.visibility_role_ids && ")
            .push_bind(actor.access.role_ids.clone())
            .push(")");
    }
    qb.push(" AND ");
    match &actor.card_owner {
        Some(OwnerIds::All) => {
            qb.push("TRUE");
        }
        Some(OwnerIds::Ids(ids)) if !ids.is_empty() => {
            qb.push("(");
            push_scope(&mut qb, &OwnerIds::Ids(ids.clone()), &["c.created_by", "c.assignee_id"]);
            qb.push(" OR EXISTS (SELECT 1 FROM kanban_card_assignees ca WHERE ca.card_id = c.id AND ca.user_id = ANY(")
                .push_bind(ids.clone())
                .push(")))");
        }
        _ => {
            qb.push("FALSE");
        }
    }
    for (col, v) in [
        ("board_id", q.board_id),
        ("column_id", q.column_id),
        ("contact_id", q.contact_id),
        ("assignee_id", q.assignee_id),
    ] {
        if let Some(v) = v {
            qb.push(format!(" AND c.{col} = ")).push_bind(v);
        }
    }
    if let Some(l) = &q.label {
        qb.push(" AND c.labels @> ARRAY[")
            .push_bind(l.clone())
            .push("]::text[]");
    }
    if let Some(s) = q.search.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND c.title ILIKE ").push_bind(format!("%{s}%"));
    }
    if q.overdue == Some(true) {
        qb.push(" AND c.due_at < now() AND c.completed_at IS NULL AND c.due_completed_at IS NULL");
    }
    let by_column = q.column_id.is_some();
    if let Some(cur) = q.cursor {
        // Con trỏ không còn tồn tại ⇒ không dòng nào khớp (như Prisma).
        if by_column {
            qb.push(format!(
                " AND ((c.position > (SELECT position FROM kanban_cards WHERE id = {cur})) OR (c.position = (SELECT position FROM kanban_cards WHERE id = {cur}) AND c.id > {cur}))"
            ));
        } else {
            qb.push(format!(
                " AND c.id < {cur} AND EXISTS (SELECT 1 FROM kanban_cards WHERE id = {cur})"
            ));
        }
    }
    qb.push(if by_column {
        " ORDER BY c.position ASC, c.id ASC"
    } else {
        " ORDER BY c.id DESC"
    });
    qb.push(" LIMIT ").push_bind(limit + 1);
    let mut rows: Vec<Row> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    let has_more = i64::try_from(rows.len()).unwrap_or(0) > limit;
    if has_more {
        rows.truncate(usize::try_from(limit).unwrap_or(30));
    }
    let next_cursor = if has_more { rows.last().map(|r| r.card.id) } else { None };
    Ok(CardList {
        cards: attach_contacts(conn, actor, rows).await?,
        next_cursor,
        has_more,
    })
}

/// `GET /cards/:id`.
pub async fn find_one(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<CardDto, AppError> {
    load_scoped(conn, actor, id).await?;
    let row = fetch_row(conn, id).await?;
    Ok(attach_contacts(conn, actor, vec![row]).await?.remove(0))
}

// ───────────────────────────── ghi ─────────────────────────────

async fn field_defs(conn: &mut PgConnection, board_id: i32) -> Result<Vec<KanbanFieldDef>, AppError> {
    sqlx::query_as::<_, KanbanFieldDef>(AssertSqlSafe(format!(
        "SELECT {} FROM kanban_field_defs WHERE board_id = $1 ORDER BY position ASC, id ASC",
        crate::FIELD_DEF_COLS
    )))
    .bind(board_id)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /cards`: cột phải tồn tại, chưa ẩn, board hiển thị với người gọi; khách gắn phải trong phạm vi `contacts.view`;
/// `attributes` kiểm theo trường của board; thẻ nối cuối cột; vào cột "hoàn thành" thì có `completed_at` ngay.
pub async fn create(conn: &mut PgConnection, actor: &Actor, input: &CreateCard) -> Result<CardDto, AppError> {
    let column = sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "SELECT {} FROM kanban_columns WHERE id = $1",
        crate::COLUMN_COLS
    )))
    .bind(input.column_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| bad_request("column_id không hợp lệ"))?;
    let board = board_of(conn, column.board_id).await?;
    match board {
        Some(b) if b.deleted_at.is_none() && is_visible(&actor.access, &b) => {}
        _ => return Err(board_not_found(column.board_id)),
    }
    if column.is_archived {
        return Err(bad_request("Cột đã ẩn — không thể tạo card mới vào đây"));
    }
    if let Some(c) = input.contact_id {
        assert_contact_linkable(conn, actor, c).await?;
    }
    let defs = field_defs(conn, column.board_id).await?;
    let attrs = attributes::validate(&defs, input.attributes.as_ref(), false)?;
    let assignees = resolve_assignee_ids(input.assignee_ids.as_ref(), input.assignee_id.map(Some))?.unwrap_or_default();
    assert_assignable(conn, &assignees).await?;
    let last: Option<f64> = sqlx::query_scalar(
        "SELECT position FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NULL ORDER BY position DESC LIMIT 1",
    )
    .bind(input.column_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let due = input
        .due_at
        .as_deref()
        .map(|d| parse_instant("due_at", d))
        .transpose()?;

    let mut tx = conn.begin().await.map_err(db)?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO kanban_cards (board_id, column_id, position, title, description, contact_id, assignee_id, created_by, due_at,
           priority, labels, attributes, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text::jsonb, CASE WHEN $13 THEN now() END, now()) RETURNING id",
    )
    .bind(column.board_id)
    .bind(input.column_id)
    .bind(append(last))
    .bind(&input.title)
    .bind(&input.description)
    .bind(input.contact_id)
    .bind(assignees.first().copied())
    .bind(actor.user_id)
    .bind(due)
    .bind(&input.priority)
    .bind(input.labels.clone().unwrap_or_default())
    .bind(Value::Object(attrs).to_string())
    .bind(column.is_done)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    sync_assignees(&mut tx, id, &assignees).await?;
    log_activity(
        &mut tx,
        id,
        actor.user_id,
        "created",
        &json!({ "title": input.title, "column_id": input.column_id }),
    )
    .await?;
    if let Some(c) = input.contact_id {
        log_activity(
            &mut tx,
            id,
            actor.user_id,
            "contact_linked",
            &json!({ "contact_id": c }),
        )
        .await?;
    }
    let row = fetch_row(&mut tx, id).await?;
    tx.commit().await.map_err(db)?;
    Ok(attach_contacts(conn, actor, vec![row]).await?.remove(0))
}

/// `PATCH /cards/:id`. Gắn/gỡ khách cần quyền `contacts.view`; người phụ trách thêm mới phải còn hoạt động (gửi lại người cũ
/// đã khoá không làm hỏng việc sửa); `attributes` trộn vào giá trị cũ. Ghi hoạt động `contact_linked|unlinked`, `assigned` và
/// `updated` (kèm danh sách khoá đã gửi) cùng giao dịch.
pub async fn update(conn: &mut PgConnection, actor: &Actor, id: i32, input: &UpdateCard) -> Result<CardDto, AppError> {
    let Scoped {
        card: existing,
        assignee_ids: existing_assignees,
        ..
    } = load_scoped(conn, actor, id).await?;
    match input.contact_id {
        Some(None) => assert_contact_mutable(actor)?,
        Some(Some(c)) => assert_contact_linkable(conn, actor, c).await?,
        None => {}
    }
    let attributes_patch = match &input.attributes {
        None => None,
        Some(raw) => {
            let defs = field_defs(conn, existing.board_id).await?;
            let validated = attributes::validate(&defs, raw.as_ref(), true)?;
            Some(attributes::merge(&existing.attributes.0, validated)?)
        }
    };
    let single = input.assignee_id;
    let assignees = resolve_assignee_ids(input.assignee_ids.as_ref(), single)?;
    let assignees_changed = assignees
        .as_ref()
        .is_some_and(|a| a.len() != existing_assignees.len() || a.iter().any(|i| !existing_assignees.contains(i)));
    if let Some(a) = &assignees {
        let added: Vec<i32> = a.iter().copied().filter(|i| !existing_assignees.contains(i)).collect();
        assert_assignable(conn, &added).await?;
    }
    let due = input
        .due_at
        .as_ref()
        .map(|v| v.as_deref().map(|d| parse_instant("due_at", d)).transpose())
        .transpose()?;
    let due_done = input
        .due_completed_at
        .as_ref()
        .map(|v| v.as_deref().map(|d| parse_instant("due_completed_at", d)).transpose())
        .transpose()?;

    let mut tx = conn.begin().await.map_err(db)?;
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE kanban_cards SET updated_at = now()");
    if let Some(v) = &input.title {
        qb.push(", title = ").push_bind(v.clone());
    }
    if let Some(v) = &input.description {
        qb.push(", description = ").push_bind(v.clone());
    }
    if let Some(v) = input.contact_id {
        qb.push(", contact_id = ").push_bind(v);
    }
    if let Some(a) = &assignees {
        qb.push(", assignee_id = ").push_bind(a.first().copied());
    }
    if let Some(v) = due {
        qb.push(", due_at = ").push_bind(v);
    }
    if let Some(v) = due_done {
        qb.push(", due_completed_at = ").push_bind(v);
    }
    if let Some(v) = &input.priority {
        qb.push(", priority = ").push_bind(v.clone());
    }
    if let Some(v) = &input.labels {
        qb.push(", labels = ").push_bind(v.clone().unwrap_or_default());
    }
    if let Some(m) = attributes_patch {
        qb.push(", attributes = ")
            .push_bind(Value::Object(m).to_string())
            .push("::text::jsonb");
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.build().execute(&mut *tx).await.map_err(db)?;
    if let Some(a) = &assignees {
        sync_assignees(&mut tx, id, a).await?;
    }
    if let Some(c) = input.contact_id
        && c != existing.contact_id
    {
        let action = if c.is_none() {
            "contact_unlinked"
        } else {
            "contact_linked"
        };
        log_activity(&mut tx, id, actor.user_id, action, &json!({ "contact_id": c })).await?;
    }
    if assignees_changed {
        log_activity(
            &mut tx,
            id,
            actor.user_id,
            "assigned",
            &json!({ "assignee_ids": assignees.clone().unwrap_or_default() }),
        )
        .await?;
    }
    if !input.fields.is_empty() {
        log_activity(
            &mut tx,
            id,
            actor.user_id,
            "updated",
            &json!({ "fields": input.fields }),
        )
        .await?;
    }
    let row = fetch_row(&mut tx, id).await?;
    tx.commit().await.map_err(db)?;
    Ok(attach_contacts(conn, actor, vec![row]).await?.remove(0))
}

/// Kết quả `POST /cards/:id/move`.
#[derive(Debug, Serialize)]
pub struct Moved {
    pub card: CardDto,
    pub wip_warning: Option<String>,
}

/// `POST /cards/:id/move`: chuyển cột và/hoặc đổi vị trí (chèn giữa `before`/`after` của cột đích; khoảng cách cạn thì sắp lại
/// cả cột). Vào cột "hoàn thành" đặt `completed_at`, ra khỏi thì xoá. Vượt giới hạn WIP chỉ cảnh báo, không chặn.
pub async fn move_card(conn: &mut PgConnection, actor: &Actor, id: i32, input: &MoveCard) -> Result<Moved, AppError> {
    let Scoped { card, .. } = load_scoped(conn, actor, id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    let col = sqlx::query_as::<_, KanbanColumn>(AssertSqlSafe(format!(
        "SELECT {} FROM kanban_columns WHERE id = $1 AND board_id = $2",
        crate::COLUMN_COLS
    )))
    .bind(input.column_id)
    .bind(card.board_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| bad_request("Cột đích không hợp lệ"))?;
    if col.is_archived {
        return Err(bad_request("Không thể chuyển card vào cột đã ẩn"));
    }
    async fn neighbour(
        tx: &mut PgConnection,
        id: Option<i32>,
        column: i32,
        name: &str,
    ) -> Result<Option<f64>, AppError> {
        let Some(id) = id else { return Ok(None) };
        sqlx::query_scalar("SELECT position FROM kanban_cards WHERE id = $1 AND column_id = $2 AND deleted_at IS NULL")
            .bind(id)
            .bind(column)
            .fetch_optional(tx)
            .await
            .map_err(db)?
            .map(Some)
            .ok_or_else(|| bad_request(format!("{name} không hợp lệ")))
    }
    let before = neighbour(&mut tx, input.before_card_id, input.column_id, "before_card_id").await?;
    let after = neighbour(&mut tx, input.after_card_id, input.column_id, "after_card_id").await?;
    let position = match between(before, after) {
        Some(p) => p,
        None => renormalize_and_retry(&mut tx, input).await?,
    };
    let was_done = card.completed_at.is_some();
    sqlx::query(
        "UPDATE kanban_cards SET column_id = $2, position = $3, updated_at = now(),
           completed_at = CASE WHEN $4 AND NOT $5 THEN now() WHEN NOT $4 AND $5 THEN NULL ELSE completed_at END WHERE id = $1",
    )
    .bind(id)
    .bind(input.column_id)
    .bind(position)
    .bind(col.is_done)
    .bind(was_done)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    log_activity(
        &mut tx,
        id,
        actor.user_id,
        "moved",
        &json!({ "from_column_id": card.column_id, "to_column_id": input.column_id }),
    )
    .await?;
    let mut wip_warning = None;
    if let Some(limit) = col.wip_limit {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NULL")
                .bind(input.column_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count > i64::from(limit) {
            wip_warning = Some(format!("Cột \"{}\" đang vượt giới hạn WIP ({count}/{limit})", col.name));
        }
    }
    let row = fetch_row(&mut tx, id).await?;
    tx.commit().await.map_err(db)?;
    let card = attach_contacts(conn, actor, vec![row]).await?.remove(0);
    Ok(Moved { card, wip_warning })
}

/// Khoảng cách giữa hai láng giềng đã cạn: sắp lại TOÀN BỘ cột đích rồi tính lại.
async fn renormalize_and_retry(tx: &mut PgConnection, input: &MoveCard) -> Result<f64, AppError> {
    let ids: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM kanban_cards WHERE column_id = $1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
    )
    .bind(input.column_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let positions = renormalized(ids.len());
    for (id, p) in ids.iter().zip(&positions) {
        sqlx::query("UPDATE kanban_cards SET position = $2 WHERE id = $1")
            .bind(id)
            .bind(p)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let (b, a) = (input.before_card_id, input.after_card_id);
    let mut refreshed: [Option<f64>; 2] = [None, None];
    for (slot, id) in [b, a].into_iter().enumerate() {
        if let Some(id) = id {
            refreshed[slot] = sqlx::query_scalar("SELECT position FROM kanban_cards WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        }
    }
    Ok(between(refreshed[0], refreshed[1])
        .unwrap_or_else(|| positions.last().copied().unwrap_or(0.0) + crate::position::POSITION_GAP))
}

/// Kết quả `DELETE /cards/:id`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Removed {
    pub deleted: bool,
}

/// Kết quả `POST /cards/:id/restore`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Restored {
    pub restored: bool,
}

/// `DELETE /cards/:id`: xoá mềm, chỉ người tạo hoặc Quản trị (quản lý không xoá được thẻ của cấp dưới).
pub async fn remove(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<Removed, AppError> {
    let Scoped { card, .. } = load_scoped(conn, actor, id).await?;
    if card.created_by != actor.user_id && !actor.is_admin {
        return Err(forbidden("Chỉ người tạo card hoặc Quản trị mới được xoá"));
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("UPDATE kanban_cards SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(actor.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    log_activity(&mut tx, id, actor.user_id, "deleted", &json!({})).await?;
    tx.commit().await.map_err(db)?;
    Ok(Removed { deleted: true })
}

/// `POST /cards/:id/restore` (nút Hoàn tác): người đã xoá hoặc Quản trị, trong 10 phút (quá hạn ⇒ 410), board còn hiển thị
/// và thẻ còn trong phạm vi của người khôi phục (ngoài phạm vi ⇒ 404).
pub async fn restore(conn: &mut PgConnection, actor: &Actor, id: i32) -> Result<Restored, AppError> {
    let nf = || not_found(format!("Không có card {id} đang chờ khôi phục"));
    let card = sqlx::query_as::<_, (i32, i32, Option<i32>, Option<i32>, bool)>(
        "SELECT board_id, created_by, assignee_id, deleted_by, now() - deleted_at > make_interval(mins => $2)
         FROM kanban_cards WHERE id = $1 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(RESTORE_WINDOW_MINUTES)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(nf)?;
    let (board_id, created_by, assignee, deleted_by, expired) = card;
    let board = board_of(conn, board_id).await?.ok_or_else(nf)?;
    if !is_visible(&actor.access, &board) {
        return Err(nf());
    }
    let assignees = assignees_of(conn, id).await?;
    if !card_in_scope(actor, created_by, assignee, &assignees) {
        return Err(nf());
    }
    if deleted_by != Some(actor.user_id) && !actor.is_admin {
        return Err(forbidden("Chỉ người đã xoá hoặc Quản trị mới khôi phục được card này"));
    }
    if expired {
        return Err(HttpError::nest(
            410,
            Some(Message::One(
                "Đã quá thời gian hoàn tác — card này không khôi phục được nữa".to_owned(),
            )),
        )
        .into());
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("UPDATE kanban_cards SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    log_activity(&mut tx, id, actor.user_id, "restored", &json!({})).await?;
    tx.commit().await.map_err(db)?;
    Ok(Restored { restored: true })
}
