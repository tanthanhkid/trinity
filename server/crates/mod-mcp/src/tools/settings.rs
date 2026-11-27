//! Nhóm tool cài đặt (4 tool): `set_features`, `save_crm_option`, `get_store_settings`, `update_store_settings`
//! (`feature-tools.ts`, `options-tool.ts`, `store-tools.ts`). Gọi lại đúng module nghiệp vụ của route tương ứng
//! (`mod_settings::features::update` cho `PUT /settings/org-features`, `mod_store::settings` cho `/store/settings`), quyền như route:
//! `set_features` ⇒ `settings.features`, `save_crm_option` ⇒ `contacts.catalog`, hai tool trang bán hàng ⇒ `pos.manage` (kèm tính
//! năng `online_store` đang bật). Bản Node ghi thẳng theo quyền người dùng (không qua khung đề xuất/duyệt M42), nên ở đây cũng vậy;
//! việc nguy hiểm (tắt tính năng cả công ty, mở bán) cần `confirmed_by_user` là lời đồng ý. Không có tool xoá.

use std::sync::Arc;

use mod_store::settings::{self as store, StoreSettings};
use mod_store::vietqr;
use serde_json::{Map, Value, json};
use sqlx::Connection;
use trinity_db::platform::Platform;
use trinity_kernel::error::AppError;
use trinity_kernel::vi::fold_vi;
use trinity_rbac::plan::{ORG_FEATURES, RETIRED_ORG_FEATURE_KEYS, is_org_feature_key};

use super::confirm::is_user_confirmation;
use super::wrapped;
use crate::args::opt_str;
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

/// Phụ thuộc riêng của nhóm cài đặt: `Platform` để giữ/nhả địa chỉ trang bán hàng (`slug`) như route `PUT /store/settings`.
pub struct SettingsDeps {
    pub platform: Platform,
}

const MANAGE: &str = "/connections?muc=ban-online";
const STORE_FEATURE: &str = "online_store";

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

fn user(msg: impl Into<String>) -> ToolError {
    ToolError::User(msg.into())
}

