//! Tool GHI dựng hệ thống (M43): `install_object_template`, `setup_build`, `propose_workspace` (`action-template-tools.ts`,
//! `action-workspace.ts`, `workspace-spec.ts`). Tạo bảng mới cần lời đồng ý `confirmed_by_user`; gói lỗi giữa chừng thì xoá hẳn
//! bảng vừa tạo, trả menu/tính năng/trạng thái về như trước (không dựng nửa vời).
//!
//! Khác bản TS (ghi ở PLAN M43): `propose_workspace` kiểm cấu hình màn của BẢNG MỚI lúc dựng (lỗi ⇒ hoàn tác cả gói) thay vì lúc đề
//! xuất; `setup_build` chưa so lại danh sách phân hệ giữa đề xuất và chạy (không có hai bước).

use std::collections::HashSet;

use mod_custom::menu::MenuEntry;
use mod_custom::views;
use mod_settings::validate::validate_org_features;
use mod_setup::build::{BuildInput, SETUP_BUILT_KEY};
use mod_setup::catalog::{TObject, catalog, find_template};
use mod_setup::industry;
use serde_json::{Map, Value, json};
use trinity_rbac::can;
use trinity_rbac::plan::{ORG_FEATURES, is_org_feature_key};

use super::structure::{
    ObjectSpec, app_msg, apply_objects, check_objects, load_def, object_details, parse_object, purge_created,
};
use super::view_tools::{assert_type_chosen, describe_view, parse_menu, parse_view, table_names};
use super::write::{Detail, assert_confirmed, clean_text, internal, is_user_confirmation, line, prepared, user, user_err};
use crate::actions::{ActionCx, ActionDef, Prepared};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

const MANAGE: &[&str] = &["custom_objects.manage"];
const MANAGE_FEATURES: &[&str] = &["custom_objects.manage", "settings.features"];

const MAX_PACKAGE_OBJECTS: usize = 8;
const MAX_PACKAGE_VIEWS: usize = 20;
const BASIC_FEATURES: [&str; 6] = ["dashboard", "contacts", "kanban", "reports", "inbox", "integrations"];

async fn live_keys(ctx: &ActionCx<'_>) -> Result<HashSet<String>, ToolError> {
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    let v: Vec<String> = sqlx::query_scalar("SELECT key FROM custom_objects WHERE deleted_at IS NULL LIMIT 200")
        .fetch_all(&mut *c)
        .await
        .map_err(internal)?;
    Ok(v.into_iter().collect())
}

/// Các dòng "Bảng X: cột (kiểu); …" của bảng mẫu CHƯA có.
fn template_details(fresh: &[&TObject]) -> Vec<Detail> {
    fresh
        .iter()
        .filter_map(|o| {
            let cols = o
                .fields
                .iter()
                .map(|f| format!("{} ({})", f.label, f.kind))
                .collect::<Vec<_>>()
                .join("; ");
            line(
                &format!("Bảng {}", o.label_plural),
                if cols.is_empty() {
                    "(chưa có trường)".to_owned()
                } else {
                    cols
                },
                900,
            )
        })
        .collect()
}

fn confirmation(args: &Value) -> Option<&str> {
    args.get("confirmed_by_user").and_then(Value::as_str)
}

pub(crate) static INSTALL_OBJECT_TEMPLATE: ActionDef = ActionDef {
    name: "install_object_template",
    label: "Cài bảng mẫu",
    permissions: MANAGE,
    prepare: install_template_prepare,
    execute: install_template_execute,
    structure: true,
};

/// Dữ liệu mẫu cần thêm quyền ghi bản ghi (kiểm cả lúc đề xuất lẫn lúc chạy: người duyệt có thể khác người đề xuất).
fn assert_sample_allowed(ctx: &ActionCx<'_>, sample: bool) -> Result<(), ToolError> {
    if sample && !can(&ctx.principal.grants, "custom_records.manage", None) {
        return Err(ToolError::Forbidden(
            "Tạo dữ liệu mẫu cần thêm quyền “Thêm/sửa dữ liệu của tính năng tuỳ biến”".to_owned(),
        ));
    }
    Ok(())
}

