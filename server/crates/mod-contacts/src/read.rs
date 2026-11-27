//! Đọc một khách: chi tiết (`GET /contacts/:id`), tra trùng khi tạo (`GET /contacts/search`), nhân sự trong phạm vi
//! (`GET /contacts/assignable-users`).

use serde::Serialize;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::types::{JsonValue, NaiveTimestamp, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;
use trinity_rbac::OwnerIds;

use crate::filter::push_folded_ids;
use crate::list::derive_stage;
use crate::{MIN_MASKED_PHONE_SEARCH_DIGITS, Scopes, assert_in_scope, db, http};

/// Cột chi tiết (`CONTACT_DETAIL_SELECT`) cùng các quan hệ dựng sẵn thành JSON. `project_id`, `deleted_at` chỉ để dựng
/// ảnh chụp sự kiện, không đưa vào response.
pub(crate) const DETAIL_SELECT: &str = "SELECT c.id, c.code, c.phone, c.phone_2, c.zalo_account, c.full_name, c.avatar_url, c.source_id,
  c.source_locked, c.stage_id, c.contact_status_id, c.reminder_at, c.reminder_notes, c.birthday, c.job_title, c.assigned_to,
  c.team_id, c.created_by_id, c.gender, c.current_address, c.company_name, c.email, c.custom_fields, c.created_at, c.updated_at,
  c.lead_score, c.lead_label, c.lead_score_reasons, c.lead_scored_at, c.project_id, c.deleted_at,
  (SELECT json_build_object('id', o.id, 'value', o.value, 'label', o.label) FROM setting_options o WHERE o.id = c.source_id) AS source,
  (SELECT json_build_object('id', o.id, 'value', o.value, 'label', o.label) FROM setting_options o WHERE o.id = c.stage_id) AS stage,
  (SELECT json_build_object('id', o.id, 'value', o.value, 'label', o.label) FROM setting_options o WHERE o.id = c.contact_status_id) AS contact_status,
  CASE WHEN cr.id IS NULL THEN NULL ELSE json_build_object('id', cr.id, 'full_name', cr.full_name, 'email', cr.email,
    'user_roles', (SELECT COALESCE(json_agg(json_build_object('role', json_build_object('name', r.name)) ORDER BY ur.id), '[]'::json)
                   FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = cr.id)) END AS creator
FROM contacts c LEFT JOIN users cr ON cr.id = c.created_by_id";

/// Chi tiết một khách. Khoá theo thứ tự của `CONTACT_DETAIL_SELECT` rồi các quan hệ; trường quan hệ thiếu là `null`.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ContactDetail {
    pub id: i32,
    pub code: Option<String>,
    pub phone: Option<String>,
    pub phone_2: Option<String>,
    pub zalo_account: Option<String>,
    pub full_name: Option<String>,
    pub avatar_url: Option<String>,
    pub source_id: Option<i32>,
    pub source_locked: bool,
    pub stage_id: Option<i32>,
    pub contact_status_id: Option<i32>,
    pub reminder_at: Option<Timestamp>,
    pub reminder_notes: Option<String>,
    pub birthday: Option<Timestamp>,
    pub job_title: Option<String>,
    pub assigned_to: Option<i32>,
    pub team_id: Option<i32>,
    pub created_by_id: Option<i32>,
    pub gender: Option<String>,
    pub current_address: Option<String>,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub custom_fields: JsonValue,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub lead_score: Option<i32>,
    pub lead_label: Option<String>,
    pub lead_score_reasons: Option<JsonValue>,
    pub lead_scored_at: Option<Timestamp>,
    #[serde(skip)]
    pub project_id: Option<i32>,
    #[serde(skip)]
    pub deleted_at: Option<NaiveTimestamp>,
    pub source: Option<JsonValue>,
    /// `stage`: đối tượng giai đoạn ở response sửa khách, nhãn ở response chi tiết.
    #[sqlx(try_from = "Option<JsonValue>")]
    pub stage: StageField,
    pub contact_status: Option<JsonValue>,
    pub creator: Option<JsonValue>,
    /// Chỉ response chi tiết: đối tượng giai đoạn (`stage_option`) và nguồn nhãn (`stage_source`).
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_option: Option<Option<JsonValue>>,
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_source: Option<&'static str>,
}

