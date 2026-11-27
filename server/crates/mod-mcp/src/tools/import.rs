//! Tool GHI nhập liệu hàng loạt (M43): `import_records` (`action-import.ts`, `import-custom.ts`). Một bảng (`object` + `rows`) hoặc
//! tối đa 5 bảng tuỳ biến (`tables`), mỗi lô ≤500 dòng; khách hàng (`object="contacts"`) đi qua `mod-contacts`. Từng dòng đi qua đúng
//! dịch vụ của giao diện web (cùng kiểm dữ liệu, quyền, trùng "duy nhất"); dòng lỗi bị bỏ qua và báo lại trong `result.errors`.
//!
//! Khác bản TS: ghi theo từng dòng (không tất-cả-hoặc-không) và chưa ghép liên kết bằng khoá nghiệp vụ `$key` (liên kết dùng id/mã).

use serde_json::{Map, Value, json};
use trinity_rbac::can;

use super::structure::{app_msg, load_def};
use super::write::{Detail, clean_text, line, prepared, user, user_err};
use crate::actions::{ActionCx, ActionDef, Prepared};
use crate::args::opt_int;
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

const MAX_IMPORT_ROWS: usize = 500;
const MAX_TABLES: usize = 5;
const MAX_REPORTED_ERRORS: usize = 50;
const CONTACT_KEYS: [&str; 9] = [
    "full_name",
    "phone",
    "phone_2",
    "email",
    "job_title",
    "company_name",
    "zalo_account",
    "source_id",
    "stage_id",
];

struct TableIn {
    object: String,
    rows: Vec<Map<String, Value>>,
    mapping: Option<Vec<(String, String)>>,
}

struct RowError {
    row: usize,
    reason: String,
}

fn parse_rows(raw: Option<&Value>) -> Result<Vec<Map<String, Value>>, ToolError> {
    let arr = raw
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| user("rows cần ít nhất 1 dòng {khoá_trường: giá trị}."))?;
    if arr.len() > MAX_IMPORT_ROWS {
        return Err(user(format!(
            "Mỗi lô tối đa {MAX_IMPORT_ROWS} dòng — hãy chia nhỏ và gọi import_records nhiều lần."
        )));
    }
    if raw.is_some_and(|r| r.to_string().contains("\\u0000")) {
        return Err(user("rows chứa ký tự không hợp lệ."));
    }
    arr.iter()
        .enumerate()
        .map(|(i, r)| {
            r.as_object()
                .cloned()
                .ok_or_else(|| user(format!("Dòng {} phải là object {{khoá_trường: giá trị}}.", i + 1)))
        })
        .collect()
}

fn read_mapping(raw: Option<&Value>) -> Option<Vec<(String, String)>> {
    raw.and_then(Value::as_object).map(|m| {
        m.iter()
            .take(60)
            .map(|(k, v)| (clean_text(Some(&json!(k)), 80), clean_text(Some(v), 48)))
            .collect()
    })
}

fn read_tables(args: &Value) -> Result<Vec<TableIn>, ToolError> {
    if let Some(tables) = args.get("tables").and_then(Value::as_array).filter(|t| !t.is_empty()) {
        if args.get("object").is_some() || args.get("rows").is_some() {
            return Err(user(
                "Dùng MỘT trong hai: object + rows (một bảng) HOẶC tables (nhiều bảng).",
            ));
        }
        if tables.len() > MAX_TABLES {
            return Err(user(format!("Tối đa {MAX_TABLES} bảng mỗi lần.")));
        }
        return tables
            .iter()
            .map(|t| {
                let object = clean_text(t.get("object"), 48);
                if object == "contacts" {
                    return Err(user(
                        "contacts (khách hàng) nhập riêng bằng object=\"contacts\"; trong tables chỉ dùng bảng tuỳ biến.",
                    ));
                }
                Ok(TableIn {
                    object,
                    rows: parse_rows(t.get("rows"))?,
                    mapping: read_mapping(t.get("mapping")),
                })
            })
            .collect();
    }
    Ok(vec![TableIn {
        object: clean_text(args.get("object"), 48),
        rows: parse_rows(args.get("rows"))?,
        mapping: read_mapping(args.get("mapping")),
    }])
}