fn install_template_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = clean_text(args.get("template"), 64);
        let Some(t) = find_template(&key) else {
            let all: Vec<&str> = catalog().templates.iter().map(|x| x.key.as_str()).collect();
            return Err(user(format!("Không có mẫu “{key}”. Mẫu hiện có: {}.", all.join(", "))));
        };
        let sample = args.get("with_sample_data").and_then(Value::as_bool) == Some(true);
        assert_sample_allowed(ctx, sample)?;
        let live = live_keys(ctx).await?;
        let fresh: Vec<&TObject> = t.objects.iter().filter(|o| !live.contains(&o.key)).collect();
        if !fresh.is_empty() {
            assert_confirmed(confirmation(args), &template_details(&fresh))?;
        }
        let kept = t.objects.len() - fresh.len();
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Mẫu", t.label.clone(), 600));
        details.extend(line(
            "Bảng sẽ tạo",
            if fresh.is_empty() {
                "(không — đã có đủ)".to_owned()
            } else {
                fresh
                    .iter()
                    .map(|o| o.label_plural.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            },
            600,
        ));
        details.extend(line("Dữ liệu mẫu", if sample { "Có (giả)" } else { "Không" }, 600));
        let summary = format!(
            "Cài mẫu “{}”: tạo {} bảng{}{}",
            t.label,
            fresh.len(),
            if kept > 0 {
                format!(", giữ {kept} bảng đã có")
            } else {
                String::new()
            },
            if sample { ", kèm dữ liệu mẫu giả" } else { "" }
        );
        Ok(prepared(
            json!({ "template": key, "with_sample_data": sample }),
            &summary,
            &details,
            None,
        ))
    })
}

fn install_template_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let key = params.get("template").and_then(Value::as_str).unwrap_or_default();
        let sample = params.get("with_sample_data").and_then(Value::as_bool) == Some(true);
        assert_sample_allowed(ctx, sample)?;
        let r = mod_setup::templates::apply(&ctx.deps.setup_ctx(), &ctx.deps.setup_actor(ctx.principal), key, sample)
            .await
            .map_err(user_err)?;
        Ok(json!({ "created": r["created"], "existing": r["existing"], "sample_records": r["sample_records"] }))
    })
}

/// Phân hệ SẼ bật khi dựng: dựng lại không truyền `features` ⇒ giữ nguyên các phân hệ đang bật.
async fn build_features(
    ctx: &ActionCx<'_>,
    ind: &'static mod_setup::catalog::Industry,
    chosen: Option<&[String]>,
) -> Result<(Vec<&'static str>, Vec<&'static str>), ToolError> {
    let p = ctx.principal;
    let settings = ctx.deps.settings_ctx(p);
    let (built, now): (bool, Vec<(&'static str, Option<bool>)>) = {
        let mut c = ctx.deps.conn(p.company).await?;
        let built: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(SETUP_BUILT_KEY)
            .fetch_optional(&mut *c)
            .await
            .map_err(internal)?;
        let f = mod_settings::features::get(&mut c, settings).await.map_err(user_err)?;
        (built.is_some(), f.0.clone())
    };
    let on_now: Vec<&'static str> = now.iter().filter(|(_, v)| *v == Some(true)).map(|(k, _)| *k).collect();
    let plan: Vec<&'static str> = if chosen.is_none() && built {
        ORG_FEATURES
            .iter()
            .map(|(k, _, _)| *k)
            .filter(|k| on_now.contains(k) || industry::is_locked(k))
            .collect()
    } else {
        industry::resolve_build_features(ind, chosen)
    };
    let off: Vec<&'static str> = on_now.iter().copied().filter(|k| !plan.contains(k)).collect();
    Ok((plan, off))
}

fn feature_label(k: &str) -> String {
    ORG_FEATURES
        .iter()
        .find(|(key, _, _)| *key == k)
        .map_or_else(|| k.to_owned(), |(_, l, _)| (*l).to_owned())
}

pub(crate) static SETUP_BUILD: ActionDef = ActionDef {
    name: "setup_build",
    label: "Dựng hệ thống theo loại doanh nghiệp",
    permissions: MANAGE_FEATURES,
    prepare: setup_build_prepare,
    execute: setup_build_execute,
    structure: true,
};

fn chosen_features(v: &Value) -> Option<Vec<String>> {
    v.get("features")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
}