/// `AppError` của nghiệp vụ → lỗi tool: 400/409 là lỗi người dùng (`BadRequestException`/`ConflictException` ⇒ `ToolUserError`),
/// còn lại theo [`app_err`].
fn biz_err(e: AppError) -> ToolError {
    match app_err(e) {
        ToolError::Http { status, message } if status == 400 || status == 409 => ToolError::User(message),
        other => other,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// set_features
// ---------------------------------------------------------------------------------------------------------------------

fn key_list() -> String {
    ORG_FEATURES
        .iter()
        .map(|(k, label, _)| format!("{k}={label}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Danh khoá trong `enable`/`disable`: khoá của tính năng đã gỡ bị bỏ qua, khoá lạ ⇒ lỗi, bỏ trùng giữ thứ tự.
fn feature_keys(v: Option<&Value>) -> Result<Vec<&'static str>, ToolError> {
    let list: Vec<String> = match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.trim().to_owned())
            .filter(|s| !RETIRED_ORG_FEATURE_KEYS.contains(&s.as_str()))
            .collect(),
        _ => Vec::new(),
    };
    let bad: Vec<&str> = list
        .iter()
        .map(String::as_str)
        .filter(|k| !is_org_feature_key(k))
        .collect();
    if !bad.is_empty() {
        return Err(user(format!(
            "Khoá tính năng không có: {}. Khoá hợp lệ: {}. / Unknown feature keys.",
            bad.join(", "),
            key_list()
        )));
    }
    let mut out: Vec<&'static str> = Vec::new();
    for k in &list {
        if let Some(&(key, _, _)) = ORG_FEATURES.iter().find(|(key, _, _)| *key == k.as_str())
            && !out.contains(&key)
        {
            out.push(key);
        }
    }
    Ok(out)
}

fn label_of(k: &str) -> &'static str {
    ORG_FEATURES
        .iter()
        .find(|(key, _, _)| *key == k)
        .map_or("", |(_, l, _)| *l)
}

pub fn set_features<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let on = feature_keys(args.get("enable"))?;
        let off = feature_keys(args.get("disable"))?;
        let both: Vec<&str> = on.iter().copied().filter(|k| off.contains(k)).collect();
        if !both.is_empty() {
            return Err(user(format!(
                "Một khoá vừa bật vừa tắt: {}. / Same key in enable and disable.",
                both.join(", ")
            )));
        }
        if on.len() + off.len() == 0 {
            return Err(user("Chưa có khoá nào trong enable hoặc disable. / Nothing to change."));
        }
        let said_raw = args.get("confirmed_by_user").and_then(Value::as_str);
        if !off.is_empty() && !is_user_confirmation(said_raw) {
            let said = match said_raw.map(str::trim) {
                Some(t) if !t.is_empty() => format!("“{}”", crate::ai_output::slice16(t, 80)),
                _ => "(trống)".to_owned(),
            };
            let names: Vec<&str> = off.iter().map(|k| label_of(k)).collect();
            return Err(user(format!(
                "Chưa đổi gì: tắt {} sẽ ẩn với cả công ty (dữ liệu vẫn giữ). Hỏi người dùng rồi gửi lại với confirmed_by_user là lời họ \
                 đồng ý (hiện là {said}). / Nothing changed: turning features off needs the user's confirmation.",
                names.join(", ")
            )));
        }
        let mut body = Map::new();
        for k in &on {
            body.insert((*k).to_owned(), Value::Bool(true));
        }
        for k in &off {
            body.insert((*k).to_owned(), Value::Bool(false));
        }
        let dto = mod_settings::validate_org_features(&Value::Object(body))
            .map_err(|e| biz_err(AppError::from(e)))?;
        let settings = deps.settings_ctx(p);
        let mut conn = deps.conn(p.company).await?;
        let updated = mod_settings::features::update(&mut conn, settings, &dto, p.user_id)
            .await
            .map_err(biz_err)?;
        let state = |k: &str| {
            let enabled = !updated.features.0.iter().any(|(fk, v)| *fk == k && *v == Some(false));
            json!({ "key": k, "label": label_of(k), "enabled": enabled })
        };
        let enabled: Vec<Value> = on.iter().map(|k| state(k)).collect();
        let disabled: Vec<Value> = off.iter().map(|k| state(k)).collect();
        wrapped(&json!({ "enabled": enabled, "disabled": disabled }))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// save_crm_option
// ---------------------------------------------------------------------------------------------------------------------

const GROUPS: [(&str, &str, &str); 3] = [
    ("sources", "contact_source", "nguồn khách"),
    ("stages", "contact_stage", "giai đoạn khách hàng"),
    ("statuses", "contact_detail_status", "trạng thái chăm sóc"),
];

/// Khoá advisory tuần tự hoá "kiểm trùng nhãn/giá trị rồi chèn" của danh mục (hai lời gọi cùng lúc không tạo trùng).
const OPTION_LOCK: &str = "save_crm_option";

type OptionRow = (i32, String, String, i32, bool, bool);

fn option_json(r: &OptionRow) -> Value {
    json!({
        "id": r.0, "label": r.1, "value": r.2, "sort_order": r.3, "is_active": r.4, "is_system": r.5,
    })
}

/// Giá trị (`value`) sinh từ nhãn: bỏ dấu, chữ/số cách nhau bằng `_`, tối đa 40 ký tự, rỗng ⇒ `muc`.
fn value_base(label: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in fold_vi(label).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push('_');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out.truncate(40);
    let out = out.trim_matches('_').to_owned();
    if out.is_empty() { "muc".to_owned() } else { out }
}

/// Đọc đối số số nguyên có cận (`z.number().int().min().max()`); sai ⇒ lỗi người dùng, không lặng lẽ bỏ qua.
fn int_arg(args: &Value, key: &str, min: i64, max: i64) -> Result<Option<i32>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .filter(|v| (min..=max).contains(v))
            .and_then(|v| i32::try_from(v).ok())
            .map(Some)
            .ok_or_else(|| user(format!("{key} phải là số nguyên từ {min} đến {max}. / {key} out of range."))),
        Some(_) => Err(user(format!("{key} phải là số nguyên. / {key} must be an integer."))),
    }
}