/// Vài dòng lỗi đầu, vd "dòng 3: …; dòng 7: …".
fn error_preview(errors: &[RowError]) -> String {
    let mut e: Vec<&RowError> = errors.iter().collect();
    e.sort_by_key(|x| x.row);
    e.iter()
        .take(3)
        .map(|x| {
            let r: String = x.reason.chars().take(80).collect();
            format!(
                "dòng {}: {r}{}",
                x.row,
                if x.reason.chars().count() > 80 { "…" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn errors_json(errors: &[RowError], object: Option<&str>) -> Vec<Value> {
    let mut e: Vec<&RowError> = errors.iter().collect();
    e.sort_by_key(|x| x.row);
    e.iter()
        .take(MAX_REPORTED_ERRORS)
        .map(|x| match object {
            Some(o) => json!({ "row": x.row, "reason": x.reason, "object": o }),
            None => json!({ "row": x.row, "reason": x.reason }),
        })
        .collect()
}

fn cut200(s: String) -> String {
    s.chars().take(200).collect()
}

fn source_of(args: &Value) -> String {
    let s = clean_text(args.get("source"), 300);
    if s.is_empty() {
        "(AI không ghi nguồn)".to_owned()
    } else {
        s
    }
}

fn mapping_text(m: &Option<Vec<(String, String)>>, fallback: &Map<String, Value>) -> String {
    match m {
        Some(m) => m
            .iter()
            .map(|(a, b)| format!("{a} → {b}"))
            .collect::<Vec<_>>()
            .join("; "),
        None => fallback.keys().cloned().collect::<Vec<_>>().join(", "),
    }
}

fn phone_ok(p: &str) -> bool {
    let rest = p.strip_prefix("+84").or_else(|| p.strip_prefix('0'));
    rest.is_some_and(|r| r.len() == 9 && r.bytes().all(|b| b.is_ascii_digit()))
}

/// Kiểm một dòng khách như `CreateContactDto` (khoá lạ bị từ chối; SĐT `^(0|\+84)\d{9}$`; tên 1..100; nguồn bắt buộc).
fn contact_row(row: &Map<String, Value>, source_id: Option<i32>) -> Result<mod_contacts::write::CreateContact, String> {
    let extra: Vec<&str> = row
        .keys()
        .map(String::as_str)
        .filter(|k| !CONTACT_KEYS.contains(k))
        .take(5)
        .collect();
    if !extra.is_empty() {
        return Err(format!(
            "cột không thuộc khách hàng: {} (dùng: {})",
            extra.join(", "),
            CONTACT_KEYS.join(", ")
        ));
    }
    let mut plain = Map::new();
    for (k, v) in row {
        plain.insert(
            k.clone(),
            match v {
                Value::String(_) => json!(clean_text(Some(v), 200)),
                other => other.clone(),
            },
        );
    }
    if !plain.contains_key("source_id")
        && let Some(s) = source_id
    {
        plain.insert("source_id".into(), json!(s));
    }
    let name_len = plain
        .get("full_name")
        .and_then(Value::as_str)
        .map_or(0, |s| s.chars().count());
    if !(1..=100).contains(&name_len) {
        return Err("full_name: bắt buộc, 1–100 ký tự".to_owned());
    }
    for k in ["phone", "phone_2"] {
        if let Some(p) = plain.get(k).and_then(Value::as_str)
            && !p.is_empty()
            && !phone_ok(p)
        {
            return Err(format!("{k}: SĐT không hợp lệ (0xxxxxxxxx hoặc +84xxxxxxxxx)"));
        }
    }
    if plain.get("phone").and_then(Value::as_str).is_none() {
        return Err("phone: bắt buộc".to_owned());
    }
    if plain.get("source_id").and_then(Value::as_i64).is_none() {
        return Err("source_id: bắt buộc (list_crm_options)".to_owned());
    }
    serde_json::from_value(Value::Object(plain)).map_err(|e| cut200(format!("dòng không hợp lệ: {e}")))
}

async fn write_contacts(
    ctx: &ActionCx<'_>,
    rows: &[Map<String, Value>],
    source_id: Option<i32>,
) -> Result<Value, ToolError> {
    let p = ctx.principal;
    if !can(&p.grants, "contacts.create", None) {
        return Err(ToolError::Forbidden(
            "Bạn không còn quyền tạo khách hàng (contacts.create).".to_owned(),
        ));
    }
    let scopes = ctx.deps.contact_scopes(p).await?;
    let actor = mod_contacts::Actor {
        user_id: p.user_id,
        is_admin: false,
        email: Some(p.email.clone()),
    };
    let t = ctx
        .deps
        .db
        .tenant(p.company)
        .await
        .map_err(|e| ToolError::Internal(e.to_string()))?;
    let (mut created, mut errors) = (0_usize, Vec::<RowError>::new());
    for (i, r) in rows.iter().enumerate() {
        let one = match contact_row(r, source_id) {
            Ok(dto) => mod_contacts::write::create(&t, &scopes, &actor, &dto)
                .await
                .map(|_| ())
                .map_err(app_msg),
            Err(m) => Err(m),
        };
        match one {
            Ok(()) => created += 1,
            Err(m) => errors.push(RowError {
                row: i + 1,
                reason: cut200(m),
            }),
        }
    }
    if created == 0 {
        return Err(user(format!(
            "Không có dòng nào hợp lệ ({} dòng lỗi). {}",
            errors.len(),
            error_preview(&errors)
        )));
    }
    Ok(json!({
        "object": "contacts", "created": created, "failed": errors.len(), "skipped": 0,
        "errors": errors_json(&errors, None), "error_total": errors.len(), "open_at": "/contacts",
    }))
}

async fn write_table(ctx: &ActionCx<'_>, t: &TableIn, multi: bool) -> Result<(Value, Vec<RowError>), ToolError> {
    let (cctx, actor) = (ctx.deps.custom_ctx(), ctx.deps.custom_actor(ctx.principal));
    let mut codes: Vec<String> = Vec::new();
    let mut errors: Vec<RowError> = Vec::new();
    for (i, r) in t.rows.iter().enumerate() {
        let body = json!({ "data": Value::Object(r.clone()) });
        match mod_custom::records::create(&cctx, &actor, &t.object, &body).await {
            Ok(v) => {
                if let Some(c) = v.get("code").and_then(Value::as_str) {
                    codes.push(c.to_owned());
                }
            }
            Err(e) => match user_err(e) {
                ToolError::Forbidden(m) => return Err(ToolError::Forbidden(m)),
                ToolError::User(m) | ToolError::Http { message: m, .. } => {
                    errors.push(RowError {
                        row: i + 1,
                        reason: cut200(m),
                    });
                }
                other => return Err(other),
            },
        }
    }
    let created = t.rows.len() - errors.len();
    if created == 0 {
        return Err(user(format!(
            "Không có dòng nào hợp lệ{} ({} dòng lỗi). {}",
            if multi {
                format!(" ở bảng “{}”", t.object)
            } else {
                String::new()
            },
            errors.len(),
            error_preview(&errors)
        )));
    }
    let codes_text = if codes.len() > 6 {
        format!("{} … {}", codes[0], codes[codes.len() - 1])
    } else {
        codes.join(", ")
    };
    Ok((
        json!({ "object": t.object, "created": created, "codes": codes_text, "open_at": format!("/x/{}", t.object) }),
        errors,
    ))
}

async fn write_custom(ctx: &ActionCx<'_>, tables: &[TableIn]) -> Result<Value, ToolError> {
    let multi = tables.len() > 1;
    let mut done: Vec<Value> = Vec::new();
    let mut all: Vec<Value> = Vec::new();
    let mut total = 0_usize;
    for t in tables {
        let (res, errs) = write_table(ctx, t, multi).await?;
        total += errs.len();
        all.extend(errors_json(&errs, multi.then_some(t.object.as_str())));
        done.push(res);
    }
    all.truncate(MAX_REPORTED_ERRORS);
    let mut out = if multi {
        let created: u64 = done.iter().map(|d| d["created"].as_u64().unwrap_or(0)).sum();
        json!({ "tables": done, "created": created })
    } else {
        done.remove(0)
    };
    out["skipped"] = json!(total);
    out["errors"] = json!(all);
    out["error_total"] = json!(total);
    Ok(out)
}

pub(crate) static IMPORT_RECORDS: ActionDef = ActionDef {
    name: "import_records",
    label: "Nhập dữ liệu hàng loạt",
    permissions: &["custom_records.manage"],
    prepare: import_prepare,
    execute: import_execute,
    structure: false,
};

fn assert_can_create_contacts(ctx: &ActionCx<'_>) -> Result<(), ToolError> {
    if !can(&ctx.principal.grants, "contacts.create", None) {
        return Err(ToolError::Forbidden(
            "Bạn không có quyền tạo khách hàng (contacts.create).".to_owned(),
        ));
    }
    Ok(())
}

/// Phần của lời gọi được giữ trong đề xuất: dữ liệu thật (`rows`) phải nằm trong `params` để duyệt xong chạy đúng như đã xem.
fn import_params(args: &Value) -> Value {
    let mut m = Map::new();
    for k in ["object", "rows", "mapping", "tables", "source", "source_id"] {
        if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
            m.insert(k.to_owned(), v.clone());
        }
    }
    Value::Object(m)
}

fn import_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let tables = read_tables(args)?;
        let source = source_of(args);
        let total_rows: usize = tables.iter().map(|t| t.rows.len()).sum();
        let mut details: Vec<Detail> = Vec::new();
        let summary;
        let contacts = tables.len() == 1 && tables[0].object == "contacts";
        if contacts {
            assert_can_create_contacts(ctx)?;
            summary = format!("Nhập {total_rows} khách hàng từ {source}");
            details.extend(line("Bảng", "Khách hàng [contacts]", 600));
        } else {
            let mut names: Vec<String> = Vec::new();
            for t in &tables {
                let def = load_def(ctx, &t.object).await?;
                names.push(format!("{} {}", t.rows.len(), def.obj.label_plural));
                details.extend(line("Bảng", format!("{} [{}]", def.obj.label_plural, def.obj.key), 600));
            }
            summary = format!("Nhập {} từ {source}", names.join(" + "));
        }
        details.extend(line("Nguồn", source.clone(), 600));
        details.extend(line("Số dòng", format!("{total_rows} dòng gửi lên"), 600));
        if let Some(t) = tables.first() {
            let m = mapping_text(&t.mapping, t.rows.first().unwrap_or(&Map::new()));
            details.extend(line("Cột ghép", m, 900));
        }
        Ok(prepared(import_params(args), &summary, &details, None))
    })
}

fn import_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let tables = read_tables(params)?;
        if tables.len() == 1 && tables[0].object == "contacts" {
            assert_can_create_contacts(ctx)?;
            write_contacts(ctx, &tables[0].rows, opt_int(params.get("source_id"))).await
        } else {
            write_custom(ctx, &tables).await
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_lo_nhap() {
        let t =
            read_tables(&json!({ "object": "khach", "rows": [{ "a": 1 }, { "a": 2 }], "mapping": { "Tên": "ten" } }))
                .unwrap();
        assert_eq!((t.len(), t[0].rows.len(), t[0].object.as_str()), (1, 2, "khach"));
        assert_eq!(t[0].mapping.as_ref().map(Vec::len), Some(1));
        assert!(read_tables(&json!({ "object": "x", "rows": [] })).is_err());
        assert!(read_tables(&json!({ "object": "x", "rows": [1] })).is_err());
        assert!(
            read_tables(&json!({ "object": "x", "rows": [{}], "tables": [{ "object": "y", "rows": [{}] }] })).is_err()
        );
        assert!(read_tables(&json!({ "tables": [{ "object": "contacts", "rows": [{}] }] })).is_err());
        let many: Vec<Value> = (0..501).map(|_| json!({})).collect();
        assert!(read_tables(&json!({ "object": "x", "rows": many })).is_err());
    }

    #[test]
    fn dong_khach() {
        let ok = json!({ "full_name": "Lan", "phone": "0901234567", "source_id": 3 });
        assert!(contact_row(ok.as_object().unwrap(), None).is_ok());
        let no_src = json!({ "full_name": "Lan", "phone": "+84901234567" });
        assert!(contact_row(no_src.as_object().unwrap(), None).is_err());
        assert!(contact_row(no_src.as_object().unwrap(), Some(2)).is_ok());
        let bad_phone = json!({ "full_name": "Lan", "phone": "12345", "source_id": 1 });
        assert!(contact_row(bad_phone.as_object().unwrap(), None).is_err());
        let extra = json!({ "full_name": "Lan", "phone": "0901234567", "source_id": 1, "x": 1 });
        assert!(
            contact_row(extra.as_object().unwrap(), None)
                .unwrap_err()
                .contains("không thuộc khách hàng")
        );
    }

    #[test]
    fn bao_loi() {
        let e = vec![
            RowError {
                row: 7,
                reason: "b".into(),
            },
            RowError {
                row: 3,
                reason: "a".into(),
            },
        ];
        assert_eq!(error_preview(&e), "dòng 3: a; dòng 7: b");
        assert_eq!(errors_json(&e, Some("khach"))[0]["row"], 3);
    }

    #[test]
    fn de_xuat_giu_du_lieu_that_va_bo_phan_thua() {
        let args = json!({
            "object": "khach", "rows": [{ "a": 1 }], "mapping": { "Tên": "ten" }, "source": "file.csv",
            "confirmed_by_user": "ok", "agent": "claude",
        });
        let p = import_params(&args);
        assert!(p.get("confirmed_by_user").is_none() && p.get("agent").is_none());
        let t = read_tables(&p).unwrap();
        assert_eq!((t.len(), t[0].rows.len(), source_of(&p).as_str()), (1, 1, "file.csv"));
    }
}
