//! Hộp thư Messenger (M48), chuyển từ `facebook-messenger.service.ts` (`listConversations`, `messages`, `syncConversation`,
//! `reply`, `sendAsAgent`, `mapSendError`, `refreshMissingNames`) và `channel.ts` (cửa sổ nhắn tin).
//!
//! Chính sách gửi (nhân viên gõ): trong 24 giờ kể từ tin KHÁCH gần nhất gửi thường (`messaging_type: RESPONSE`); từ 24 giờ đến
//! 7 ngày kèm thẻ `HUMAN_AGENT` (Meta phải duyệt quyền, chưa duyệt thì Graph từ chối và người dùng thấy câu hướng dẫn); quá 7 ngày
//! hoặc chưa có tin khách thì chặn ngay (400), không gọi Graph.
//!
//! Quy tắc chung: không giữ kết nối pool khi gọi Graph và không giữ hai kết nối cùng lúc; mọi lời gọi Graph đi qua `GraphClient`
//! (báo cửa sổ lỗi cho `ChannelGuard`) và việc gửi còn qua `ChannelGuard::assert_outbound` (khoá kênh).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::PoisonError;

use chrono::{DateTime, Utc};
use mod_channel_guard::{ChannelGuard, OutboundMode, OutboundScope};
use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::models::{FacebookConversation, FacebookMessage};
use trinity_db::outbox::publish_integration_event;
use trinity_db::{CompanyRef, TenantTx};
use trinity_kernel::error::{AppError, HttpError};

use crate::graph::GraphApiError;
use crate::ingest::{FacebookIngest, db, platform_db, utf16_prefix};
use crate::messenger::assigned_to;
use crate::pages;

/// Cửa sổ trả lời chuẩn: 24 giờ kể từ tin khách gần nhất.
pub const MESSAGING_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// Cửa sổ thẻ Human Agent: 7 ngày kể từ tin khách gần nhất.
pub const HUMAN_AGENT_WINDOW_MS: i64 = 7 * MESSAGING_WINDOW_MS;
/// Độ dài tối đa của một tin nhân viên gõ.
pub const MAX_TEXT: usize = 2000;
/// Mỗi hội thoại chỉ đồng bộ từ Facebook tối đa một lần trong khoảng này.
pub const SYNC_INTERVAL_MS: i64 = 60_000;
/// Số tin kéo về mỗi lần đồng bộ.
const SYNC_LIMIT: u32 = 20;

pub const MESSENGER_CLOSED: &str =
    "Đã quá 7 ngày kể từ tin nhắn gần nhất của khách — Messenger không cho gửi. Có thể trả lời khi khách nhắn lại.";
pub const HUMAN_AGENT_REFUSED: &str = "Cần Meta duyệt quyền Human Agent: tin quá 24 giờ (trong 7 ngày) chưa gửi được. Trả lời trong Inbox của Fanpage, hoặc chờ khách nhắn lại.";
const OUTSIDE_WINDOW: &str = "Đã quá 24 giờ kể từ tin nhắn gần nhất của khách — Messenger không cho gửi tin chủ động.";
const TOKEN_REVOKED: &str = "Token Fanpage đã hết hạn hoặc bị thu hồi — hãy kết nối lại Fanpage.";
const NO_PERMISSION: &str = "Facebook từ chối: ứng dụng chưa có quyền pages_messaging cho Fanpage này.";
const SEND_FAILED: &str = "Facebook không nhận tin nhắn, thử lại sau.";
const PAGE_OFF: &str = "Fanpage chưa kết nối hoặc đã tắt";

const CONV_COLS: &str = "id, page_id, psid, customer_name, contact_id, last_inbound_at, last_message_at, \
                         last_message_preview, unread_count, entry_link_id, created_at";
const MSG_COLS: &str = "id, conversation_id, mid, direction, text, sent_by_user_id, sent_at";

/// Cách nhân viên trả lời được (`messengerReplyMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyMode {
    /// Trong 24 giờ.
    Standard,
    /// 24 giờ đến 7 ngày: gửi kèm thẻ `HUMAN_AGENT`.
    HumanAgent,
    /// Quá 7 ngày hoặc chưa có tin khách.
    Closed,
}

