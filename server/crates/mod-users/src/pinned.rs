//! Ghim menu sidebar theo người dùng (`PinnedMenuController`): preference cá nhân, mọi người đăng nhập tự quản lý của mình.

#![allow(clippy::result_large_err)]

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_kernel::error::HttpError;

use crate::guards::{R, db};

/// Key menu cố định hợp lệ (đồng bộ tay với `nav-config.ts` ở web, như `KNOWN_MENU_KEYS`).
pub const KNOWN_MENU_KEYS: [&str; 17] = [
    "dashboard",
    "contacts",
    "projects",
    "reports",
    "newsfeed",
    "social",
    "kanban",
    "attendance",
    "payroll",
    "management",
    "management_employees",
    "management_contracts",
    "management_job_titles",
    "management_recruitment",
    "management_workdays",
    "connections",
    "settings",
];

/// Trần số mục ghim (bằng `MAX_PINS` của web).
pub const MAX_PINNED_MENU_KEYS: usize = 20;
const CUSTOM_PREFIX: &str = "custom_";

/// `^[a-z][a-z0-9_]{0,max-1}$`.
fn ident(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= max
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// `^custom_[a-z][a-z0-9_]{0,96}$`.
pub fn is_custom_menu_key(key: &str) -> bool {
    key.strip_prefix(CUSTOM_PREFIX).is_some_and(|rest| ident(rest, 97))
}

pub fn is_known_menu_key(key: &str) -> bool {
    KNOWN_MENU_KEYS.contains(&key)
}

/// Mọi cách hiểu hợp lệ của một key `custom_…`: cả bảng, và từng điểm tách `__` thành bảng + màn.
pub fn parse_custom_menu_key(key: &str) -> Vec<(String, Option<String>)> {
    if !is_custom_menu_key(key) {
        return Vec::new();
    }
    let rest = &key[CUSTOM_PREFIX.len()..];
    let mut out = Vec::new();
    if ident(rest, 48) {
        out.push((rest.to_owned(), None));
    }
    let mut from = 0;
    while let Some(off) = rest[from..].find("__") {
        let i = from + off;
        let (object, view) = (&rest[..i], &rest[i + 2..]);
        if ident(object, 48) && ident(view, 48) {
            out.push((object.to_owned(), Some(view.to_owned())));
        }
        from = i + 1;
    }
    out
}

/// Kiểm body `PUT`: `keys` là mảng, tối đa 20, không trùng, mỗi key cố định hoặc `custom_<key>` (câu lỗi như class-validator).
pub fn validate_keys(body: &Value) -> Result<Vec<String>, HttpError> {
    let mut errors: Vec<String> = Vec::new();
    let keys = body.get("keys");
    let arr = keys.and_then(Value::as_array);
    match arr {
        None => errors.push("keys must be an array".to_owned()),
        Some(a) => {
            if a.len() > MAX_PINNED_MENU_KEYS {
                errors.push(format!(
                    "keys must contain no more than {MAX_PINNED_MENU_KEYS} elements"
                ));
            }
            let strs: Vec<Option<&str>> = a.iter().map(Value::as_str).collect();
            let uniq: HashSet<String> = a.iter().map(Value::to_string).collect();
            if uniq.len() != a.len() {
                errors.push("All keys's elements must be unique".to_owned());
            }
            if strs
                .iter()
                .any(|s| s.is_none_or(|k| !(is_known_menu_key(k) || is_custom_menu_key(k))))
            {
                errors.push(
                    "each value in keys must be a known menu key or a custom table key (custom_<key>)".to_owned(),
                );
            }
        }
    }
    if !errors.is_empty() {
        return Err(HttpError::validation(errors));
    }
    Ok(arr
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default())
}

/// Key bảng tuỳ biến mà bảng (hoặc màn xem) không còn tồn tại / đã lưu trữ thì bỏ đi; key cố định giữ nguyên.
async fn drop_stale_custom_keys(conn: &mut PgConnection, keys: Vec<String>) -> R<Vec<String>> {
    let targets: BTreeMap<&str, Vec<(String, Option<String>)>> = keys
        .iter()
        .filter(|k| k.starts_with(CUSTOM_PREFIX))
        .map(|k| (k.as_str(), parse_custom_menu_key(k)))
        .collect();
    if targets.is_empty() {
        return Ok(keys);
    }
    let object_keys: Vec<String> = targets
        .values()
        .flatten()
        .map(|t| t.0.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let objects: Vec<(i32, String)> = if object_keys.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, key FROM custom_objects WHERE key = ANY($1) AND deleted_at IS NULL AND is_active")
            .bind(&object_keys)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    let id_by_key: BTreeMap<&str, i32> = objects.iter().map(|(i, k)| (k.as_str(), *i)).collect();
    let view_targets: Vec<(i32, &str)> = targets
        .values()
        .flatten()
        .filter_map(|(o, v)| Some((*id_by_key.get(o.as_str())?, v.as_deref()?)))
        .collect();
    let views: Vec<(i32, String)> = if view_targets.is_empty() {
        Vec::new()
    } else {
        let ids: Vec<i32> = view_targets
            .iter()
            .map(|t| t.0)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let vkeys: Vec<String> = view_targets
            .iter()
            .map(|t| t.1.to_owned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        sqlx::query_as("SELECT object_id, key FROM custom_views WHERE deleted_at IS NULL AND object_id = ANY($1) AND key = ANY($2)")
            .bind(ids)
            .bind(vkeys)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    let view_set: BTreeSet<(i32, &str)> = views.iter().map(|(o, k)| (*o, k.as_str())).collect();
    Ok(keys
        .iter()
        .filter(|k| match targets.get(k.as_str()) {
            None => true,
            Some(cands) => cands.iter().any(|(o, v)| match id_by_key.get(o.as_str()) {
                None => false,
                Some(id) => v.as_deref().is_none_or(|v| view_set.contains(&(*id, v))),
            }),
        })
        .cloned()
        .collect())
}

/// `GET /users/me/pinned-menu`.
pub async fn get(conn: &mut PgConnection, user: i32) -> R<Value> {
    let keys: Option<Option<Vec<String>>> = sqlx::query_scalar("SELECT pinned_menu_keys FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let keys = drop_stale_custom_keys(conn, keys.flatten().unwrap_or_default()).await?;
    Ok(json!({ "keys": keys }))
}

/// `PUT /users/me/pinned-menu`: bỏ trùng giữ thứ tự, bỏ key ma, ghi.
pub async fn update(conn: &mut PgConnection, user: i32, keys: Vec<String>) -> R<Value> {
    let mut seen = HashSet::new();
    let deduped: Vec<String> = keys.into_iter().filter(|k| seen.insert(k.clone())).collect();
    let keys = drop_stale_custom_keys(conn, deduped).await?;
    let saved: Option<Vec<String>> = sqlx::query_scalar(
        "UPDATE users SET pinned_menu_keys = $1, updated_at = now() WHERE id = $2 RETURNING pinned_menu_keys",
    )
    .bind(&keys)
    .bind(user)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    Ok(json!({ "keys": saved.unwrap_or_default() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_tuy_bien_va_cach_tach() {
        assert!(is_custom_menu_key("custom_a"));
        assert!(!is_custom_menu_key("custom_"));
        assert!(!is_custom_menu_key("custom_1a"));
        assert!(!is_custom_menu_key("custom_A"));
        assert!(!is_custom_menu_key(&format!("custom_a{}", "b".repeat(97))));
        assert!(is_custom_menu_key(&format!("custom_a{}", "b".repeat(96))));
        assert_eq!(parse_custom_menu_key("custom_khach"), [("khach".to_owned(), None)]);
        assert_eq!(
            parse_custom_menu_key("custom_a__b"),
            [("a__b".to_owned(), None), ("a".to_owned(), Some("b".to_owned()))]
        );
        assert_eq!(
            parse_custom_menu_key("custom_a__b__c"),
            [
                ("a__b__c".to_owned(), None),
                ("a".to_owned(), Some("b__c".to_owned())),
                ("a__b".to_owned(), Some("c".to_owned()))
            ]
        );
        assert!(parse_custom_menu_key("khong_phai").is_empty());
    }

    #[test]
    fn kiem_body() {
        assert_eq!(
            validate_keys(&json!({ "keys": ["dashboard", "custom_x"] })).unwrap(),
            ["dashboard", "custom_x"]
        );
        assert!(validate_keys(&json!({ "keys": [] })).unwrap().is_empty());
        for bad in [
            json!({}),
            json!({ "keys": "dashboard" }),
            json!({ "keys": ["dashboard", "dashboard"] }),
            json!({ "keys": ["khong-co"] }),
            json!({ "keys": [1] }),
            json!({ "keys": (0..21).map(|i| format!("custom_k{i}")).collect::<Vec<_>>() }),
        ] {
            assert!(validate_keys(&bad).is_err(), "{bad}");
        }
    }
}