/// Giá trị khoá `stage` của response.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum StageField {
    Object(Option<JsonValue>),
    Label(String),
}

impl From<Option<JsonValue>> for StageField {
    fn from(v: Option<JsonValue>) -> Self {
        Self::Object(v)
    }
}

/// Số điện thoại trong cột `phone` là `NOT NULL`; kiểu `Option` để che được cùng đường với `phone_2`.
impl ContactDetail {
    pub(crate) fn mask(&mut self, scopes: &Scopes) {
        let masker = scopes.masker();
        let owners = [self.assigned_to, self.created_by_id];
        self.phone = masker.mask(&owners, self.phone.as_deref());
        if let Some(p2) = self.phone_2.take() {
            self.phone_2 = masker.mask(&owners, Some(&p2));
        }
    }
}

/// Thương vụ gắn khách (chi tiết đầy đủ hơn danh sách).
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DealBrief {
    pub id: i32,
    pub title: String,
    pub status: String,
    pub created_by: i32,
    pub assigned_to: i32,
    pub created_at: Timestamp,
    pub creator: Option<JsonValue>,
    pub assignee: Option<JsonValue>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ActivityBrief {
    pub id: i32,
    pub action: String,
    pub details: Option<JsonValue>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
}

/// Kết quả `GET /contacts/:id`: chi tiết + thương vụ + 20 hoạt động mới nhất; `stage` là nhãn, `stage_option` là đối tượng.
#[derive(Debug, Serialize)]
pub struct ContactFull {
    #[serde(flatten)]
    pub contact: ContactDetail,
    pub assigned_user: Option<JsonValue>,
    pub team: Option<JsonValue>,
    pub deals: Vec<DealBrief>,
    pub activities: Vec<ActivityBrief>,
}

fn not_found_id(id: i32) -> AppError {
    http(HttpError::not_found(format!("Không tìm thấy contact ID {id}")))
}

/// `GET /contacts/:id`: khách đã xoá mềm là 404 với mọi vai; ngoài phạm vi `contacts.view` cũng 404. SĐT che theo
/// `contacts.phone_full`.
pub async fn find_by_id(conn: &mut PgConnection, scopes: &Scopes, id: i32) -> Result<ContactFull, AppError> {
    let mut contact: ContactDetail = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{DETAIL_SELECT} WHERE c.id = $1 AND c.deleted_at IS NULL"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| not_found_id(id))?;
    assert_in_scope(scopes.view.as_ref(), &[contact.assigned_to, contact.created_by_id])?;

    let assigned_user: Option<JsonValue> = sqlx::query_scalar(
        "SELECT json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) FROM users u WHERE u.id = $1",
    )
    .bind(contact.assigned_to)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let team: Option<JsonValue> =
        sqlx::query_scalar("SELECT json_build_object('id', t.id, 'name', t.name) FROM teams t WHERE t.id = $1")
            .bind(contact.team_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let deals: Vec<DealBrief> = sqlx::query_as(
        "SELECT d.id, d.title, d.status, d.created_by, d.assigned_to, d.created_at,
           json_build_object('id', cu.id, 'full_name', cu.full_name, 'email', cu.email) AS creator,
           json_build_object('id', au.id, 'full_name', au.full_name, 'email', au.email) AS assignee
         FROM deals d LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users au ON au.id = d.assigned_to
         WHERE d.contact_id = $1 ORDER BY d.created_at DESC",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let activities: Vec<ActivityBrief> = sqlx::query_as(
        "SELECT id, action, details, created_by, created_at FROM activities WHERE contact_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;

    contact.mask(scopes);
    let StageField::Object(stage) = std::mem::replace(&mut contact.stage, StageField::Object(None)) else {
        unreachable!("cột stage luôn đọc ra đối tượng")
    };
    let (label, source) = derive_stage(stage.as_ref());
    contact.stage = StageField::Label(label);
    contact.stage_option = Some(stage);
    contact.stage_source = Some(source);
    Ok(ContactFull {
        contact,
        assigned_user,
        team,
        deals,
        activities,
    })
}

/// Một dòng của `GET /contacts/search`: tối thiểu để cảnh báo trùng, không lộ chi tiết.
#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub id: i32,
    pub phone: Option<String>,
    pub full_name: Option<String>,
    pub source_id: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub data: Vec<SearchHit>,
}

/// `GET /contacts/search?q=`: tra theo SĐT (chỉ chữ số) hoặc tên (không phân biệt hoa/thường và dấu). CỐ Ý bỏ qua phạm
/// vi `contacts.view` (phải thấy khách đã có ở nhánh khác để khỏi tạo trùng) nhưng vẫn che SĐT theo `contacts.phone_full`;
/// ai không có `phone_full` toàn công ty phải gõ ≥ 9 chữ số mới tra được SĐT. Tối đa 20 kết quả.
pub async fn search(conn: &mut PgConnection, scopes: &Scopes, term: &str) -> Result<SearchResult, AppError> {
    let trimmed = trim_js(term);
    if trimmed.encode_utf16().count() < 2 {
        return Ok(SearchResult { data: Vec::new() });
    }
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    let digits_only = !digits.is_empty() && digits == trimmed;
    if digits_only
        && scopes.phone_full != Some(OwnerIds::All)
        && digits.chars().count() < MIN_MASKED_PHONE_SEARCH_DIGITS
    {
        return Ok(SearchResult { data: Vec::new() });
    }
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, phone, full_name, source_id, assigned_to, created_by_id FROM contacts WHERE deleted_at IS NULL AND ",
    );
    if digits_only {
        qb.push("phone LIKE ")
            .push_bind(format!("%{digits}%"))
            .push(" ESCAPE '\\'");
    } else {
        qb.push("(full_name ILIKE ")
            .push_bind(format!("%{}%", crate::filter::escape_like(trimmed)))
            .push(" ESCAPE '\\'");
        push_folded_ids(&mut qb, trimmed, "");
        qb.push(")");
    }
    qb.push(" ORDER BY id ASC LIMIT 20");
    let rows: Vec<(i32, String, Option<String>, Option<i32>, Option<i32>, Option<i32>)> =
        qb.build_query_as().fetch_all(conn).await.map_err(db)?;
    let masker = scopes.masker();
    Ok(SearchResult {
        data: rows
            .into_iter()
            .map(|(id, phone, full_name, source_id, assigned_to, created_by)| SearchHit {
                id,
                phone: masker.mask(&[assigned_to, created_by], Some(&phone)),
                full_name,
                source_id,
            })
            .collect(),
    })
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UserBrief {
    pub id: i32,
    pub full_name: Option<String>,
    pub email: String,
}

/// `GET /contacts/assignable-users`: nhân sự active trong phạm vi `contacts.view` của chính người gọi (dropdown lọc), sắp
/// theo tên, tối đa 200.
pub async fn assignable_users(conn: &mut PgConnection, scopes: &Scopes) -> Result<Vec<UserBrief>, AppError> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, full_name, email FROM users WHERE status = 'active' AND deleted_at IS NULL AND ",
    );
    match scopes.view_or_empty() {
        OwnerIds::All => {
            qb.push("TRUE");
        }
        OwnerIds::Ids(ids) => {
            qb.push("id = ANY(").push_bind(ids).push(")");
        }
    }
    qb.push(" ORDER BY full_name ASC LIMIT 200");
    qb.build_query_as().fetch_all(conn).await.map_err(db)
}