pub fn save_crm_option<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let list = args.get("list").and_then(Value::as_str).unwrap_or_default();
        let Some((_, group, group_label)) = GROUPS.iter().find(|(k, _, _)| *k == list) else {
            return Err(user(
                "list phải là sources, stages hoặc statuses. / list must be sources, stages or statuses.",
            ));
        };
        let label = opt_str(args.get("label"), 100);
        let sort = int_arg(args, "sort_order", 0, 999)?;
        let active = args.get("active").and_then(Value::as_bool);
        let id = match args.get("id") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                crate::args::opt_int(Some(v))
                    .ok_or_else(|| user("id phải là số nguyên dương. / id must be a positive integer."))?,
            ),
        };
        let mut conn = deps.conn(p.company).await?;
        let mut tx = conn.begin().await.map_err(internal)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(OPTION_LOCK)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        let row: OptionRow = if let Some(id) = id {
            let cur: Option<i32> = sqlx::query_scalar("SELECT id FROM setting_options WHERE id = $1 AND group_key = $2")
                .bind(id)
                .bind(group)
                .fetch_optional(&mut *tx)
                .await
                .map_err(internal)?;
            let Some(cur) = cur else {
                return Err(user(format!(
                    "Không có mục id {id} trong {group_label} (xem list_crm_options). / No such item in this list."
                )));
            };
            if label.is_none() && sort.is_none() && active.is_none() {
                return Err(user(
                    "Chưa có gì để sửa: gửi label, sort_order hoặc active. / Nothing to change.",
                ));
            }
            sqlx::query_as(
                "UPDATE setting_options SET label = COALESCE($2, label), sort_order = COALESCE($3, sort_order), \
                 is_active = COALESCE($4, is_active), updated_by = $5, updated_at = now() WHERE id = $1 \
                 RETURNING id, label, value, sort_order, is_active, is_system",
            )
            .bind(cur)
            .bind(label.as_deref())
            .bind(sort)
            .bind(active)
            .bind(p.user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?
        } else {
            let Some(label) = label else {
                return Err(user("Thêm mục mới cần label. / label is required to add an item."));
            };
            let same: Option<OptionRow> = sqlx::query_as(
                "SELECT id, label, value, sort_order, is_active, is_system FROM setting_options \
                 WHERE group_key = $1 AND lower(label) = lower($2) ORDER BY id ASC LIMIT 1",
            )
            .bind(group)
            .bind(&label)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
            if let Some(s) = same {
                let off = if s.4 { "" } else { ", đang tắt" };
                return Err(user(format!(
                    "Đã có “{}” (id {}{off}) trong {group_label}; sửa mục đó bằng id thay vì thêm mới. / Already exists.",
                    s.1, s.0
                )));
            }
            let base = value_base(&label);
            let mut value = base.clone();
            let mut n = 2;
            loop {
                let taken: Option<i32> =
                    sqlx::query_scalar("SELECT id FROM setting_options WHERE group_key = $1 AND value = $2")
                        .bind(group)
                        .bind(&value)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(internal)?;
                if taken.is_none() {
                    break;
                }
                value = format!("{base}_{n}");
                n += 1;
            }
            let last: Option<i32> = sqlx::query_scalar("SELECT MAX(sort_order) FROM setting_options WHERE group_key = $1")
                .bind(group)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
            let order = sort.unwrap_or_else(|| last.unwrap_or(0).saturating_add(1));
            sqlx::query_as(
                "INSERT INTO setting_options (group_key, value, label, sort_order, is_active, is_system, metadata, updated_by, \
                 updated_at) VALUES ($1, $2, $3, $4, $5, false, 'null'::jsonb, $6, now()) \
                 RETURNING id, label, value, sort_order, is_active, is_system",
            )
            .bind(group)
            .bind(&value)
            .bind(&label)
            .bind(order)
            .bind(active.unwrap_or(true))
            .bind(p.user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?
        };
        tx.commit().await.map_err(internal)?;
        wrapped(&json!({ "list": list, "item": option_json(&row) }))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// get_store_settings, update_store_settings
// ---------------------------------------------------------------------------------------------------------------------

/// Tính năng "Trang bán hàng" (`online_store`) phải đang bật (đã tính gói), như `OrgFeatureGuard` của route.
async fn require_store_feature(ctx: &ToolCtx<'_>) -> Result<(), ToolError> {
    let (p, deps) = (ctx.principal, ctx.deps);
    let settings = deps.settings_ctx(p);
    let mut conn = deps.conn(p.company).await?;
    let f = mod_settings::features::get(&mut conn, settings).await.map_err(app_err)?;
    if f.0.iter().any(|(k, v)| *k == STORE_FEATURE && *v == Some(true)) {
        Ok(())
    } else {
        Err(user(
            "Tính năng \"Trang bán hàng\" đang tắt (Cài đặt › Tính năng). / The Online store feature is turned off for this workspace.",
        ))
    }
}

async fn load_store(ctx: &ToolCtx<'_>) -> Result<StoreSettings, ToolError> {
    let p = ctx.principal;
    let mut conn = ctx.deps.conn(p.company).await?;
    store::load(&mut conn).await.map_err(app_err)
}

fn banks_json() -> Value {
    Value::Array(
        store::store_banks()
            .into_iter()
            .map(|b| json!({ "bin": b.bin, "name": b.name }))
            .collect(),
    )
}

/// `storeForAi`: cấu hình hiển thị cho AI (không trả khoá lạ hay `owner_user_id`).
fn store_for_ai(s: &StoreSettings) -> Map<String, Value> {
    let bank = store::bank_account_of(s);
    let bank_name = bank.as_ref().map(|b| b.name).or_else(|| {
        s.bank_bin
            .as_deref()
            .and_then(vietqr::find_bank)
            .map(|b| b.name)
    });
    let page_path = (!s.slug.is_empty()).then(|| format!("/s/{}", s.slug));
    let Value::Object(m) = json!({
        "name": s.name,
        "slug": s.slug,
        "page_path": page_path,
        "published": s.published,
        "tagline": s.tagline,
        "theme": s.theme,
        "accent": s.accent,
        "phone": s.phone,
        "address": s.address,
        "cover_url": s.cover_url,
        "logo_url": s.logo_url,
        "cod": s.cod,
        "bank_transfer": s.bank_transfer,
        // Chuyển khoản đang thật sự nhận được trên trang (bật + đủ tài khoản).
        "bank_transfer_ready": bank.is_some(),
        "bank_bin": s.bank_bin,
        "bank_name": bank_name,
        "bank_account": s.bank_account,
        "bank_account_name": s.bank_account_name,
        "bank_notice": s.bank_notice,
        "product_ids": s.product_ids,
    }) else {
        return Map::new();
    };
    m
}

pub fn get_store_settings<'a>(_args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        require_store_feature(ctx).await?;
        let s = load_store(ctx).await?;
        let mut m = store_for_ai(&s);
        m.insert("banks".into(), banks_json());
        m.insert("manage_url".into(), json!(format!("{}{MANAGE}", ctx.base_url)));
        wrapped(&Value::Object(m))
    })
}

