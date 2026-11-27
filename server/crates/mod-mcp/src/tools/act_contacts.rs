//! Thao tác ghi về khách hàng: `create_contact`, `add_contact_note`, `update_contact_stage`, `assign_contact`
//! (`actions/action-contact-tools.ts`). Chạy qua `mod-contacts` (cùng kiểm quyền/phạm vi với giao diện web).

use mod_contacts::write::{CreateContact, UpdateContact};
use mod_custom::refs::{Ref, RefType};
use serde_json::{Map, Value, json};
use trinity_rbac::mask_phone;

use crate::actions::{
    ActionCx, ActionDef, NOTE_MAX, Prepared, bad, clean_text, clean_value, compact, covers, int_or_null, internal, line,
    lines, load_contact, option_label, owner, shown,
};
use crate::args::opt_int;
use crate::deps::{app_err, to_json};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

const PHONE_MSG: &str = "SĐT không hợp lệ. VD: 0900000001 hoặc +84900000001";

/// Chuỗi đã làm sạch, rỗng ⇒ `null` (bị `compact` bỏ).
fn text(args: &Value, key: &str, max: usize) -> Value {
    let s = clean_value(args.get(key), max);
    if s.is_empty() { Value::Null } else { json!(s) }
}

/// `^(0|\+84)\d{9}$`.
fn valid_phone(s: &str) -> bool {
    let rest = s.strip_prefix("+84").or_else(|| s.strip_prefix('0'));
    rest.is_some_and(|r| r.len() == 9 && r.bytes().all(|b| b.is_ascii_digit()))
}

/// Email đủ chặt cho `IsEmail`: một `@`, phần tên và miền không rỗng, miền có dấu chấm ở giữa, không khoảng trắng.
fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && !s.chars().any(char::is_whitespace)
        && s.len() <= 254
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
}

/// Luật của `CreateContactDto` (thông điệp như bản TS).
fn validate_contact(p: &Value) -> Result<(), ToolError> {
    let mut e: Vec<String> = Vec::new();
    match p.get("phone").and_then(Value::as_str) {
        None => {
            e.push("SĐT không được để trống".to_owned());
            e.push(PHONE_MSG.to_owned());
        }
        Some(s) if !valid_phone(s) => e.push(PHONE_MSG.to_owned()),
        Some(_) => {}
    }
    if p.get("full_name").and_then(Value::as_str).is_none() {
        e.push("full_name: phải là chuỗi".to_owned());
        e.push("Họ tên không được để trống".to_owned());
        e.push("Họ tên phải từ 1 đến 100 ký tự".to_owned());
    }
    if p.get("source_id").is_none() {
        e.push("Vui lòng chọn nguồn".to_owned());
        e.push("source_id phải là số nguyên".to_owned());
    }
    if p.get("email")
        .and_then(Value::as_str)
        .is_some_and(|m| !is_email(m))
    {
        e.push("Email không hợp lệ".to_owned());
    }
    if e.is_empty() { Ok(()) } else { Err(bad(e.join("; "))) }
}

fn contact_dto(params: &Value) -> Result<CreateContact, ToolError> {
    validate_contact(params)?;
    serde_json::from_value(params.clone()).map_err(|e| bad(e.to_string()))
}

fn display_name(name: Option<&str>) -> &str {
    name.filter(|n| !n.is_empty()).unwrap_or("(chưa có tên)")
}

