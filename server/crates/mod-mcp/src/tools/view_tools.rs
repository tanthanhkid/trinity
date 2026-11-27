//! Tool GHI màn xem và menu (M43): `create_view`, `update_view`, `set_menu` (`action-view-tools.ts`). Loại màn luôn do người dùng
//! chọn: `type_words` phải gọi tên đúng loại (sau khi bỏ tên bảng/tên màn khỏi câu). `update_view` có `remove=true` là xoá mềm.

use mod_custom::menu::{self, MenuEntry};
use mod_custom::values::slugify_key;
use mod_custom::views::{self, VIEW_TYPES, ViewSpec};
use serde_json::{Map, Value, json};

use super::structure::{app_msg, load_def};
use super::write::{
    Detail, Prepared, assert_direct, clean_text, fold_words, internal, line, opt_clean, run_direct, user, user_err,
};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const VIEW_TYPE_WORDS: [(&str, &[&str]); 4] = [
    ("list", &["danh sach", "list", "liet ke", "tung dong"]),
    (
        "kanban",
        &[
            "kanban",
            "pipeline",
            "keo tha",
            "keo the",
            "chia cot",
            "theo cot",
            "dang cot",
            "theo trang thai",
            "theo giai doan",
            "theo buoc",
            "board",
            "trello",
        ],
    ),
    ("calendar", &["lich", "calendar", "theo ngay", "theo thang", "theo tuan"]),
    (
        "table",
        &[
            "bang sua nhanh",
            "sua nhanh",
            "bang tinh",
            "sua tai o",
            "sua tren o",
            "kieu bang",
            "dang bang",
            "bang excel",
            "excel",
            "table",
            "spreadsheet",
            "sheet",
        ],
    ),
];

/// Các loại màn mà lời người dùng gọi tên, sau khi bỏ tên bảng/màn (`ignore`) khỏi câu (`viewTypesInWords`).
pub(super) fn view_types_in_words(words: Option<&str>, ignore: &[String]) -> Vec<&'static str> {
    let mut w = format!(" {} ", fold_words(words.unwrap_or_default()));
    for raw in ignore {
        let n = fold_words(raw);
        if !n.is_empty() {
            w = w.replace(&format!(" {n} "), " ");
        }
    }
    VIEW_TYPE_WORDS
        .iter()
        .filter(|(_, ks)| ks.iter().any(|k| w.contains(&format!(" {k} "))))
        .map(|(t, _)| *t)
        .collect()
}

/// Lời người dùng không gọi tên loại màn `kind` ⇒ từ chối kèm 4 loại để hỏi lại (`assertTypeChosen`).
pub(super) fn assert_type_chosen(kind: &str, words: Option<&str>, ignore: &[String]) -> Result<(), ToolError> {
    if view_types_in_words(words, ignore).contains(&kind) {
        return Ok(());
    }
    let said = match words.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => format!("“{}”", w.chars().take(80).collect::<String>()),
        None => "(trống)".to_owned(),
    };
    Err(user(format!(
        "Chưa tạo màn: lời người dùng {said} không nêu loại màn “{kind}”. Loại màn do người dùng chọn; 4 loại Trinity có: {}. \
         type_words là chính lời người dùng gọi tên loại màn (vd \"kanban\", \"dạng lịch\", \"danh sách\", \"bảng sửa nhanh\"). / \
         Screen not created: the user's words {said} do not name the \"{kind}\" type. The user picks one of: {}; type_words carries the user's own words for it.",
        views::view_types_line(),
        VIEW_TYPES.join(", ")
    )))
}

/// Tên bảng/màn để bỏ khỏi lời người dùng trước khi tìm tên loại màn.
pub(super) fn table_names(key: &str, label: &str, label_plural: &str, view_label: Option<&str>) -> Vec<String> {
    let mut v = vec![label.to_owned(), label_plural.to_owned(), key.replace('_', " ")];
    v.extend(view_label.map(str::to_owned));
    v.retain(|s| !s.is_empty());
    v
}

fn flag(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(Value::as_bool)
}

