//! "Tương tác" (`InteractionsController`/`InteractionsService`): một dòng thời gian gộp bình luận Fanpage, hội thoại Messenger
//! và Zalo OA, kèm luật đã chạy, kết quả và trạng thái trả lời. Mỗi nguồn chỉ hiện khi tính năng của nó bật VÀ người xem có
//! quyền như hộp thư từng kênh (Fanpage: `integrations.webhooks`, Zalo OA: `contacts.update`).

use chrono::{DateTime, Duration, NaiveTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{FacebookComment, FacebookConversation, FacebookMessage, ZaloOaThread};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::{js_iso_string, vn_date, vn_to_utc};
use trinity_rbac::plan::OrgFeatures;
use trinity_rbac::{Grants, can};

use crate::{db, http};

/// Cột của từng bảng, đúng thứ tự struct trong `trinity_db::models` (liệt kê tường minh thay cho `*`).
const COMMENT_COLS: &str = "id, comment_id, page_id, post_id, parent_id, from_id, from_name, message, commented_at, contact_id, phone, rule_id, status, note, actions, hidden, created_at";
const CONV_COLS: &str = "id, page_id, psid, customer_name, contact_id, last_inbound_at, last_message_at, last_message_preview, unread_count, entry_link_id, created_at";
const THREAD_COLS: &str = "id, oa_id, zalo_user_id, display_name, avatar_url, phone, contact_id, last_message_preview, last_message_at, last_inbound_at, unread_count, created_at, updated_at";
const MESSAGE_COLS: &str = "id, conversation_id, mid, direction, text, sent_by_user_id, sent_at";

/// Facebook cho nhắn riêng một lần mỗi bình luận, trong 7 ngày.
const PRIVATE_WINDOW_MS: i64 = 7 * 86_400_000;

/// Nguồn nào người xem được thấy (công tắc tính năng + quyền).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Sources {
    pub facebook: bool,
    pub zalo: bool,
}

/// `OrgFeaturesService.get()` đã tính gói (K25) + quyền của người xem. Khoá vắng = bật (`!== false`).
pub fn sources(features: &OrgFeatures, grants: &Grants) -> Sources {
    let on = |k: &str| features.get(k) != Some(false);
    let inbox = on("inbox");
    Sources {
        facebook: inbox && on("facebook_page") && can(grants, "integrations.webhooks", None),
        zalo: inbox && on("zalo_oa") && can(grants, "contacts.update", None),
    }
}

/// Query `GET /interactions` đã chuẩn hoá như controller: giá trị lạ của `channel`/`type`/`status` bị bỏ, `has_rule` `1`/`0`,
/// `q` cắt 100 ký tự, `limit` mặc định 50 (service kẹp 1..100).
#[derive(Debug, Clone, Default)]
pub struct InteractionQuery {
    pub channel: Option<String>,
    pub r#type: Option<String>,
    pub page_id: Option<String>,
    pub unanswered_only: bool,
    pub has_rule: Option<bool>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub before: Option<DateTime<Utc>>,
    pub q: Option<String>,
    pub limit: Option<i64>,
}

impl InteractionQuery {
    /// Dựng từ chuỗi query thô; ngày không hợp lệ ⇒ 400 `Ngày không hợp lệ: <giá trị>`.
    #[allow(clippy::too_many_arguments)]
    pub fn from_raw(
        channel: Option<&str>,
        r#type: Option<&str>,
        page_id: Option<&str>,
        status: Option<&str>,
        has_rule: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
        q: Option<&str>,
        limit: Option<&str>,
        before: Option<&str>,
    ) -> Result<Self, AppError> {
        let date = |v: Option<&str>| -> Result<Option<DateTime<Utc>>, AppError> {
            match v.filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(s) => mod_contacts::filter::parse_js_instant(s)
                    .map(Some)
                    .ok_or_else(|| http(HttpError::bad_request(format!("Ngày không hợp lệ: {s}")))),
            }
        };
        let limit = match limit.filter(|s| !s.is_empty()) {
            // `Number(limit) || 50`
            Some(s) => {
                let n: f64 = s.trim().parse().unwrap_or(0.0);
                if n.is_finite() && n != 0.0 { n as i64 } else { 50 }
            }
            None => 50,
        };
        let q = q
            .filter(|s| !s.is_empty())
            .map(|s| truncate_utf16(s, 100))
            .filter(|s| !s.is_empty());
        Ok(Self {
            channel: channel.filter(|c| matches!(*c, "facebook" | "zalo")).map(str::to_owned),
            r#type: r#type
                .filter(|c| matches!(*c, "comment" | "message"))
                .map(str::to_owned),
            page_id: page_id.filter(|s| !s.is_empty()).map(str::to_owned),
            unanswered_only: status == Some("unanswered"),
            has_rule: match has_rule {
                Some("1") => Some(true),
                Some("0") => Some(false),
                _ => None,
            },
            from: date(from)?,
            to: date(to)?,
            before: date(before)?,
            q,
            limit: Some(limit),
        })
    }
}