fn setup_build_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = args.get("industry").and_then(Value::as_str).unwrap_or_default();
        let Some(ind) = industry::find(key) else {
            return Err(user(format!(
                "Loại doanh nghiệp không hợp lệ. Chọn một trong: {}.",
                industry::industry_keys().join(", ")
            )));
        };
        let chosen = chosen_features(args);
        let (plan, off) = build_features(ctx, ind, chosen.as_deref()).await?;
        let tpl = ind.template.as_deref().and_then(find_template);
        let live = live_keys(ctx).await?;
        let fresh: Vec<&TObject> = tpl
            .map(|t| t.objects.iter().filter(|o| !live.contains(&o.key)).collect())
            .unwrap_or_default();
        let mut preview = template_details(&fresh);
        if !off.is_empty() {
            preview.extend(line(
                "Phân hệ sẽ TẮT",
                off.iter().map(|k| feature_label(k)).collect::<Vec<_>>().join(", "),
                600,
            ));
        }
        if (!fresh.is_empty() || !off.is_empty()) && !is_user_confirmation(confirmation(args)) {
            assert_confirmed(confirmation(args), &preview)?;
        }
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Loại doanh nghiệp", ind.label.clone(), 600));
        details.extend(line(
            "Bảng sẽ tạo",
            if fresh.is_empty() {
                "(không)".to_owned()
            } else {
                fresh
                    .iter()
                    .map(|o| o.label_plural.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            },
            600,
        ));
        details.extend(line(
            "Phân hệ bật",
            plan.iter().map(|k| feature_label(k)).collect::<Vec<_>>().join(", "),
            600,
        ));
        details.extend(line(
            "Dữ liệu mẫu",
            "Vài dòng giả, tự xoá khi có bản ghi thật đầu tiên",
            600,
        ));
        let summary = format!(
            "Dựng hệ thống “{}”: {} bảng mới, {} phân hệ bật{}",
            ind.label,
            fresh.len(),
            plan.len(),
            if off.is_empty() {
                String::new()
            } else {
                format!(", tắt {}", off.len())
            }
        );
        Ok(prepared(
            json!({ "industry": ind.key, "features": chosen, "resolved": plan }),
            &summary,
            &details,
            None,
        ))
    })
}

fn setup_build_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let key = params.get("industry").and_then(Value::as_str).unwrap_or_default();
        let input = BuildInput {
            industry: key.to_owned(),
            features: chosen_features(params),
        };
        let r = mod_setup::build::build(&ctx.deps.setup_ctx(), &ctx.deps.setup_actor(ctx.principal), &input)
            .await
            .map_err(user_err)?;
        let n = |k: &str| r[k].as_u64().unwrap_or(0);
        Ok(json!({
            "industry": r["industry"], "created_objects": r["created_objects"], "kept_objects": r["existing_objects"],
            "sample_records": n("sample_records") + n("sample_contacts"),
        }))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// propose_workspace
// ---------------------------------------------------------------------------------------------------------------------

struct PackageView {
    object: String,
    type_words: Option<String>,
    spec: views::ViewSpec,
}

struct Package {
    title: String,
    objects: Vec<ObjectSpec>,
    views: Vec<PackageView>,
    menu: Option<Vec<MenuEntry>>,
    features: Vec<String>,
}

