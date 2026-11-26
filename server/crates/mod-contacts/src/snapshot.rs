//! Ảnh chụp khách/thương vụ cho sự kiện outbox (`snapshotContact`, `snapshotDeal` của `packages/prisma/src/integrations/snapshots.ts`).
//! Khoá theo đúng thứ tự của bản TS; ngày là chuỗi ISO có mili giây, số lớn là chuỗi.

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::types::{JsBigInt, NaiveTimestamp, Timestamp};
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::js_iso_string;

use crate::db;

/// Cột đủ để dựng `ContactEventSnapshot` (`CONTACT_EVENT_SELECT`).
pub(crate) const CONTACT_EVENT_COLS: &str = "id, phone, phone_2, full_name, email, zalo_account, source_id, stage_id, \
     contact_status_id, assigned_to, team_id, created_by_id, project_id, created_at, updated_at, deleted_at";

#[derive(sqlx::FromRow)]
pub(crate) struct ContactEventRow {
    pub id: i32,
    pub phone: String,
    pub phone_2: Option<String>,
    pub full_name: Option<String>,
    pub email: Option<String>,
    pub zalo_account: Option<String>,
    pub source_id: Option<i32>,
    pub stage_id: Option<i32>,
    pub contact_status_id: Option<i32>,
    pub assigned_to: Option<i32>,
    pub team_id: Option<i32>,
    pub created_by_id: Option<i32>,
    pub project_id: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<NaiveTimestamp>,
}

fn n(v: Option<i32>) -> Value {
    v.map_or(Value::Null, Value::from)
}

fn s(v: Option<&str>) -> Value {
    v.map_or(Value::Null, |x| Value::String(x.to_owned()))
}

impl ContactEventRow {
    pub(crate) fn snapshot(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.into());
        m.insert("phone".into(), Value::String(self.phone.clone()));
        m.insert("phone_2".into(), s(self.phone_2.as_deref()));
        m.insert("full_name".into(), s(self.full_name.as_deref()));
        m.insert("email".into(), s(self.email.as_deref()));
        m.insert("zalo_account".into(), s(self.zalo_account.as_deref()));
        m.insert("source_id".into(), n(self.source_id));
        m.insert("stage_id".into(), n(self.stage_id));
        m.insert("contact_status_id".into(), n(self.contact_status_id));
        m.insert("assigned_to".into(), n(self.assigned_to));
        m.insert("team_id".into(), n(self.team_id));
        m.insert("created_by_id".into(), n(self.created_by_id));
        m.insert("project_id".into(), n(self.project_id));
        m.insert("created_at".into(), Value::String(js_iso_string(self.created_at.0)));
        m.insert("updated_at".into(), Value::String(js_iso_string(self.updated_at.0)));
        m.insert(
            "deleted_at".into(),
            self.deleted_at
                .map_or(Value::Null, |d| Value::String(js_iso_string(d.0.and_utc()))),
        );
        Value::Object(m)
    }
}

pub(crate) async fn contact_event(conn: &mut PgConnection, id: i32) -> Result<ContactEventRow, AppError> {
    sqlx::query_as::<_, ContactEventRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {CONTACT_EVENT_COLS} FROM contacts WHERE id = $1"
    )))
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// Thương vụ như `DEAL_EVENT_SELECT`: cũng là phần `deal` của response tạo khách.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DealEventRow {
    pub id: i32,
    pub title: String,
    pub description: Option<String>,
    pub note: Option<String>,
    pub value: Option<JsBigInt>,
    pub status: String,
    pub assigned_to: i32,
    pub created_by: i32,
    pub contact_id: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

pub(crate) const DEAL_EVENT_COLS: &str =
    "id, title, description, note, value, status, assigned_to, created_by, contact_id, created_at, updated_at";

impl DealEventRow {
    pub(crate) fn snapshot(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.into());
        m.insert("title".into(), Value::String(self.title.clone()));
        m.insert("description".into(), s(self.description.as_deref()));
        m.insert("note".into(), s(self.note.as_deref()));
        m.insert(
            "value".into(),
            self.value.map_or(Value::Null, |v| Value::String(v.0.to_string())),
        );
        m.insert("status".into(), Value::String(self.status.clone()));
        m.insert("assigned_to".into(), self.assigned_to.into());
        m.insert("created_by".into(), self.created_by.into());
        m.insert("contact_id".into(), n(self.contact_id));
        m.insert("created_at".into(), Value::String(js_iso_string(self.created_at.0)));
        m.insert("updated_at".into(), Value::String(js_iso_string(self.updated_at.0)));
        Value::Object(m)
    }
}