fn contact_actor(cx: &ActionCx<'_>) -> mod_contacts::Actor {
    mod_contacts::Actor {
        user_id: cx.principal.user_id,
        is_admin: false,
        email: Some(cx.principal.email.clone()),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// create_contact

pub(crate) static CREATE_CONTACT: ActionDef = ActionDef {
    name: "create_contact",
    label: "Tạo khách hàng",
    permissions: &["contacts.create"],
    prepare: create_prepare,
    execute: create_execute,
};

fn create_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let mut m = Map::new();
        m.insert("full_name".into(), text(args, "full_name", 100));
        m.insert("phone".into(), text(args, "phone", 12));
        m.insert("source_id".into(), int_or_null(args.get("source_id")));
        m.insert("stage_id".into(), int_or_null(args.get("stage_id")));
        m.insert("job_title".into(), text(args, "job_title", 100));
        m.insert("company_name".into(), text(args, "company_name", 150));
        m.insert("email".into(), text(args, "email", 150));
        let params = compact(m);
        let dto = contact_dto(&params)?;
        let source = option_label(cx, dto.source_id, "contact_source", "source_id").await?;
        let stage = match dto.stage_id {
            Some(s) => Some(option_label(cx, s, "contact_stage", "stage_id").await?),
            None => None,
        };
        let phone = mask_phone(Some(dto.phone.as_str())).unwrap_or_else(|| "***".to_owned());
        let stage_part = stage
            .as_ref()
            .map(|s| format!(", giai đoạn: {s}"))
            .unwrap_or_default();
        let summary = shown(
            &format!(
                "Tạo khách hàng \"{}\" (SĐT {phone}), nguồn: {source}{stage_part}",
                dto.full_name
            ),
            300,
        );
        let details = lines(vec![
            line("Họ tên", Some(dto.full_name.as_str()), 600),
            line("SĐT (đã che)", Some(phone.as_str()), 600),
            line("Nguồn", Some(source.as_str()), 600),
            line("Giai đoạn", Some(stage.as_deref().unwrap_or("Mặc định (Mới)")), 600),
            line("Nghề nghiệp", dto.job_title.as_deref(), 600),
            line("Công ty", dto.company_name.as_deref(), 600),
            line("Email", dto.email.as_deref(), 600),
        ]);
        Ok(Prepared {
            params,
            summary,
            details,
        })
    })
}

fn create_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let dto = contact_dto(params)?;
        let p = cx.principal;
        let scopes = cx.deps.contact_scopes(p).await?;
        let tenant = cx.deps.db.tenant(p.company).await.map_err(internal)?;
        let res = mod_contacts::write::create(&tenant, &scopes, &contact_actor(cx), &dto)
            .await
            .map_err(app_err)?;
        let c = to_json(&res.contact)?;
        Ok(json!({ "contact_id": c["id"] }))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// add_contact_note

pub(crate) static ADD_CONTACT_NOTE: ActionDef = ActionDef {
    name: "add_contact_note",
    label: "Thêm ghi chú cho khách",
    permissions: &["contacts.update"],
    prepare: note_prepare,
    execute: note_execute,
};

fn note_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let id = opt_int(args.get("contact_id"));
        let note = clean_value(args.get("note"), NOTE_MAX);
        let Some(id) = id else {
            return Err(bad("contact_id phải là số nguyên dương"));
        };
        if note.is_empty() {
            return Err(bad("Nội dung ghi chú không được rỗng"));
        }
        let c = load_contact(cx, id, "contacts.update", true).await?;
        let name = c.full_name.clone().unwrap_or_else(|| format!("#{}", c.id));
        let one_line = note.split_whitespace().collect::<Vec<_>>().join(" ");
        let who = format!("{} (#{})", display_name(c.full_name.as_deref()), c.id);
        Ok(Prepared {
            params: json!({ "contact_id": id, "note": note }),
            summary: shown(&format!("Thêm ghi chú vào khách \"{name}\": \"{one_line}\""), 300),
            details: lines(vec![
                line("Khách hàng", Some(who.as_str()), 600),
                line("Nội dung ghi chú", Some(note.as_str()), NOTE_MAX),
            ]),
        })
    })
}