impl ReplyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::HumanAgent => "human_agent",
            Self::Closed => "closed",
        }
    }
}

/// `isWithinMessagingWindow`: tin khách gần nhất cách `now_ms` dưới 24 giờ.
pub fn within_messaging_window(last_inbound_ms: Option<i64>, now_ms: i64) -> bool {
    last_inbound_ms.is_some_and(|t| now_ms - t < MESSAGING_WINDOW_MS)
}

/// `messengerReplyMode`: dưới 24 giờ `Standard`, dưới 7 ngày `HumanAgent`, còn lại (kể cả chưa có tin khách) `Closed`.
pub fn reply_mode(last_inbound_ms: Option<i64>, now_ms: i64) -> ReplyMode {
    let Some(t) = last_inbound_ms else {
        return ReplyMode::Closed;
    };
    let age = now_ms - t;
    if age < MESSAGING_WINDOW_MS {
        ReplyMode::Standard
    } else if age < HUMAN_AGENT_WINDOW_MS {
        ReplyMode::HumanAgent
    } else {
        ReplyMode::Closed
    }
}

/// `awaitingReply`: có tin khách và tin cuối là của khách.
pub fn awaiting_reply(last_inbound_ms: Option<i64>, last_message_ms: i64) -> bool {
    last_inbound_ms.is_some_and(|t| t >= last_message_ms)
}

/// `limit` của `GET /conversations`: `limit ? Number(limit) || 50 : 50`, rồi kẹp trong 1 đến 100.
pub fn parse_limit(raw: Option<&str>) -> i64 {
    let n = match raw.map(trinity_kernel::vi::trim_js) {
        Some(s) if !s.is_empty() => s.parse::<f64>().ok(),
        _ => None,
    };
    let n = n.filter(|n| !n.is_nan() && *n != 0.0).unwrap_or(50.0);
    n.clamp(1.0, 100.0) as i64
}

/// `unanswered === '1' || unanswered === 'true'`.
pub fn parse_unanswered(raw: Option<&str>) -> bool {
    matches!(raw, Some("1" | "true"))
}

/// Bộ lọc `contact_id` của `GET /conversations` (nút «Messenger» ở hồ sơ khách): vắng, rỗng hoặc `0` ⇒ không lọc;
/// không phải số nguyên dương trong i32 ⇒ 400.
pub fn parse_contact_filter(raw: Option<&str>) -> Result<Option<i32>, HttpError> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match s.parse::<i32>() {
        Ok(0) => Ok(None),
        Ok(n) if n > 0 => Ok(Some(n)),
        _ => Err(HttpError::validation(vec![
            "contact_id must be a positive integer".to_owned(),
        ])),
    }
}

/// Nội dung `POST /conversations/:id/messages` (`FacebookReplyDto`): `text` là chuỗi, 1 đến 2000 ký tự (đơn vị UTF-16). Báo đủ
/// lỗi theo thứ tự class-validator chạy decorator (từ dưới lên: `MaxLength`, `MinLength`, `IsString`).
pub fn parse_reply_text(body: &Value) -> Result<String, HttpError> {
    let Some(o) = body.as_object() else {
        return Err(HttpError::validation(vec!["body must be an object".to_owned()]));
    };
    match o.get("text") {
        Some(Value::String(s)) => {
            let n = s.encode_utf16().count();
            if n > MAX_TEXT {
                Err(HttpError::validation(vec!["Tin nhắn tối đa 2000 ký tự".to_owned()]))
            } else if n == 0 {
                Err(HttpError::validation(vec!["Nội dung trống".to_owned()]))
            } else {
                Ok(s.clone())
            }
        }
        _ => Err(HttpError::validation(vec![
            "Tin nhắn tối đa 2000 ký tự".to_owned(),
            "Nội dung trống".to_owned(),
            "Nội dung phải là chuỗi".to_owned(),
        ])),
    }
}

fn is_agent_tag_error(message: &str) -> bool {
    static RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?i)human.?agent|tag").expect("regex hợp lệ"));
    RE.is_match(message)
}

