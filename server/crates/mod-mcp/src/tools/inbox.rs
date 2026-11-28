//! Hộp thư cho AI (M44c, `inbox-tools.ts`): `list_unanswered_messages`, `list_conversations`, `get_conversation_messages`,
//! `reply_to_customer`. Tin/bình luận khách chưa ai trả lời trên Messenger, bình luận Fanpage và Zalo OA; trả lời đi thẳng tới
//! khách nên cần hai bước (xem trước, rồi `confirmed_by_user`). Giữ luật kênh: Messenger 24 giờ (tới 7 ngày với thẻ Human Agent),
//! Zalo OA 48 giờ, nhắn riêng bình luận một lần trong 7 ngày.
//!
//! Đọc: SQL thẳng trên bảng hội thoại/tin (chỉ đọc, KHÔNG đồng bộ Graph, KHÔNG đánh dấu đã đọc, khác `FacebookIngest::messages`).
//! Gửi: chính `FacebookIngest::reply` và `mod_zalo::messaging::send_text` (cùng luật cửa sổ, khoá kênh, ghi lịch sử như giao diện).
//!
//! Chưa có: kênh `facebook_comment` (danh sách và trả lời thuộc M49, `mod-facebook` chưa có dịch vụ bình luận). Nhánh "dịch vụ
//! vắng" của bản TS được giữ nguyên chữ: danh sách ghi chú trong `notes`, trả lời báo lỗi người dùng. Khi M49 có trên main, thay hai
//! chỗ có chú thích `M49` bằng lời gọi dịch vụ.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, TimeDelta, Utc};
use mod_channel_guard::ChannelGuard;
use mod_facebook::inbox::{
    HUMAN_AGENT_WINDOW_MS, MESSENGER_CLOSED, ReplyMode, awaiting_reply, reply_mode, within_messaging_window,
};
use mod_facebook::ingest::FacebookIngest;
use mod_zalo::client::ZaloClient;
use mod_zalo::messaging::{in_consult_window, send_text};
use mod_zalo::token::Ctx as ZaloCtx;
use serde_json::{Map, Value, json};
use trinity_db::models::FacebookConversation;
use trinity_db::platform::Platform;
use trinity_db::types::Timestamp;
use trinity_http::router::OrgFeatureGate;
use trinity_kernel::error::AppError;
use trinity_rbac::{can, mask_phone};

use super::confirm::is_user_confirmation;
use super::wrapped;
use crate::args::{clamp_limit, opt_str, reject_digit_probe, s};
use crate::auth::Principal;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const INBOX_URL: &str = "/connections?muc=facebook";
const ZALO_WINDOW_MS: i64 = 48 * 3_600_000;

const CONV_COLS: &str = "id, page_id, psid, customer_name, contact_id, last_inbound_at, last_message_at, \
                         last_message_preview, unread_count, entry_link_id, created_at";

/// Phụ thuộc riêng của nhóm hộp thư (không nằm trong `ToolDeps` để các nhóm tool song song không đụng nhau).
pub struct InboxDeps {
    /// Công tắc tính năng của công ty (`facebook_page`, `zalo_oa`).
    pub features: Arc<dyn OrgFeatureGate>,
    /// Gửi Messenger (`reply`) và đồng bộ hội thoại khi cửa sổ có vẻ đã đóng.
    pub facebook: Arc<FacebookIngest>,
    /// Khoá kênh cho tin Zalo (tin Messenger đã đi qua `GraphClient` của `facebook`).
    pub guard: ChannelGuard,
    pub zalo_client: ZaloClient,
    pub zalo_env: mod_zalo::config::Env,
    pub platform: Platform,
}

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// `vnIso`: giờ Việt Nam dạng ISO có `+07:00`.
pub(crate) fn vn_iso(t: DateTime<Utc>) -> String {
    (t + TimeDelta::hours(7)).format("%Y-%m-%dT%H:%M:%S+07:00").to_string()
}

fn vn_iso_ms(ms: i64) -> Option<String> {
    DateTime::from_timestamp_millis(ms).map(vn_iso)
}

fn contact_url(base: &str, id: Option<i32>) -> Value {
    id.map_or(Value::Null, |i| json!(format!("{base}/contacts/{i}")))
}