fn note_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let id = opt_int(params.get("contact_id"));
        let note = clean_text(params.get("note").and_then(Value::as_str).unwrap_or(""), NOTE_MAX);
        let (Some(id), false) = (id, note.is_empty()) else {
            return Err(bad("Dữ liệu đề xuất không hợp lệ"));
        };
        let p = cx.principal;
        load_contact(cx, id, "contacts.update", false).await?;
        let activity: i32 = {
            let mut c = cx.deps.conn(p.company).await?;
            sqlx::query_scalar(
                "INSERT INTO activities (contact_id, action, details, metadata, created_by)
                 VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, $4) RETURNING id",
            )
            .bind(id)
            .bind(json!({ "description": note, "source": "ai_action" }).to_string())
            .bind(json!({ "ai_action_draft_id": draft_id }).to_string())
            .bind(p.user_id)
            .fetch_one(&mut *c)
            .await
            .map_err(internal)?
        };
        // Thẻ @ trong ghi chú → "Được nhắc tới ở" của bản ghi được nhắc (theo quyền xem của người duyệt); lỗi chỉ ghi log.
        mod_custom::refs::sync_mentions(
            &cx.deps.custom_ctx(),
            &cx.deps.custom_actor(p),
            Ref {
                ty: RefType::Contact,
                id,
            },
            &format!("note:{activity}"),
            Some(&note),
        )
        .await;
        Ok(json!({ "contact_id": id, "activity_id": activity }))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// update_contact_stage

pub(crate) static UPDATE_CONTACT_STAGE: ActionDef = ActionDef {
    name: "update_contact_stage",
    label: "Đổi giai đoạn khách",
    permissions: &["contacts.update"],
    prepare: stage_prepare,
    execute: stage_execute,
};

fn stage_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let (Some(id), Some(stage_id)) = (opt_int(args.get("contact_id")), opt_int(args.get("stage_id"))) else {
            return Err(bad("contact_id và stage_id phải là số nguyên dương"));
        };
        let c = load_contact(cx, id, "contacts.update", true).await?;
        let to = option_label(cx, stage_id, "contact_stage", "stage_id").await?;
        if c.stage_id == Some(stage_id) {
            return Err(bad(format!("Khách đã ở giai đoạn \"{to}\"")));
        }
        let from = c.stage_label.clone().unwrap_or_else(|| "(chưa có)".to_owned());
        let name = c.full_name.clone().unwrap_or_else(|| format!("#{}", c.id));
        let who = format!("{} (#{})", display_name(c.full_name.as_deref()), c.id);
        Ok(Prepared {
            params: json!({ "contact_id": id, "stage_id": stage_id }),
            summary: shown(&format!("Đổi giai đoạn khách \"{name}\": {from} → {to}"), 300),
            details: lines(vec![
                line("Khách hàng", Some(who.as_str()), 600),
                line("Giai đoạn hiện tại", Some(from.as_str()), 600),
                line("Giai đoạn mới", Some(to.as_str()), 600),
            ]),
        })
    })
}

fn stage_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let (Some(id), Some(stage_id)) = (opt_int(params.get("contact_id")), opt_int(params.get("stage_id"))) else {
            return Err(bad("Dữ liệu đề xuất không hợp lệ"));
        };
        let p = cx.principal;
        let scopes = cx.deps.contact_scopes(p).await?;
        let tenant = cx.deps.db.tenant(p.company).await.map_err(internal)?;
        let dto = UpdateContact {
            stage_id: Some(Some(stage_id)),
            ..UpdateContact::default()
        };
        mod_contacts::write::update(&tenant, &scopes, &contact_actor(cx), id, &dto)
            .await
            .map_err(app_err)?;
        Ok(json!({ "contact_id": id, "stage_id": stage_id }))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// assign_contact

pub(crate) static ASSIGN_CONTACT: ActionDef = ActionDef {
    name: "assign_contact",
    label: "Chuyển người phụ trách",
    permissions: &["contacts.transfer"],
    prepare: assign_prepare,
    execute: assign_execute,
};

