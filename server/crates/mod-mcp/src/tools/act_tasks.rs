//! Thao tác ghi về việc (thẻ Kanban): `create_task` (`actions/action-task-tool.ts`). Chạy qua `mod-kanban`.

use mod_contacts::filter::parse_js_instant;
use mod_kanban::cards::CreateCard;
use serde_json::{Map, Value, json};
use trinity_kernel::vi::{escape_like, trim_js};
use trinity_kernel::vn_time::{VnDateStyle, format_vn_date};
use trinity_rbac::OwnerIds;

use crate::actions::{
    ActionCx, ActionDef, Prepared, bad, clean_value, compact, http_err, int_or_null, internal, line, lines, owner,
    shown,
};
use crate::args::opt_int;
use crate::deps::{app_err, to_json};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;
use crate::tools::visible_contacts;

const NO_BOARD: &str = "Bạn chưa có bảng công việc (Kanban) nào có cột đang mở để tạo thẻ. Hãy nhờ quản trị tạo một bảng ở mục Công việc (hoặc cấp quyền xem bảng), rồi thử lại; nếu đã có bảng thì truyền column_id lấy từ list_crm_options.";

/// Cột mặc định: cột đầu (chưa ẩn, chưa phải "Hoàn thành") của bảng đầu tiên mà người dùng thấy.
async fn default_column(cx: &ActionCx<'_>, actor: &mod_kanban::Actor) -> Result<i32, ToolError> {
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    let id: Option<i32> = sqlx::query_scalar(
        "SELECT c.id FROM kanban_columns c JOIN kanban_boards b ON b.id = c.board_id
         WHERE b.id IN (SELECT id FROM kanban_boards WHERE deleted_at IS NULL ORDER BY id LIMIT 50)
           AND ($1 OR (b.is_active AND (cardinality(b.visibility_role_ids) = 0 OR b.visibility_role_ids && $2)))
           AND NOT c.is_archived AND NOT c.is_done
         ORDER BY b.id, c.position LIMIT 1",
    )
    .bind(actor.access.can_manage_boards)
    .bind(&actor.access.role_ids)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    id.ok_or_else(|| ToolError::User(NO_BOARD.to_owned()))
}

fn with_me(mut ids: Vec<i32>, me: i32) -> Vec<i32> {
    if !ids.contains(&me) {
        ids.push(me);
    }
    ids
}

/// Người được giao: chính mình, hoặc người trong phạm vi `kanban.manage` của mình. `None` = mọi người.
fn assignable(o: Option<OwnerIds>, me: i32) -> Option<Vec<i32>> {
    match o {
        Some(OwnerIds::All) => None,
        Some(OwnerIds::Ids(ids)) => Some(with_me(ids, me)),
        None => Some(with_me(Vec::new(), me)),
    }
}

