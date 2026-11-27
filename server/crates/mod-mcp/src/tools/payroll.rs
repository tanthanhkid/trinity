//! Tool phiếu lương (M31c): xuất xlsx/PDF, tải mẫu nhập, nhập xem trước và nhập áp dụng. Gọi lại đúng hàm nghiệp vụ của router
//! payroll (`mod_payroll::payslips::files`), quyền như route tương ứng: xuất ⇒ `payroll.export` + phạm vi chủ phiếu của quyền đó;
//! mẫu nhập, xem trước, áp dụng ⇒ `payroll.manage`. Không có tool xoá. Tệp trả về dạng base64 trong `data.file_base64`; kết quả
//! văn bản bị cắt ở 40.000 ký tự nên tệp lớn hơn ngưỡng [`MAX_FILE_B64`] bị từ chối (tải bằng giao diện web).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_payroll::payslips::MonthQuery;
use mod_payroll::payslips::files::{self, FileOut, ImportPreviewRow, ListExcelInput};
use serde_json::{Value, json};
use trinity_kernel::error::AppError;
use trinity_kernel::json::js_json;
use trinity_rbac::OwnerIds;

use super::done;
use crate::ai_output::DATA_NOTICE;
use crate::args::opt_int;
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

/// Tệp base64 tối đa trả về (ký tự); chừa chỗ cho khung JSON dưới trần 40.000 của kết quả văn bản.
const MAX_FILE_B64: usize = 34_000;
/// Tệp nhập tối đa sau khi giải mã (bằng trần multipart của route).
const UPLOAD_MAX: usize = 20 * 1024 * 1024;
/// Ngân sách độ dài JSON cho danh sách dòng xem trước/áp dụng.
const ROWS_BUDGET: usize = 28_000;

const FILE_NOTICE: &str = "Tệp mã hoá base64 trong data.file_base64 (giải mã rồi lưu đúng tên data.filename). Dữ liệu lương là thông tin nhạy cảm — chỉ chuyển cho người có quyền. / File is base64-encoded in data.file_base64; payroll data is sensitive.";

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

fn month_of(args: &Value) -> Result<String, ToolError> {
    let month = args.get("month").and_then(Value::as_str).unwrap_or_default().to_owned();
    let q = MonthQuery { month };
    q.validate().map_err(|e| app_err(AppError::from(e)))?;
    Ok(q.month)
}

fn payslip_id(args: &Value) -> Result<i32, ToolError> {
    opt_int(args.get("payslip_id")).ok_or_else(|| ToolError::User("payslip_id phải là số nguyên dương".into()))
}

/// Phạm vi chủ phiếu của một quyền như `scope_of` của router: `None` = tất cả; không có phạm vi ⇒ rỗng.
async fn owner_scope(ctx: &ToolCtx<'_>, permission: &str) -> Result<Option<Vec<i32>>, ToolError> {
    let p = ctx.principal;
    let owners = ctx
        .deps
        .scopes
        .owner_ids(p.company, p.user_id, &p.grants, permission)
        .await
        .map_err(internal)?;
    Ok(match owners {
        Some(OwnerIds::All) => None,
        Some(OwnerIds::Ids(ids)) => Some(ids),
        None => Some(Vec::new()),
    })
}

fn file_result(f: &FileOut) -> Result<ToolOutput, ToolError> {
    let b64 = STANDARD.encode(&f.bytes);
    if b64.len() > MAX_FILE_B64 {
        return Err(ToolError::User(format!(
            "Tệp {} ({} byte) quá lớn để trả qua MCP (tối đa khoảng {} byte). Hãy xuất ít phiếu hơn hoặc tải bằng giao diện web. / File too large for MCP; download it from the web app.",
            f.filename,
            f.bytes.len(),
            MAX_FILE_B64 / 4 * 3
        )));
    }
    done(json!({
        "notice": FILE_NOTICE,
        "data": {
            "filename": f.filename,
            "content_type": f.content_type,
            "size_bytes": f.bytes.len(),
            "encoding": "base64",
            "file_base64": b64,
        },
    }))
}