fn manage_url(base: &str) -> String {
    format!("{base}{INBOX_URL}")
}

fn can_zalo(p: &Principal) -> bool {
    can(&p.grants, "contacts.update", None)
}

/// Lỗi của dịch vụ gửi: 400/404 ⇒ lỗi người dùng (câu nguyên văn, như `BadRequestException`/`NotFoundException` bản TS); còn lại
/// giữ mã để `failure()` quyết định.
fn send_err(e: AppError) -> ToolError {
    app_err(e, &[400, 404])
}

/// `AppError` → `ToolError`: mã trong `user_statuses` là lỗi người dùng (câu nguyên văn), còn lại giữ mã.
fn app_err(e: AppError, user_statuses: &[u16]) -> ToolError {
    let (status, body) = e.response(true);
    let message = match body.message {
        trinity_kernel::error::Message::One(s) => s,
        trinity_kernel::error::Message::Many(m) => m.join("; "),
    };
    if user_statuses.contains(&status) {
        ToolError::User(message)
    } else {
        ToolError::Http { status, message }
    }
}

/// `{ channel, number }` từ id dạng `kênh:số`; `channels` là các kênh cho phép, `max_digits` độ dài tối đa của số.
fn parse_id<'a>(raw: &'a str, channels: &[&str], max_digits: usize) -> Option<(&'a str, &'a str)> {
    let (ch, num) = raw.trim().split_once(':')?;
    let ok_num = !num.is_empty() && num.len() <= max_digits && num.bytes().all(|b| b.is_ascii_digit());
    (channels.contains(&ch) && ok_num).then_some((ch, num))
}

async fn fb_enabled(d: &InboxDeps, p: &Principal) -> bool {
    d.features.enabled(p.company, "facebook_page").await
}

async fn zalo_enabled(d: &InboxDeps, p: &Principal) -> bool {
    d.features.enabled(p.company, "zalo_oa").await
}

fn ms_of(t: Option<Timestamp>) -> Option<i64> {
    t.map(|t| t.0.timestamp_millis())
}

#[derive(Debug, sqlx::FromRow)]
struct ZaloThread {
    id: i32,
    display_name: Option<String>,
    contact_id: Option<i32>,
    last_message_preview: Option<String>,
    last_message_at: Option<Timestamp>,
    last_inbound_at: Option<Timestamp>,
    unread_count: i32,
}

const ZALO_COLS: &str =
    "id, display_name, contact_id, last_message_preview, last_message_at, last_inbound_at, unread_count";

async fn find_conversation(conn: &mut sqlx::PgConnection, id: i32) -> Result<Option<FacebookConversation>, ToolError> {
    sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
        "SELECT {CONV_COLS} FROM facebook_conversations WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(internal)
}