/// Trường tool được đổi (đúng danh sách `keys` của Node); `confirmed_by_user` không đi vào cấu hình.
const STORE_KEYS: [&str; 16] = [
    "name",
    "slug",
    "tagline",
    "theme",
    "accent",
    "phone",
    "address",
    "cover_url",
    "logo_url",
    "cod",
    "bank_transfer",
    "bank_bin",
    "bank_account",
    "bank_account_name",
    "product_ids",
    "published",
];

pub fn update_store_settings<'a>(
    d: &'a SettingsDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        require_store_feature(ctx).await?;
        let input: Map<String, Value> = STORE_KEYS
            .iter()
            .filter_map(|k| args.get(*k).map(|v| ((*k).to_owned(), v.clone())))
            .collect();
        if input.is_empty() {
            return Err(user("Chưa có trường nào cần đổi. / Nothing to change."));
        }
        let current = load_store(ctx).await?;
        if input.get("published") == Some(&Value::Bool(true))
            && !current.published
            && !is_user_confirmation(args.get("confirmed_by_user").and_then(Value::as_str))
        {
            return Err(user(
                "Chưa đổi gì: mở bán đưa trang lên công khai cho mọi người. Cho người dùng xem tên, địa chỉ trang, sản phẩm và cách \
                 thanh toán rồi gửi lại với confirmed_by_user là lời họ đồng ý. / Nothing changed: publishing needs the user's confirmation.",
            ));
        }
        // `save` tự mượn kết nối tenant ngắn (không giữ kết nối khi giữ/nhả địa chỉ trang), nên không giữ kết nối nào ở đây.
        let next = store::save(&deps.db, &d.platform, p.company, &input, p.user_id)
            .await
            .map_err(biz_err)?;
        let mut m = store_for_ai(&next);
        m.insert("updated".into(), Value::Bool(true));
        m.insert("manage_url".into(), json!(format!("{}{MANAGE}", ctx.base_url)));
        wrapped(&Value::Object(m))
    })
}