/// `file_base64` ⇒ byte (cho phép tiền tố `data:…;base64,` và khoảng trắng/xuống dòng).
fn decode_upload(args: &Value) -> Result<Vec<u8>, ToolError> {
    let raw = args.get("file_base64").and_then(Value::as_str).unwrap_or_default();
    let body = raw.split_once(";base64,").map_or(raw, |(_, b)| b);
    let clean: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.is_empty() {
        return Err(ToolError::User(
            "Thiếu file_base64 (nội dung tệp xlsx mã hoá base64). / file_base64 is required.".into(),
        ));
    }
    if clean.len() / 4 * 3 > UPLOAD_MAX + 3 {
        return Err(ToolError::User("Tệp quá lớn (tối đa 20 MB). / File too large.".into()));
    }
    let bytes = STANDARD
        .decode(clean.as_bytes())
        .map_err(|_| ToolError::User("file_base64 không phải base64 hợp lệ. / Invalid base64.".into()))?;
    if bytes.len() > UPLOAD_MAX {
        return Err(ToolError::User("Tệp quá lớn (tối đa 20 MB). / File too large.".into()));
    }
    Ok(bytes)
}

/// Tóm tắt kết quả nhập: đếm đủ mọi dòng, liệt kê dòng có thay đổi/bị bỏ qua trong ngân sách độ dài (`truncated` khi thiếu).
fn import_result(month: &str, applied: bool, rows: &[ImportPreviewRow]) -> Result<ToolOutput, ToolError> {
    let with_changes = rows.iter().filter(|r| !r.skipped && !r.changes.is_empty()).count();
    let skipped = rows.iter().filter(|r| r.skipped).count();
    let changed_cells: usize = rows.iter().map(|r| r.changes.len()).sum();
    let mut listed: Vec<Value> = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    for r in rows.iter().filter(|r| r.skipped || !r.changes.is_empty()) {
        let v = to_json(r)?;
        let n = js_json(&v).len();
        if used + n > ROWS_BUDGET {
            truncated = true;
            break;
        }
        used += n;
        listed.push(v);
    }
    done(json!({
        "notice": DATA_NOTICE,
        "data": {
            "month": month,
            "applied": applied,
            "total_rows": rows.len(),
            "rows_with_changes": with_changes,
            "rows_skipped": skipped,
            "changed_cells": changed_cells,
            "rows": listed,
            "truncated": truncated,
        },
    }))
}

pub fn export_payslip_excel<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let id = payslip_id(args)?;
        let scope = owner_scope(ctx, "payroll.export").await?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let f = files::export_excel(&mut conn, id, scope.as_deref())
            .await
            .map_err(app_err)?;
        file_result(&f)
    })
}

pub fn export_payslip_pdf<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let id = payslip_id(args)?;
        let scope = owner_scope(ctx, "payroll.export").await?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let f = files::export_pdf(&mut conn, id, scope.as_deref())
            .await
            .map_err(app_err)?;
        file_result(&f)
    })
}

/// Xuất cả kỳ: `layout` `bulk` (mỗi phiếu một sheet, như `excel-bulk`) hoặc `list` (bảng danh sách, như `excel-list`, có thể
/// kèm `ordered_ids` theo thứ tự màn hình).
pub fn export_payslips_excel<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let month = month_of(args)?;
        let list = args.get("layout").and_then(Value::as_str) == Some("list");
        let scope = owner_scope(ctx, "payroll.export").await?;
        let f = if list {
            let input = ListExcelInput {
                month: month.clone(),
                ordered_ids: args.get("ordered_ids").filter(|v| !v.is_null()).cloned(),
            };
            input.validate().map_err(|e| app_err(AppError::from(e)))?;
            let ids = input.ids();
            let mut conn = ctx.deps.conn(ctx.principal.company).await?;
            files::export_list(&mut conn, &month, scope.as_deref(), ids.as_deref())
                .await
                .map_err(app_err)?
        } else {
            let mut conn = ctx.deps.conn(ctx.principal.company).await?;
            files::export_bulk(&mut conn, &month, scope.as_deref())
                .await
                .map_err(app_err)?
        };
        file_result(&f)
    })
}