async fn find_zalo_thread(conn: &mut sqlx::PgConnection, id: i32) -> Result<Option<ZaloThread>, ToolError> {
    sqlx::query_as::<_, ZaloThread>(sqlx::AssertSqlSafe(format!(
        "SELECT {ZALO_COLS} FROM zalo_oa_threads WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(internal)
}

/// Mẫu `ILIKE` chứa chuỗi `q` (đã escape `\ % _`), dùng với `ESCAPE '\'`.
fn like(q: &str) -> String {
    format!("%{}%", trinity_kernel::vi::escape_like(q))
}

/// Một dòng của `list_unanswered_messages` cho Messenger, dựng từ một phần tử `data` của `FacebookIngest::list_conversations`.
fn unanswered_messenger_row(c: &Value, base: &str) -> Value {
    let inbound = c
        .get("last_inbound_at")
        .and_then(Value::as_str)
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc));
    let contact_id = c
        .get("contact_id")
        .and_then(Value::as_i64)
        .and_then(|i| i32::try_from(i).ok());
    json!({
        "id": format!("messenger:{}", c.get("id").and_then(Value::as_i64).unwrap_or(0)),
        "customer": c.get("customer_name").cloned().unwrap_or(Value::Null),
        "page": c.get("page_name").cloned().unwrap_or(Value::Null),
        "last_message": c.get("last_message_preview").cloned().unwrap_or(Value::Null),
        "at": inbound.map_or(Value::Null, |t| json!(vn_iso(t))),
        "can_reply": c.get("can_reply").cloned().unwrap_or(Value::Null),
        "reply_mode": c.get("reply_mode").cloned().unwrap_or(Value::Null),
        "reply_deadline": inbound
            .and_then(|t| vn_iso_ms(t.timestamp_millis() + HUMAN_AGENT_WINDOW_MS))
            .map_or(Value::Null, Value::String),
        "contact_url": contact_url(base, contact_id),
    })
}

pub(crate) fn list_unanswered_messages<'a>(
    d: &'a InboxDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, base) = (ctx.principal, ctx.base_url);
        let limit = clamp_limit(args.get("limit"));
        let channel = s(args, "channel");
        let want = |c: &str| channel.is_none_or(|x| x == c);
        let now_ms = Utc::now().timestamp_millis();
        let fb_on = fb_enabled(d, p).await;
        let mut out = Map::new();
        let mut notes: Vec<Value> = Vec::new();

        if want("messenger") {
            if fb_on {
                let rows = d
                    .facebook
                    .list_conversations(p.company, Some(limit.to_string().as_str()), Some("1"), now_ms)
                    .await
                    .map_err(internal_app)?;
                let data = rows.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
                out.insert(
                    "messenger".into(),
                    Value::Array(data.iter().map(|c| unanswered_messenger_row(c, base)).collect()),
                );
            } else {
                notes.push(json!(
                    "Messenger: tính năng Fanpage đang tắt hoặc chưa có trên máy chủ."
                ));
            }
        }
        if want("facebook_comment") {
            // M49: chưa có dịch vụ bình luận ⇒ nhánh "dịch vụ vắng" của bản TS.
            notes.push(json!(
                "Bình luận Fanpage: tính năng Fanpage đang tắt hoặc chưa có trên máy chủ."
            ));
        }
        if want("zalo_oa") {
            if !zalo_enabled(d, p).await {
                notes.push(json!("Zalo OA: tính năng đang tắt hoặc chưa kết nối."));
            } else if !can_zalo(p) {
                notes.push(json!("Zalo OA: cần quyền sửa khách hàng để xem hộp thư Zalo."));
            } else {
                let rows = {
                    let mut conn = ctx.deps.conn(p.company).await?;
                    sqlx::query_as::<_, ZaloThread>(sqlx::AssertSqlSafe(format!(
                        "SELECT {ZALO_COLS} FROM zalo_oa_threads WHERE last_inbound_at IS NOT NULL \
                         ORDER BY last_message_at DESC, id DESC LIMIT 300"
                    )))
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(internal)?
                };
                let take = usize::try_from(limit).unwrap_or(20);
                let items: Vec<Value> = rows
                    .iter()
                    .filter_map(|t| {
                        let inbound = t.last_inbound_at?.0;
                        let unanswered = t.last_message_at.is_none_or(|m| inbound >= m.0);
                        unanswered.then_some((t, inbound))
                    })
                    .take(take)
                    .map(|(t, inbound)| {
                        json!({
                            "id": format!("zalo_oa:{}", t.id),
                            "customer": t.display_name,
                            "last_message": t.last_message_preview,
                            "at": vn_iso(inbound),
                            "can_reply": in_consult_window(Some(inbound), now_ms),
                            "reply_deadline": vn_iso_ms(inbound.timestamp_millis() + ZALO_WINDOW_MS),
                            "contact_url": contact_url(base, t.contact_id),
                        })
                    })
                    .collect();
                out.insert("zalo_oa".into(), Value::Array(items));
            }
        }
        out.insert("notes".into(), Value::Array(notes));
        out.insert("manage_url".into(), json!(manage_url(base)));
        wrapped(&Value::Object(out))
    })
}

fn internal_app(e: AppError) -> ToolError {
    internal(e.to_string())
}

