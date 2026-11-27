//! Tool báo cáo tuỳ chỉnh và bản tin (`report-tools.ts`, `briefing-tools.ts`): `get_report`, `get_briefing_data`, `save_briefing`.
//! Gọi lại đúng module nghiệp vụ (`mod_reports::custom`, `mod_briefings::agent`), quyền như route tương ứng: báo cáo tuỳ chỉnh theo
//! phạm vi xem của từng bảng nguồn (kiểm trong `mod-reports`); bản tin cần `reports.overview` + cờ tổ chức `ai_briefing`, phạm vi
//! dữ liệu là phạm vi của quyền đó. `save_briefing` chỉ ghi bản tin của CHÍNH người gọi (không sửa dữ liệu nghiệp vụ), không có tool xoá.

use chrono::{DateTime, Utc};
use mod_briefings::agent::{agent_data, save_from_agent};
use mod_briefings::ports::RbacPorts;
use mod_briefings::types::{Owners, Slot};
use mod_briefings::{Error as BriefingError, Ports, now_slot};
use serde_json::{Value, json};
use trinity_kernel::error::AppError;
use trinity_rbac::OwnerIds;

use super::{forbidden, wrapped};
use crate::ai_output::slice16;
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const PERMISSION: &str = "reports.overview";
const TITLE_MAX: usize = 200;
/// Trần nội dung bản tin agent viết (`BRIEFING_TEXT_MAX`).
const TEXT_MAX: usize = 6000;

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// `get_report`: không `report_id` ⇒ danh sách báo cáo mở được; có ⇒ chạy báo cáo theo kỳ.
pub fn get_report<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let actor = deps.report_actor(p);
        let id = args.get("report_id").and_then(Value::as_str);
        let data = match id {
            None => {
                let v = mod_reports::custom::list(&deps.reports, &actor).await.map_err(app_err)?;
                let reports: Vec<Value> = v["reports"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|r| json!({ "id": r["id"], "name": r["name"], "table": r["source_label"] }))
                            .collect()
                    })
                    .unwrap_or_default();
                json!({ "reports": reports })
            }
            Some(id) => {
                let period = args.get("period").and_then(Value::as_str);
                let r = mod_reports::custom::run(&deps.reports, &actor, id, period)
                    .await
                    .map_err(app_err)?;
                report_data(&r)
            }
        };
        wrapped(&data)
    })
}

/// Kết quả `run` của báo cáo ⇒ dữ liệu gọn cho AI (đúng hình của bản Node).
fn report_data(r: &Value) -> Value {
    let sum_fields: Vec<Value> = r["fields"]["sums"].as_array().cloned().unwrap_or_default();
    let pick = |sums: &Value, key: &Value| -> Value {
        key.as_str()
            .and_then(|k| sums.get(k))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!(0))
    };
    let totals: Vec<Value> = sum_fields
        .iter()
        .map(|s| json!({ "label": s["label"], "total": pick(&r["sums"], &s["key"]) }))
        .collect();
    let group = r["fields"]["group"].as_str().map(|by| {
        let rows: Vec<Value> = r["groups"]
            .as_array()
            .map(|gs| {
                gs.iter()
                    .map(|g| {
                        let sums: Vec<Value> = sum_fields.iter().map(|s| pick(&g["sums"], &s["key"])).collect();
                        json!({ "label": g["label"], "count": g["count"], "sums": sums })
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({ "by": by, "rows": rows })
    });
    let by_month: Vec<Value> = r["by_month"]
        .as_array()
        .map(|ms| ms.iter().map(|m| json!({ "month": m["month"], "count": m["count"] })).collect())
        .unwrap_or_default();
    json!({
        "report": { "id": r["report"]["id"], "name": r["report"]["name"] },
        "period": r["period"]["label"],
        "date_field": r["fields"]["date"],
        "count": r["count"],
        "sums": totals,
        "missing_date": r["missing_date"],
        "groups": group.unwrap_or(Value::Null),
        "by_month": by_month,
    })
}

/// `slot` của đối số, bỏ trống/không hợp lệ ⇒ theo giờ VN hiện tại.
fn slot_of(args: &Value, now: DateTime<Utc>) -> Slot {
    args.get("slot")
        .and_then(Value::as_str)
        .and_then(Slot::parse)
        .unwrap_or_else(|| now_slot(now))
}

/// Phạm vi `reports.overview` của người gọi; `None` = không có quyền.
async fn briefing_owners(ctx: &ToolCtx<'_>) -> Result<Option<Owners>, ToolError> {
    let p = ctx.principal;
    let owners = ctx
        .deps
        .scopes
        .owner_ids(p.company, p.user_id, &p.grants, PERMISSION)
        .await
        .map_err(internal)?;
    Ok(owners.map(|o| match o {
        OwnerIds::All => Owners::All,
        OwnerIds::Ids(ids) => Owners::Users(ids),
    }))
}

fn briefing_err(e: BriefingError) -> ToolError {
    match e {
        BriefingError::Http(h) => app_err(AppError::from(*h)),
        BriefingError::Internal(m) => ToolError::Internal(m),
    }
}

fn feature_off() -> ToolError {
    forbidden(
        "Tính năng Bản tin sáng/chiều đang tắt cho tổ chức này (Cài đặt › Tính năng). / Briefings are disabled for this organisation.",
    )
}

pub fn get_briefing_data<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let now = Utc::now();
        let slot = slot_of(args, now);
        // Phạm vi lấy TRƯỚC khi giữ kết nối; sau đó một kết nối duy nhất cho cờ tính năng và số liệu.
        let owners = briefing_owners(ctx).await?;
        let mut conn = deps.conn(p.company).await?;
        let ports = RbacPorts::new(p.company, deps.db.multi_tenant());
        if !ports.feature_on(&mut conn).await {
            return Err(feature_off());
        }
        let Some(owners) = owners else {
            return Err(forbidden(
                "Bạn không có phạm vi báo cáo Tổng quan. / No reporting scope.",
            ));
        };
        let res = agent_data(&mut conn, &owners, slot, now).await.map_err(briefing_err)?;
        let v = to_json(&res)?;
        wrapped(&json!({
            "data": v["data"],
            "details": v["details"],
            "template": v["template"],
            "how_to_save": "Gọi save_briefing với cùng slot, title và text bạn đã viết. Chỉ dùng số trong dữ liệu này, không bịa.",
        }))
    })
}