/// `String.prototype.slice(0, n)` tính theo đơn vị UTF-16.
fn truncate_utf16(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// Phần việc đã lên kế hoạch của một bình luận (`PlannedActions`), chỉ đọc những gì dòng thời gian cần.
struct Planned<'a>(&'a Value);

impl Planned<'_> {
    fn text_at(&self, key: &str, field: &str) -> Option<&str> {
        self.0.get(key)?.get(field)?.as_str().filter(|s| !s.is_empty())
    }
    fn manual_len(&self) -> usize {
        self.0.get("manual").and_then(Value::as_array).map_or(0, Vec::len)
    }
    fn manual_private(&self) -> bool {
        self.0.get("manual").and_then(Value::as_array).is_some_and(|a| {
            a.iter()
                .any(|m| m.get("mode").and_then(Value::as_str) == Some("private"))
        })
    }
    fn public_id(&self) -> bool {
        self.text_at("public_reply", "id").is_some()
    }
    fn private_id(&self) -> bool {
        self.text_at("private_reply", "message_id").is_some()
    }
}

/// Bình luận đã có người/luật trả lời, hoặc luật bỏ qua vì đã trả lời người này.
pub fn comment_answered(status: &str, actions: &Value) -> bool {
    let a = Planned(actions);
    status == "skipped" || a.public_id() || a.private_id() || a.manual_len() > 0
}

/// Đã nhắn riêng cho bình luận này chưa (luật hoặc tay) — Facebook chỉ cho một lần.
pub fn private_replied(actions: &Value) -> bool {
    let a = Planned(actions);
    a.private_id() || a.manual_private()
}

