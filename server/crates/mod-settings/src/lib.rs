//! Cài đặt hệ thống (M06): 12 endpoint của `services/crm/src/{settings,settings-options,usage}`.
//!
//! | Endpoint | Quyền | Hàm |
//! |---|---|---|
//! | `GET /settings/options` | đăng nhập | [`options::list`] |
//! | `POST /settings/options` (201) | `contacts.catalog` | [`options::create`] |
//! | `PATCH /settings/options/:id` | `contacts.catalog` | [`options::update`] |
//! | `DELETE /settings/options/:id` | `contacts.catalog` | [`options::remove`] |
//! | `GET /settings/notification-sound` | đăng nhập | [`general::get_notification_sound`] |
//! | `PATCH /settings/notification-sound` | `settings.integrations` | [`general::update_notification_sound`] |
//! | `GET /settings/departments` | đăng nhập | [`general::get_departments`] |
//! | `PATCH /settings/departments` | `org.manage` | [`general::update_departments`] |
//! | `GET /settings/org-features` | đăng nhập | [`features::get`] |
//! | `PUT /settings/org-features` | `settings.features` | [`features::update`] |
//! | `GET /settings/usage` | `settings.features` | [`features::usage_summary`] |
//! | `PUT /settings/plan` | `settings.features` + `PlanTokenGuard` | [`features::set_plan`] (+ [`verify_plan_token`]) |
//!
//! Hai đường `settings/channel-guard` thuộc M45; `settings/client-ip/alerts` thuộc K-biên. Hàm nhận `&mut PgConnection`
//! đã gắn công ty và trả `AppError` của K05; tầng serve chỉ nối extractor K15 → `validate_*` → hàm → JSON. Bảng gói, nhãn
//! và hạn mức nằm ở `trinity-rbac::plan` (K25). Bản Node không có giá gói trong các phản hồi này (giá hiển thị ở web), nên
//! `GET /settings/usage` chỉ trả `plan`, `plan_label`, `max_users`, `active_users`, `features`.
//!
//! Đo lường (`trackProductEvent`) CHƯA gọi ở đây: tầng serve gọi `plan_changed` sau [`features::set_plan`] (trả [`features::PlanChange`])
//! và `feature_toggled` cho từng khoá trong [`features::Updated::changed`] sau [`features::update`].
//! Khoá của `metadata` trong tuỳ chọn trả theo thứ tự chữ cái (serde_json), bản Node theo thứ tự lưu của jsonb.
// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

pub mod features;
pub mod general;
pub mod options;
pub mod routes;
pub mod validate;

use serde::{Serialize, Serializer, ser::SerializeMap};
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::AppError;

pub use features::verify_plan_token;
pub use validate::{
    CreateOption, QueryOptions, UpdateOption, validate_create_option, validate_org_features, validate_plan_body,
    validate_query_options, validate_update_departments, validate_update_notification_sound, validate_update_option,
};

/// Ngữ cảnh công ty của lời gọi: `Some(id)` ở chế độ nhiều công ty, `None` ở bản cài một công ty (quyết định gói mặc
/// định, xem `trinity_rbac::plan::resolve_plan_for_company`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ctx {
    pub company_id: Option<i32>,
}

pub(crate) fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Đọc một dòng `settings` (giá trị chuỗi); `None` nếu chưa có.
pub(crate) async fn read_setting(conn: &mut PgConnection, key: &str) -> Result<Option<String>, AppError> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// `upsert` một dòng `settings` kèm người sửa (`updated_at` do cột tự đặt lúc tạo, `now()` lúc sửa như `@updatedAt`).
pub(crate) async fn write_setting(
    conn: &mut PgConnection,
    key: &str,
    value: &str,
    user_id: Option<i32>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .bind(user_id)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Object JSON giữ thứ tự khoá như bản Node (serde_json mặc định sắp theo chữ cái). `None` ra `null`.
#[derive(Debug, Clone, PartialEq)]
pub struct Ordered(pub Vec<(&'static str, Option<bool>)>);

impl Serialize for Ordered {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}
