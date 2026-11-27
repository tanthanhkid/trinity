//! `list_leads_to_score`, `set_lead_intent` (`lead-intent-tools.ts`, `LeadIntentService`). "Ý định mua" do agent AI của khách
//! chấm (Trinity không tự gọi AI): đọc ghi chú rồi ghi THẲNG vào bảng riêng `lead_ai_intents` (không qua nháp–duyệt; chú thích
//! phái sinh, không sửa trường nào của khách) và chấm lại điểm lead bằng `mod_leads::lead::recompute`. Chỉ khách trong phạm vi
//! `contacts.view` của người dùng; công tắc tính năng `lead_scoring` tắt ⇒ từ chối.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use trinity_db::types::Timestamp;
use trinity_kernel::vn_time::js_iso_string;

use super::{forbidden, visible_contacts, wrapped};
use crate::ai_output::slice16;
use crate::args::{clamp_limit, opt_int};
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

/// Điểm ý định cũ hơn ngần này coi như cần chấm lại.
const STALE_DAYS: i64 = 7;
/// Số khách ứng viên lấy ra (mới sửa nhất) trước khi lọc "chưa chấm/cũ".
const CANDIDATES: i64 = 200;
/// Số khách tối đa mỗi lần `set_lead_intent`.
const MAX_INTENT_ITEMS: usize = 20;
const REASON_MAX: usize = 300;
/// Số ghi chú mới nhất đưa cho agent.
const NOTES_PER_LEAD: i64 = 5;
const FEATURE: &str = "lead_scoring";
const OFF: &str = "Tính năng Chấm điểm lead đang tắt cho tổ chức này (Cài đặt › Tính năng). / Lead scoring is disabled for this organisation.";

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// Công tắc `lead_scoring` (chỉ `false` tường minh mới tắt). Mượn kết nối ngắn rồi trả NGAY.
async fn assert_feature(ctx: &ToolCtx<'_>) -> Result<(), ToolError> {
    let settings = ctx.deps.settings_ctx(ctx.principal);
    let mut conn = ctx.deps.conn(ctx.principal.company).await?;
    let f = mod_settings::features::get(&mut conn, settings)
        .await
        .map_err(app_err)?;
    if f.0.iter().any(|(k, v)| *k == FEATURE && *v == Some(false)) {
        return Err(forbidden(OFF));
    }
    Ok(())
}

