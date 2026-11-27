//! `list_interactions` (`interaction-tools.ts`): dòng thời gian gộp bình luận Fanpage, hội thoại Messenger và Zalo OA, kèm luật đã chạy
//! và trạng thái trả lời. Gọi lại đúng hàm nghiệp vụ của router `/interactions` (`mod_deals::interactions`): mỗi nguồn chỉ hiện khi
//! tính năng của nó bật VÀ người dùng có quyền như hộp thư từng kênh (Fanpage: `integrations.webhooks`, Zalo OA: `contacts.update`).

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use mod_deals::interactions::{InteractionQuery, list, sources, stats};
use serde_json::{Value, json};
use trinity_kernel::vn_time::vn_to_utc;
use trinity_rbac::plan::resolve_org_features;

use super::wrapped;
use crate::args::{opt_str, reject_digit_probe};
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const DEFAULT_LIMIT: i64 = 30;
const MANAGE_URL: &str = "/inbox?kenh=tuong-tac";

fn bad_date(v: &str) -> ToolError {
    ToolError::User(format!("Ngày không hợp lệ: {v}. Dùng dạng 2026-10-16. / Invalid date."))
}

/// Ngày không kèm giờ (`2026-10-16`) = cả ngày theo giờ VN: `from` từ 00:00:00, `to` tới 23:59:59; dạng khác như `new Date(v)`.
fn day_bound(v: Option<&Value>, end: bool) -> Result<Option<DateTime<Utc>>, ToolError> {
    let Some(raw) = v.and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let b = raw.as_bytes();
    let date_only = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        });
    if date_only {
        let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| bad_date(raw))?;
        let time = if end {
            NaiveTime::from_hms_opt(23, 59, 59).unwrap_or(NaiveTime::MIN)
        } else {
            NaiveTime::MIN
        };
        return Ok(Some(vn_to_utc(day, time)));
    }
    mod_contacts::filter::parse_js_instant(raw)
        .map(Some)
        .ok_or_else(|| bad_date(raw))
}

pub fn list_interactions<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let pick = |k: &str, allowed: &[&str]| {
            args.get(k)
                .and_then(Value::as_str)
                .filter(|s| allowed.contains(s))
                .map(str::to_owned)
        };
        let q = opt_str(args.get("q"), 100);
        if let Some(text) = &q {
            // Khớp theo nội dung/tên còn phản hồi thì che SĐT ⇒ chặn dò chữ số như `list_contacts`.
            reject_digit_probe(text)?;
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite())
            .map_or(DEFAULT_LIMIT, |f| f.trunc() as i64);
        let query = InteractionQuery {
            channel: pick("channel", &["facebook", "zalo"]),
            r#type: pick("type", &["comment", "message"]),
            unanswered_only: args.get("status").and_then(Value::as_str) == Some("unanswered"),
            has_rule: args.get("has_rule").and_then(Value::as_bool),
            from: day_bound(args.get("from"), false)?,
            to: day_bound(args.get("to"), true)?,
            q,
            limit: Some(limit),
            ..InteractionQuery::default()
        };
        let mut conn = deps.conn(p.company).await?;
        // Cờ tính năng đã tính gói; khoá vắng = bật (như router).
        let mut features = resolve_org_features(&Value::Null, None);
        if let Ok(flags) = mod_settings::features::get(&mut conn, deps.settings_ctx(p)).await {
            for (key, on) in &flags.0 {
                features.set(key, on.unwrap_or(true));
            }
        }
        let src = sources(&features, &p.grants);
        let listed = list(&mut conn, src, &query).await.map_err(app_err)?;
        let today = stats(&mut conn, src, Utc::now()).await.map_err(app_err)?;
        let mut items = to_json(&listed.data)?;
        if let Some(a) = items.as_array_mut() {
            for it in a {
                if let Some(o) = it.as_object_mut() {
                    o.remove("ref");
                }
            }
        }
        wrapped(&json!({
            "stats_today": {
                "messages": today.messages_today, "comments": today.comments_today,
                "auto_handled": today.auto_handled_today, "unanswered_last_7_days": today.unanswered_7d,
            },
            "items": items, "more": listed.next_before.is_some(), "manage_url": MANAGE_URL,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ngay_khong_gio_la_ca_ngay_gio_viet_nam() {
        let from = day_bound(Some(&json!("2026-10-16")), false).unwrap().unwrap();
        let to = day_bound(Some(&json!("2026-10-16")), true).unwrap().unwrap();
        assert_eq!(from.to_rfc3339(), "2026-10-15T17:00:00+00:00");
        assert_eq!(to.to_rfc3339(), "2026-10-16T16:59:59+00:00");
        assert!(day_bound(None, false).unwrap().is_none());
        assert!(day_bound(Some(&json!("")), true).unwrap().is_none());
        assert!(day_bound(Some(&json!("2026-02-30")), false).is_err());
        assert!(day_bound(Some(&json!("hôm qua")), false).is_err());
    }
}