pub(crate) fn list_conversations<'a>(
    d: &'a InboxDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, base) = (ctx.principal, ctx.base_url);
        let limit = clamp_limit(args.get("limit"));
        let q = opt_str(args.get("search"), 100);
        if let Some(q) = &q {
            reject_digit_probe(q)?; // tìm theo tên, không cho dò số điện thoại hay mã
        }
        let pattern = q.as_deref().map(like);
        let channel = s(args, "channel");
        let want = |c: &str| channel.is_none_or(|x| x == c);
        let now_ms = Utc::now().timestamp_millis();
        let mut out = Map::new();
        let mut notes: Vec<Value> = Vec::new();

        if want("messenger") {
            if !fb_enabled(d, p).await {
                notes.push(json!("Messenger: tính năng Fanpage đang tắt."));
            } else {
                let (rows, pages) = {
                    let mut conn = ctx.deps.conn(p.company).await?;
                    let rows = sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
                        "SELECT {CONV_COLS} FROM facebook_conversations \
                         WHERE ($1::text IS NULL OR customer_name ILIKE $1 ESCAPE '\\') \
                         ORDER BY last_message_at DESC, id DESC LIMIT $2"
                    )))
                    .bind(pattern.as_deref())
                    .bind(limit)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(internal)?;
                    let pages: Vec<(String, String)> = sqlx::query_as("SELECT page_id, name FROM facebook_pages")
                        .fetch_all(&mut *conn)
                        .await
                        .map_err(internal)?;
                    (rows, pages)
                };
                let names: HashMap<String, String> = pages.into_iter().collect();
                let items: Vec<Value> = rows
                    .iter()
                    .map(|c| {
                        let inbound = ms_of(c.last_inbound_at);
                        let mode = reply_mode(inbound, now_ms);
                        json!({
                            "id": format!("messenger:{}", c.id),
                            "customer": c.customer_name,
                            "page": names.get(&c.page_id),
                            "last_message": c.last_message_preview,
                            "last_message_at": vn_iso(c.last_message_at.0),
                            "unread": c.unread_count,
                            "awaiting_reply": awaiting_reply(inbound, c.last_message_at.0.timestamp_millis()),
                            "can_reply": mode != ReplyMode::Closed,
                            "reply_mode": mode.as_str(),
                            "contact_url": contact_url(base, c.contact_id),
                        })
                    })
                    .collect();
                out.insert("messenger".into(), Value::Array(items));
            }
        }
        if want("zalo_oa") {
            if !zalo_enabled(d, p).await {
                notes.push(json!("Zalo OA: tính năng đang tắt hoặc chưa kết nối."));
            } else if !can_zalo(p) {
                notes.push(json!("Zalo OA: cần quyền sửa khách hàng để xem hộp thư Zalo."));
            } else {
                let rows = {
                    let mut conn = ctx.deps.conn(p.company).await?;
                    sqlx::query_as::<_, ZaloThread>(sqlx::AssertSqlSafe(format!(
                        "SELECT {ZALO_COLS} FROM zalo_oa_threads \
                         WHERE ($1::text IS NULL OR display_name ILIKE $1 ESCAPE '\\') \
                         ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT $2"
                    )))
                    .bind(pattern.as_deref())
                    .bind(limit)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(internal)?
                };
                let items: Vec<Value> = rows
                    .iter()
                    .map(|t| {
                        let inbound = t.last_inbound_at.map(|x| x.0);
                        json!({
                            "id": format!("zalo_oa:{}", t.id),
                            "customer": t.display_name,
                            "last_message": t.last_message_preview,
                            "last_message_at": t.last_message_at.map(|x| vn_iso(x.0)),
                            "unread": t.unread_count,
                            "awaiting_reply": inbound.is_some_and(|i| t.last_message_at.is_none_or(|m| i >= m.0)),
                            "can_reply": in_consult_window(inbound, now_ms),
                            "contact_url": contact_url(base, t.contact_id),
                        })
                    })
                    .collect();
                out.insert("zalo_oa".into(), Value::Array(items));
            }
        }
        out.insert("notes".into(), Value::Array(notes));
        out.insert("manage_url".into(), json!(manage_url(base)));
        wrapped(&Value::Object(out))
    })
}

fn user(msg: &str) -> ToolError {
    ToolError::User(msg.to_owned())
}