pub fn save_briefing<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let now = Utc::now();
        let slot = slot_of(args, now);
        let owners = briefing_owners(ctx).await?;
        {
            let mut conn = deps.conn(p.company).await?;
            let ports = RbacPorts::new(p.company, deps.db.multi_tenant());
            if !ports.feature_on(&mut conn).await {
                return Err(feature_off());
            }
        }
        let title = clean(args.get("title"), TITLE_MAX);
        let text = clean(args.get("text"), TEXT_MAX);
        if title.is_empty() || text.is_empty() {
            return Err(ToolError::User("Cần title và text (không rỗng).".into()));
        }
        let Some(owners) = owners else {
            return Err(forbidden(
                "Không có quyền xem báo cáo Tổng quan (reports.overview)",
            ));
        };
        let tenant = deps.db.tenant(p.company).await.map_err(internal)?;
        let saved = save_from_agent(&tenant, p.user_id, &owners, slot, &title, &text, now)
            .await
            .map_err(briefing_err)?;
        wrapped(&json!({
            "briefing_id": saved.id,
            "created": saved.created,
            "notified": saved.notified,
            "url": format!("{}/briefings?id={}", ctx.base_url.trim_end_matches('/'), saved.id),
        }))
    })
}

/// Chuỗi đã cắt khoảng trắng và cắt theo đơn vị UTF-16 (như `trim().slice(0, max)`); không phải chuỗi ⇒ rỗng.
fn clean(v: Option<&Value>, max: usize) -> String {
    v.and_then(Value::as_str)
        .map(|s| slice16(s.trim(), max))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn slot_mac_dinh_theo_gio_viet_nam() {
        // 02:00 UTC = 09:00 VN ⇒ sáng; 08:00 UTC = 15:00 VN ⇒ chiều.
        assert_eq!(slot_of(&json!({}), at("2026-11-27T02:00:00Z")), Slot::Morning);
        assert_eq!(slot_of(&json!({}), at("2026-11-27T08:00:00Z")), Slot::Evening);
        assert_eq!(
            slot_of(&json!({ "slot": "evening" }), at("2026-11-27T02:00:00Z")),
            Slot::Evening
        );
        assert_eq!(
            slot_of(&json!({ "slot": "khac" }), at("2026-11-27T02:00:00Z")),
            Slot::Morning
        );
    }

    #[test]
    fn lam_sach_tieu_de_va_noi_dung() {
        assert_eq!(clean(Some(&json!("  Bản tin  ")), 200), "Bản tin");
        assert_eq!(clean(Some(&json!("abcdef")), 3), "abc");
        assert_eq!(clean(Some(&json!(5)), 3), "");
        assert_eq!(clean(None, 3), "");
        assert_eq!(clean(Some(&json!("   ")), 3), "");
    }

    #[test]
    fn du_lieu_bao_cao_dung_hinh() {
        let r = json!({
            "report": { "id": "doanh_so", "name": "Doanh số", "source": "deals" },
            "period": { "value": "this_month", "label": "Tháng 11/2026" },
            "count": 4, "sums": { "value": 1500 }, "missing_date": 1,
            "groups": [
                { "key": "1", "count": 3, "sums": { "value": 1000 }, "label": "An" },
                { "key": null, "count": 1, "sums": {}, "label": "(Trống)" }
            ],
            "by_month": [{ "month": "2026-11", "count": 4, "sums": { "value": 1500 } }],
            "fields": {
                "date": "Ngày tạo",
                "sums": [{ "key": "value", "label": "Giá trị" }],
                "group": "Người phụ trách"
            }
        });
        let d = report_data(&r);
        assert_eq!(d["report"], json!({ "id": "doanh_so", "name": "Doanh số" }));
        assert_eq!(d["period"], "Tháng 11/2026");
        assert_eq!(d["date_field"], "Ngày tạo");
        assert_eq!(d["sums"], json!([{ "label": "Giá trị", "total": 1500 }]));
        assert_eq!(d["groups"]["by"], "Người phụ trách");
        assert_eq!(d["groups"]["rows"][0]["sums"], json!([1000]));
        assert_eq!(d["groups"]["rows"][1]["sums"], json!([0]));
        assert_eq!(d["by_month"], json!([{ "month": "2026-11", "count": 4 }]));
        let mut no_group = r.clone();
        no_group["fields"]["group"] = Value::Null;
        assert_eq!(report_data(&no_group)["groups"], Value::Null);
    }
}