pub fn get_payslip_import_template<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let month = month_of(args)?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let f = files::import_template(&mut conn, &month).await.map_err(app_err)?;
        file_result(&f)
    })
}

pub fn preview_payslip_import<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let month = month_of(args)?;
        let bytes = decode_upload(args)?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let rows = files::preview_import(&mut conn, &bytes, &month)
            .await
            .map_err(app_err)?;
        import_result(&month, false, &rows)
    })
}

/// Ghi trong MỘT giao dịch như route: lỗi giữa chừng hoàn tác cả lô.
pub fn apply_payslip_import<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let month = month_of(args)?;
        let bytes = decode_upload(args)?;
        let tenant = ctx.deps.db.tenant(ctx.principal.company).await.map_err(internal)?;
        let mut tx = tenant.begin().await.map_err(internal)?;
        let rows = files::apply_import(&mut tx, &bytes, &month).await.map_err(app_err)?;
        tx.commit().await.map_err(internal)?;
        import_result(&month, true, &rows)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(code: &str, changes: usize, skipped: bool) -> ImportPreviewRow {
        ImportPreviewRow {
            employee_code: code.to_owned(),
            employee_name: None,
            payslip_id: None,
            payslip_status: None,
            changes: (0..changes)
                .map(|i| files::ImportChange {
                    header: format!("Cột {i}"),
                    field: format!("f{i}"),
                    before: "1,000,000".into(),
                    after: "2,000,000".into(),
                })
                .collect(),
            skipped,
            skip_reason: skipped.then(|| "đã duyệt".to_owned()),
        }
    }

    #[test]
    fn thang_hop_le() {
        assert_eq!(month_of(&json!({ "month": "2026-03" })).unwrap(), "2026-03");
        assert!(month_of(&json!({ "month": "2026-13" })).is_err());
        assert!(month_of(&json!({})).is_err());
    }

    #[test]
    fn giai_ma_tep_nhap() {
        let b = STANDARD.encode(b"PK\x03\x04abc");
        assert_eq!(decode_upload(&json!({ "file_base64": b })).unwrap(), b"PK\x03\x04abc");
        let with_prefix = format!("data:application/vnd.ms-excel;base64,{b}\n");
        assert_eq!(decode_upload(&json!({ "file_base64": with_prefix })).unwrap().len(), 7);
        assert!(decode_upload(&json!({ "file_base64": "" })).is_err());
        assert!(decode_upload(&json!({ "file_base64": "***" })).is_err());
        assert!(decode_upload(&json!({})).is_err());
    }

    #[test]
    fn tep_qua_lon_bi_tu_choi() {
        let big = FileOut {
            bytes: vec![0u8; MAX_FILE_B64],
            filename: "x.xlsx".into(),
            content_type: files::XLSX_MIME,
        };
        assert!(matches!(file_result(&big), Err(ToolError::User(_))));
        let small = FileOut {
            bytes: vec![1u8; 10],
            filename: "x.pdf".into(),
            content_type: files::PDF_MIME,
        };
        let out = file_result(&small).unwrap();
        assert_eq!(out.structured["data"]["size_bytes"], 10);
        assert_eq!(out.structured["data"]["filename"], "x.pdf");
    }

    #[test]
    fn ket_qua_nhap_dem_du_va_cat_theo_ngan_sach() {
        let rows: Vec<ImportPreviewRow> = (0..400).map(|i| row(&format!("NV{i}"), 3, false)).collect();
        let out = import_result("2026-03", false, &rows).unwrap();
        let d = &out.structured["data"];
        assert_eq!(d["total_rows"], 400);
        assert_eq!(d["rows_with_changes"], 400);
        assert_eq!(d["changed_cells"], 1200);
        assert_eq!(d["truncated"], true);
        assert!(out.text.unwrap().len() < 40_000);
        let small = import_result("2026-03", true, &[row("A", 0, false), row("B", 0, true)]).unwrap();
        assert_eq!(small.structured["data"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(small.structured["data"]["rows_skipped"], 1);
    }
}
