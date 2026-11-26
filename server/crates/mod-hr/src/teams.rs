//! Team (M09): 9 endpoint `/api/v1/management/teams`. Bản TS: `services/crm/src/teams/teams.service.ts`.
//!
//! Người phụ trách team là NHÃN tổ chức (user đang hoạt động, role bất kỳ). Thành viên = `employees.team_id`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgConnection};
use trinity_db::pg_error::db_error;
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_kernel::vi::{Collation, compare, trim_js};

use crate::nullable::some_nullable;
use crate::{OK, Ok, db, len16};

const NOT_FOUND: &str = "Không tìm thấy team";
const NAME_TAKEN: &str = "Tên team đã tồn tại";
const NAME_EMPTY: &str = "Tên team không được rỗng";
const HEAD_INVALID: &str = "Người phụ trách không hợp lệ (không tồn tại hoặc đã bị khoá)";
const COLOR_MSG: &str = "Màu phải là mã hex hợp lệ (vd: #f59e0b)";

/// Một dòng `GET /teams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamRow {
    pub id: i32,
    pub name: String,
    pub department: Option<String>,
    pub description: Option<String>,
    pub team_lead_id: Option<i32>,
    pub team_lead_name: Option<String>,
    pub color: Option<String>,
    pub member_count: i64,
}

/// Một dòng `GET /teams/:id/members`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamMemberRow {
    pub user_id: i32,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub role: Option<String>,
}

/// Một dòng `GET /teams/for-filter`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamFilterRow {
    pub id: i32,
    pub name: String,
    pub team_lead_id: Option<i32>,
    pub department: Option<String>,
}

/// Một dòng `GET /teams/lead-filter`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamLeadFilterRow {
    pub team_lead_id: i32,
    pub name: String,
}

/// Body `POST /teams`. Chuỗi rỗng sau `trim` của `department`/`description` thành `null`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateTeam {
    pub name: String,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub team_lead_id: Option<i32>,
    #[serde(default)]
    pub color: Option<String>,
}

/// Body `PATCH /teams/:id`: trường vắng = giữ nguyên, `null` = xoá.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateTeam {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub department: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub team_lead_id: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub color: Option<Option<String>>,
}

/// Body `POST /teams/:id/members`.
#[derive(Debug, Clone, Deserialize)]
pub struct TeamMembers {
    pub user_ids: Vec<i32>,
}

/// Kết quả `POST /teams/:id/members`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Added {
    pub added: u64,
}

fn max_len(field: &str, v: &str, max: usize, out: &mut Vec<String>) {
    if len16(v) > max {
        out.push(format!("{field} must be shorter than or equal to {max} characters"));
    }
}

/// `#rgb` hoặc `#rrggbb`.
fn is_hex_color(v: &str) -> bool {
    let Some(h) = v.strip_prefix('#') else { return false };
    matches!(h.len(), 3 | 6) && h.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `normalizeColor`: rỗng hoặc không hợp lệ ⇒ `None`, hợp lệ ⇒ chữ thường.
fn normalize_color(color: Option<&str>) -> Option<String> {
    let v = trim_js(color?);
    if v.is_empty() || !is_hex_color(v) {
        None
    } else {
        Some(v.to_lowercase())
    }
}

fn clean(v: Option<&str>) -> Option<String> {
    v.map(trim_js).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn color_errors(c: &str, out: &mut Vec<String>) {
    // Thứ tự decorator từ dưới lên: Matches, MaxLength.
    if !is_hex_color(c) {
        out.push(COLOR_MSG.to_owned());
    }
    max_len("color", c, 20, out);
}

fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

impl CreateTeam {
    /// Luật của `CreateTeamDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        max_len("name", &self.name, 100, &mut e);
        if let Some(d) = &self.department {
            max_len("department", d, 100, &mut e);
        }
        if let Some(d) = &self.description {
            max_len("description", d, 500, &mut e);
        }
        if let Some(c) = &self.color {
            color_errors(c, &mut e);
        }
        finish(e)
    }
}

impl UpdateTeam {
    /// Luật của `UpdateTeamDto`.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(n) = &self.name {
            max_len("name", n, 100, &mut e);
        }
        if let Some(Some(d)) = &self.department {
            max_len("department", d, 100, &mut e);
        }
        if let Some(Some(d)) = &self.description {
            max_len("description", d, 500, &mut e);
        }
        if let Some(Some(c)) = &self.color {
            color_errors(c, &mut e);
        }
        finish(e)
    }
}

impl TeamMembers {
    /// Luật của `TeamMembersDto`: không rỗng, tối đa 500.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if self.user_ids.len() > 500 {
            e.push("user_ids must contain no more than 500 elements".to_owned());
        }
        if self.user_ids.is_empty() {
            e.push("user_ids should not be empty".to_owned());
        }
        finish(e)
    }
}

