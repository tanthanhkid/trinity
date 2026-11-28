//! Tool «Sửa giờ công kèm lý do» (chấm công): `adjust_attendance_time` (ghi) và `list_attendance_edits` (đọc lịch sử). Gọi lại đúng
//! hàm nghiệp vụ của route `POST|GET /management/attendance/:id/edits` (`mod_attendance::adjust`): cùng quyền (`attendance.manage` /
//! `attendance.view`), cùng phạm vi chủ bản ghi (ngoài phạm vi ⇒ không tìm thấy), cùng giao dịch cập nhật + lịch sử. Bản ghi chỉ định
//! bằng `record_id` hoặc cặp `user_id` + `work_date` (AI chưa có tool liệt kê bản ghi chấm công). Không có tool xoá.

use chrono::NaiveDate;
use mod_attendance::adjust::{self, AdjustInput, EditOut};
use serde_json::{Value, json};
use trinity_rbac::OwnerIds;

use super::wrapped;
use crate::args::opt_int;
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// Phạm vi chủ bản ghi của một quyền; không có phạm vi ⇒ rỗng.
async fn owner_ids(ctx: &ToolCtx<'_>, permission: &str) -> Result<OwnerIds, ToolError> {
    let p = ctx.principal;
    Ok(ctx
        .deps
        .scopes
        .owner_ids(p.company, p.user_id, &p.grants, permission)
        .await
        .map_err(internal)?
        .unwrap_or(OwnerIds::Ids(Vec::new())))
}

/// `record_id`, hoặc `user_id` + `work_date` (YYYY-MM-DD) ⇒ id bản ghi.
async fn record_id(args: &Value, conn: &mut sqlx::PgConnection, owner: &OwnerIds) -> Result<i32, ToolError> {
    if let Some(id) = opt_int(args.get("record_id")) {
        return Ok(id);
    }
    let user = opt_int(args.get("user_id")).ok_or_else(|| {
        ToolError::User("Cần record_id, hoặc user_id kèm work_date (YYYY-MM-DD) để chỉ định ngày công".into())
    })?;
    let day = args
        .get("work_date")
        .and_then(Value::as_str)
        .and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok())
        .ok_or_else(|| ToolError::User("work_date phải có dạng YYYY-MM-DD".into()))?;
    adjust::find_record_id(conn, owner, user, day).await.map_err(app_err)
}

/// Chỉ giữ khoá của body có giá trị (`null` của tool = vắng); khoá lạ do schema đóng băng đã bị bỏ trước đó.
fn body_of(args: &Value) -> Value {
    let mut m = serde_json::Map::new();
    for k in ["check_in", "check_out", "reason"] {
        if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
            m.insert(k.to_owned(), v.clone());
        }
    }
    Value::Object(m)
}

fn edit_json(e: &EditOut) -> Value {
    json!({
        "id": e.id,
        "record_id": e.record_id,
        "editor_id": e.editor_id,
        "editor_name": e.editor_name,
        "old_check_in_at": e.old_check_in_at,
        "old_check_out_at": e.old_check_out_at,
        "new_check_in_at": e.new_check_in_at,
        "new_check_out_at": e.new_check_out_at,
        "reason": e.reason,
        "created_at": e.created_at,
    })
}

/// Ghi trong MỘT giao dịch: cập nhật bản ghi + lịch sử cùng thành công hoặc cùng hoàn tác.
pub fn adjust_attendance_time<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let input: AdjustInput = adjust::parse_input(&body_of(args)).map_err(|e| app_err(e.into()))?;
        let p = ctx.principal;
        let owner = owner_ids(ctx, "attendance.manage").await?;
        let tenant = ctx.deps.db.tenant(p.company).await.map_err(internal)?;
        let mut conn = tenant.acquire().await.map_err(internal)?;
        let id = record_id(args, &mut conn, &owner).await?;
        let out = adjust::adjust(&mut conn, &owner, p.user_id, id, &input)
            .await
            .map_err(app_err)?;
        let r = &out.record;
        wrapped(&json!({
            "record": {
                "id": r.id,
                "user_id": r.user_id,
                "work_date": r.work_date,
                "check_in_at": r.check_in_at,
                "check_out_at": r.check_out_at,
                "total_hours": r.total_hours,
                "late_minutes": r.late_minutes,
                "status": r.status,
            },
            "edit": edit_json(&out.edit),
        }))
    })
}

pub fn list_attendance_edits<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        let owner = owner_ids(ctx, "attendance.view").await?;
        let tenant = ctx.deps.db.tenant(p.company).await.map_err(internal)?;
        let mut conn = tenant.acquire().await.map_err(internal)?;
        let id = record_id(args, &mut conn, &owner).await?;
        let edits = adjust::list_edits(&mut conn, &owner, id).await.map_err(app_err)?;
        wrapped(&json!({
            "record_id": id,
            "edits": edits.iter().map(edit_json).collect::<Vec<_>>(),
        }))
    })
}