/// `parseView`: một màn theo cách AI mô tả → `ViewSpec` (config chưa chuẩn hoá; `views::check` làm việc đó).
pub(super) fn parse_view(raw: &Value) -> Result<ViewSpec, ToolError> {
    let label = clean_text(raw.get("label"), 100);
    if label.is_empty() {
        return Err(user("View cần có tên (label)."));
    }
    let kind = raw.get("type").and_then(Value::as_str).unwrap_or_default();
    if !VIEW_TYPES.contains(&kind) {
        return Err(user(views::unsupported_view_type_message(raw.get("type").and_then(Value::as_str))));
    }
    let key = opt_clean(raw.get("key"), 48).unwrap_or_else(|| slugify_key(&label));
    let list = |k: &str| {
        raw.get(k)
            .and_then(Value::as_array)
            .map(|a| Value::Array(a.iter().map(|x| json!(clean_text(Some(x), 48))).collect()))
    };
    let mut cfg = Map::new();
    if let Some(g) = opt_clean(raw.get("group_by"), 48) {
        cfg.insert("group_by".into(), json!(g));
    }
    for k in ["card_fields", "columns"] {
        if let Some(l) = list(k) {
            cfg.insert(k.into(), l);
        }
    }
    if let Some(d) = opt_clean(raw.get("date_field"), 48) {
        cfg.insert("date_field".into(), json!(d));
    }
    if let Some(m) = raw.get("mode").and_then(Value::as_str).filter(|m| *m == "week" || *m == "month") {
        cfg.insert("mode".into(), json!(m));
    }
    if let Some(f) = opt_clean(raw.get("sort_field"), 48) {
        let dir = if raw.get("sort_dir").and_then(Value::as_str) == Some("desc") { "desc" } else { "asc" };
        cfg.insert("sort".into(), json!({ "field": f, "dir": dir }));
    }
    Ok(ViewSpec {
        key,
        label,
        kind: kind.to_owned(),
        config: Value::Object(cfg),
        icon: opt_clean(raw.get("icon"), 48),
        show_in_nav: Some(flag(raw, "show_in_nav") == Some(true)),
    })
}

/// Câu mô tả cấu hình màn (`describeView`).
pub(super) fn describe_view(s: &ViewSpec) -> String {
    let c = |k: &str| s.config.get(k).and_then(Value::as_str).unwrap_or("undefined").to_owned();
    match s.kind.as_str() {
        "kanban" => format!("Kanban theo “{}”", c("group_by")),
        "calendar" => format!(
            "Lịch ({}) theo “{}”",
            if c("mode") == "week" { "tuần" } else { "tháng" },
            c("date_field")
        ),
        "table" => "Bảng sửa nhanh".to_owned(),
        _ => "Danh sách".to_owned(),
    }
}

pub(super) fn create_view<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        assert_direct(ctx).await?;
        let key = clean_text(args.get("object"), 48);
        let def = load_def(ctx, &key).await?;
        let spec = parse_view(args)?;
        let ignore = table_names(&def.obj.key, &def.obj.label, &def.obj.label_plural, Some(&spec.label));
        assert_type_chosen(&spec.kind, args.get("type_words").and_then(Value::as_str), &ignore)?;
        let taken: Vec<String> = {
            let mut c = ctx.deps.conn(ctx.principal.company).await?;
            sqlx::query_scalar("SELECT key FROM custom_views WHERE object_id = $1 AND deleted_at IS NULL")
                .bind(def.obj.id)
                .fetch_all(&mut *c)
                .await
                .map_err(internal)?
        };
        let ok = views::check(&def, &spec, &taken).map_err(user_err)?;
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Bảng", format!("{} [{key}]", def.obj.label), 600));
        details.extend(line("Màn", format!("{} [{}]", ok.label, ok.key), 600));
        details.extend(line("Kiểu", describe_view(&ok), 600));
        details.extend(line("Cấu hình", ok.config.to_string(), 600));
        let prepared = Prepared {
            params: json!({ "object": key, "view": { "key": ok.key, "label": ok.label, "type": ok.kind } }),
            summary: format!("Tạo màn “{}” cho bảng “{}”: {}", ok.label, def.obj.label, describe_view(&ok)),
            details,
        };
        run_direct(ctx, "create_view", false, prepared, async {
            let mut tx = ctx.deps.custom_ctx().begin(ctx.principal.company).await.map_err(user_err)?;
            let v = views::create(&mut tx, &def, &ok, ctx.principal.user_id).await.map_err(user_err)?;
            tx.commit().await.map_err(internal)?;
            Ok(json!({ "view": v.key, "open_at": format!("/x/{}/v/{}", def.obj.key, v.key) }))
        })
        .await
    })
}