fn assign_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let (Some(id), Some(to)) = (opt_int(args.get("contact_id")), opt_int(args.get("new_assigned_to"))) else {
            return Err(bad("contact_id và new_assigned_to phải là số nguyên dương"));
        };
        let c = load_contact(cx, id, "contacts.transfer", true).await?;
        if c.assigned_to == Some(to) {
            return Err(bad("Người này đang là người phụ trách hiện tại"));
        }
        // Người nhận PHẢI nằm trong phạm vi `contacts.transfer` của người dùng và đang hoạt động: AI không chọn được ai tuỳ ý.
        let allowed = owner(cx, "contacts.transfer").await?;
        let target: Option<String> = {
            let mut conn = cx.deps.conn(cx.principal.company).await?;
            sqlx::query_scalar("SELECT full_name FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL")
                .bind(to)
                .fetch_optional(&mut *conn)
                .await
                .map_err(internal)?
        };
        let target_name = match target {
            Some(n) if covers(allowed.as_ref(), to) => n,
            _ => {
                return Err(bad(
                    "Người nhận không hợp lệ hoặc nằm ngoài phạm vi chuyển khách của bạn (xem list_crm_options)",
                ));
            }
        };
        let reason = clean_value(args.get("reason"), 200);
        let mut m = Map::new();
        m.insert("contact_id".into(), json!(id));
        m.insert("new_assigned_to".into(), json!(to));
        m.insert("reason".into(), if reason.is_empty() { Value::Null } else { json!(reason) });
        let name = c.full_name.clone().unwrap_or_else(|| format!("#{}", c.id));
        let who = format!("{} (#{})", display_name(c.full_name.as_deref()), c.id);
        Ok(Prepared {
            params: compact(m),
            summary: shown(&format!("Chuyển khách \"{name}\" cho {target_name}"), 300),
            details: lines(vec![
                line("Khách hàng", Some(who.as_str()), 600),
                line("Người nhận", Some(target_name.as_str()), 600),
                line("Lý do", Some(reason.as_str()), 600),
            ]),
        })
    })
}

fn assign_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let (Some(id), Some(to)) = (opt_int(params.get("contact_id")), opt_int(params.get("new_assigned_to"))) else {
            return Err(bad("Dữ liệu đề xuất không hợp lệ"));
        };
        let extra = clean_value(params.get("reason"), 200);
        let reason = if extra.is_empty() {
            "Do AI thực hiện".to_owned()
        } else {
            format!("Do AI thực hiện: {extra}")
        };
        let p = cx.principal;
        let scopes = cx.deps.contact_scopes(p).await?;
        let tenant = cx.deps.db.tenant(p.company).await.map_err(internal)?;
        let res = mod_contacts::transfer::transfer(&tenant, &scopes, &contact_actor(cx), id, to, &reason)
            .await
            .map_err(app_err)?;
        Ok(json!({ "contact_id": res.contact_id, "from_user_id": res.from_user_id, "to_user_id": res.to_user_id }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdt_va_email_nhu_dto() {
        for ok in ["0900000001", "+84900000001"] {
            assert!(valid_phone(ok), "{ok}");
        }
        for x in ["900000001", "090000001", "09000000012", "+8490000001", "0900a00001"] {
            assert!(!valid_phone(x), "{x}");
        }
        assert!(!valid_phone("０９０００００００１"));
        assert!(is_email("a@b.vn"));
        for x in ["a", "a@b", "@b.vn", "a b@c.vn", "a@@b.vn", "a@b..vn", "a@.vn"] {
            assert!(!is_email(x), "{x}");
        }
    }

    #[test]
    fn kiem_dto_tao_khach() {
        let ok = json!({ "full_name": "A", "phone": "0900000001", "source_id": 3 });
        assert!(validate_contact(&ok).is_ok());
        let thieu = json!({ "full_name": "A" });
        let Err(ToolError::Http { status, message }) = validate_contact(&thieu) else {
            panic!("phải lỗi 400");
        };
        assert_eq!(status, 400);
        assert!(message.contains("SĐT không được để trống") && message.contains("Vui lòng chọn nguồn"), "{message}");
        let sai = json!({ "full_name": "A", "phone": "123", "source_id": 3, "email": "x" });
        let Err(ToolError::Http { message, .. }) = validate_contact(&sai) else {
            panic!("phải lỗi 400");
        };
        assert_eq!(message, format!("{PHONE_MSG}; Email không hợp lệ"));
    }
}