fn parse_features(raw: Option<&Value>) -> Result<Vec<String>, ToolError> {
    let Some(a) = raw.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let a = a
        .as_array()
        .ok_or_else(|| user("features phải là danh sách khoá tính năng."))?;
    let mut out: Vec<String> = Vec::new();
    for k in a {
        let key = k.as_str().map_or_else(|| k.to_string(), str::to_owned);
        if !is_org_feature_key(&key) {
            return Err(user(format!(
                "Tính năng “{}” không có. Dùng: {}.",
                key.chars().take(40).collect::<String>(),
                ORG_FEATURES
                    .iter()
                    .map(|(k, l, _)| format!("{k} ({l})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        if !out.contains(&key) {
            out.push(key);
        }
    }
    Ok(out)
}

fn parse_package(args: &Value) -> Result<Package, ToolError> {
    let title = clean_text(args.get("title"), 150);
    if title.is_empty() {
        return Err(user("Cần title cho gói dựng."));
    }
    let raw = args
        .get("objects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw.is_empty() || raw.len() > MAX_PACKAGE_OBJECTS {
        return Err(user(format!("Gói cần 1–{MAX_PACKAGE_OBJECTS} bảng.")));
    }
    let objects = raw.iter().map(parse_object).collect::<Result<Vec<_>, _>>()?;
    let raw_views = args.get("views").and_then(Value::as_array).cloned().unwrap_or_default();
    if raw_views.len() > MAX_PACKAGE_VIEWS {
        return Err(user(format!("Gói tối đa {MAX_PACKAGE_VIEWS} màn xem.")));
    }
    let views = raw_views
        .iter()
        .map(|v| {
            Ok(PackageView {
                object: clean_text(v.get("object"), 48),
                type_words: v
                    .get("type_words")
                    .and_then(Value::as_str)
                    .map(|s| s.chars().take(200).collect()),
                spec: parse_view(v)?,
            })
        })
        .collect::<Result<Vec<_>, ToolError>>()?;
    let menu = match args.get("menu") {
        None | Some(Value::Null) => None,
        m => Some(parse_menu(m)?),
    };
    Ok(Package {
        title,
        objects,
        views,
        menu,
        features: parse_features(args.get("features"))?,
    })
}

/// Menu mặc định: mỗi bảng mới một mục, ưu tiên màn kanban đầu tiên của bảng.
fn default_menu(p: &Package) -> Vec<MenuEntry> {
    p.objects
        .iter()
        .map(|o| MenuEntry {
            object: o.key.clone(),
            view: p
                .views
                .iter()
                .find(|v| v.object == o.key && v.spec.kind == "kanban")
                .map(|v| v.spec.key.clone()),
            roles: None,
        })
        .collect()
}

/// Vai trò trong menu phải CÓ THẬT ngay lúc đề xuất.
async fn check_roles(ctx: &ActionCx<'_>, menu: &[MenuEntry]) -> Result<(), ToolError> {
    let mut wanted: Vec<String> = Vec::new();
    for r in menu.iter().flat_map(|m| m.roles.iter().flatten()) {
        let r = r.trim().to_owned();
        if !r.is_empty() && !wanted.iter().any(|w| w.eq_ignore_ascii_case(&r)) {
            wanted.push(r);
        }
    }
    if wanted.is_empty() {
        return Ok(());
    }
    let roles: Vec<String> = {
        let mut c = ctx.deps.conn(ctx.principal.company).await?;
        sqlx::query_scalar("SELECT name FROM roles ORDER BY id ASC LIMIT 100")
            .fetch_all(&mut *c)
            .await
            .map_err(internal)?
    };
    let have: HashSet<String> = roles.iter().map(|r| r.trim().to_lowercase()).collect();
    let missing: Vec<String> = wanted
        .into_iter()
        .filter(|r| !have.contains(&r.to_lowercase()))
        .map(|r| format!("“{}”", r.chars().take(60).collect::<String>()))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(user(format!(
        "Menu: không có vai trò {}. Vai trò hiện có: {}. Hãy dùng đúng tên vai trò có sẵn, bỏ trống roles (mọi người thấy), \
         hoặc nhờ quản trị viên tạo vai trò ở Cài đặt › Vai trò rồi đề xuất lại.",
        missing.join(", "),
        if roles.is_empty() {
            "(chưa có)".to_owned()
        } else {
            roles.join(", ")
        }
    )))
}

/// Kiểm cả gói KHÔNG ghi: bảng, màn (bảng tồn tại, loại màn do người dùng chọn, bảng có sẵn kiểm cả cấu hình), menu trỏ đúng chỗ.
async fn check_package(ctx: &ActionCx<'_>, p: &Package) -> Result<(), ToolError> {
    check_objects(ctx, &p.objects).await?;
    let mut seen: Vec<(String, String)> = Vec::new();
    for v in &p.views {
        let in_pack = p.objects.iter().find(|o| o.key == v.object);
        let (names, def) = match in_pack {
            Some(o) => (
                table_names(&o.key, &o.label, &o.label_plural, Some(&v.spec.label)),
                None,
            ),
            None => {
                let d = load_def(ctx, &v.object).await.map_err(|_| {
                    user(format!(
                        "View “{}”: không có bảng “{}” (trong gói hoặc có sẵn).",
                        v.spec.label, v.object
                    ))
                })?;
                (
                    table_names(&d.obj.key, &d.obj.label, &d.obj.label_plural, Some(&v.spec.label)),
                    Some(d),
                )
            }
        };
        assert_type_chosen(&v.spec.kind, v.type_words.as_deref(), &names)?;
        if seen.iter().any(|(o, k)| *o == v.object && *k == v.spec.key) {
            return Err(user(format!(
                "Bảng “{}” có hai màn trùng khoá “{}”.",
                v.object, v.spec.key
            )));
        }
        if let Some(d) = def {
            let taken: Vec<String> = {
                let mut c = ctx.deps.conn(ctx.principal.company).await?;
                sqlx::query_scalar("SELECT key FROM custom_views WHERE object_id = $1 AND deleted_at IS NULL")
                    .bind(d.obj.id)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(internal)?
            };
            let mut all = taken;
            all.extend(seen.iter().filter(|(o, _)| *o == v.object).map(|(_, k)| k.clone()));
            views::check(&d, &v.spec, &all).map_err(|e| user(app_msg(e)))?;
        }
        seen.push((v.object.clone(), v.spec.key.clone()));
    }
    let menu = p.menu.clone().unwrap_or_else(|| default_menu(p));
    check_roles(ctx, &menu).await?;
    let mut known = live_keys(ctx).await?;
    known.extend(p.objects.iter().map(|o| o.key.clone()));
    for m in &menu {
        if !known.contains(&m.object) {
            return Err(user(format!("Menu: không có bảng “{}”.", m.object)));
        }
        if let Some(view) = &m.view
            && !p.views.iter().any(|v| v.object == m.object && v.spec.key == *view)
        {
            let n: i64 = {
                let mut c = ctx.deps.conn(ctx.principal.company).await?;
                sqlx::query_scalar(
                    "SELECT count(*) FROM custom_views v JOIN custom_objects o ON o.id = v.object_id \
                     WHERE v.key = $1 AND v.deleted_at IS NULL AND o.key = $2 AND o.deleted_at IS NULL",
                )
                .bind(view)
                .bind(&m.object)
                .fetch_one(&mut *c)
                .await
                .map_err(internal)?
            };
            if n == 0 {
                return Err(user(format!("Menu: bảng “{}” không có view “{view}”.", m.object)));
            }
        }
    }
    Ok(())
}

fn describe(p: &Package, blank: bool) -> Vec<Detail> {
    let menu = p.menu.clone().unwrap_or_else(|| default_menu(p));
    let mut out = object_details(&p.objects);
    let vs = p
        .views
        .iter()
        .map(|v| format!("{} ({})", v.spec.label, describe_view(&v.spec)))
        .collect::<Vec<_>>()
        .join("; ");
    out.extend(line(
        "Màn xem",
        if vs.is_empty() {
            "(chỉ danh sách mặc định)".to_owned()
        } else {
            vs
        },
        900,
    ));
    out.extend(line(
        "Menu",
        menu.iter()
            .map(|m| match &m.view {
                Some(v) => format!("{}/{v}", m.object),
                None => m.object.clone(),
            })
            .collect::<Vec<_>>()
            .join(" · "),
        900,
    ));
    let on = p
        .features
        .iter()
        .map(|k| feature_label(k))
        .collect::<Vec<_>>()
        .join(", ");
    out.extend(line(
        if blank {
            "Module bật (còn lại TẮT)"
        } else {
            "Module bật thêm"
        },
        if on.is_empty() { "(không)".to_owned() } else { on },
        900,
    ));
    out
}

/// Ảnh chụp menu (`show_in_nav`, `nav_order`) để trả lại nếu dựng lỗi giữa chừng.
struct NavSnapshot {
    objects: Vec<(i32, bool, i32)>,
    views: Vec<(i32, bool, i32)>,
}

async fn snapshot_nav(ctx: &ActionCx<'_>) -> Result<NavSnapshot, ToolError> {
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    let objects = sqlx::query_as("SELECT id, show_in_nav, nav_order FROM custom_objects WHERE deleted_at IS NULL")
        .fetch_all(&mut *c)
        .await
        .map_err(internal)?;
    let views = sqlx::query_as("SELECT id, show_in_nav, nav_order FROM custom_views WHERE deleted_at IS NULL")
        .fetch_all(&mut *c)
        .await
        .map_err(internal)?;
    Ok(NavSnapshot { objects, views })
}

async fn restore_nav(ctx: &ActionCx<'_>, s: &NavSnapshot) {
    let Ok(mut c) = ctx.deps.conn(ctx.principal.company).await else {
        return;
    };
    for (table, rows) in [("custom_objects", &s.objects), ("custom_views", &s.views)] {
        for (id, nav, ord) in rows {
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE {table} SET show_in_nav = $2, nav_order = $3 WHERE id = $1"
            )))
            .bind(id)
            .bind(nav)
            .bind(ord)
            .execute(&mut *c)
            .await;
        }
    }
}

async fn read_features_raw(ctx: &ActionCx<'_>) -> Result<Option<String>, ToolError> {
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    sqlx::query_scalar("SELECT value FROM settings WHERE key = 'org_features'")
        .fetch_optional(&mut *c)
        .await
        .map_err(internal)
}

async fn restore_features_raw(ctx: &ActionCx<'_>, raw: Option<&str>) {
    let Ok(mut c) = ctx.deps.conn(ctx.principal.company).await else {
        return;
    };
    let _ = match raw {
        None => {
            sqlx::query("DELETE FROM settings WHERE key = 'org_features'")
                .execute(&mut *c)
                .await
        }
        Some(v) => {
            sqlx::query("UPDATE settings SET value = $1 WHERE key = 'org_features'")
                .bind(v)
                .execute(&mut *c)
                .await
        }
    };
}

/// Bật/tắt phân hệ: hệ thống mới ⇒ bộ cơ bản + phân hệ AI chọn bật, còn lại TẮT; hệ thống đang chạy ⇒ chỉ bật thêm.
async fn apply_features(ctx: &ActionCx<'_>, keys: &[String], blank: bool) -> Result<(), ToolError> {
    let mut m = Map::new();
    if blank {
        for (k, _, _) in ORG_FEATURES.iter() {
            m.insert(
                (*k).to_owned(),
                json!(BASIC_FEATURES.contains(k) || keys.iter().any(|x| x.as_str() == *k)),
            );
        }
    } else if keys.is_empty() {
        return Ok(());
    } else {
        for k in keys {
            m.insert(k.clone(), json!(true));
        }
    }
    let dto = validate_org_features(&Value::Object(m)).map_err(|e| user(format!("{e:?}")))?;
    let p = ctx.principal;
    let settings = ctx.deps.settings_ctx(p);
    let mut c = ctx.deps.conn(p.company).await?;
    mod_settings::features::update(&mut c, settings, &dto, p.user_id)
        .await
        .map_err(user_err)?;
    Ok(())
}

async fn build_package(
    ctx: &ActionCx<'_>,
    p: &Package,
    status: &str,
    created: &mut Vec<String>,
) -> Result<(), ToolError> {
    let user_id = ctx.principal.user_id;
    *created = apply_objects(ctx, &p.objects).await?;
    for v in &p.views {
        let def = load_def(ctx, &v.object).await?;
        let mut tx = ctx
            .deps
            .custom_ctx()
            .begin(ctx.principal.company)
            .await
            .map_err(user_err)?;
        views::create(&mut tx, &def, &v.spec, user_id).await.map_err(user_err)?;
        tx.commit().await.map_err(internal)?;
    }
    let menu = p.menu.clone().unwrap_or_else(|| default_menu(p));
    {
        let mut tx = ctx
            .deps
            .custom_ctx()
            .begin(ctx.principal.company)
            .await
            .map_err(user_err)?;
        mod_custom::menu::apply(&mut tx, &menu, user_id)
            .await
            .map_err(user_err)?;
        tx.commit().await.map_err(internal)?;
    }
    apply_features(ctx, &p.features, status == "chua_dung").await?;
    if status != "da_dung" {
        let mut c = ctx.deps.conn(ctx.principal.company).await?;
        mod_setup::status::set(&mut c, "dang_dung", Some(user_id))
            .await
            .map_err(user_err)?;
    }
    Ok(())
}

async fn execute_package(ctx: &ActionCx<'_>, p: &Package) -> Result<Value, ToolError> {
    let status: String = {
        let mut c = ctx.deps.conn(ctx.principal.company).await?;
        mod_setup::status::get(&mut c).await.to_owned()
    };
    let features_before = read_features_raw(ctx).await?;
    let nav = snapshot_nav(ctx).await?;
    let mut created: Vec<String> = Vec::new();
    if let Err(e) = build_package(ctx, p, &status, &mut created).await {
        // Xoá HẲN mọi bảng của gói vừa tạo trong lượt này (cascade trường + màn), trả menu + tính năng + trạng thái về như cũ.
        let keys: Vec<String> = p.objects.iter().map(|o| o.key.clone()).collect();
        purge_created(ctx, &keys).await;
        restore_nav(ctx, &nav).await;
        restore_features_raw(ctx, features_before.as_deref()).await;
        if let Ok(mut c) = ctx.deps.conn(ctx.principal.company).await {
            let back: &'static str = mod_setup::status::resolve_status(Some(&status));
            let _ = mod_setup::status::set(&mut c, back, Some(ctx.principal.user_id)).await;
        }
        return Err(e);
    }
    let menu = p.menu.clone().unwrap_or_else(|| default_menu(p));
    let open_at = menu.first().map_or_else(
        || "/bat-dau".to_owned(),
        |f| match &f.view {
            Some(v) => format!("/x/{}/v/{v}", f.object),
            None => format!("/x/{}", f.object),
        },
    );
    Ok(json!({
        "created_objects": created,
        "views": p.views.iter().map(|v| format!("{}/{}", v.object, v.spec.key)).collect::<Vec<_>>(),
        "setup_status": if status == "da_dung" { "da_dung" } else { "dang_dung" },
        "open_at": open_at,
    }))
}

pub(crate) static PROPOSE_WORKSPACE: ActionDef = ActionDef {
    name: "propose_workspace",
    label: "Dựng gói bảng + màn xem + menu",
    permissions: MANAGE_FEATURES,
    prepare: propose_workspace_prepare,
    execute: propose_workspace_execute,
    structure: true,
};

/// Phần của lời gọi được giữ trong đề xuất (bỏ `confirmed_by_user`): chạy lại bằng đúng [`parse_package`].
fn package_params(args: &Value) -> Value {
    let mut m = Map::new();
    for k in ["title", "objects", "views", "menu", "features"] {
        if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
            m.insert(k.to_owned(), v.clone());
        }
    }
    Value::Object(m)
}

fn propose_workspace_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let p = parse_package(args)?;
        check_package(ctx, &p).await?;
        let blank = {
            let mut c = ctx.deps.conn(ctx.principal.company).await?;
            mod_setup::status::get(&mut c).await == "chua_dung"
        };
        let details = describe(&p, blank);
        assert_confirmed(confirmation(args), &details)?;
        let summary = format!(
            "Dựng gói “{}”: {} bảng ({}), {} màn xem{}",
            p.title,
            p.objects.len(),
            p.objects
                .iter()
                .map(|o| o.label.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            p.views.len(),
            if p.features.is_empty() {
                String::new()
            } else {
                format!(", bật {} module", p.features.len())
            }
        );
        Ok(prepared(package_params(args), &summary, &details, None))
    })
}