pub(super) fn update_view<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        assert_direct(ctx).await?;
        let key = clean_text(args.get("object"), 48);
        let view_key = clean_text(args.get("view"), 48);
        let def = load_def(ctx, &key).await?;
        let cur = {
            let (cctx, actor) = (ctx.deps.custom_ctx(), ctx.deps.custom_actor(ctx.principal));
            views::get(&cctx, &actor, &key, &view_key).await.map_err(|e| {
                user(format!("Bảng “{}” không có view “{view_key}”. ({})", def.obj.label, app_msg(e)))
            })?
        };
        let cur_label = cur["label"].as_str().unwrap_or_default().to_owned();
        let cur_type = cur["type"].as_str().unwrap_or("list").to_owned();
        let remove = flag(args, "remove") == Some(true);
        let c = &cur["config"];
        let pick = |k: &str| args.get(k).filter(|v| !v.is_null()).or_else(|| c.get(k)).cloned().unwrap_or(Value::Null);
        let merged_raw = json!({
            "key": view_key,
            "label": args.get("label").cloned().unwrap_or_else(|| json!(cur_label)),
            "type": args.get("type").cloned().unwrap_or_else(|| json!(cur_type)),
            "group_by": pick("group_by"), "card_fields": pick("card_fields"), "columns": pick("columns"),
            "date_field": pick("date_field"), "mode": pick("mode"),
            "sort_field": args.get("sort_field").cloned().or_else(|| c["sort"].get("field").cloned()).unwrap_or(Value::Null),
            "sort_dir": args.get("sort_dir").cloned().or_else(|| c["sort"].get("dir").cloned()).unwrap_or(Value::Null),
            "icon": args.get("icon").cloned().unwrap_or_else(|| cur["icon"].clone()),
            "show_in_nav": args.get("show_in_nav").cloned().unwrap_or_else(|| cur["show_in_nav"].clone()),
        });
        let merged = parse_view(&merged_raw)?;
        let changed_type = args.get("type").and_then(Value::as_str).is_some_and(|t| t != cur_type);
        if !remove && changed_type {
            let ignore = table_names(&def.obj.key, &def.obj.label, &def.obj.label_plural, Some(&cur_label));
            assert_type_chosen(&merged.kind, args.get("type_words").and_then(Value::as_str), &ignore)?;
        }
        let checked = if remove {
            None
        } else {
            Some(views::check(&def, &merged, &[]).map_err(user_err)?)
        };
        let patch = match &checked {
            None => json!({ "is_deleted": true }),
            Some(m) => {
                let mut p = json!({ "label": m.label, "type": m.kind, "config": m.config });
                if args.get("icon").is_some() {
                    p["icon"] = json!(m.icon);
                }
                if let Some(b) = flag(args, "show_in_nav") {
                    p["show_in_nav"] = json!(b);
                }
                p
            }
        };
        let summary = match &checked {
            None => format!("XOÁ màn “{cur_label}” của bảng “{}”", def.obj.label),
            Some(m) => format!(
                "Sửa màn “{}” của bảng “{}”: {}",
                if m.label != cur_label { format!("{cur_label} → {}", m.label) } else { cur_label.clone() },
                def.obj.label,
                describe_view(m)
            ),
        };
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Bảng", format!("{} [{key}]", def.obj.label), 600));
        details.extend(line("Màn", format!("{cur_label} [{view_key}]"), 600));
        details.extend(line("Thay đổi", patch.to_string(), 600));
        let prepared = Prepared { params: json!({ "object": key, "view": view_key, "patch": patch }), summary, details };
        run_direct(ctx, "update_view", false, prepared, async {
            let mut tx = ctx.deps.custom_ctx().begin(ctx.principal.company).await.map_err(user_err)?;
            views::update(&mut tx, &def, &view_key, &patch, ctx.principal.user_id)
                .await
                .map_err(user_err)?;
            tx.commit().await.map_err(internal)?;
            Ok(json!({ "view": view_key, "open_at": format!("/x/{}/v/{view_key}", def.obj.key) }))
        })
        .await
    })
}