/// `mapSendError`: đổi lỗi Graph khi gửi thành lỗi tiếng Việt. giá trị thứ hai `true` = cần đánh dấu token Page hỏng (lỗi 190).
pub fn map_send_error(err: &GraphApiError, human_agent: bool) -> (HttpError, bool) {
    if err.is_config_error() {
        let msg = format!(
            "Cấu hình kết nối Facebook của máy chủ sai: {}",
            utf16_prefix(&err.message, 160)
        );
        return (HttpError::new(500, msg), false);
    }
    // Thẻ HUMAN_AGENT bị từ chối (app chưa được Meta duyệt quyền Human Agent).
    if human_agent && (err.is_outside_window() || err.is_permission_error() || is_agent_tag_error(&err.message)) {
        return (HttpError::bad_request(HUMAN_AGENT_REFUSED), false);
    }
    if err.is_outside_window() {
        return (HttpError::bad_request(OUTSIDE_WINDOW), false);
    }
    if err.is_token_error() {
        return (HttpError::service_unavailable(TOKEN_REVOKED), true);
    }
    if err.is_permission_error() {
        return (HttpError::service_unavailable(NO_PERMISSION), false);
    }
    (HttpError::service_unavailable(SEND_FAILED), false)
}

/// Thời điểm tin Graph (`created_time`, dạng `2026-03-05T07:30:09+0000`) tính bằng mili giây.
fn graph_time_ms(s: &str) -> Option<i64> {
    trinity_kernel::instant::parse_instant_with(s, 0).map(|t| t.timestamp_millis())
}