fn propose_workspace_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let p = parse_package(params)?;
        check_package(ctx, &p).await?;
        execute_package(ctx, &p).await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_goi() {
        let p = parse_package(&json!({
            "title": "CRM bán lẻ",
            "objects": [{ "label": "Đơn hàng", "fields": [{ "label": "Mã", "type": "text" }, { "label": "Trạng thái", "type": "select", "choices": ["Mới", "Xong"] }] }],
            "views": [{ "object": "don_hang", "label": "Pipeline", "type": "kanban", "type_words": "kanban", "group_by": "trang_thai" }],
            "features": ["pos", "pos"],
        }))
        .unwrap();
        assert_eq!((p.objects.len(), p.views.len(), p.features.len()), (1, 1, 1));
        let m = default_menu(&p);
        assert_eq!(
            (m[0].object.as_str(), m[0].view.as_deref()),
            ("don_hang", Some("pipeline"))
        );
        assert!(
            describe(&p, true)
                .iter()
                .any(|(l, _)| l.starts_with("Module bật (còn lại TẮT)"))
        );
    }

    #[test]
    fn goi_sai() {
        assert!(parse_package(&json!({ "title": "x", "objects": [] })).is_err());
        assert!(parse_package(&json!({ "objects": [{ "label": "A" }] })).is_err());
        assert!(parse_features(Some(&json!(["khong_co"]))).is_err());
        assert!(parse_features(Some(&json!("pos"))).is_err());
        assert!(parse_features(None).unwrap().is_empty());
    }

    #[test]
    fn goi_giu_nguyen_qua_params() {
        let args = json!({
            "title": "CRM", "confirmed_by_user": "ok", "agent": "claude",
            "objects": [{ "label": "Đơn", "fields": [{ "label": "Mã", "type": "text" }] }],
            "views": [], "features": ["pos"],
        });
        let params = package_params(&args);
        assert!(params.get("confirmed_by_user").is_none() && params.get("agent").is_none());
        let p = parse_package(&params).unwrap();
        assert_eq!((p.title.as_str(), p.objects.len(), p.features.len()), ("CRM", 1, 1));
        assert!(p.menu.is_none());
    }
}