/// `parseMenu`.
pub(super) fn parse_menu(raw: Option<&Value>) -> Result<Vec<MenuEntry>, ToolError> {
    let arr = raw
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| user("menu cần ít nhất một mục {object, view?}."))?;
    Ok(arr
        .iter()
        .map(|o| MenuEntry {
            object: clean_text(o.get("object"), 48),
            view: opt_clean(o.get("view"), 48),
            roles: o.get("roles").and_then(Value::as_array).map(|a| {
                a.iter()
                    .map(|x| clean_text(Some(x), 100))
                    .filter(|s| !s.is_empty())
                    .collect()
            }),
        })
        .collect())
}

pub(super) fn set_menu<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        assert_direct(ctx).await?;
        let entries = parse_menu(args.get("menu"))?;
        let details: Vec<Detail> = entries
            .iter()
            .enumerate()
            .filter_map(|(i, e)| {
                let roles = e.roles.as_ref().map(|r| format!(" — vai trò: {}", r.join(", ")));
                line(
                    &format!("Mục {}", i + 1),
                    format!("{}{}{}", e.object, e.view.as_ref().map(|v| format!(" / {v}")).unwrap_or_default(), roles.unwrap_or_default()),
                    600,
                )
            })
            .collect();
        let prepared = Prepared {
            params: json!({ "menu": entries.iter().map(|e| json!({ "object": e.object, "view": e.view, "roles": e.roles })).collect::<Vec<_>>() }),
            summary: format!(
                "Đặt menu {} mục: {}",
                entries.len(),
                entries.iter().map(|e| e.object.as_str()).collect::<Vec<_>>().join(" · ")
            ),
            details,
        };
        run_direct(ctx, "set_menu", false, prepared, async {
            let mut tx = ctx.deps.custom_ctx().begin(ctx.principal.company).await.map_err(user_err)?;
            let r = menu::apply(&mut tx, &entries, ctx.principal.user_id).await.map_err(user_err)?;
            tx.commit().await.map_err(internal)?;
            Ok(r)
        })
        .await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goi_ten_loai_man() {
        let none: Vec<String> = Vec::new();
        assert_eq!(view_types_in_words(Some("xem dạng lịch"), &none), vec!["calendar"]);
        assert_eq!(view_types_in_words(Some("kéo thả theo trạng thái"), &none), vec!["kanban"]);
        assert!(view_types_in_words(Some("ok tạo đi"), &none).is_empty());
        let ignore = table_names("lich_hen", "Lịch hẹn", "Lịch hẹn", None);
        assert!(view_types_in_words(Some("quản lý lịch hẹn"), &ignore).is_empty());
        assert!(assert_type_chosen("list", Some("danh sách"), &none).is_ok());
        assert!(assert_type_chosen("kanban", Some("danh sách"), &none).is_err());
    }

    #[test]
    fn doc_man_va_menu() {
        let v = parse_view(&json!({
            "label": "Pipeline", "type": "kanban", "group_by": "trang_thai", "card_fields": ["ten"],
            "sort_field": "ten", "sort_dir": "desc", "show_in_nav": true,
        }))
        .unwrap();
        assert_eq!(v.key, "pipeline");
        assert_eq!(v.config["sort"], json!({ "field": "ten", "dir": "desc" }));
        assert_eq!(describe_view(&v), "Kanban theo “trang_thai”");
        assert!(parse_view(&json!({ "label": "x", "type": "gantt" })).is_err());
        assert!(parse_menu(Some(&json!([]))).is_err());
        let m = parse_menu(Some(&json!([{ "object": "khach", "view": "kb", "roles": ["Quản lý", ""] }]))).unwrap();
        assert_eq!((m[0].object.as_str(), m[0].roles.as_ref().map(Vec::len)), ("khach", Some(1)));
    }
}