/// Một dòng kết quả luật: `Luật "X": đã trả lời công khai, đã nhắn riêng`.
pub fn auto_result_line(rule_name: Option<&str>, status: &str, actions: &Value) -> Option<String> {
    let name = rule_name?;
    if status == "test" {
        return Some(format!("Luật \"{name}\" (chạy thử)"));
    }
    if status == "skipped" {
        return Some(format!("Luật \"{name}\": bỏ qua (đã trả lời người này)"));
    }
    let a = Planned(actions);
    let hide_done = actions.get("hide").and_then(|h| h.get("done")).and_then(Value::as_bool) == Some(true);
    let mut done: Vec<&str> = Vec::new();
    if a.public_id() {
        done.push("đã trả lời công khai");
    }
    if a.private_id() {
        done.push("đã nhắn riêng");
    }
    if hide_done {
        done.push("đã ẩn vì có SĐT");
    }
    let failed = [
        a.text_at("public_reply", "error"),
        a.text_at("private_reply", "error"),
        a.text_at("hide", "error"),
    ]
    .iter()
    .flatten()
    .count();
    let list = if done.is_empty() {
        "chưa làm được".to_owned()
    } else {
        done.join(", ")
    };
    let tail = if failed > 0 {
        format!(" ({failed} việc lỗi)")
    } else {
        String::new()
    };
    Some(format!("Luật \"{name}\": {list}{tail}"))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Ref {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Interaction {
    pub key: String,
    pub channel: &'static str,
    pub r#type: &'static str,
    pub page_id: Option<String>,
    pub channel_name: String,
    pub at: String,
    pub customer_name: Option<String>,
    pub contact_id: Option<i32>,
    pub text: Option<String>,
    pub post_url: Option<String>,
    pub rule_name: Option<String>,
    pub auto_result: Option<String>,
    pub hidden: bool,
    pub status: &'static str,
    pub r#ref: Ref,
}

#[derive(Debug, Serialize)]
pub struct InteractionList {
    pub data: Vec<Interaction>,
    pub next_before: Option<String>,
}

fn contains(qb: &mut QueryBuilder<Postgres>, cols: &[&str], text: &str) {
    qb.push(" AND (");
    for (i, c) in cols.iter().enumerate() {
        if i > 0 {
            qb.push(" OR ");
        }
        qb.push(*c)
            .push(" ILIKE ")
            .push_bind(format!("%{}%", trinity_kernel::vi::escape_like(text)))
            .push(" ESCAPE '\\'");
    }
    qb.push(")");
}

fn time_range(qb: &mut QueryBuilder<Postgres>, col: &str, q: &InteractionQuery) {
    if let Some(t) = q.from {
        qb.push(format!(" AND {col} >= ")).push_bind(t);
    }
    if let Some(t) = q.to {
        qb.push(format!(" AND {col} <= ")).push_bind(t);
    }
    if let Some(t) = q.before {
        qb.push(format!(" AND {col} < ")).push_bind(t);
    }
}

/// `GET /interactions`: gộp, mới nhất trước, phân trang lùi theo thời gian bằng `before`.
pub async fn list(conn: &mut PgConnection, src: Sources, q: &InteractionQuery) -> Result<InteractionList, AppError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let text =
        q.q.as_deref()
            .map(trinity_kernel::vi::trim_js)
            .filter(|t| !t.is_empty());
    let channel = q.channel.as_deref();
    let ty = q.r#type.as_deref();
    let want_comments = src.facebook && channel != Some("zalo") && ty != Some("message");
    let want_fb_msg = src.facebook && channel != Some("zalo") && ty != Some("comment") && q.has_rule.is_none();
    let want_zalo =
        src.zalo && channel != Some("facebook") && ty != Some("comment") && q.has_rule.is_none() && q.page_id.is_none();
    // Lọc "chưa trả lời" của bình luận nằm trong JSON ⇒ lấy rộng hơn rồi lọc.
    let take = if q.unanswered_only { (limit * 4).min(300) } else { limit };

    let comments: Vec<FacebookComment> = if want_comments {
        let mut qb = QueryBuilder::<Postgres>::new(format!("SELECT {COMMENT_COLS} FROM facebook_comments WHERE TRUE"));
        time_range(&mut qb, "commented_at", q);
        if let Some(p) = &q.page_id {
            qb.push(" AND page_id = ").push_bind(p.clone());
        }
        match q.has_rule {
            Some(true) => {
                qb.push(" AND rule_id IS NOT NULL");
            }
            Some(false) => {
                qb.push(" AND rule_id IS NULL");
            }
            None => {}
        }
        if let Some(t) = text {
            contains(&mut qb, &["message", "from_name"], t);
        }
        qb.push(" ORDER BY commented_at DESC, id DESC LIMIT ").push_bind(take);
        qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?
    } else {
        Vec::new()
    };
    let convs: Vec<FacebookConversation> = if want_fb_msg {
        let mut qb =
            QueryBuilder::<Postgres>::new(format!("SELECT {CONV_COLS} FROM facebook_conversations WHERE TRUE"));
        time_range(&mut qb, "last_message_at", q);
        if let Some(p) = &q.page_id {
            qb.push(" AND page_id = ").push_bind(p.clone());
        }
        if let Some(t) = text {
            contains(&mut qb, &["customer_name", "last_message_preview"], t);
        }
        qb.push(" ORDER BY last_message_at DESC, id DESC LIMIT ")
            .push_bind(take);
        qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?
    } else {
        Vec::new()
    };
    let threads: Vec<ZaloOaThread> = if want_zalo {
        let mut qb = QueryBuilder::<Postgres>::new(format!(
            "SELECT {THREAD_COLS} FROM zalo_oa_threads WHERE last_message_at IS NOT NULL"
        ));
        time_range(&mut qb, "last_message_at", q);
        if let Some(t) = text {
            contains(&mut qb, &["display_name", "last_message_preview"], t);
        }
        qb.push(" ORDER BY last_message_at DESC, id DESC LIMIT ")
            .push_bind(take);
        qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?
    } else {
        Vec::new()
    };
    let pages: Vec<(String, String)> = sqlx::query_as("SELECT page_id, name FROM facebook_pages")
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let page_name = |id: &str| pages.iter().find(|(p, _)| p == id).map(|(_, n)| n.clone());
    let mut rule_ids: Vec<i32> = comments.iter().filter_map(|c| c.rule_id).collect();
    rule_ids.sort_unstable();
    rule_ids.dedup();
    let rules: Vec<(i32, String)> = if rule_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, name FROM facebook_comment_rules WHERE id = ANY($1)")
            .bind(&rule_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };

    let mut items: Vec<Interaction> = Vec::new();
    for c in &comments {
        let rn = c
            .rule_id
            .and_then(|id| rules.iter().find(|(r, _)| *r == id).map(|(_, n)| n.as_str()));
        let a = &c.actions.0;
        let status = if Planned(a).manual_len() > 0 {
            "staff"
        } else if comment_answered(&c.status, a) {
            "auto"
        } else {
            "unanswered"
        };
        items.push(Interaction {
            key: format!("fb-comment:{}", c.id.0),
            channel: "facebook",
            r#type: "comment",
            page_id: Some(c.page_id.clone()),
            channel_name: page_name(&c.page_id).unwrap_or_else(|| "Fanpage".to_owned()),
            at: js_iso_string(c.commented_at.0),
            customer_name: c.from_name.clone(),
            contact_id: c.contact_id,
            text: c.message.clone(),
            post_url: Some(format!("https://www.facebook.com/{}", c.post_id)),
            rule_name: rn.filter(|n| !n.is_empty()).map(str::to_owned),
            auto_result: auto_result_line(rn, &c.status, a),
            hidden: c.hidden,
            status,
            r#ref: Ref {
                comment_id: Some(c.id.0.to_string()),
                conversation_id: None,
                thread_id: None,
            },
        });
    }
    for c in &convs {
        let unanswered = c.last_inbound_at.is_some_and(|i| i.0 >= c.last_message_at.0);
        items.push(Interaction {
            key: format!("fb-conv:{}", c.id),
            channel: "facebook",
            r#type: "message",
            page_id: Some(c.page_id.clone()),
            channel_name: page_name(&c.page_id).unwrap_or_else(|| "Fanpage".to_owned()),
            at: js_iso_string(c.last_message_at.0),
            customer_name: c.customer_name.clone(),
            contact_id: c.contact_id,
            text: c.last_message_preview.clone(),
            post_url: None,
            rule_name: None,
            auto_result: None,
            hidden: false,
            status: if unanswered { "unanswered" } else { "answered" },
            r#ref: Ref {
                comment_id: None,
                conversation_id: Some(c.id),
                thread_id: None,
            },
        });
    }
    for t in &threads {
        let Some(last) = t.last_message_at else { continue };
        let unanswered = t.last_inbound_at.is_some_and(|i| i.0 >= last.0);
        items.push(Interaction {
            key: format!("zalo-thread:{}", t.id),
            channel: "zalo",
            r#type: "message",
            page_id: None,
            channel_name: "Zalo OA".to_owned(),
            at: js_iso_string(last.0),
            customer_name: t.display_name.clone(),
            contact_id: t.contact_id,
            text: t.last_message_preview.clone(),
            post_url: None,
            rule_name: None,
            auto_result: None,
            hidden: false,
            status: if unanswered { "unanswered" } else { "answered" },
            r#ref: Ref {
                comment_id: None,
                conversation_id: None,
                thread_id: Some(t.id),
            },
        });
    }
    if q.unanswered_only {
        items.retain(|i| i.status == "unanswered");
    }
    // Sắp xếp ổn định theo `at` giảm dần (chuỗi ISO cùng độ dài nên so chuỗi = so thời gian), như `localeCompare`.
    items.sort_by(|x, y| y.at.cmp(&x.at));
    let total = items.len();
    let take_n = usize::try_from(limit).unwrap_or(100);
    items.truncate(take_n);
    let next_before = if total > take_n {
        items.last().map(|i| i.at.clone())
    } else {
        None
    };
    Ok(InteractionList {
        data: items,
        next_before,
    })
}