pub(crate) fn get_conversation_messages<'a>(
    d: &'a InboxDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, base) = (ctx.principal, ctx.base_url);
        let raw = s(args, "id").unwrap_or("");
        let Some((channel, num)) = parse_id(raw, &["messenger", "zalo_oa"], 9) else {
            return Err(user(
                "id phải có dạng messenger:<số> hoặc zalo_oa:<số> (lấy từ list_conversations). / id must look like messenger:12 or zalo_oa:5.",
            ));
        };
        // `\d{1,9}` luôn nằm trong i64; ngoài i32 thì chắc chắn không có hội thoại.
        let id = num.parse::<i32>().ok();
        let take = match args.get("limit") {
            Some(Value::Number(n)) => n
                .as_f64()
                .filter(|f| f.is_finite())
                .map_or(30, |f| f.trunc() as i64)
                .clamp(1, 50),
            _ => 30,
        };
        let now_ms = Utc::now().timestamp_millis();
        let not_found = || ToolError::User(format!("Không có hội thoại {raw}. / Conversation not found."));
        if channel == "messenger" {
            if !fb_enabled(d, p).await {
                return Err(user(
                    "Tính năng \"Fanpage Facebook\" đang tắt. / The Facebook Page feature is turned off.",
                ));
            }
            let mut conn = ctx.deps.conn(p.company).await?;
            let Some(c) = (match id {
                Some(i) => find_conversation(&mut conn, i).await?,
                None => None,
            }) else {
                return Err(not_found());
            };
            let mut rows: Vec<(String, Option<String>, Timestamp)> = sqlx::query_as(
                "SELECT direction, text, sent_at FROM facebook_messages WHERE conversation_id = $1 \
                 ORDER BY sent_at DESC, id DESC LIMIT $2",
            )
            .bind(c.id)
            .bind(take)
            .fetch_all(&mut *conn)
            .await
            .map_err(internal)?;
            drop(conn);
            rows.reverse();
            let mode = reply_mode(ms_of(c.last_inbound_at), now_ms);
            let messages: Vec<Value> = rows
                .iter()
                .map(|(dir, text, at)| {
                    let from = if dir == "in" { "customer" } else { "business" };
                    json!({ "from": from, "text": text, "at": vn_iso(at.0) })
                })
                .collect();
            return wrapped(&json!({
                "id": format!("messenger:{}", c.id),
                "customer": c.customer_name,
                "can_reply": mode != ReplyMode::Closed,
                "reply_mode": mode.as_str(),
                "contact_url": contact_url(base, c.contact_id),
                "messages": messages,
            }));
        }
        if !zalo_enabled(d, p).await {
            return Err(user("Zalo OA chưa bật hoặc chưa kết nối. / Zalo OA is not available."));
        }
        if !can_zalo(p) {
            return Err(user(
                "Cần quyền sửa khách hàng để xem hộp thư Zalo OA. / Missing contacts.update permission.",
            ));
        }
        let mut conn = ctx.deps.conn(p.company).await?;
        let Some(t) = (match id {
            Some(i) => find_zalo_thread(&mut conn, i).await?,
            None => None,
        }) else {
            return Err(not_found());
        };
        let mut rows: Vec<(String, String, Option<String>, Timestamp)> = sqlx::query_as(
            "SELECT direction, kind, text, created_at FROM zalo_oa_messages WHERE thread_id = $1 AND status <> 'failed' \
             ORDER BY id DESC LIMIT $2",
        )
        .bind(t.id)
        .bind(take)
        .fetch_all(&mut *conn)
        .await
        .map_err(internal)?;
        drop(conn);
        rows.reverse();
        let messages: Vec<Value> = rows
            .iter()
            .map(|(dir, kind, text, at)| {
                let mut m = Map::new();
                let from = if dir == "in" { "customer" } else { "business" };
                m.insert("from".into(), json!(from));
                if kind != "text" {
                    m.insert("kind".into(), json!(kind));
                }
                m.insert("text".into(), json!(text));
                m.insert("at".into(), json!(vn_iso(at.0)));
                Value::Object(m)
            })
            .collect();
        wrapped(&json!({
            "id": format!("zalo_oa:{}", t.id),
            "customer": t.display_name,
            "can_reply": in_consult_window(t.last_inbound_at.map(|x| x.0), now_ms),
            "contact_url": contact_url(base, t.contact_id),
            "messages": messages,
        }))
    })
}