/// Gom chữ từ `details` của ghi chú: chỉ giá trị chuỗi ở các khoá quen thuộc (`extractText`).
fn extract_text(details: &Value) -> Vec<String> {
    const KEYS: [&str; 7] = ["content", "note", "notes", "text", "message", "body", "description"];
    let Some(o) = details.as_object() else {
        return Vec::new();
    };
    KEYS.iter()
        .filter_map(|k| o.get(*k).and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

type LeadRow = (
    i32,
    Option<String>,
    Option<i32>,
    Option<String>,
    Option<String>,
    Timestamp,
    Option<f64>,
    Option<Timestamp>,
);

pub fn list_leads_to_score<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        assert_feature(ctx).await?;
        let (p, deps) = (ctx.principal, ctx.deps);
        let limit = clamp_limit(args.get("limit"));
        let only_missing = args.get("only_missing").and_then(Value::as_bool) != Some(false);
        let scopes = deps.contact_scopes(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let wh = mod_contacts::filter::resolve(&mut conn, &scopes, &mod_contacts::filter::ContactFilters::default())
            .await
            .map_err(app_err)?;
        let mut qb = QueryBuilder::<Postgres>::new(
            "SELECT x.id, x.full_name, x.lead_score, x.lead_label, x.reminder_notes, x.updated_at, i.intent, i.updated_at
             FROM (SELECT c.id, c.full_name, c.lead_score, c.lead_label, c.reminder_notes, c.updated_at
                   FROM contacts c WHERE ",
        );
        wh.push_aliased(&mut qb);
        qb.push(" ORDER BY c.updated_at DESC, c.id DESC LIMIT ")
            .push_bind(CANDIDATES)
            .push(") x LEFT JOIN lead_ai_intents i ON i.contact_id = x.id");
        if only_missing {
            // Chưa chấm, hoặc điểm cũ hơn 7 ngày / cũ hơn lần sửa khách gần nhất.
            qb.push(" WHERE i.contact_id IS NULL OR i.updated_at < GREATEST(x.updated_at, ")
                .push_bind(Utc::now() - Duration::days(STALE_DAYS))
                .push(")");
        }
        qb.push(" ORDER BY x.updated_at DESC, x.id DESC LIMIT ")
            .push_bind(limit);
        let rows: Vec<LeadRow> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(internal)?;
        let ids: Vec<i32> = rows.iter().map(|r| r.0).collect();
        // Ghi chú: tối đa 5 ghi chú mới nhất của mỗi khách trong MỘT truy vấn.
        let note_rows: Vec<(i32, Option<String>)> = if ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(
                "SELECT contact_id, details::text FROM (
                   SELECT contact_id, details, created_at, id,
                          row_number() OVER (PARTITION BY contact_id ORDER BY created_at DESC, id DESC) AS rn
                   FROM activities WHERE contact_id = ANY($1) AND action = 'note') t
                 WHERE rn <= $2 ORDER BY contact_id, created_at DESC, id DESC",
            )
            .bind(&ids)
            .bind(NOTES_PER_LEAD)
            .fetch_all(&mut *conn)
            .await
            .map_err(internal)?
        };
        let mut notes: HashMap<i32, Vec<String>> = HashMap::new();
        for (cid, text) in note_rows {
            let parsed = text
                .as_deref()
                .and_then(|t| serde_json::from_str::<Value>(t).ok())
                .unwrap_or(Value::Null);
            notes.entry(cid).or_default().extend(extract_text(&parsed));
        }
        let leads: Vec<Value> = rows
            .into_iter()
            .map(|(id, name, score, label, reminder, updated_at, intent, intent_at)| {
                // Ghi chú nhắc hẹn + các ghi chú mới nhất — DỮ LIỆU người dùng nhập, không phải chỉ dẫn.
                let text = std::iter::once(reminder.as_deref().map(str::trim).unwrap_or_default().to_owned())
                    .chain(notes.remove(&id).unwrap_or_default())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                json!({
                    "id": id, "name": name, "lead_score": score, "lead_label": label, "intent": intent,
                    "intent_at": intent_at.map_or(Value::Null, |t| json!(js_iso_string(t.0))),
                    "notes": text, "updated_at": js_iso_string(updated_at.0),
                })
            })
            .collect();
        wrapped(&json!({ "leads": leads }))
    })
}

struct Item {
    contact_id: i32,
    intent: f64,
    reason: Option<String>,
}