/// Tìm người được giao theo email (khớp đúng) hoặc tên (chứa), trong phạm vi quyền. Bỏ trống = chính người dùng.
async fn resolve_assignee(cx: &ActionCx<'_>, query: Option<&str>) -> Result<(i32, String), ToolError> {
    let me = cx.principal.user_id;
    let q = query.map_or("", trim_js);
    if q.is_empty() {
        return Ok((me, "Bạn".to_owned()));
    }
    let allowed = assignable(owner(cx, "kanban.manage").await?, me);
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    let by_email: Option<(i32, String)> = sqlx::query_as(
        "SELECT id, full_name FROM users
         WHERE status = 'active' AND deleted_at IS NULL AND ($1::int4[] IS NULL OR id = ANY($1::int4[]))
           AND lower(email) = lower($2) ORDER BY id LIMIT 1",
    )
    .bind(&allowed)
    .bind(q)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    if let Some((id, name)) = by_email {
        return Ok((id, name));
    }
    // Tên khớp đúng tra riêng (không bị cắt bởi giới hạn kết quả gần đúng bên dưới).
    let mut found: Vec<(i32, String, String)> = sqlx::query_as(
        "SELECT id, full_name, email FROM users
         WHERE status = 'active' AND deleted_at IS NULL AND ($1::int4[] IS NULL OR id = ANY($1::int4[]))
           AND lower(full_name) = lower($2) ORDER BY id LIMIT 6",
    )
    .bind(&allowed)
    .bind(q)
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)?;
    if let [(id, name, _)] = found.as_slice() {
        return Ok((*id, name.clone()));
    }
    if found.is_empty() {
        found = sqlx::query_as(
            "SELECT id, full_name, email FROM users
             WHERE status = 'active' AND deleted_at IS NULL AND ($1::int4[] IS NULL OR id = ANY($1::int4[]))
               AND full_name ILIKE $2 ESCAPE '\\' ORDER BY id LIMIT 6",
        )
        .bind(&allowed)
        .bind(format!("%{}%", escape_like(q)))
        .fetch_all(&mut *conn)
        .await
        .map_err(internal)?;
    }
    match found.as_slice() {
        [(id, name, _)] => Ok((*id, name.clone())),
        [] => Err(ToolError::User(format!(
            "Không tìm thấy người tên hoặc email \"{q}\" trong phạm vi bạn được giao việc. Hỏi lại người dùng tên đầy đủ hoặc email; nếu bạn chỉ được giao việc cho chính mình thì bỏ trống assignee."
        ))),
        many => {
            let list: Vec<String> = many.iter().map(|(_, n, e)| format!("{n} ({e})")).collect();
            Err(ToolError::User(format!(
                "Có nhiều người khớp \"{q}\": {}. Hỏi người dùng chọn một người rồi gửi lại assignee bằng email.",
                list.join(", ")
            )))
        }
    }
}

fn text(args: &Value, key: &str, max: usize) -> Value {
    let s = clean_value(args.get(key), max);
    if s.is_empty() { Value::Null } else { json!(s) }
}

/// Tham số tạo thẻ (không có `assignee_id`) dựng từ `params` của đề xuất.
fn card_input(params: &Value, assignee: Option<i32>) -> Result<CreateCard, ToolError> {
    let mut m: Map<String, Value> = params.as_object().cloned().unwrap_or_default();
    m.remove("assignee_id");
    if m.get("title").is_none() {
        return Err(bad("title: bắt buộc"));
    }
    if let Some(a) = assignee {
        m.insert("assignee_ids".into(), json!([a]));
    }
    serde_json::from_value(Value::Object(m)).map_err(|e| bad(e.to_string()))
}

pub(crate) static CREATE_TASK: ActionDef = ActionDef {
    name: "create_task",
    label: "Tạo công việc",
    permissions: &["kanban.manage"],
    prepare: task_prepare,
    execute: task_execute,
    structure: false,
};