pub(crate) fn reply_to_customer<'a>(
    d: &'a InboxDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, base) = (ctx.principal, ctx.base_url);
        let raw = s(args, "id").unwrap_or("");
        let Some((channel, num)) = parse_id(raw, &["messenger", "facebook_comment", "zalo_oa"], 19) else {
            return Err(user(
                "id không hợp lệ — lấy id từ list_unanswered_messages (vd messenger:12). / Invalid id.",
            ));
        };
        let text = s(args, "text").unwrap_or("").trim().to_owned();
        let id = num.parse::<i32>().ok();
        let now = Utc::now();
        let now_ms = now.timestamp_millis();
        let preview: Value = match channel {
            "messenger" => {
                if !fb_enabled(d, p).await {
                    return Err(user(
                        "Messenger chưa bật trên máy chủ này. / Messenger is not available.",
                    ));
                }
                let mut c = {
                    let mut conn = ctx.deps.conn(p.company).await?;
                    match id {
                        Some(i) => find_conversation(&mut conn, i).await?,
                        None => None,
                    }
                }
                .ok_or_else(|| user("Không tìm thấy hội thoại. / Conversation not found."))?;
                // Tin khách có thể chưa về qua webhook: hỏi lại Facebook trước khi chặn (lỗi Facebook thì bỏ qua như bản TS).
                if !within_messaging_window(ms_of(c.last_inbound_at), now_ms) {
                    let synced = d.facebook.sync_conversation(p.company, &c, true, now_ms).await;
                    if matches!(synced, Ok(n) if n > 0) {
                        let mut conn = ctx.deps.conn(p.company).await?;
                        if let Some(again) = find_conversation(&mut conn, c.id).await? {
                            c = again;
                        }
                    }
                }
                let reply = reply_mode(ms_of(c.last_inbound_at), now_ms);
                if reply == ReplyMode::Closed {
                    return Err(ToolError::User(format!(
                        "{MESSENGER_CLOSED} / Outside the 7-day window."
                    )));
                }
                json!({ "channel": channel, "customer": c.customer_name, "text": text, "reply_mode": reply.as_str() })
            }
            "facebook_comment" => {
                // M49: chưa có dịch vụ bình luận ⇒ nhánh "dịch vụ vắng" của bản TS.
                return Err(user(
                    "Bình luận Fanpage chưa bật trên máy chủ này. / Facebook comments are not available.",
                ));
            }
            _ => {
                if !zalo_enabled(d, p).await {
                    return Err(user("Zalo OA chưa bật hoặc chưa kết nối. / Zalo OA is not available."));
                }
                if !can_zalo(p) {
                    return Err(user(
                        "Cần quyền sửa khách hàng để nhắn Zalo OA. / Missing contacts.update permission.",
                    ));
                }
                let t = {
                    let mut conn = ctx.deps.conn(p.company).await?;
                    match id {
                        Some(i) => find_zalo_thread(&mut conn, i).await?,
                        None => None,
                    }
                }
                .ok_or_else(|| user("Không tìm thấy hội thoại Zalo. / Zalo thread not found."))?;
                if !in_consult_window(t.last_inbound_at.map(|x| x.0), now_ms) {
                    return Err(user(
                        "Đã quá 48 giờ kể từ tin cuối của khách — Zalo không cho gửi tin tư vấn. / Outside the 48-hour window.",
                    ));
                }
                json!({ "channel": channel, "customer": t.display_name, "text": text })
            }
        };
        if !is_user_confirmation(s(args, "confirmed_by_user")) {
            return wrapped(&json!({
                "sent": false,
                "preview": preview,
                "next_step": "CHƯA GỬI. Đưa người dùng xem nội dung sẽ gửi; người dùng đồng ý thì gọi lại với confirmed_by_user.",
            }));
        }
        let Some(id) = id else {
            return Err(user("Không tìm thấy hội thoại. / Conversation not found."));
        };
        if channel == "messenger" {
            d.facebook
                .reply(p.company, Some(&d.guard), id, &text, p.user_id, now)
                .await
                .map_err(send_err)?;
        } else {
            let zctx = ZaloCtx {
                db: &ctx.deps.db,
                env: &d.zalo_env,
                client: &d.zalo_client,
                platform: &d.platform,
                company: p.company,
            };
            send_text(&zctx, Some(&d.guard), id, &text, Some(p.user_id), now_ms)
                .await
                .map_err(send_err)?;
        }
        let mut sent = Map::new();
        sent.insert("sent".into(), json!(true));
        if let Value::Object(m) = preview {
            sent.extend(m);
        }
        sent.insert("manage_url".into(), json!(manage_url(base)));
        wrapped(&Value::Object(sent))
    })
}