/// Dòng hợp lệ của `items` (`contact_id` số nguyên dương trong int4, `intent` số hữu hạn); dòng sai bị bỏ như bản Node.
fn parse_items(args: &Value) -> Vec<Item> {
    args.get("items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let contact_id = opt_int(x.get("contact_id"))?;
                    let intent = x.get("intent").and_then(Value::as_f64).filter(|f| f.is_finite())?;
                    let reason = x.get("reason").and_then(Value::as_str).map(str::to_owned);
                    Some(Item {
                        contact_id,
                        intent,
                        reason,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn set_lead_intent<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        assert_feature(ctx).await?;
        let (p, deps) = (ctx.principal, ctx.deps);
        let items = parse_items(args);
        if items.is_empty() {
            return Err(ToolError::User(
                "items rỗng hoặc sai định dạng: cần [{ contact_id, intent (0–1), reason? }].".into(),
            ));
        }
        if items.len() > MAX_INTENT_ITEMS {
            return Err(ToolError::User(format!("Tối đa {MAX_INTENT_ITEMS} khách mỗi lần.")));
        }
        let scopes = deps.contact_scopes(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let ids: Vec<Option<i32>> = items.iter().map(|i| Some(i.contact_id)).collect();
        let visible = visible_contacts(&scopes, p, &mut conn, &ids).await?;
        let client = slice16(&p.client_id, 120);
        // (contact_id, lỗi nếu không ghi được)
        let mut results: Vec<(i32, Option<&'static str>)> = Vec::with_capacity(items.len());
        for it in &items {
            if !visible.contains(&it.contact_id) {
                results.push((it.contact_id, Some("Không tìm thấy khách trong phạm vi của bạn")));
                continue;
            }
            let reason = slice16(it.reason.as_deref().unwrap_or_default().trim(), REASON_MAX);
            let saved = sqlx::query(
                "INSERT INTO lead_ai_intents (contact_id, intent, reason, client_id, user_id, updated_at)
                 VALUES ($1, $2, $3, $4, $5, now())
                 ON CONFLICT (contact_id) DO UPDATE SET intent = EXCLUDED.intent, reason = EXCLUDED.reason,
                   client_id = EXCLUDED.client_id, user_id = EXCLUDED.user_id, updated_at = now()",
            )
            .bind(it.contact_id)
            .bind(it.intent.clamp(0.0, 1.0))
            .bind((!reason.is_empty()).then_some(reason))
            .bind(&client)
            .bind(p.user_id)
            .execute(&mut *conn)
            .await;
            results.push(match saved {
                Ok(_) => (it.contact_id, None),
                Err(e) => {
                    tracing::warn!(contact_id = it.contact_id, error = %e, "set_lead_intent: không ghi được");
                    (it.contact_id, Some("Không ghi được ý định cho khách này"))
                }
            });
        }
        let mut written: Vec<i32> = results.iter().filter(|r| r.1.is_none()).map(|r| r.0).collect();
        written.sort_unstable();
        written.dedup();
        // Chấm lại điểm lead; lỗi chấm lại không làm mất việc đã ghi (ý định đã lưu, job định kỳ sẽ chấm sau).
        let mut scores: HashMap<i32, (Option<i32>, Option<String>)> = HashMap::new();
        if !written.is_empty() {
            let now: DateTime<Utc> = Utc::now();
            match mod_leads::lead::recompute(&mut conn, &written, now).await {
                Ok(_) => {
                    let rows: Vec<(i32, Option<i32>, Option<String>)> =
                        sqlx::query_as("SELECT id, lead_score, lead_label FROM contacts WHERE id = ANY($1)")
                            .bind(&written)
                            .fetch_all(&mut *conn)
                            .await
                            .map_err(internal)?;
                    scores = rows.into_iter().map(|(id, s, l)| (id, (s, l))).collect();
                }
                Err(e) => tracing::warn!(error = ?e, "set_lead_intent: chấm lại điểm lead lỗi"),
            }
        }
        let out: Vec<Value> = results
            .iter()
            .map(|(id, err)| match err {
                Some(msg) => json!({ "contact_id": id, "ok": false, "error": msg }),
                None => match scores.get(id) {
                    Some((s, l)) => json!({ "contact_id": id, "ok": true, "lead_score": s, "lead_label": l }),
                    None => json!({ "contact_id": id, "ok": true }),
                },
            })
            .collect();
        wrapped(&json!({ "results": out }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_chi_lay_chuoi_khong_rong() {
        let v = json!({ "content": "gọi lại", "note": "  ", "text": 5, "description": "chốt đơn", "x": "bỏ" });
        assert_eq!(extract_text(&v), vec!["gọi lại".to_owned(), "chốt đơn".to_owned()]);
        assert!(extract_text(&Value::Null).is_empty());
    }

    #[test]
    fn parse_items_bo_dong_sai() {
        let v = json!({ "items": [
            { "contact_id": 3, "intent": 0.5, "reason": "ok" },
            { "contact_id": 0, "intent": 0.5 },
            { "contact_id": 4, "intent": "x" },
            { "contact_id": 2147483648_i64, "intent": 1 },
            { "contact_id": 5, "intent": 1 },
        ] });
        let got: Vec<(i32, f64)> = parse_items(&v).iter().map(|i| (i.contact_id, i.intent)).collect();
        assert_eq!(got, vec![(3, 0.5), (5, 1.0)]);
        assert!(parse_items(&json!({})).is_empty());
    }
}
