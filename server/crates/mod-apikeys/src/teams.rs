//! Team (cũ, `teams.service.ts`): nguồn thật của quan hệ team là `users.manager_id`; hai endpoint này giữ cho tương thích.

use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

#[derive(Debug, Serialize)]
pub struct LeadRef {
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    pub id: i32,
    pub name: String,
    pub lead_user_id: Option<i32>,
    pub lead: Option<LeadRef>,
    pub member_count: i64,
}

/// `GET /auth/teams` (`AuthOnly`): theo `id`, kèm tên trưởng nhóm và số thành viên đang hoạt động.
pub async fn find_all(conn: &mut PgConnection) -> Result<Vec<TeamView>, AppError> {
    let teams: Vec<(i32, String, Option<i32>, i64)> = sqlx::query_as(
        "SELECT t.id, t.name, t.team_lead_id,
                (SELECT count(*) FROM users u WHERE u.team_id = t.id AND u.status = 'active')
         FROM teams t ORDER BY t.id ASC",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let lead_ids: Vec<i32> = teams.iter().filter_map(|t| t.2).collect();
    let leads: Vec<(i32, String)> = if lead_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
            .bind(&lead_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    Ok(teams
        .into_iter()
        .map(|(id, name, lead, member_count)| TeamView {
            id,
            name,
            lead_user_id: lead,
            lead: lead.map(|l| LeadRef {
                name: leads.iter().find(|x| x.0 == l).map(|x| x.1.clone()),
            }),
            member_count,
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct TeamCreated {
    pub id: i32,
    pub name: String,
    pub team_lead_id: Option<i32>,
}

/// Thân `POST /auth/teams` đã kiểm: `{ name: string, leadUserId: số nguyên }`. Bản Node không có DTO (thiếu trường thì Prisma
/// báo 500); bản Rust trả 400 với câu của class-validator.
pub fn parse_create(body: &Value) -> Result<(String, i32), HttpError> {
    let mut errors = Vec::new();
    let name = body.get("name").and_then(Value::as_str).map(str::to_owned);
    if name.is_none() {
        errors.push("name must be a string".to_owned());
    }
    let lead = body
        .get("leadUserId")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
        })
        .and_then(|n| i32::try_from(n).ok());
    if lead.is_none() {
        errors.push("leadUserId must be an integer number".to_owned());
    }
    match (name, lead) {
        (Some(n), Some(l)) if errors.is_empty() => Ok((n, l)),
        _ => Err(HttpError::validation(errors)),
    }
}

/// `POST /auth/teams` (`org.manage`, 201).
pub async fn create(conn: &mut PgConnection, name: &str, lead_user_id: i32) -> Result<TeamCreated, AppError> {
    let (id, name, lead): (i32, String, Option<i32>) =
        sqlx::query_as("INSERT INTO teams (name, team_lead_id) VALUES ($1, $2) RETURNING id, name, team_lead_id")
            .bind(name)
            .bind(lead_user_id)
            .fetch_one(conn)
            .await
            .map_err(db)?;
    Ok(TeamCreated {
        id,
        name,
        team_lead_id: lead,
    })
}