fn task_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        let actor = cx.deps.kanban_actor(p).await?;
        let column_id = match opt_int(args.get("column_id")) {
            Some(c) => c,
            None => default_column(cx, &actor).await?,
        };
        let who_query = args.get("assignee").and_then(Value::as_str);
        let (assignee_id, assignee_name) = resolve_assignee(cx, who_query).await?;
        let mut m = Map::new();
        m.insert("column_id".into(), json!(column_id));
        m.insert("title".into(), text(args, "title", 200));
        m.insert("description".into(), text(args, "description", 2000));
        m.insert("due_at".into(), text(args, "due_at", 40));
        m.insert("priority".into(), args.get("priority").cloned().unwrap_or(Value::Null));
        m.insert("contact_id".into(), int_or_null(args.get("contact_id")));
        m.insert("assignee_id".into(), json!(assignee_id));
        let params = compact(m);
        let dto = card_input(&params, None)?;
        dto.validate().map_err(http_err)?;
        let scopes = cx.deps.contact_scopes(p).await?;
        let mut conn = cx.deps.conn(p.company).await?;
        let col: Option<(String, i32, bool)> =
            sqlx::query_as("SELECT name, board_id, is_archived FROM kanban_columns WHERE id = $1")
                .bind(column_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(internal)?;
        let Some((col_name, board_id, archived)) = col else {
            return Err(bad("column_id không hợp lệ — xem list_crm_options"));
        };
        let board = mod_kanban::boards::load_visible(&mut conn, &actor.access, board_id)
            .await
            .map_err(app_err)?;
        if archived {
            return Err(bad("Cột đã ẩn — chọn cột khác"));
        }
        if let Some(cid) = dto.contact_id {
            let seen = visible_contacts(&scopes, p, &mut conn, &[Some(cid)]).await?;
            if !seen.contains(&cid) {
                return Err(ToolError::User(format!(
                    "contact_id {cid}: không tìm thấy khách hàng hoặc nằm ngoài phạm vi quyền của bạn."
                )));
            }
        }
        let due = dto
            .due_at
            .as_deref()
            .and_then(parse_js_instant)
            .map(|d| format_vn_date(d, VnDateStyle::ShortDateTime));
        let due_part = due.as_ref().map(|d| format!(", hạn {d}")).unwrap_or_default();
        let who = if assignee_id == p.user_id {
            "Bạn".to_owned()
        } else {
            assignee_name
        };
        let summary = shown(
            &format!(
                "Tạo công việc \"{}\" (bảng {}, cột {col_name}{due_part}), giao cho {}",
                dto.title,
                board.name,
                if assignee_id == p.user_id {
                    "bạn"
                } else {
                    who.as_str()
                }
            ),
            300,
        );
        let place = format!("{} / {col_name}", board.name);
        let contact = dto.contact_id.map(|c| format!("#{c}"));
        let details = lines(vec![
            line("Tiêu đề", Some(dto.title.as_str()), 600),
            line("Mô tả", dto.description.as_deref(), 2000),
            line("Bảng / cột", Some(place.as_str()), 600),
            line("Hạn", due.as_deref(), 600),
            line("Ưu tiên", dto.priority.as_deref(), 600),
            line("Khách hàng gắn kèm", contact.as_deref(), 600),
            line("Người phụ trách", Some(who.as_str()), 600),
        ]);
        Ok(Prepared {
            params,
            summary,
            details,
            impact: None,
        })
    })
}

fn task_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        // Người phụ trách: kiểm lại phạm vi lúc chạy (quyền có thể đã đổi từ lúc soạn nháp); không có ⇒ chính người dùng.
        let target = params
            .get("assignee_id")
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok())
            .unwrap_or(p.user_id);
        if target != p.user_id {
            let allowed = assignable(owner(cx, "kanban.manage").await?, p.user_id);
            if allowed.is_some_and(|ids| !ids.contains(&target)) {
                return Err(ToolError::User(
                    "Người được giao không còn trong phạm vi quyền giao việc của bạn.".to_owned(),
                ));
            }
        }
        let dto = card_input(params, Some(target))?;
        let actor = cx.deps.kanban_actor(p).await?;
        let mut conn = cx.deps.conn(p.company).await?;
        let card = mod_kanban::cards::create(&mut conn, &actor, &dto)
            .await
            .map_err(app_err)?;
        let c = to_json(&card)?;
        Ok(json!({ "card_id": c["id"], "title": c["title"] }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nguoi_duoc_giao_trong_pham_vi() {
        assert_eq!(assignable(Some(OwnerIds::All), 1), None);
        assert_eq!(assignable(None, 1), Some(vec![1]));
        assert_eq!(assignable(Some(OwnerIds::Ids(vec![2, 3])), 1), Some(vec![2, 3, 1]));
        assert_eq!(assignable(Some(OwnerIds::Ids(vec![1, 2])), 1), Some(vec![1, 2]));
    }

    #[test]
    fn dung_the_tu_tham_so_de_xuat() {
        let p = json!({ "column_id": 4, "title": "Gọi lại", "assignee_id": 9, "priority": "high", "contact_id": 7 });
        let c = card_input(&p, Some(9)).unwrap();
        assert_eq!((c.column_id, c.title.as_str(), c.contact_id), (4, "Gọi lại", Some(7)));
        assert_eq!(c.assignee_ids, Some(vec![9]));
        assert_eq!(c.assignee_id, None);
        assert!(c.validate().is_ok());
        let sai = json!({ "column_id": 4, "title": "x", "priority": "khong-co" });
        assert!(card_input(&sai, None).unwrap().validate().is_err());
        assert!(matches!(
            card_input(&json!({ "column_id": 4 }), None),
            Err(ToolError::Http { status: 400, .. })
        ));
    }
}