/// Lỗi lưu SĐT: 400/404/409 là lỗi người dùng (câu nguyên văn), còn lại giữ mã.
fn save_err(e: AppError) -> ToolError {
    app_err(e, &[400, 404, 409])
}

/// `save_phone_from_message`: lưu SĐT khách đã NHẮN trong hội thoại Zalo OA vào hồ sơ khách (cùng dịch vụ với nút «Lưu SĐT vào hồ
/// sơ» ở Hộp thư). Máy chủ tự dò số trong các tin gần nhất của khách; AI chỉ chọn số thứ mấy (số luôn bị che nên AI không gõ số).
pub(crate) fn save_phone_from_message<'a>(
    d: &'a InboxDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, base) = (ctx.principal, ctx.base_url);
        let raw = s(args, "id").unwrap_or("");
        let Some(("zalo_oa", num)) = parse_id(raw, &["messenger", "zalo_oa"], 9) else {
            return Err(user(
                "id phải có dạng zalo_oa:<số> (lấy từ list_conversations); Messenger chưa ghép khách nên chưa lưu được. / id must look like zalo_oa:5.",
            ));
        };
        if !zalo_enabled(d, p).await {
            return Err(user("Zalo OA chưa bật hoặc chưa kết nối. / Zalo OA is not available."));
        }
        if !can_zalo(p) {
            return Err(user(
                "Cần quyền sửa khách hàng để lưu SĐT từ Zalo OA. / Missing contacts.update permission.",
            ));
        }
        let not_found = || ToolError::User(format!("Không có hội thoại {raw}. / Conversation not found."));
        let Some(id) = num.parse::<i32>().ok() else {
            return Err(not_found());
        };
        let mut conn = ctx.deps.conn(p.company).await?;
        if find_zalo_thread(&mut conn, id).await?.is_none() {
            return Err(not_found());
        }
        // 50 tin gần nhất của khách, duyệt từ CŨ tới mới: số theo thứ tự khách nhắn lần đầu (số mới nhắn thêm vào CUỐI nên index
        // người dùng đã chọn không bị xô lệch giữa hai lần gọi); mỗi số lấy tin MỚI nhất chứa nó.
        let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
            "SELECT id, text FROM zalo_oa_messages WHERE thread_id = $1 AND direction = 'in' AND status <> 'failed' \
             AND text IS NOT NULL ORDER BY id DESC LIMIT 50",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(internal)?;
        let mut found: Vec<(String, i64)> = Vec::new();
        for (mid, text) in rows.iter().rev() {
            for ph in trinity_kernel::phone::detect_phones(text.as_deref().unwrap_or("")) {
                match found.iter_mut().find(|(x, _)| *x == ph) {
                    Some(hit) => hit.1 = *mid,
                    None => found.push((ph, *mid)),
                }
            }
        }
        if found.is_empty() {
            return Err(user(
                "Khách chưa nhắn số điện thoại nào trong hội thoại này. / No phone number in the customer's messages.",
            ));
        }
        let index = match args.get("index") {
            Some(Value::Number(n)) => n.as_i64().and_then(|n| usize::try_from(n).ok()).filter(|n| *n >= 1),
            None | Some(Value::Null) => (found.len() == 1).then_some(1),
            _ => None,
        };
        let Some((phone, mid)) = index.and_then(|i| found.get(i - 1)) else {
            let options: Vec<Value> = found
                .iter()
                .enumerate()
                .map(|(i, (ph, _))| json!({ "index": i + 1, "phone": mask_phone(Some(ph)) }))
                .collect();
            return Err(ToolError::User(format!(
                "Có {} số khác nhau trong tin khách (nhắn sớm nhất trước): {}. Hỏi người dùng chọn số rồi gọi lại với index. / Several numbers found; pass index.",
                found.len(),
                Value::Array(options)
            )));
        };
        let saved = mod_zalo::threads::save_phone(&mut conn, id, *mid, Some(phone), p.user_id)
            .await
            .map_err(save_err)?;
        drop(conn);
        wrapped(&json!({
            "saved": true,
            "phone": mask_phone(Some(&saved.phone)),
            "contact_id": saved.contact_id,
            "contact_url": contact_url(base, Some(saved.contact_id)),
            "created_contact": saved.created,
            "already_saved": saved.already,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loi_luu_sdt_409_la_loi_nguoi_dung() {
        use trinity_kernel::error::HttpError;
        assert!(matches!(save_err(HttpError::conflict("x").into()), ToolError::User(m) if m == "x"));
        assert!(matches!(
            save_err(HttpError::service_unavailable("z").into()),
            ToolError::Http { status: 503, .. }
        ));
    }

    #[test]
    fn id_hop_le() {
        let all = ["messenger", "facebook_comment", "zalo_oa"];
        assert_eq!(parse_id("messenger:12", &all, 19), Some(("messenger", "12")));
        assert_eq!(parse_id(" zalo_oa:5 ", &all, 19), Some(("zalo_oa", "5")));
        assert_eq!(
            parse_id("facebook_comment:9007199254740993", &all, 19),
            Some(("facebook_comment", "9007199254740993"))
        );
        for bad in [
            "messenger",
            "messenger:",
            "messenger:x1",
            "messenger:-1",
            "sms:3",
            ":3",
            "messenger:1:2",
            "messenger:12345678901234567890",
        ] {
            assert_eq!(parse_id(bad, &all, 19), None, "{bad}");
        }
        // get_conversation_messages: không nhận bình luận, tối đa 9 chữ số.
        assert_eq!(parse_id("facebook_comment:3", &["messenger", "zalo_oa"], 9), None);
        assert_eq!(parse_id("messenger:1234567890", &["messenger", "zalo_oa"], 9), None);
    }

    #[test]
    fn gio_viet_nam() {
        let t = DateTime::parse_from_rfc3339("2026-10-12T11:26:05Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(vn_iso(t), "2026-10-12T18:26:05+07:00");
        assert_eq!(vn_iso_ms(0).as_deref(), Some("1970-01-01T07:00:00+07:00"));
    }

    #[test]
    fn dong_tin_messenger_chua_tra_loi() {
        let c = json!({
            "id": 12, "customer_name": "Lan", "page_name": "Shop", "last_message_preview": "alo",
            "last_inbound_at": "2026-10-12T11:26:05.000Z", "can_reply": true, "reply_mode": "standard", "contact_id": 7,
        });
        let r = unanswered_messenger_row(&c, "https://x.test");
        assert_eq!(r["id"], "messenger:12");
        assert_eq!(r["at"], "2026-10-12T18:26:05+07:00");
        assert_eq!(r["reply_deadline"], "2026-10-19T18:26:05+07:00");
        assert_eq!(r["contact_url"], "https://x.test/contacts/7");
        assert_eq!(r["page"], "Shop");
        let none = unanswered_messenger_row(&json!({ "id": 1, "last_inbound_at": null }), "https://x.test");
        assert!(none["at"].is_null() && none["contact_url"].is_null() && none["reply_deadline"].is_null());
    }

    #[test]
    fn loi_gui_400_404_la_loi_nguoi_dung() {
        use trinity_kernel::error::HttpError;
        assert!(matches!(send_err(HttpError::bad_request("x").into()), ToolError::User(m) if m == "x"));
        assert!(matches!(send_err(HttpError::not_found("y").into()), ToolError::User(m) if m == "y"));
        assert!(matches!(
            send_err(HttpError::service_unavailable("z").into()),
            ToolError::Http { status: 503, .. }
        ));
    }

    #[test]
    fn mau_tim_escape() {
        assert_eq!(like("a%b_c\\"), "%a\\%b\\_c\\\\%");
    }
}