#[derive(Debug, Serialize)]
pub struct Stats {
    pub messages_today: i64,
    pub comments_today: i64,
    pub auto_handled_today: i64,
    pub unanswered_7d: usize,
    pub channels: Sources,
}

/// 00:00 hôm nay theo giờ VN và 24 giờ sau (`vnTodayRange`).
fn vn_today(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = vn_to_utc(vn_date(now), NaiveTime::MIN);
    (start, start + Duration::hours(24))
}

async fn count(
    conn: &mut PgConnection,
    enabled: bool,
    sql: &'static str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<i64, AppError> {
    if !enabled {
        return Ok(0);
    }
    sqlx::query_scalar(sql)
        .bind(start)
        .bind(end)
        .fetch_one(conn)
        .await
        .map_err(db)
}

/// `GET /interactions/stats`: số đầu trang hôm nay (giờ VN) và số việc chưa trả lời trong 7 ngày.
pub async fn stats(conn: &mut PgConnection, src: Sources, now: DateTime<Utc>) -> Result<Stats, AppError> {
    let (start, end) = vn_today(now);
    let fb_in = count(
        conn,
        src.facebook,
        "SELECT count(*) FROM facebook_messages WHERE direction = 'in' AND sent_at >= $1 AND sent_at < $2",
        start,
        end,
    )
    .await?;
    let zalo_in = count(
        conn,
        src.zalo,
        "SELECT count(*) FROM zalo_oa_messages WHERE direction = 'in' AND created_at >= $1 AND created_at < $2",
        start,
        end,
    )
    .await?;
    let comments = count(
        conn,
        src.facebook,
        "SELECT count(*) FROM facebook_comments WHERE commented_at >= $1 AND commented_at < $2",
        start,
        end,
    )
    .await?;
    let auto = count(conn, src.facebook, "SELECT count(*) FROM facebook_comments WHERE commented_at >= $1 AND commented_at < $2 AND rule_id IS NOT NULL AND status IN ('done', 'test')", start, end).await?;
    let unanswered = list(
        conn,
        src,
        &InteractionQuery {
            unanswered_only: true,
            from: Some(now - Duration::days(7)),
            limit: Some(100),
            ..InteractionQuery::default()
        },
    )
    .await?
    .data
    .len();
    Ok(Stats {
        messages_today: fb_in + zalo_in,
        comments_today: comments,
        auto_handled_today: auto,
        unanswered_7d: unanswered,
        channels: src,
    })
}