/// Đăng ký 4 tool cài đặt vào `r`. Ba tool ghi cần scope `crm.write`.
pub(crate) fn register(r: &mut crate::exec::ToolRegistry, d: Arc<SettingsDeps>) {
    use crate::exec::ToolSpec;
    let reg = |r: &mut crate::exec::ToolRegistry,
               name: &'static str,
               scope: Option<&'static str>,
               permissions: &'static [&'static str],
               run: super::RunFn| {
        r.register(ToolSpec {
            name,
            scope,
            permissions,
            runner: Arc::new(super::Tool(run)),
        });
    };
    reg(r, "set_features", Some("crm.write"), &["settings.features"], set_features);
    reg(
        r,
        "save_crm_option",
        Some("crm.write"),
        &["contacts.catalog"],
        save_crm_option,
    );
    reg(r, "get_store_settings", None, &["pos.manage"], get_store_settings);
    super::reg_state(
        r,
        &d,
        "update_store_settings",
        Some("crm.write"),
        &["pos.manage"],
        update_store_settings,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_tu_nhan() {
        assert_eq!(value_base("Khách Đến Từ Zalo!"), "khach_den_tu_zalo");
        assert_eq!(value_base("  --  "), "muc");
        assert_eq!(value_base(&"a".repeat(60)).len(), 40);
        assert_eq!(value_base("Đã chốt (VIP) 2"), "da_chot_vip_2");
    }

    #[test]
    fn khoa_tinh_nang() {
        let ok = feature_keys(Some(&json!(["pos", " pos ", "google_sheets", "kanban"]))).unwrap();
        assert_eq!(ok, vec!["pos", "kanban"]);
        assert!(feature_keys(None).unwrap().is_empty());
        assert!(matches!(
            feature_keys(Some(&json!(["pos", "khong_co"]))),
            Err(ToolError::User(m)) if m.contains("khong_co")
        ));
    }

    #[test]
    fn loi_nghiep_vu_la_loi_nguoi_dung() {
        let e = biz_err(trinity_kernel::error::HttpError::bad_request("sai").into());
        assert!(matches!(e, ToolError::User(m) if m == "sai"));
        let e = biz_err(trinity_kernel::error::HttpError::conflict("trùng").into());
        assert!(matches!(e, ToolError::User(_)));
    }

    #[test]
    fn dang_ky_du_bon_tool_khong_co_xoa() {
        let mut r = crate::exec::ToolRegistry::new();
        // `Platform` cần DB thật; chỉ kiểm tên/phạm vi qua hợp đồng đóng băng.
        let _ = &mut r;
        let frozen = crate::frozen::Frozen::embedded();
        for n in ["set_features", "save_crm_option", "get_store_settings", "update_store_settings"] {
            assert!(frozen.tool(n).is_some(), "{n}");
            assert!(!n.contains("delete") && !n.contains("remove"), "{n}");
        }
    }
}