async fn find_conversation(conn: &mut PgConnection, id: i32) -> Result<Option<FacebookConversation>, AppError> {
    sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
        "SELECT {CONV_COLS} FROM facebook_conversations WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

fn conversation_json(c: &FacebookConversation) -> Result<serde_json::Map<String, Value>, AppError> {
    // trinity-lint: allow-json-value (model cần vá thêm khoá rồi trả Value (hoặc ghi cột jsonb), giữ hành vi cũ; không phải đường ghi chuỗi JSON thẳng)
    match serde_json::to_value(c).map_err(AppError::internal)? {
        Value::Object(m) => Ok(m),
        _ => Err(AppError::internal("hội thoại không phải object")),
    }
}

fn message_json(m: &FacebookMessage) -> Result<Value, AppError> {
    // trinity-lint: allow-json-value (model cần vá thêm khoá rồi trả Value (hoặc ghi cột jsonb), giữ hành vi cũ; không phải đường ghi chuỗi JSON thẳng)
    let mut v = serde_json::to_value(m).map_err(AppError::internal)?;
    // `id` là BigInt: bản Node trả chuỗi (`m.id.toString()`).
    v["id"] = json!(m.id.0.to_string());
    Ok(v)
}

fn last_inbound_ms(c: &FacebookConversation) -> Option<i64> {
    c.last_inbound_at.map(|t| t.0.timestamp_millis())
}

fn reply_fields(c: &FacebookConversation, now_ms: i64) -> (bool, &'static str) {
    let mode = reply_mode(last_inbound_ms(c), now_ms);
    (mode != ReplyMode::Closed, mode.as_str())
}

/// Kịch bản tự động đang dở dừng lại khi nhân viên vào trả lời. Chạy trong SAVEPOINT: lỗi chỉ ghi log, không làm hỏng việc ghi
/// tin đã gửi.
async fn stop_flow_runs_in_savepoint(tx: &mut TenantTx, conversation_id: i32) {
    if sqlx::query("SAVEPOINT fb_stop_flows").execute(&mut **tx).await.is_err() {
        return;
    }
    let r = sqlx::query(
        "UPDATE facebook_flow_runs SET status = 'stopped', step_id = NULL, due_at = NULL, note = 'Nhân viên đã trả lời', \
         updated_at = now() WHERE conversation_id = $1 AND status IN ('waiting_button', 'waiting_answer', 'scheduled')",
    )
    .bind(conversation_id)
    .execute(&mut **tx)
    .await;
    if let Err(e) = r {
        tracing::warn!("Không dừng được kịch bản của hội thoại {conversation_id}: {e}");
        let _ = sqlx::query("ROLLBACK TO SAVEPOINT fb_stop_flows")
            .execute(&mut **tx)
            .await;
    }
    let _ = sqlx::query("RELEASE SAVEPOINT fb_stop_flows").execute(&mut **tx).await;
}

impl FacebookIngest {
    /// `GET /facebook/conversations`: hội thoại mới nhất trước kèm tên Page, `can_reply`, `reply_mode`, `awaiting_reply`.
    /// `unanswered`: chỉ hội thoại có tin cuối là của khách (đọc 300 dòng mới nhất rồi lọc).
    /// `contact_id`: chỉ hội thoại đã ghép với khách đó (nút «Messenger» ở hồ sơ khách mở đúng hội thoại).
    pub async fn list_conversations(
        &self,
        company: CompanyRef,
        limit: Option<&str>,
        unanswered: Option<&str>,
        contact_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Value, AppError> {
        let take = parse_limit(limit);
        let only_unanswered = parse_unanswered(unanswered);
        let contact = parse_contact_filter(contact_id)?;
        let (rows, pages) = {
            let mut c = self.acquire(company).await?;
            let res = if let Some(cid) = contact {
                sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
                    "SELECT {CONV_COLS} FROM facebook_conversations WHERE contact_id = $1 \
                     ORDER BY last_message_at DESC, id DESC LIMIT 300"
                )))
                .bind(cid)
                .fetch_all(&mut *c)
                .await
            } else if only_unanswered {
                sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
                    "SELECT {CONV_COLS} FROM facebook_conversations WHERE last_inbound_at IS NOT NULL \
                     ORDER BY last_message_at DESC, id DESC LIMIT 300"
                )))
                .fetch_all(&mut *c)
                .await
            } else {
                sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
                    "SELECT {CONV_COLS} FROM facebook_conversations ORDER BY last_message_at DESC, id DESC LIMIT $1"
                )))
                .bind(take)
                .fetch_all(&mut *c)
                .await
            };
            let rows = res.map_err(db)?;
            let pages: Vec<(String, String)> = sqlx::query_as("SELECT page_id, name FROM facebook_pages")
                .fetch_all(&mut *c)
                .await
                .map_err(db)?;
            (rows, pages)
        };
        let names: HashMap<String, String> = pages.into_iter().collect();
        let mut out = Vec::new();
        for c in &rows {
            let awaiting = awaiting_reply(last_inbound_ms(c), c.last_message_at.0.timestamp_millis());
            if only_unanswered && !awaiting {
                continue;
            }
            if out.len() >= usize::try_from(take).unwrap_or(100) {
                break;
            }
            let (can_reply, mode) = reply_fields(c, now_ms);
            let mut v = conversation_json(c)?;
            let page_name = names.get(&c.page_id).cloned().unwrap_or_else(|| c.page_id.clone());
            v.insert("page_name".to_owned(), json!(page_name));
            v.insert("can_reply".to_owned(), json!(can_reply));
            v.insert("reply_mode".to_owned(), json!(mode));
            v.insert("awaiting_reply".to_owned(), json!(awaiting));
            out.push(Value::Object(v));
        }
        Ok(json!({ "data": out }))
    }

    /// `GET /facebook/conversations/:id/messages`: đồng bộ tin còn thiếu từ Facebook (tối đa mỗi phút một lần), trả 100 tin gần nhất
    /// (cũ đến mới) và đánh dấu đã đọc. Không có hội thoại ⇒ 404.
    pub async fn messages(&self, company: CompanyRef, conversation_id: i32, now_ms: i64) -> Result<Value, AppError> {
        let found = find_conversation(&mut *self.acquire(company).await?, conversation_id).await?;
        let Some(mut conv) = found else {
            return Err(HttpError::not_found("Không tìm thấy hội thoại").into());
        };
        if self.sync_conversation(company, &conv, false, now_ms).await? > 0 {
            let again = find_conversation(&mut *self.acquire(company).await?, conversation_id).await?;
            conv = again.unwrap_or(conv);
        }
        let mut c = self.acquire(company).await?;
        let mut rows = sqlx::query_as::<_, FacebookMessage>(sqlx::AssertSqlSafe(format!(
            "SELECT {MSG_COLS} FROM facebook_messages WHERE conversation_id = $1 ORDER BY sent_at DESC, id DESC LIMIT 100"
        )))
        .bind(conv.id)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
        if conv.unread_count > 0 {
            sqlx::query("UPDATE facebook_conversations SET unread_count = 0 WHERE id = $1")
                .bind(conv.id)
                .execute(&mut *c)
                .await
                .map_err(db)?;
        }
        drop(c);
        rows.reverse();
        let (can_reply, mode) = reply_fields(&conv, now_ms);
        let mut conversation = conversation_json(&conv)?;
        conversation.insert("unread_count".to_owned(), json!(0));
        conversation.insert("can_reply".to_owned(), json!(can_reply));
        conversation.insert("reply_mode".to_owned(), json!(mode));
        let messages = rows.iter().map(message_json).collect::<Result<Vec<_>, _>>()?;
        Ok(json!({ "conversation": Value::Object(conversation), "messages": messages }))
    }

    /// `syncConversation`: kéo tin gần nhất của hội thoại thẳng từ Facebook và ghi tin còn thiếu như webhook (bù khi webhook không
    /// về). Mỗi hội thoại tối đa một lần mỗi phút (trừ `force`); lỗi Facebook thì bỏ qua. Trả số tin mới.
    pub async fn sync_conversation(
        &self,
        company: CompanyRef,
        conv: &FacebookConversation,
        force: bool,
        now_ms: i64,
    ) -> Result<usize, AppError> {
        {
            let mut map = self.last_sync.lock().unwrap_or_else(PoisonError::into_inner);
            let last = map.get(&(company, conv.id)).copied().unwrap_or(0);
            if !force && now_ms - last < SYNC_INTERVAL_MS {
                return Ok(0);
            }
            map.insert((company, conv.id), now_ms);
        }
        let found = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, &conv.page_id).await?
        };
        let Some((_, token)) = found else {
            return Ok(0);
        };
        let graph = (self.graph_for)(company);
        let msgs = match graph
            .get_recent_messages(&conv.page_id, &conv.psid, &token, SYNC_LIMIT)
            .await
        {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("Đồng bộ hội thoại {} từ Facebook lỗi: {e}", conv.id);
                return Ok(0);
            }
        };
        let mut added = 0;
        // Chỉ tin mới hơn tin cuối đã lưu: không kéo lùi "tin cuối" của hội thoại.
        let after = conv.last_message_at.0.timestamp_millis();
        for m in msgs.iter().rev() {
            let at = graph_time_ms(&m.created_time);
            if at.unwrap_or(0) <= after {
                continue;
            }
            let from_page = m.from.as_ref().and_then(|f| f.id.as_deref()) == Some(conv.page_id.as_str());
            let (sender, recipient) = if from_page {
                (&conv.page_id, &conv.psid)
            } else {
                (&conv.psid, &conv.page_id)
            };
            let mut message = json!({ "mid": m.id });
            if let Some(t) = m.message.as_deref().filter(|t| !t.is_empty()) {
                message["text"] = json!(t);
            }
            if from_page {
                message["is_echo"] = json!(true);
            }
            let mut ev = json!({ "sender": { "id": sender }, "recipient": { "id": recipient }, "message": message });
            if let Some(ms) = at {
                ev["timestamp"] = json!(ms);
            }
            match self.ingest_message(company, &conv.page_id, &ev).await {
                Ok(true) => added += 1,
                Ok(false) => {}
                Err(e) => tracing::warn!("Ghi tin đồng bộ của hội thoại {} lỗi: {e}", conv.id),
            }
        }
        Ok(added)
    }

    /// `POST /facebook/conversations/:id/messages`: nhân viên trả lời. Trong 24 giờ gửi thường; 24 giờ đến 7 ngày kèm thẻ
    /// HUMAN_AGENT; quá 7 ngày ⇒ 400 (không gọi Graph). Quá 24 giờ theo dữ liệu đã lưu thì hỏi lại Facebook trước khi chặn (tin
    /// khách có thể chưa về qua webhook). Trả bản ghi tin vừa lưu (`id` là chuỗi).
    pub async fn reply(
        &self,
        company: CompanyRef,
        guard: Option<&ChannelGuard>,
        conversation_id: i32,
        raw_text: &str,
        actor_user_id: i32,
        now: DateTime<Utc>,
    ) -> Result<Value, AppError> {
        let text = trinity_kernel::vi::trim_js(raw_text);
        if text.is_empty() {
            return Err(HttpError::bad_request("Nội dung tin nhắn trống").into());
        }
        if text.encode_utf16().count() > MAX_TEXT {
            return Err(HttpError::bad_request(format!("Tin nhắn tối đa {MAX_TEXT} ký tự")).into());
        }
        let now_ms = now.timestamp_millis();
        let found = find_conversation(&mut *self.acquire(company).await?, conversation_id).await?;
        let Some(mut conv) = found else {
            return Err(HttpError::not_found("Không tìm thấy hội thoại").into());
        };
        if !within_messaging_window(last_inbound_ms(&conv), now_ms)
            && self.sync_conversation(company, &conv, true, now_ms).await? > 0
        {
            let again = find_conversation(&mut *self.acquire(company).await?, conversation_id).await?;
            conv = again.unwrap_or(conv);
        }
        let mode = reply_mode(last_inbound_ms(&conv), now_ms);
        if mode == ReplyMode::Closed {
            return Err(HttpError::bad_request(MESSENGER_CLOSED).into());
        }
        let tag = mode == ReplyMode::HumanAgent;
        if let Some(g) = guard {
            g.assert_outbound(company, OutboundMode::Manual, OutboundScope::Meta)
                .await?;
        }
        let found = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, &conv.page_id).await?
        };
        let Some((_, token)) = found else {
            return Err(HttpError::bad_request(PAGE_OFF).into());
        };
        let graph = (self.graph_for)(company);
        let sent = match graph.send_text(&token, &conv.psid, text, tag).await {
            Ok(s) => s,
            Err(e) => {
                let (http, token_invalid) = map_send_error(&e, tag);
                tracing::warn!(
                    "Gửi tin Messenger lỗi code={:?} subcode={:?} human_agent={tag}",
                    e.code,
                    e.subcode
                );
                if token_invalid && let Ok(mut c) = self.acquire(company).await {
                    let _ = pages::mark_token_invalid(&mut c, &conv.page_id).await;
                }
                return Err(http.into());
            }
        };
        // Tin đã tới khách: từ đây chỉ ghi lại; mọi phần ghi nằm trong MỘT giao dịch.
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        stop_flow_runs_in_savepoint(&mut tx, conv.id).await;
        sqlx::query("UPDATE facebook_conversations SET last_message_at = $2, last_message_preview = $3 WHERE id = $1")
            .bind(conv.id)
            .bind(now)
            .bind(utf16_prefix(text, 200))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // Echo của tin này có thể đã tới trước: gắn người gửi vào bản ghi đó.
        let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM facebook_messages WHERE mid = $1")
            .bind(&sent.message_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        let row = sqlx::query_as::<_, FacebookMessage>(sqlx::AssertSqlSafe(format!(
            "INSERT INTO facebook_messages (conversation_id, mid, direction, text, sent_by_user_id, sent_at) \
             VALUES ($1, $2, 'out', $3, $4, $5) \
             ON CONFLICT (mid) DO UPDATE SET sent_by_user_id = EXCLUDED.sent_by_user_id RETURNING {MSG_COLS}"
        )))
        .bind(conv.id)
        .bind(&sent.message_id)
        .bind(text)
        .bind(actor_user_id)
        .bind(now)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        // Echo tới trước thì `ingest` đã ghi sự kiện và lịch sử; còn không thì ghi ở đây.
        if existing.is_none() {
            let assigned = assigned_to(&mut tx, conv.contact_id).await?;
            publish_integration_event(
                &mut tx,
                "messenger.message_sent",
                &json!({
                    "conversation_id": conv.id, "page_id": conv.page_id, "contact_id": conv.contact_id,
                    "contact_assigned_to": assigned, "origin": "agent",
                }),
                conv.id,
                Some(actor_user_id),
            )
            .await
            .map_err(AppError::internal)?;
            if let Some(cid) = conv.contact_id {
                let description = utf16_prefix(&format!("Nhân viên trả lời qua Messenger: {text}"), 2000);
                let details = json!({ "description": description, "source": "facebook_messenger" });
                let metadata = json!({
                    "facebook_page_id": conv.page_id, "psid": conv.psid, "mid": sent.message_id, "direction": "out",
                });
                sqlx::query(
                    "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
                     VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, $4)",
                )
                .bind(cid)
                .bind(trinity_kernel::json::js_json(&details))
                .bind(trinity_kernel::json::js_json(&metadata))
                .bind(actor_user_id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            }
        }
        tx.commit().await.map_err(platform_db)?;
        message_json(&row)
    }

    /// `refreshMissingNames`: lấy lại tên cho 20 hội thoại mới nhất của Page chưa có tên (gọi sau khi "Kiểm tra token" thành
    /// công). Khách còn tên tạm "Khách Messenger xxxx" thì đổi sang tên Facebook. Trả số hội thoại đã có tên.
    pub async fn refresh_missing_names(&self, company: CompanyRef, page_id: &str) -> Result<usize, AppError> {
        let found = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, page_id).await?
        };
        let Some((_, token)) = found else {
            return Ok(0);
        };
        let convs: Vec<(i32, String, Option<i32>)> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_as(
                "SELECT id, psid, contact_id FROM facebook_conversations WHERE page_id = $1 AND customer_name IS NULL \
                 ORDER BY last_message_at DESC, id DESC LIMIT 20",
            )
            .bind(page_id)
            .fetch_all(&mut *c)
            .await
            .map_err(db)?
        };
        let graph = (self.graph_for)(company);
        let mut named = 0;
        for (id, psid, contact_id) in convs {
            let name = match graph.get_user_name(&psid, &token).await {
                Some(n) => Some(n),
                None => graph.get_conversation_name(page_id, &psid, &token).await,
            };
            let Some(name) = name else {
                continue;
            };
            let mut tx = self
                .db
                .tenant(company)
                .await
                .map_err(platform_db)?
                .begin()
                .await
                .map_err(platform_db)?;
            sqlx::query("UPDATE facebook_conversations SET customer_name = $2 WHERE id = $1")
                .bind(id)
                .bind(&name)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            if let Some(cid) = contact_id {
                sqlx::query("UPDATE contacts SET full_name = $3 WHERE id = $1 AND full_name = $2")
                    .bind(cid)
                    .bind(crate::messenger::placeholder_name(&psid))
                    .bind(&name)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            tx.commit().await.map_err(platform_db)?;
            named += 1;
        }
        Ok(named)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 60 * 60 * 1000;
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn che_do_tra_loi_theo_cua_so() {
        // Trong 24 giờ: gửi thường.
        assert_eq!(reply_mode(Some(NOW - 23 * H), NOW), ReplyMode::Standard);
        assert_eq!(reply_mode(Some(NOW), NOW), ReplyMode::Standard);
        // Đúng 24 giờ trở đi tới dưới 7 ngày: thẻ Human Agent.
        assert_eq!(reply_mode(Some(NOW - 24 * H), NOW), ReplyMode::HumanAgent);
        assert_eq!(reply_mode(Some(NOW - 6 * 24 * H), NOW), ReplyMode::HumanAgent);
        assert_eq!(reply_mode(Some(NOW - 7 * 24 * H + 1), NOW), ReplyMode::HumanAgent);
        // Từ 7 ngày hoặc chưa có tin khách: chặn.
        assert_eq!(reply_mode(Some(NOW - 7 * 24 * H), NOW), ReplyMode::Closed);
        assert_eq!(reply_mode(Some(NOW - 30 * 24 * H), NOW), ReplyMode::Closed);
        assert_eq!(reply_mode(None, NOW), ReplyMode::Closed);
        assert!(within_messaging_window(Some(NOW - 24 * H + 1), NOW));
        assert!(!within_messaging_window(Some(NOW - 24 * H), NOW));
        assert!(!within_messaging_window(None, NOW));
        assert_eq!(ReplyMode::HumanAgent.as_str(), "human_agent");
    }

    #[test]
    fn dang_cho_tra_loi() {
        assert!(awaiting_reply(Some(10), 10));
        assert!(awaiting_reply(Some(11), 10));
        assert!(!awaiting_reply(Some(9), 10));
        assert!(!awaiting_reply(None, 10));
    }

    #[test]
    fn tham_so_truy_van() {
        assert_eq!(parse_limit(None), 50);
        assert_eq!(parse_limit(Some("")), 50);
        assert_eq!(parse_limit(Some("abc")), 50);
        assert_eq!(parse_limit(Some("0")), 50);
        assert_eq!(parse_limit(Some("20")), 20);
        assert_eq!(parse_limit(Some("500")), 100);
        assert_eq!(parse_limit(Some("-5")), 1);
        assert!(parse_unanswered(Some("1")));
        assert!(parse_unanswered(Some("true")));
        assert!(!parse_unanswered(Some("0")));
        assert!(!parse_unanswered(None));
        assert_eq!(parse_contact_filter(None).unwrap(), None);
        assert_eq!(parse_contact_filter(Some("")).unwrap(), None);
        assert_eq!(parse_contact_filter(Some("0")).unwrap(), None);
        assert_eq!(parse_contact_filter(Some("12")).unwrap(), Some(12));
        assert_eq!(parse_contact_filter(Some(" 7 ")).unwrap(), Some(7));
        for bad in ["-3", "abc", "1.5", "99999999999"] {
            assert_eq!(parse_contact_filter(Some(bad)).unwrap_err().status(), 400, "{bad}");
        }
    }

    #[test]
    fn kiem_noi_dung_tra_loi() {
        assert_eq!(parse_reply_text(&json!({ "text": "chào" })).unwrap(), "chào");
        let msgs = |v: Value| match parse_reply_text(&v) {
            Err(e) => format!("{:?}", e.body().message),
            Ok(_) => String::new(),
        };
        assert!(msgs(json!({ "text": "" })).contains("Nội dung trống"));
        assert!(msgs(json!({ "text": "x".repeat(2001) })).contains("tối đa 2000"));
        assert!(msgs(json!({ "text": 5 })).contains("phải là chuỗi"));
        assert!(msgs(json!({})).contains("phải là chuỗi"));
        assert!(msgs(json!({ "text": null })).contains("phải là chuỗi"));
        // 2000 đơn vị UTF-16 vẫn hợp lệ, 1001 ký tự ngoài BMP (2002 đơn vị) thì không.
        assert!(parse_reply_text(&json!({ "text": "x".repeat(2000) })).is_ok());
        assert!(parse_reply_text(&json!({ "text": "😀".repeat(1001) })).is_err());
        assert!(parse_reply_text(&json!("x")).is_err());
    }

    fn gerr(code: Option<i64>, subcode: Option<i64>, message: &str) -> GraphApiError {
        GraphApiError {
            http_status: 400,
            code,
            subcode,
            message: message.to_owned(),
            config_error: false,
        }
    }

    #[test]
    fn doi_loi_gui_tin() {
        let (e, mark) = map_send_error(&gerr(Some(10), Some(2_018_278), "outside"), false);
        assert_eq!((e.status(), mark), (400, false));
        let (e, _) = map_send_error(&gerr(Some(10), Some(2_018_278), "outside"), true);
        assert_eq!(e.status(), 400);
        assert!(format!("{:?}", e.body().message).contains("Human Agent"));
        // Thẻ bị từ chối theo nội dung lỗi (không có mã đặc biệt).
        let (e, _) = map_send_error(&gerr(Some(100), None, "Invalid tag HUMAN_AGENT"), true);
        assert!(format!("{:?}", e.body().message).contains("Human Agent"));
        // Không phải Human Agent: chữ "tag" trong lỗi không đổi nghĩa.
        let (e, mark) = map_send_error(&gerr(Some(190), None, "token"), false);
        assert_eq!((e.status(), mark), (503, true));
        let (e, mark) = map_send_error(&gerr(Some(200), None, "perm"), false);
        assert_eq!((e.status(), mark), (503, false));
        let (e, _) = map_send_error(&gerr(Some(2), None, "tạm lỗi"), false);
        assert_eq!(e.status(), 503);
        let mut cfg = gerr(None, None, "base sai");
        cfg.config_error = true;
        assert_eq!(map_send_error(&cfg, false).0.status(), 500);
    }

    #[test]
    fn thoi_gian_graph() {
        assert_eq!(graph_time_ms("2027-01-15T08:00:00+0000"), Some(1_800_000_000_000));
        assert_eq!(graph_time_ms("khong"), None);
    }
}