fn nothing() -> AppError {
    http(HttpError::nest(404, None))
}

/// `GET /interactions/comments/:id/thread`: các bình luận cùng người trên cùng bài + hội thoại Messenger của khách (nếu có).
/// Cùng cổng với danh sách: công tắc Hộp thư + Fanpage và quyền Fanpage, nếu không ⇒ 404 trơn.
pub async fn thread(conn: &mut PgConnection, src: Sources, id: &str, now: DateTime<Utc>) -> Result<Value, AppError> {
    if !src.facebook || id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(nothing());
    }
    let id: i64 = id.parse().map_err(|_| nothing())?;
    let c: FacebookComment = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COMMENT_COLS} FROM facebook_comments WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(nothing)?;
    let siblings: Vec<FacebookComment> = match &c.from_id {
        Some(from) => sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {COMMENT_COLS} FROM facebook_comments WHERE post_id = $1 AND from_id = $2 ORDER BY commented_at ASC, id ASC LIMIT 30"
        )))
        .bind(&c.post_id)
        .bind(from)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?,
        None => vec![c.clone()],
    };
    let conv: Option<FacebookConversation> = match c.contact_id {
        Some(cid) => sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {CONV_COLS} FROM facebook_conversations WHERE page_id = $1 AND contact_id = $2 ORDER BY last_message_at DESC, id DESC LIMIT 1"
        )))
        .bind(&c.page_id)
        .bind(cid)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?,
        None => None,
    };
    let mut messages: Vec<FacebookMessage> = match &conv {
        Some(v) => sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {MESSAGE_COLS} FROM facebook_messages WHERE conversation_id = $1 ORDER BY sent_at DESC, id DESC LIMIT 30"
        )))
        .bind(v.id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?,
        None => Vec::new(),
    };
    messages.reverse();
    let comments: Vec<Value> = siblings
        .iter()
        .map(|s| {
            let within = (now - s.commented_at.0).num_milliseconds() <= PRIVATE_WINDOW_MS;
            json!({
                "id": s.id.0.to_string(),
                "message": s.message,
                "at": js_iso_string(s.commented_at.0),
                "status": s.status,
                "actions": s.actions.0,
                "hidden": s.hidden,
                "can_private_reply": !private_replied(&s.actions.0) && within,
            })
        })
        .collect();
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| {
            json!({
                "id": m.id.0.to_string(),
                "direction": m.direction,
                "text": m.text,
                "at": js_iso_string(m.sent_at.0),
            })
        })
        .collect();
    Ok(json!({
        "comments": comments,
        "conversation": conv.as_ref().map(|v| json!({ "id": v.id, "customer_name": v.customer_name })),
        "messages": msgs,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ket_qua_luat_nhu_ban_ts() {
        let a =
            json!({ "public_reply": { "text": "x", "id": "1" }, "private_reply": { "text": "y", "error": "boom" } });
        assert_eq!(
            auto_result_line(Some("Giá"), "done", &a).as_deref(),
            Some("Luật \"Giá\": đã trả lời công khai (1 việc lỗi)")
        );
        assert_eq!(
            auto_result_line(Some("Giá"), "done", &json!({})).as_deref(),
            Some("Luật \"Giá\": chưa làm được")
        );
        assert_eq!(
            auto_result_line(Some("G"), "test", &json!({})).as_deref(),
            Some("Luật \"G\" (chạy thử)")
        );
        assert_eq!(auto_result_line(None, "done", &a), None);
        let both =
            json!({ "public_reply": { "id": "1" }, "private_reply": { "message_id": "m" }, "hide": { "done": true } });
        assert_eq!(
            auto_result_line(Some("R"), "done", &both).as_deref(),
            Some("Luật \"R\": đã trả lời công khai, đã nhắn riêng, đã ẩn vì có SĐT")
        );
    }

    #[test]
    fn da_tra_loi_va_nhan_rieng() {
        assert!(comment_answered("skipped", &json!({})));
        assert!(comment_answered("done", &json!({ "manual": [{ "mode": "public" }] })));
        assert!(!comment_answered("done", &json!({ "public_reply": { "text": "x" } })));
        assert!(private_replied(&json!({ "manual": [{ "mode": "private" }] })));
        assert!(private_replied(&json!({ "private_reply": { "message_id": "m" } })));
        assert!(!private_replied(&json!({ "manual": [{ "mode": "public" }] })));
    }

    #[test]
    fn query_chuan_hoa_nhu_controller() {
        let q = InteractionQuery::from_raw(
            Some("tiktok"),
            Some("comment"),
            None,
            Some("unanswered"),
            Some("0"),
            None,
            None,
            Some(""),
            Some("abc"),
            None,
        )
        .unwrap();
        assert_eq!(q.channel, None);
        assert_eq!(q.r#type.as_deref(), Some("comment"));
        assert!(q.unanswered_only);
        assert_eq!(q.has_rule, Some(false));
        assert_eq!(q.q, None);
        assert_eq!(q.limit, Some(50));
        let bad = InteractionQuery::from_raw(
            None,
            None,
            None,
            None,
            None,
            Some("khong-phai-ngay"),
            None,
            None,
            None,
            None,
        );
        assert!(bad.is_err());
        assert_eq!(truncate_utf16(&"a".repeat(150), 100).len(), 100);
    }
}