struct TeamBase {
    id: i32,
    name: String,
    department: Option<String>,
    description: Option<String>,
    team_lead_id: Option<i32>,
    color: Option<String>,
}

/// `GET /teams`: theo phòng ban rồi tên. `member_count` như bản TS: gán trực tiếp (`employees.team_id`) thắng;
/// chưa gán thì suy theo trưởng nhóm hoặc cấp trên; mỗi nhân viên tính một lần.
pub async fn find_all(conn: &mut PgConnection) -> Result<Vec<TeamRow>, AppError> {
    let teams = sqlx::query_as!(
        TeamBase,
        "SELECT id, name, department, description, team_lead_id, color FROM teams ORDER BY department ASC, name ASC"
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    if teams.is_empty() {
        return Ok(Vec::new());
    }
    let team_ids: Vec<i32> = teams.iter().map(|t| t.id).collect();
    let lead_ids: Vec<i32> = {
        let mut seen = HashSet::new();
        teams
            .iter()
            .filter_map(|t| t.team_lead_id)
            .filter(|l| seen.insert(*l))
            .collect()
    };
    let leads: HashMap<i32, String> = sqlx::query!("SELECT id, full_name FROM users WHERE id = ANY($1)", &lead_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?
        .into_iter()
        .map(|r| (r.id, r.full_name))
        .collect();

    let team_set: HashSet<i32> = team_ids.iter().copied().collect();
    let mut team_by_lead: HashMap<i32, i32> = HashMap::new();
    for t in &teams {
        if let Some(l) = t.team_lead_id {
            team_by_lead.entry(l).or_insert(t.id);
        }
    }
    let members = sqlx::query!(
        r#"SELECT e.team_id, u.id AS user_id, u.manager_id
           FROM employees e JOIN users u ON u.id = e.user_id
           WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL
             AND (e.team_id = ANY($1) OR u.id = ANY($2) OR u.manager_id = ANY($2))"#,
        &team_ids,
        &lead_ids
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut counts: HashMap<i32, i64> = HashMap::new();
    for m in members {
        let key = match m.team_id {
            Some(t) if team_set.contains(&t) => Some(t),
            _ => team_by_lead
                .get(&m.user_id)
                .or_else(|| m.manager_id.and_then(|g| team_by_lead.get(&g)))
                .copied(),
        };
        if let Some(k) = key {
            *counts.entry(k).or_insert(0) += 1;
        }
    }
    Ok(teams
        .into_iter()
        .map(|t| TeamRow {
            team_lead_name: t.team_lead_id.and_then(|l| leads.get(&l).cloned()),
            member_count: counts.get(&t.id).copied().unwrap_or(0),
            id: t.id,
            name: t.name,
            department: t.department,
            description: t.description,
            team_lead_id: t.team_lead_id,
            color: t.color,
        })
        .collect())
}

/// Một team (như `findOne`: lấy từ [`find_all`] nên `member_count` đúng cùng luật).
pub async fn find_one(conn: &mut PgConnection, id: i32) -> Result<TeamRow, AppError> {
    find_all(conn)
        .await?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

async fn assert_head_valid(conn: &mut PgConnection, lead: Option<i32>) -> Result<(), AppError> {
    let Some(id) = lead else { return Ok(()) };
    let found = sqlx::query_scalar!("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    if found.is_none() {
        return Err(HttpError::bad_request(HEAD_INVALID).into());
    }
    Ok(())
}

fn name_taken_on_race(e: sqlx::Error) -> AppError {
    if db_error(&e).is(DbErrorKind::UniqueViolation, Some("teams_name_key")) {
        HttpError::conflict(NAME_TAKEN).into()
    } else {
        db(e)
    }
}

/// `POST /teams`. Gọi sau [`CreateTeam::validate`]. Tên trùng ⇒ 409, cả khi hai request chạy song song.
pub async fn create(conn: &mut PgConnection, input: &CreateTeam) -> Result<TeamRow, AppError> {
    let name = trim_js(&input.name);
    if name.is_empty() {
        return Err(HttpError::bad_request(NAME_EMPTY).into());
    }
    let dup = sqlx::query_scalar!("SELECT id FROM teams WHERE name = $1", name)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if dup.is_some() {
        return Err(HttpError::conflict(NAME_TAKEN).into());
    }
    assert_head_valid(conn, input.team_lead_id).await?;
    let id = sqlx::query_scalar!(
        "INSERT INTO teams (name, department, description, team_lead_id, color) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        name,
        clean(input.department.as_deref()),
        clean(input.description.as_deref()),
        input.team_lead_id,
        normalize_color(input.color.as_deref())
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(name_taken_on_race)?;
    find_one(conn, id).await
}

/// `PATCH /teams/:id`. Gọi sau [`UpdateTeam::validate`].
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateTeam) -> Result<TeamRow, AppError> {
    exists(conn, id).await?;
    let name = match &input.name {
        Some(n) => {
            let n = trim_js(n);
            if n.is_empty() {
                return Err(HttpError::bad_request(NAME_EMPTY).into());
            }
            let dup = sqlx::query_scalar!("SELECT id FROM teams WHERE name = $1 AND id <> $2", n, id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
            if dup.is_some() {
                return Err(HttpError::conflict(NAME_TAKEN).into());
            }
            Some(n.to_owned())
        }
        None => None,
    };
    if let Some(lead) = input.team_lead_id {
        assert_head_valid(conn, lead).await?;
    }
    // (có đổi, giá trị mới)
    let dep = input.department.as_ref().map(|v| clean(v.as_deref()));
    let desc = input.description.as_ref().map(|v| clean(v.as_deref()));
    let color = input.color.as_ref().map(|v| normalize_color(v.as_deref()));
    sqlx::query!(
        r#"UPDATE teams SET name = COALESCE($2, name),
                  department = CASE WHEN $3 THEN $4 ELSE department END,
                  description = CASE WHEN $5 THEN $6 ELSE description END,
                  team_lead_id = CASE WHEN $7 THEN $8 ELSE team_lead_id END,
                  color = CASE WHEN $9 THEN $10 ELSE color END
           WHERE id = $1"#,
        id,
        name,
        dep.is_some(),
        dep.flatten(),
        desc.is_some(),
        desc.flatten(),
        input.team_lead_id.is_some(),
        input.team_lead_id.flatten(),
        color.is_some(),
        color.flatten()
    )
    .execute(&mut *conn)
    .await
    .map_err(name_taken_on_race)?;
    find_one(conn, id).await
}

async fn exists(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let found = sqlx::query_scalar!("SELECT id FROM teams WHERE id = $1", id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    found.map(|_| ()).ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

/// `DELETE /teams/:id`: gỡ `team_id` của nhân viên (giữ `manager_id`/phòng ban của họ) rồi xoá team, trong một giao dịch.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<Ok, AppError> {
    exists(conn, id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query!("UPDATE employees SET team_id = NULL WHERE team_id = $1", id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query!("DELETE FROM teams WHERE id = $1", id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(OK)
}

/// `GET /teams/for-filter?include_unled=true`: team có người phụ trách; `include_unled` thêm team chưa có người phụ
/// trách nhưng có ít nhất một nhân viên gán trực tiếp.
pub async fn list_for_filter(conn: &mut PgConnection, include_unled: bool) -> Result<Vec<TeamFilterRow>, AppError> {
    let rows = sqlx::query_as!(
        TeamFilterRow,
        r#"SELECT t.id, t.name, t.team_lead_id, t.department
           FROM teams t
           WHERE t.team_lead_id IS NOT NULL
              OR ($1 AND EXISTS (SELECT 1 FROM employees e WHERE e.team_id = t.id AND e.deleted_at IS NULL))
           ORDER BY t.department ASC, t.name ASC"#,
        include_unled
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows)
}

/// `GET /teams/lead-filter`: hợp của team có người phụ trách và người đang quản lý ít nhất một người khác, khoá theo
/// `team_lead_id`, nhãn không trùng chữ, xếp theo `localeCompare('vi')`.
pub async fn list_team_lead_filter(conn: &mut PgConnection) -> Result<Vec<TeamLeadFilterRow>, AppError> {
    let teams = sqlx::query!(
        r#"SELECT name, team_lead_id AS "team_lead_id!" FROM teams WHERE team_lead_id IS NOT NULL ORDER BY id ASC"#
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let leaders = sqlx::query!(
        r#"SELECT u.id, u.full_name FROM users u
           WHERE u.status = 'active' AND u.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM users m WHERE m.manager_id = u.id AND m.status = 'active' AND m.deleted_at IS NULL)
           ORDER BY u.id ASC LIMIT 2000"#
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;

    let mut by_lead: BTreeMap<i32, String> = BTreeMap::new();
    let mut order: Vec<i32> = Vec::new();
    for t in teams {
        if let std::collections::btree_map::Entry::Vacant(v) = by_lead.entry(t.team_lead_id) {
            v.insert(t.name);
            order.push(t.team_lead_id);
        }
    }
    let mut used: HashSet<String> = by_lead.values().cloned().collect();
    for u in leaders {
        if by_lead.contains_key(&u.id) {
            continue;
        }
        let trimmed = trim_js(&u.full_name);
        let base = if trimmed.is_empty() {
            format!("Nhân viên #{}", u.id)
        } else {
            trimmed.to_owned()
        };
        let mut label = base.clone();
        if used.contains(&label) {
            label = format!("{base} (chưa có Team)");
        }
        if used.contains(&label) {
            label = format!("{base} (chưa có Team, #{})", u.id);
        }
        used.insert(label.clone());
        by_lead.insert(u.id, label);
        order.push(u.id);
    }
    let mut rows: Vec<TeamLeadFilterRow> = order
        .into_iter()
        .map(|id| TeamLeadFilterRow {
            team_lead_id: id,
            name: by_lead[&id].clone(),
        })
        .collect();
    // `sort` ổn định như `Array.prototype.sort`.
    rows.sort_by(|a, b| compare(&a.name, &b.name, Collation::Vi));
    Ok(rows)
}

/// `GET /teams/:id/members`: nhân viên gán trực tiếp, theo họ tên.
pub async fn list_members(conn: &mut PgConnection, team_id: i32) -> Result<Vec<TeamMemberRow>, AppError> {
    exists(conn, team_id).await?;
    let rows = sqlx::query!(
        r#"SELECT e.user_id, u.full_name, u.email,
                  (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id ORDER BY ur.id LIMIT 1) AS role
           FROM employees e JOIN users u ON u.id = e.user_id
           WHERE e.team_id = $1 AND e.deleted_at IS NULL
           ORDER BY u.full_name ASC, e.id ASC"#,
        team_id
    )
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|r| TeamMemberRow {
            user_id: r.user_id,
            full_name: Some(r.full_name),
            email: Some(r.email),
            role: r.role,
        })
        .collect())
}

/// `POST /teams/:id/members`: gán nhân viên (theo `users.id`, bỏ trùng và id không dương) vào team.
pub async fn add_members(conn: &mut PgConnection, team_id: i32, user_ids: &[i32]) -> Result<Added, AppError> {
    exists(conn, team_id).await?;
    let ids: Vec<i32> = {
        let mut seen = HashSet::new();
        user_ids.iter().copied().filter(|x| *x > 0 && seen.insert(*x)).collect()
    };
    if ids.is_empty() {
        return Ok(Added { added: 0 });
    }
    let n = sqlx::query!(
        "UPDATE employees SET team_id = $1 WHERE user_id = ANY($2) AND deleted_at IS NULL",
        team_id,
        &ids
    )
    .execute(conn)
    .await
    .map_err(db)?
    .rows_affected();
    Ok(Added { added: n })
}

/// `DELETE /teams/:id/members/:userId`: chỉ khi nhân viên đang thuộc đúng team này.
pub async fn remove_member(conn: &mut PgConnection, team_id: i32, user_id: i32) -> Result<Ok, AppError> {
    let n = sqlx::query!(
        "UPDATE employees SET team_id = NULL WHERE user_id = $1 AND team_id = $2",
        user_id,
        team_id
    )
    .execute(conn)
    .await
    .map_err(db)?
    .rows_affected();
    if n == 0 {
        return Err(HttpError::not_found("Nhân viên không thuộc team này").into());
    }
    Ok(OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mau_hex() {
        assert!(is_hex_color("#abc") && is_hex_color("#A1b2C3"));
        assert!(!is_hex_color("abc") && !is_hex_color("#abcd") && !is_hex_color("#ggg"));
        assert_eq!(normalize_color(Some(" #ABC ")).as_deref(), Some("#abc"));
        assert_eq!(normalize_color(Some("xanh")), None);
        assert_eq!(normalize_color(Some("  ")), None);
        assert_eq!(normalize_color(None), None);
    }

    #[test]
    fn validate_dto() {
        let long = "x".repeat(101);
        let t = CreateTeam {
            name: long,
            color: Some("red".into()),
            ..Default::default()
        };
        let m = match t.validate().unwrap_err().body().message {
            trinity_kernel::error::Message::Many(m) => m,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            m,
            [
                "name must be shorter than or equal to 100 characters",
                "Màu phải là mã hex hợp lệ (vd: #f59e0b)"
            ]
        );
        assert!(TeamMembers { user_ids: vec![] }.validate().is_err());
        assert!(TeamMembers { user_ids: vec![1] }.validate().is_ok());
    }

    #[test]
    fn patch_phan_biet_vang_mat_va_null() {
        let u: UpdateTeam = serde_json::from_str(r#"{"department":null,"name":"A"}"#).unwrap();
        assert_eq!(u.department, Some(None));
        assert_eq!(u.description, None);
        assert_eq!(u.team_lead_id, None);
        let u: UpdateTeam = serde_json::from_str(r#"{"team_lead_id":null}"#).unwrap();
        assert_eq!(u.team_lead_id, Some(None));
    }
}
