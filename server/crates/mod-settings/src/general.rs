//! Âm báo chung và danh sách phòng ban: hai dòng `settings` (`settings.service.ts`).

use serde::Serialize;
use sqlx::PgConnection;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;

use crate::{read_setting, write_setting};

const KEY_SOUND: &str = "notification_sound_id";
const KEY_DEPARTMENTS: &str = "department_list";

/// Id âm báo hợp lệ (khớp `NOTIFICATION_SOUNDS` của web).
pub const SOUND_IDS: [&str; 12] = [
    "beep",
    "ding-dong",
    "chime",
    "tri-tone",
    "pop",
    "sweep",
    "bell",
    "harp",
    "water-drop",
    "soft-bell",
    "upbeat",
    "power-up",
];
pub const DEFAULT_SOUND_ID: &str = "beep";

pub const DEFAULT_DEPARTMENTS: [&str; 7] = [
    "Kinh doanh",
    "Kế toán",
    "Hành chính",
    "Marketing",
    "Vận hành",
    "Công nghệ",
    "Khác",
];
pub const MAX_DEPARTMENTS: usize = 50;
pub const MAX_DEPARTMENT_NAME_LENGTH: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Sound {
    pub sound_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Departments {
    pub departments: Vec<String>,
}

/// `GET /settings/notification-sound`: giá trị rác hoặc lỗi đọc ⇒ mặc định (không chặn giao diện).
pub async fn get_notification_sound(conn: &mut PgConnection) -> Sound {
    let stored = read_setting(conn, KEY_SOUND).await.ok().flatten();
    let sound_id = stored
        .filter(|s| SOUND_IDS.contains(&s.as_str()))
        .unwrap_or_else(|| DEFAULT_SOUND_ID.to_owned());
    Sound { sound_id }
}

pub async fn update_notification_sound(
    conn: &mut PgConnection,
    sound_id: &str,
    user_id: i32,
) -> Result<Sound, AppError> {
    if !SOUND_IDS.contains(&sound_id) {
        return Err(
            HttpError::bad_request(format!("sound_id không hợp lệ. Cho phép: {}", SOUND_IDS.join(", "))).into(),
        );
    }
    write_setting(conn, KEY_SOUND, sound_id, Some(user_id))
        .await
        .map_err(|_| AppError::from(HttpError::new(500, "Không cập nhật được âm báo thông báo")))?;
    tracing::info!("Notification sound updated by user {user_id}: {sound_id}");
    Ok(Sound {
        sound_id: sound_id.to_owned(),
    })
}

/// Cắt theo đơn vị UTF-16 như `String.prototype.slice(0, max)`.
fn slice16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// Cắt khoảng trắng, bỏ rỗng, cắt độ dài, bỏ trùng không phân biệt hoa thường (giữ bản đầu), tối đa 50 mục.
pub fn sanitize_departments(input: &[serde_json::Value]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in input {
        let Some(s) = item.as_str() else { continue };
        let name = slice16(trim_js(s), MAX_DEPARTMENT_NAME_LENGTH);
        // `item.trim().slice(0, 100)` KHÔNG cắt khoảng trắng đầu/cuối sau khi cắt độ dài: giữ nguyên như bản Node.
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        out.push(name.to_owned());
        if out.len() >= MAX_DEPARTMENTS {
            break;
        }
    }
    out
}

/// `GET /settings/departments`: chưa cấu hình, rác hoặc rỗng ⇒ danh sách mặc định.
pub async fn get_departments(conn: &mut PgConnection) -> Departments {
    let raw = read_setting(conn, KEY_DEPARTMENTS).await.ok().flatten();
    let parsed = raw
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .and_then(|v| v.as_array().map(|a| sanitize_departments(a)))
        .filter(|d| !d.is_empty());
    Departments {
        departments: parsed.unwrap_or_else(|| DEFAULT_DEPARTMENTS.iter().map(|s| (*s).to_owned()).collect()),
    }
}

pub async fn update_departments(
    conn: &mut PgConnection,
    departments: &[serde_json::Value],
    user_id: i32,
) -> Result<Departments, AppError> {
    let cleaned = sanitize_departments(departments);
    if cleaned.is_empty() {
        return Err(HttpError::bad_request("Danh sách phòng ban không được rỗng").into());
    }
    let json = trinity_kernel::json::js_json(&serde_json::Value::Array(
        cleaned.iter().cloned().map(serde_json::Value::String).collect(),
    ));
    write_setting(conn, KEY_DEPARTMENTS, &json, Some(user_id))
        .await
        .map_err(|_| AppError::from(HttpError::new(500, "Không cập nhật được danh sách phòng ban")))?;
    tracing::info!("Departments updated by user {user_id}: {} mục", cleaned.len());
    Ok(Departments { departments: cleaned })
}
