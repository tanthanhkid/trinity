//! Cấu hình bản tin: một dòng `settings` khoá `briefing_config` (JSON). Thiếu hoặc rác ⇒ mặc định (TẮT).

use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_kernel::error::HttpError;

use crate::time::parse_hhmm;
use crate::types::Config;

pub const KEY: &str = "briefing_config";

fn flag(s: &Map<String, Value>, k: &str, d: bool) -> bool {
    s.get(k).and_then(Value::as_bool).unwrap_or(d)
}

fn time(s: &Map<String, Value>, k: &str, d: &str) -> String {
    match s.get(k).and_then(Value::as_str) {
        Some(v) if parse_hhmm(v).is_some() => v.to_owned(),
        _ => d.to_owned(),
    }
}

/// `normalizeConfig`: giá trị sai kiểu rơi về mặc định.
pub fn normalize(raw: Option<&Value>) -> Config {
    let empty = Map::new();
    let s = raw.and_then(Value::as_object).unwrap_or(&empty);
    let d = Config::default();
    Config {
        enabled: flag(s, "enabled", d.enabled),
        morning_enabled: flag(s, "morning_enabled", d.morning_enabled),
        evening_enabled: flag(s, "evening_enabled", d.evening_enabled),
        morning_time: time(s, "morning_time", &d.morning_time),
        evening_time: time(s, "evening_time", &d.evening_time),
        in_app: flag(s, "in_app", d.in_app),
    }
}

fn config_json(c: &Config) -> Value {
    serde_json::json!({
        "enabled": c.enabled,
        "morning_enabled": c.morning_enabled,
        "evening_enabled": c.evening_enabled,
        "morning_time": c.morning_time,
        "evening_time": c.evening_time,
        "in_app": c.in_app,
    })
}

/// Đọc cấu hình; lỗi đọc hay JSON hỏng ⇒ mặc định (ghi log).
pub async fn get(conn: &mut PgConnection) -> Config {
    match sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
        .bind(KEY)
        .fetch_optional(&mut *conn)
        .await
    {
        Ok(Some(text)) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => normalize(Some(&v)),
            Err(e) => {
                tracing::warn!("Đọc cấu hình bản tin lỗi, dùng mặc định: {e}");
                Config::default()
            }
        },
        Ok(None) => Config::default(),
        Err(e) => {
            tracing::warn!("Đọc cấu hình bản tin lỗi, dùng mặc định: {e}");
            Config::default()
        }
    }
}

/// Các trường client gửi trong `PATCH /briefings/config` (`UpdateBriefingConfigDto`): thiếu = không đổi.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Patch {
    pub enabled: Option<bool>,
    pub morning_enabled: Option<bool>,
    pub evening_enabled: Option<bool>,
    pub morning_time: Option<String>,
    pub evening_time: Option<String>,
    pub in_app: Option<bool>,
}

impl Patch {
    /// Kiểm thân request như class-validator (khoá lạ bị bỏ qua; `null` coi như vắng, như `@IsOptional`).
    pub fn parse(body: &Value) -> Result<Self, Box<HttpError>> {
        let mut errors = Vec::new();
        let obj = body.as_object();
        let get = |k: &str| obj.and_then(|o| o.get(k)).filter(|v| !v.is_null());
        let mut b = |k: &str| -> Option<bool> {
            match get(k) {
                None => None,
                Some(Value::Bool(v)) => Some(*v),
                Some(_) => {
                    errors.push(format!("{k} must be a boolean value"));
                    None
                }
            }
        };
        let enabled = b("enabled");
        let morning_enabled = b("morning_enabled");
        let evening_enabled = b("evening_enabled");
        let in_app = b("in_app");
        let mut t = |k: &str| -> Option<String> {
            match get(k) {
                None => None,
                Some(Value::String(v)) if parse_hhmm(v).is_some() => Some(v.clone()),
                Some(_) => {
                    errors.push("Giờ phải dạng HH:mm".to_owned());
                    None
                }
            }
        };
        let morning_time = t("morning_time");
        let evening_time = t("evening_time");
        if errors.is_empty() {
            Ok(Self {
                enabled,
                morning_enabled,
                evening_enabled,
                morning_time,
                evening_time,
                in_app,
            })
        } else {
            Err(Box::new(HttpError::validation(errors)))
        }
    }
}

/// Gộp bản vá vào cấu hình hiện tại, chuẩn hoá và lưu (`upsert` một dòng). Trả cấu hình mới.
pub async fn update(conn: &mut PgConnection, patch: &Patch, user_id: i32) -> Result<Config, sqlx::Error> {
    let mut c = get(conn).await;
    if let Some(v) = patch.enabled {
        c.enabled = v;
    }
    if let Some(v) = patch.morning_enabled {
        c.morning_enabled = v;
    }
    if let Some(v) = patch.evening_enabled {
        c.evening_enabled = v;
    }
    if let Some(v) = &patch.morning_time {
        c.morning_time.clone_from(v);
    }
    if let Some(v) = &patch.evening_time {
        c.evening_time.clone_from(v);
    }
    if let Some(v) = patch.in_app {
        c.in_app = v;
    }
    let next = normalize(Some(&config_json(&c)));
    sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(KEY)
    .bind(trinity_kernel::json::js_json(&config_json(&next)))
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chuan_hoa() {
        assert_eq!(normalize(None), Config::default());
        assert_eq!(normalize(Some(&json!("rác"))), Config::default());
        let c = normalize(Some(
            &json!({"enabled": true, "morning_time": "9:00", "evening_time": "18:45", "in_app": "x"}),
        ));
        assert!(c.enabled);
        assert_eq!(c.morning_time, "08:00");
        assert_eq!(c.evening_time, "18:45");
        assert!(c.in_app);
    }

    #[test]
    fn kiem_ban_va() {
        let p = Patch::parse(&json!({"enabled": true, "morning_time": "07:30", "lạ": 1, "in_app": null})).unwrap();
        assert_eq!(
            (p.enabled, p.morning_time.as_deref(), p.in_app),
            (Some(true), Some("07:30"), None)
        );
        let e = Patch::parse(&json!({"enabled": "yes", "evening_time": "25:00"})).unwrap_err();
        assert_eq!(e.status(), 400);
        assert_eq!(Patch::parse(&json!(null)).unwrap(), Patch::default());
    }
}
