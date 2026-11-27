//! Bình luận Fanpage và luật tự động (M49), chuyển từ `facebook-comments.service.ts` và `CommentRuleDto`/`CommentReplyDto`.
//!
//! - Webhook `feed` ([`FacebookIngest::handle_comment`]): bình luận mới của người khác ⇒ lưu (idempotent theo `comment_id`), ghép
//!   khách, chạy luật đầu tiên khớp (trả lời công khai, nhắn riêng Private Reply, ẩn khi có SĐT), phát `facebook.comment_received`
//!   và báo chuông. Luật chế độ "thử" chỉ ghi lại việc SẼ làm.
//! - Màn quản trị: [`list_comments`], [`reply_manually`], luật ([`list_rules`], [`create_rule`], [`update_rule`], [`delete_rule`])
//!   và [`dry_run`]. Tầng route (api_router) thuộc việc khác; ở đây chỉ có hàm dịch vụ và bảng route (`routes::comment_routes`).
//!
//! Quy tắc: không giữ kết nối pool khi gọi Graph và không bao giờ giữ hai kết nối cùng lúc; việc phụ (hội thoại sau nhắn riêng, ghi chú,
//! sự kiện, tạo khách) chạy trong SAVEPOINT nên lỗi không làm mất việc ghi chính; phát lại webhook không tạo bản ghi thứ hai.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use mod_channel_guard::{BlockCode, ChannelGuard, GuardError, OutboundMode, OutboundScope, QuotaKind};
use mod_public_api::service::{NewContact, create_contact_in_tx};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{FacebookComment, FacebookCommentRule, FacebookPage};
use trinity_db::outbox::{NewNotification, publish_integration_event};
use trinity_db::{CompanyRef, Db, TenantTx};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::phone::phone_variants;
use trinity_kernel::vi::{fold_vi, is_js_whitespace, trim_js};

use crate::config::Env;
use crate::graph::{GraphApiError, GraphClient};
use crate::ingest::{FacebookIngest, db, platform_db, str_of, utf16_prefix};
use crate::messenger::{
    MANAGER_PERMISSION, assigned_to, clip, find_vn_phone, notify_in_savepoint, owner_for, roster_with_permission,
};
use crate::pages;

/// Facebook chỉ cho nhắn riêng (Private Reply) trong 7 ngày kể từ lúc bình luận, mỗi bình luận một lần.
pub const PRIVATE_REPLY_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

const MAX_TEXT: usize = 2000;
const MAX_WORDS: usize = 30;

const COMMENT_COLS: &str = "id, comment_id, page_id, post_id, parent_id, from_id, from_name, message, commented_at, \
     contact_id, phone, rule_id, status, note, actions, hidden, created_at";
const RULE_COLS: &str = "id, name, page_id, post_id, keywords, exclude_keywords, public_replies, private_reply, \
     hide_if_phone, once_per_user, mode, is_active, \"position\", created_by, created_at, updated_at";

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn non_empty(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|x| !x.is_empty())
}

// ───────────────────────── Việc đã/ sẽ làm của một bình luận (cột `actions`) ─────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicReply {
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivateReply {
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HideResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Nhân viên trả lời tay từ Trinity (công khai dưới bình luận hoặc nhắn riêng qua Messenger).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualReply {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub by: Option<i32>,
    #[serde(default)]
    pub at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedActions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_reply: Option<PublicReply>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_reply: Option<PrivateReply>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide: Option<HideResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone_saved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual: Option<Vec<ManualReply>>,
}

impl PlannedActions {
    /// Đọc cột `actions` (JSON hỏng hoặc không phải object ⇒ rỗng, như `(actions ?? {})` của bản TS).
    pub fn from_json(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }

    fn public_id(&self) -> bool {
        self.public_reply.as_ref().is_some_and(|p| non_empty(&p.id))
    }

    fn private_id(&self) -> bool {
        self.private_reply.as_ref().is_some_and(|p| non_empty(&p.message_id))
    }
}

/// Bình luận đã có người/luật trả lời (công khai hoặc nhắn riêng thành công), hoặc luật bỏ qua vì đã trả lời người này.
pub fn comment_answered(status: &str, a: &PlannedActions) -> bool {
    status == "skipped" || a.public_id() || a.private_id() || a.manual.as_ref().is_some_and(|m| !m.is_empty())
}

/// Đã nhắn riêng cho bình luận này chưa (luật hoặc tay): Facebook chỉ cho một lần.
pub fn private_replied(a: &PlannedActions) -> bool {
    a.private_id() || a.manual.as_ref().is_some_and(|m| m.iter().any(|x| x.mode == "private"))
}

// ───────────────────────── Hàm thuần ─────────────────────────

/// Chuẩn hoá để so từ khoá: chữ thường, bỏ dấu tiếng Việt (đ → d), gộp khoảng trắng.
pub fn normalize_vi(s: &str) -> String {
    fold_vi(s)
        .split(is_js_whitespace)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Bình luận khớp luật (không xét Page/bài): chứa một từ khoá (rỗng = mọi bình luận) và không chứa từ loại trừ.
pub fn matches_keywords(message: Option<&str>, keywords: &[String], exclude: &[String]) -> bool {
    let m = normalize_vi(message.unwrap_or(""));
    let has = |w: &String| {
        let k = normalize_vi(w);
        !k.is_empty() && m.contains(&k)
    };
    if exclude.iter().any(has) {
        return false;
    }
    !keywords.iter().any(|k| !normalize_vi(k).is_empty()) || keywords.iter().any(has)
}

static TEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\{\s*ten\s*\}").expect("regex {ten}"));

/// Thay `{ten}` bằng tên người bình luận (không có tên thì "bạn").
pub fn fill_template(text: &str, name: Option<&str>) -> String {
    let who = name.map(trim_js).filter(|n| !n.is_empty()).unwrap_or("bạn");
    let replaced = TEN_RE.replace_all(text, regex::NoExpand(who));
    utf16_prefix(&replaced, MAX_TEXT)
}

/// `cleanList`: cắt khoảng trắng, bỏ rỗng, cắt 2000 ký tự, bỏ trùng (giữ thứ tự), tối đa 30 mục.
pub fn clean_list(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in v {
        let t = trim_js(x);
        if t.is_empty() {
            continue;
        }
        let t = utf16_prefix(t, MAX_TEXT);
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(MAX_WORDS);
    out
}

pub fn post_link(post_id: &str) -> String {
    format!("https://www.facebook.com/{post_id}")
}

fn placeholder_name(from_id: Option<&str>) -> String {
    let tail = from_id.map_or_else(String::new, |f| {
        let chars: Vec<char> = f.chars().collect();
        chars[chars.len().saturating_sub(4)..].iter().collect()
    });
    format!("Khách bình luận {tail}").trim().to_owned()
}

static POST_PAIR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^0-9])([0-9]{5,}_[0-9]{5,})(?:$|[^0-9])").expect("regex post pair"));
static POST_NUM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:/posts/|story_fbid=|fbid=|/videos/|/permalink/)([0-9]{5,})").expect("regex post num")
});

fn all_digits(s: &str, min: usize) -> bool {
    s.len() >= min && s.bytes().all(|b| b.is_ascii_digit())
}

/// Bài nhập dạng link Facebook hoặc id. Graph dùng id `<page>_<post>`: link đã chứa sẵn `<page>_<post>` thì lấy luôn; link chứa
/// `/posts/<số>` hoặc `story_fbid=<số>` thì ghép với Page của luật. Không đọc được ⇒ 400 (đừng lưu luật áp sai bài).
pub fn normalize_post_id(raw: Option<&str>, page_id: Option<&str>) -> Result<Option<String>, HttpError> {
    let Some(v) = raw.map(trim_js).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let is_pair = v
        .split_once('_')
        .is_some_and(|(a, b)| all_digits(a, 1) && all_digits(b, 1));
    if let Some(c) = POST_PAIR_RE.captures(v) {
        return Ok(Some(c[1].to_owned()));
    }
    if is_pair {
        return Ok(Some(v.to_owned()));
    }
    let num = POST_NUM_RE
        .captures(v)
        .map(|c| c[1].to_owned())
        .or_else(|| all_digits(v, 5).then(|| v.to_owned()));
    if let (Some(n), Some(p)) = (num, page_id.filter(|p| !p.is_empty())) {
        return Ok(Some(format!("{p}_{n}")));
    }
    Err(HttpError::bad_request(
        "Không đọc được bài từ link này. Trên Facebook bấm vào giờ đăng của bài rồi chép link có dạng .../posts/<số> \
         (link chứa \"pfbid\" không dùng được), hoặc chọn bài Trinity đã đăng, hoặc chọn Page trước rồi dán số bài.",
    ))
}

/// `toDate` của TS: số < 1e12 là giây, còn lại mili giây; chuỗi số là giây; chuỗi ngày ISO; còn lại ⇒ bây giờ.
pub fn to_date(v: Option<&Value>) -> DateTime<Utc> {
    let from_ms = |ms: f64| {
        if ms.is_finite() {
            DateTime::from_timestamp_millis(ms as i64)
        } else {
            None
        }
    };
    let parsed = match v {
        Some(Value::Number(n)) => n.as_f64().and_then(|f| from_ms(if f < 1e12 { f * 1000.0 } else { f })),
        Some(Value::String(s)) if !s.is_empty() => {
            if s.bytes().all(|b| b.is_ascii_digit()) {
                s.parse::<f64>().ok().and_then(|f| from_ms(f * 1000.0))
            } else {
                DateTime::parse_from_rfc3339(s)
                    .or_else(|_| DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%z"))
                    .ok()
                    .map(|d| d.with_timezone(&Utc))
            }
        }
        _ => None,
    };
    parsed.unwrap_or_else(Utc::now)
}

/// Một dòng kết quả luật cho thông báo: `Luật "X": đã trả lời công khai, đã nhắn riêng`.
pub fn auto_result_line(rule_name: Option<&str>, status: &str, a: &PlannedActions) -> Option<String> {
    let name = rule_name?;
    if status == "test" {
        return Some(format!("Luật \"{name}\" (chạy thử)"));
    }
    if status == "skipped" {
        return Some(format!("Luật \"{name}\": bỏ qua (đã trả lời người này)"));
    }
    let mut done: Vec<&str> = Vec::new();
    if a.public_id() {
        done.push("đã trả lời công khai");
    }
    if a.private_id() {
        done.push("đã nhắn riêng");
    }
    if a.hide.as_ref().is_some_and(|h| h.done == Some(true)) {
        done.push("đã ẩn vì có SĐT");
    }
    let failed = [
        a.public_reply.as_ref().and_then(|p| p.error.as_ref()),
        a.private_reply.as_ref().and_then(|p| p.error.as_ref()),
        a.hide.as_ref().and_then(|h| h.error.as_ref()),
    ]
    .iter()
    .filter(|e| e.is_some_and(|s| !s.is_empty()))
    .count();
    let what = if done.is_empty() {
        "chưa làm được".to_owned()
    } else {
        done.join(", ")
    };
    let tail = if failed > 0 {
        format!(" ({failed} việc lỗi)")
    } else {
        String::new()
    };
    Some(format!("Luật \"{name}\": {what}{tail}"))
}

/// Việc luật sẽ làm (chưa gửi). `pick` chọn câu trả lời công khai (`pick % số câu`).
pub fn plan(rule: &FacebookCommentRule, name: Option<&str>, phone: Option<&str>, pick: usize) -> PlannedActions {
    let mut a = PlannedActions::default();
    let replies = &rule.public_replies.0;
    if !replies.is_empty() {
        a.public_reply = Some(PublicReply {
            text: fill_template(&replies[pick % replies.len()], name),
            ..PublicReply::default()
        });
    }
    if let Some(p) = rule.private_reply.as_deref().filter(|p| !trim_js(p).is_empty()) {
        a.private_reply = Some(PrivateReply {
            text: fill_template(p, name),
            ..PrivateReply::default()
        });
    }
    if rule.hide_if_phone && phone.is_some() {
        a.hide = Some(HideResult::default());
    }
    a
}

/// Số ngẫu nhiên đủ dùng để chọn một câu trả lời (không cần thêm crate).
fn rand_pick() -> usize {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let mixed = nanos.wrapping_mul(2_654_435_761) >> 7;
    mixed as usize
}

/// Tiêu đề và nội dung chuông cho một bình luận mới.
pub fn comment_notice(
    channel_name: &str,
    from_name: Option<&str>,
    text: Option<&str>,
    auto_result: Option<&str>,
    contact_created: bool,
) -> (String, String) {
    let who = from_name.map(trim_js).filter(|s| !s.is_empty()).unwrap_or("Khách");
    let flat = text.unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    let shown = if flat.is_empty() {
        "[không có chữ]"
    } else {
        flat.as_str()
    };
    let mut parts = vec![format!("{who}: {}", clip(shown, 120))];
    if let Some(a) = auto_result.filter(|a| !a.is_empty()) {
        parts.push(a.to_owned());
    }
    if contact_created {
        parts.push("đã tạo khách mới".to_owned());
    }
    (
        format!("Bình luận mới trên {channel_name}"),
        clip(&parts.join(" · "), 280),
    )
}

// ───────────────────────── Việc phụ trong SAVEPOINT ─────────────────────────

async fn sp_begin(tx: &mut TenantTx, name: &str) -> bool {
    sqlx::query(sqlx::AssertSqlSafe(format!("SAVEPOINT {name}")))
        .execute(&mut **tx)
        .await
        .is_ok()
}

/// Kết thúc SAVEPOINT: `ok` ⇒ giữ; không ⇒ hoàn tác riêng phần việc phụ (giao dịch chính vẫn dùng được).
async fn sp_end(tx: &mut TenantTx, name: &str, ok: bool) {
    if !ok {
        let _ = sqlx::query(sqlx::AssertSqlSafe(format!("ROLLBACK TO SAVEPOINT {name}")))
            .execute(&mut **tx)
            .await;
    }
    let _ = sqlx::query(sqlx::AssertSqlSafe(format!("RELEASE SAVEPOINT {name}")))
        .execute(&mut **tx)
        .await;
}

/// Giải thích lỗi Graph cho người dùng (và đánh dấu token hỏng). Kết nối chỉ được xin trong hàm này, không giữ khi gọi Graph.
pub(crate) async fn explain_graph(
    db: &Db,
    company: CompanyRef,
    e: &GraphApiError,
    page_id: &str,
    what: &str,
) -> String {
    if e.is_config_error() {
        tracing::error!("Bình luận: {what} lỗi cấu hình Graph API: {}", e.message);
        return format!(
            "Không {what} được: cấu hình kết nối Facebook của máy chủ sai ({}).",
            utf16_prefix(&e.message, 160)
        );
    }
    if e.is_token_error() {
        if let Err(err) = mark_invalid(db, company, page_id).await {
            tracing::warn!("Không đánh dấu token Page {page_id} hỏng: {err}");
        }
        return format!("Không {what} được: token Fanpage hết hạn, hãy kết nối lại Fanpage.");
    }
    if e.is_permission_error() {
        return format!(
            "Không {what} được: ứng dụng Facebook chưa có quyền (cần kết nối lại Fanpage sau khi bật quyền)."
        );
    }
    format!("Không {what} được: Facebook báo \"{}\".", utf16_prefix(&e.message, 160))
}

async fn mark_invalid(db: &Db, company: CompanyRef, page_id: &str) -> Result<(), AppError> {
    let mut c = db
        .tenant(company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)?;
    pages::mark_token_invalid(&mut c, page_id).await
}

// ───────────────────────── Truy vấn dùng chung ─────────────────────────

/// Luật đầu tiên (theo position, id) đang bật và khớp Page, bài, từ khoá.
pub async fn match_rule(
    conn: &mut PgConnection,
    page_id: &str,
    post_id: &str,
    message: Option<&str>,
) -> Result<Option<FacebookCommentRule>, AppError> {
    let rules = sqlx::query_as::<_, FacebookCommentRule>(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_COLS} FROM facebook_comment_rules WHERE is_active \
         AND (page_id IS NULL OR page_id = $1) AND (post_id IS NULL OR post_id = $2) \
         ORDER BY \"position\" ASC, id ASC"
    )))
    .bind(page_id)
    .bind(post_id)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rules
        .into_iter()
        .find(|r| matches_keywords(message, &r.keywords.0, &r.exclude_keywords.0)))
}

/// Khách sẵn có của người bình luận: SĐT trùng khách cũ ⇒ khách đó; đã bình luận trước ⇒ khách lần trước.
async fn find_contact(
    conn: &mut PgConnection,
    page_id: &str,
    from_id: Option<&str>,
    phone: Option<&str>,
) -> Result<Option<i32>, AppError> {
    if let Some(p) = phone {
        let by_phone: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
        )
        .bind(phone_variants(p))
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if by_phone.is_some() {
            return Ok(by_phone);
        }
    }
    if let Some(f) = from_id {
        let before: Option<i32> = sqlx::query_scalar(
            "SELECT contact_id FROM facebook_comments WHERE page_id = $1 AND from_id = $2 AND contact_id IS NOT NULL \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(page_id)
        .bind(f)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if let Some(cid) = before {
            return alive_contact(conn, cid).await;
        }
    }
    Ok(None)
}

async fn alive_contact(conn: &mut PgConnection, id: i32) -> Result<Option<i32>, AppError> {
    sqlx::query_scalar("SELECT id FROM contacts WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// Khách Messenger sẵn có của người này (PSID lấy từ lần nhắn riêng).
async fn contact_of_conversation(conn: &mut PgConnection, page_id: &str, psid: &str) -> Result<Option<i32>, AppError> {
    let cid: Option<Option<i32>> =
        sqlx::query_scalar("SELECT contact_id FROM facebook_conversations WHERE page_id = $1 AND psid = $2")
            .bind(page_id)
            .bind(psid)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    match cid.flatten() {
        Some(id) => alive_contact(conn, id).await,
        None => Ok(None),
    }
}

/// Tạo khách mới từ người bình luận (nguồn = nguồn khách của Page, người phụ trách = người nhận khách của Page). Không biết người
/// bình luận và không có SĐT ⇒ không tạo. Kiểm trùng nằm dưới khoá advisory theo (schema, Page, người bình luận hoặc SĐT).
async fn create_contact(
    conn: &mut PgConnection,
    page: &FacebookPage,
    from_id: Option<&str>,
    from_name: Option<&str>,
    phone: Option<&str>,
) -> Result<Option<i32>, AppError> {
    let Some(key) = from_id.or(phone) else {
        return Ok(None);
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.fb_comment.' || $1 || ':' || $2))")
        .bind(&page.page_id)
        .bind(key)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let Some(owner) = owner_for(&mut *conn, page).await? else {
        tracing::warn!(
            "Không tạo khách từ bình luận (Page {}): người nhận khách và người kết nối Page đều không còn hoạt động",
            page.page_id
        );
        return Ok(None);
    };
    let name = from_name
        .map(trim_js)
        .filter(|n| !n.is_empty())
        .map_or_else(|| placeholder_name(from_id), str::to_owned);
    let (id, _) = create_contact_in_tx(
        &mut *conn,
        &NewContact {
            phone: phone.unwrap_or(""),
            full_name: Some(&name),
            source_id: Some(page.contact_source_id),
            email: None,
            job_title: None,
            reminder_notes: None,
            zalo_account: None,
            project_id: page.project_id,
        },
        &owner,
        "facebook_comment",
    )
    .await?;
    Ok(Some(id))
}

/// Private Reply trả về PSID của người bình luận: tạo sẵn hội thoại Messenger gắn đúng khách, để khi khách nhắn lại tin vào cùng khách
/// hàng (không đẻ khách trùng). Hội thoại đã gắn khách thì GIỮ khách đó. Tin của Page lưu luôn (echo tới sau trùng `mid` bị bỏ qua).
async fn remember_conversation(
    conn: &mut PgConnection,
    page_id: &str,
    psid: &str,
    mid: &str,
    text: &str,
    contact_id: Option<i32>,
) -> Result<(), AppError> {
    let now = Utc::now();
    let preview = utf16_prefix(text, 200);
    let (conv_id, conv_contact): (i32, Option<i32>) = sqlx::query_as(
        "INSERT INTO facebook_conversations (page_id, psid, contact_id, last_message_at, last_message_preview) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (page_id, psid) DO UPDATE SET last_message_at = $4, last_message_preview = $5, \
         contact_id = COALESCE(facebook_conversations.contact_id, $3) \
         RETURNING id, contact_id",
    )
    .bind(page_id)
    .bind(psid)
    .bind(contact_id)
    .bind(now)
    .bind(&preview)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let saved: Option<i32> = sqlx::query_scalar(
        "INSERT INTO facebook_messages (conversation_id, mid, direction, text, sent_at) \
         VALUES ($1, $2, 'out', $3, $4) ON CONFLICT (mid) DO NOTHING RETURNING id",
    )
    .bind(conv_id)
    .bind(mid)
    .bind(text)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if saved.is_some() {
        let assigned = assigned_to(&mut *conn, conv_contact).await?;
        publish_integration_event(
            &mut *conn,
            "messenger.message_sent",
            &json!({
                "conversation_id": conv_id, "page_id": page_id, "contact_id": conv_contact,
                "contact_assigned_to": assigned, "origin": "comment_reply",
            }),
            conv_id,
            None,
        )
        .await
        .map_err(AppError::internal)?;
    }
    Ok(())
}

// ───────────────────────── Webhook `feed` ─────────────────────────

/// Kết quả giữ chỗ hạn mức trả lời tự động.
struct Gate {
    /// Bị chặn: (lời báo, đang tạm dừng).
    held: Option<(String, bool)>,
    bucket: Option<DateTime<Utc>>,
    reserved: bool,
}

/// Trạng thái sau bước ghi đầu (bình luận đã lưu).
struct Saved {
    row_id: i64,
    contact_id: Option<i32>,
    rule: Option<FacebookCommentRule>,
    dup: bool,
}

impl FacebookIngest {
    /// Một thay đổi `feed`. Chỉ xử lý bình luận MỚI của người khác (bỏ bình luận của chính Page ⇒ không tự trả lời mình). `true` nếu có
    /// ghi mới; Meta gửi lại cùng `comment_id` ⇒ `false`.
    pub async fn handle_comment(&self, company: CompanyRef, entry_page_id: &str, v: &Value) -> Result<bool, AppError> {
        fn field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
            v.get(k).and_then(Value::as_str)
        }
        if field(v, "item") != Some("comment") || field(v, "verb") != Some("add") {
            return Ok(false);
        }
        let (Some(comment_id), Some(post_id)) = (str_of(v.get("comment_id")), str_of(v.get("post_id"))) else {
            return Ok(false);
        };
        let from = v.get("from");
        let from_id = str_of(from.and_then(|f| f.get("id")));
        if from_id.as_deref() == Some(entry_page_id) {
            return Ok(false);
        }
        let from_name = from
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .map(|n| utf16_prefix(n, 200));
        let message = v.get("message").and_then(Value::as_str).map(|m| utf16_prefix(m, 5000));
        let parent_id = str_of(v.get("parent_id")).filter(|p| *p != post_id);
        let phone = find_vn_phone(message.as_deref());
        let at = to_date(v.get("created_time"));
        let page_id = entry_page_id;

        // Bước 1: Page + token (kết nối trả lại ngay, không giữ khi gọi Graph).
        let found = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, page_id).await?
        };
        let Some((page, token)) = found else {
            return Ok(false);
        };

        // Bước 2: lưu bình luận (idempotent theo `comment_id`), tìm khách và luật; một giao dịch rồi trả kết nối.
        let saved = {
            let mut tx = self
                .db
                .tenant(company)
                .await
                .map_err(platform_db)?
                .begin()
                .await
                .map_err(platform_db)?;
            let row: Option<i64> = sqlx::query_scalar(
                "INSERT INTO facebook_comments (comment_id, page_id, post_id, parent_id, from_id, from_name, message, \
                 commented_at, phone) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
                 ON CONFLICT (comment_id) DO NOTHING RETURNING id",
            )
            .bind(&comment_id)
            .bind(page_id)
            .bind(&post_id)
            .bind(parent_id.as_deref())
            .bind(from_id.as_deref())
            .bind(from_name.as_deref())
            .bind(message.as_deref())
            .bind(at)
            .bind(phone.as_deref())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
            let Some(row_id) = row else {
                return Ok(false);
            };
            // Khách có sẵn (SĐT, bình luận trước). Chưa có thì CHỜ nhắn riêng xong: PSID có thể trỏ tới khách Messenger cũ.
            let contact_id = find_contact(&mut tx, page_id, from_id.as_deref(), phone.as_deref()).await?;
            let rule = match_rule(&mut tx, page_id, &post_id, message.as_deref()).await?;
            let mut dup = false;
            if let (Some(r), Some(f)) = (&rule, &from_id)
                && r.once_per_user
            {
                dup = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM facebook_comments WHERE post_id = $1 AND from_id = $2 \
                     AND rule_id = $3 AND status IN ('done', 'test') AND id <> $4)",
                )
                .bind(&post_id)
                .bind(f)
                .bind(r.id)
                .bind(row_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            }
            tx.commit().await.map_err(platform_db)?;
            Saved {
                row_id,
                contact_id,
                rule,
                dup,
            }
        };

        // Bước 3: quyết định việc làm và gọi Graph (không giữ kết nối).
        let rule = saved.rule.as_ref();
        let mut status = "received".to_owned();
        let mut note: Option<String> = None;
        let mut actions = PlannedActions::default();
        let mut psid: Option<String> = None;
        if let Some(rule) = rule {
            if saved.dup {
                status = "skipped".to_owned();
                note = Some(
                    "Người này đã được trả lời ở bài này rồi (luật chỉ trả lời mỗi người một lần mỗi bài).".to_owned(),
                );
            } else {
                actions = plan(rule, from_name.as_deref(), phone.as_deref(), rand_pick());
                // Hạn mức chỉ tính khi luật THẬT SỰ trả lời (công khai hoặc nhắn riêng); luật chỉ ẩn bình luận thì không tốn.
                let wants_reply = actions.public_reply.is_some() || actions.private_reply.is_some();
                let gate = if rule.mode == "live" && wants_reply {
                    self.hold_auto_reply(company).await?
                } else {
                    Gate {
                        held: None,
                        bucket: None,
                        reserved: false,
                    }
                };
                if let Some((message, pause)) = gate.held {
                    // Không trả lời tự động lúc này (khoá kênh / tạm dừng / hết hạn mức giờ). Gỡ nội dung vẫn được phép.
                    if let Some(h) = actions.hide.clone() {
                        let only_hide = PlannedActions {
                            hide: Some(h),
                            ..PlannedActions::default()
                        };
                        (actions, _) = self
                            .execute_actions(company, &page, &token, &comment_id, &only_hide)
                            .await;
                    } else {
                        actions = PlannedActions::default();
                    }
                    // Tạm dừng chỉ là tạm: bình luận còn "chưa trả lời" để nhân viên trả tay. Khoá/hạn mức: bỏ qua có ghi lý do.
                    let held_status = if pause { "received" } else { "skipped" };
                    status = held_status.to_owned();
                    note = Some(message);
                } else if rule.mode == "live" {
                    (actions, psid) = self
                        .execute_actions(company, &page, &token, &comment_id, &actions)
                        .await;
                    // Không có lời trả lời nào tới Facebook ⇒ hoàn hạn mức đã giữ chỗ.
                    if gate.reserved
                        && !actions.public_id()
                        && !actions.private_id()
                        && let Some(g) = &self.guard
                    {
                        g.refund(company, QuotaKind::CommentReply, 1, gate.bucket).await;
                    }
                    let errs: Vec<&str> = [
                        actions.public_reply.as_ref().and_then(|p| p.error.as_deref()),
                        actions.private_reply.as_ref().and_then(|p| p.error.as_deref()),
                        actions.hide.as_ref().and_then(|h| h.error.as_deref()),
                    ]
                    .into_iter()
                    .flatten()
                    .filter(|e| !e.is_empty())
                    .collect();
                    let ok = actions.public_id()
                        || actions.private_id()
                        || actions.hide.as_ref().is_some_and(|h| h.done == Some(true));
                    let end_status = if !errs.is_empty() && !ok { "failed" } else { "done" };
                    status = end_status.to_owned();
                    note = (!errs.is_empty()).then(|| utf16_prefix(&errs.join(" · "), 500));
                } else {
                    status = "test".to_owned();
                    note = Some("Luật đang ở chế độ thử: chỉ ghi lại, chưa gửi gì lên Facebook.".to_owned());
                }
            }
        }
        if let Some(n) = &note {
            note = Some(utf16_prefix(n, 500));
        }

        // Bước 4: một giao dịch ghi kết quả; việc phụ nằm trong SAVEPOINT.
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        let mut contact_id = saved.contact_id;
        if contact_id.is_none()
            && let Some(p) = &psid
        {
            contact_id = contact_of_conversation(&mut tx, page_id, p).await?;
        }
        let mut contact_created = false;
        if contact_id.is_none() && sp_begin(&mut tx, "fb_c_contact").await {
            let r = create_contact(
                &mut tx,
                &page,
                from_id.as_deref(),
                from_name.as_deref(),
                phone.as_deref(),
            )
            .await;
            sp_end(&mut tx, "fb_c_contact", r.is_ok()).await;
            match r {
                Ok(id) => {
                    contact_created = id.is_some();
                    contact_id = id;
                }
                Err(e) => tracing::warn!("Tạo khách từ bình luận lỗi: {e}"),
            }
        }
        if let (Some(p), Some(pr)) = (&psid, &actions.private_reply)
            && let Some(mid) = pr.message_id.as_deref().filter(|m| !m.is_empty())
            && sp_begin(&mut tx, "fb_c_conv").await
        {
            let r = remember_conversation(&mut tx, page_id, p, mid, &pr.text, contact_id).await;
            sp_end(&mut tx, "fb_c_conv", r.is_ok()).await;
            if let Err(e) = r {
                tracing::warn!("Lưu hội thoại sau nhắn riêng lỗi: {e}");
            }
        }
        if let (Some(p), Some(cid)) = (&phone, contact_id) {
            let r = sqlx::query("UPDATE contacts SET phone = $2 WHERE id = $1 AND phone = ''")
                .bind(cid)
                .bind(p)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            if r.rows_affected() > 0 {
                actions.phone_saved = Some(true);
            }
        }
        let hidden = actions.hide.as_ref().is_some_and(|h| h.done == Some(true));
        sqlx::query(
            "UPDATE facebook_comments SET contact_id = $2, rule_id = $3, status = $4, note = $5, \
             actions = $6::text::jsonb, hidden = $7 WHERE id = $1",
        )
        .bind(saved.row_id)
        .bind(contact_id)
        .bind(rule.map(|r| r.id))
        .bind(&status)
        .bind(note.as_deref())
        .bind(trinity_kernel::json::js_json(&actions.to_json()))
        .bind(hidden)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        if let Some(cid) = contact_id
            && sp_begin(&mut tx, "fb_c_activity").await
        {
            let r = log_activity(
                &mut tx,
                cid,
                &page,
                &post_id,
                &comment_id,
                message.as_deref(),
                rule,
                &status,
                &actions,
            )
            .await;
            sp_end(&mut tx, "fb_c_activity", r.is_ok()).await;
            if let Err(e) = r {
                tracing::warn!("Ghi chú bình luận lỗi: {e}");
            }
        }
        if sp_begin(&mut tx, "fb_c_event").await {
            let r = publish_comment_event(&mut tx, saved.row_id, page_id, &post_id, contact_id, &status).await;
            sp_end(&mut tx, "fb_c_event", r.is_ok()).await;
            if let Err(e) = r {
                tracing::warn!("Sự kiện webhook bình luận lỗi: {e}");
            }
        }
        tx.commit().await.map_err(platform_db)?;

        // Thông báo chuông: giao dịch riêng, lỗi chỉ ghi log (không hoàn tác bình luận đã lưu).
        let auto = auto_result_line(rule.map(|r| r.name.as_str()), &status, &actions);
        if let Err(e) = self
            .notify_comment(
                company,
                &page,
                contact_id,
                contact_created,
                from_name.as_deref(),
                message.as_deref(),
                auto.as_deref(),
            )
            .await
        {
            tracing::warn!("Thông báo kênh lỗi (facebook.comment_received): {e}");
        }
        Ok(true)
    }

    /// Giữ chỗ hạn mức trả lời tự động; bị chặn ⇒ lời báo (không gửi), được ⇒ không chặn.
    async fn hold_auto_reply(&self, company: CompanyRef) -> Result<Gate, AppError> {
        let Some(guard) = &self.guard else {
            return Ok(Gate {
                held: None,
                bucket: None,
                reserved: false,
            });
        };
        match guard
            .reserve(company, QuotaKind::CommentReply, 1, OutboundScope::Meta)
            .await
        {
            Ok(bucket) => Ok(Gate {
                held: None,
                bucket,
                reserved: true,
            }),
            Err(GuardError::Blocked(b)) => {
                let pause = b.code == BlockCode::ChannelPaused;
                Ok(Gate {
                    held: Some((b.message, pause)),
                    bucket: None,
                    reserved: false,
                })
            }
            Err(GuardError::App(e)) => Err(e),
        }
    }

    /// Gọi Graph cho từng việc; lỗi một việc ghi vào việc đó (không dừng các việc khác). Trả thêm PSID của lần nhắn riêng.
    async fn execute_actions(
        &self,
        company: CompanyRef,
        page: &FacebookPage,
        token: &str,
        comment_id: &str,
        a: &PlannedActions,
    ) -> (PlannedActions, Option<String>) {
        let graph = (self.graph_for)(company);
        let mut out = a.clone();
        let mut psid: Option<String> = None;
        if let Some(p) = &a.public_reply {
            out.public_reply = Some(match graph.reply_to_comment(token, comment_id, &p.text).await {
                Ok(id) => PublicReply {
                    id: Some(id),
                    ..p.clone()
                },
                Err(e) => PublicReply {
                    error: Some(explain_graph(&self.db, company, &e, &page.page_id, "trả lời bình luận").await),
                    ..p.clone()
                },
            });
        }
        if let Some(p) = &a.private_reply {
            out.private_reply = Some(
                match graph.private_reply(token, &page.page_id, comment_id, &p.text).await {
                    Ok(r) => {
                        psid = r.recipient_id;
                        PrivateReply {
                            message_id: Some(r.message_id),
                            ..p.clone()
                        }
                    }
                    Err(e) => PrivateReply {
                        error: Some(explain_graph(&self.db, company, &e, &page.page_id, "nhắn riêng").await),
                        ..p.clone()
                    },
                },
            );
        }
        if a.hide.is_some() {
            out.hide = Some(match graph.hide_comment(token, comment_id).await {
                Ok(()) => HideResult {
                    done: Some(true),
                    error: None,
                },
                Err(e) => HideResult {
                    done: None,
                    error: Some(explain_graph(&self.db, company, &e, &page.page_id, "ẩn bình luận").await),
                },
            });
        }
        (out, psid)
    }

    /// `ChannelNotificationsService.notify` cho bình luận: người phụ trách khách + người nhận mặc định của Page + người quản lý kết nối.
    #[allow(clippy::too_many_arguments)]
    async fn notify_comment(
        &self,
        company: CompanyRef,
        page: &FacebookPage,
        contact_id: Option<i32>,
        contact_created: bool,
        from_name: Option<&str>,
        text: Option<&str>,
        auto_result: Option<&str>,
    ) -> Result<(), AppError> {
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        let owner = assigned_to(&mut tx, contact_id).await?;
        let managers = roster_with_permission(&mut tx, MANAGER_PERMISSION).await?;
        let mut recipients: Vec<i32> = Vec::new();
        for id in [owner, Some(page.default_assignee_id)]
            .into_iter()
            .flatten()
            .chain(managers)
        {
            if id > 0 && !recipients.contains(&id) {
                recipients.push(id);
            }
        }
        if recipients.is_empty() {
            return Ok(());
        }
        let (title, body) = comment_notice(&page.name, from_name, text, auto_result, contact_created);
        let items: Vec<NewNotification> = recipients
            .iter()
            .map(|r| NewNotification {
                recipient_id: *r,
                event_type: "facebook.comment_received".to_owned(),
                title: title.clone(),
                body: body.clone(),
                action_url: Some("/inbox?kenh=tuong-tac".to_owned()),
            })
            .collect();
        notify_in_savepoint(&mut tx, &items).await;
        tx.commit().await.map_err(platform_db)?;
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn log_activity(
    conn: &mut PgConnection,
    contact_id: i32,
    page: &FacebookPage,
    post_id: &str,
    comment_id: &str,
    message: Option<&str>,
    rule: Option<&FacebookCommentRule>,
    status: &str,
    a: &PlannedActions,
) -> Result<(), AppError> {
    let mut lines = vec![format!(
        "Khách bình luận bài trên Page \"{}\": {}",
        page.name,
        message.unwrap_or("")
    )];
    let verb = if status == "test" { "sẽ" } else { "đã" };
    if let Some(r) = rule
        && (status == "done" || status == "test")
    {
        if let Some(p) = a.public_reply.as_ref().filter(|p| !non_empty(&p.error)) {
            lines.push(format!(
                "Trinity {verb} trả lời công khai (luật \"{}\"): {}",
                r.name, p.text
            ));
        }
        if let Some(p) = a.private_reply.as_ref().filter(|p| !non_empty(&p.error)) {
            lines.push(format!("Trinity {verb} nhắn riêng qua Messenger: {}", p.text));
        }
        if a.hide.as_ref().is_some_and(|h| !non_empty(&h.error)) {
            lines.push(format!("Trinity {verb} ẩn bình luận vì có số điện thoại."));
        }
    }
    let details = json!({ "description": utf16_prefix(&lines.join("\n"), 2000), "source": "facebook_comment" });
    let metadata = json!({
        "facebook_page_id": page.page_id, "post_id": post_id, "comment_id": comment_id, "post_url": post_link(post_id),
    });
    sqlx::query(
        "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
         VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, NULL)",
    )
    .bind(contact_id)
    .bind(trinity_kernel::json::js_json(&details))
    .bind(trinity_kernel::json::js_json(&metadata))
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

async fn publish_comment_event(
    conn: &mut PgConnection,
    row_id: i64,
    page_id: &str,
    post_id: &str,
    contact_id: Option<i32>,
    status: &str,
) -> Result<(), AppError> {
    let assigned = assigned_to(&mut *conn, contact_id).await?;
    publish_integration_event(
        conn,
        "facebook.comment_received",
        &json!({
            "comment_id": row_id, "page_id": page_id, "post_id": post_id, "contact_id": contact_id,
            "contact_assigned_to": assigned, "auto_reply_status": status,
        }),
        row_id,
        None,
    )
    .await
    .map_err(AppError::internal)
}

// ───────────────────────── Kiểm dữ liệu vào (class-validator) ─────────────────────────

fn max_msg(key: &str, max: usize) -> String {
    format!("{key} must be shorter than or equal to {max} characters")
}

/// Số nguyên trong `int4` (số thực nguyên như `1.0` cũng nhận, như `Number.isInteger`).
fn int_i32(v: &Value) -> Option<i32> {
    if let Some(i) = v.as_i64() {
        return i32::try_from(i).ok();
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f >= f64::from(i32::MIN) && f <= f64::from(i32::MAX)).then_some(f as i32)
}

/// `@IsOptional() @IsString() @MaxLength(max)`: thiếu/null qua; sai kiểu báo cả hai câu (MaxLength đăng ký trước).
fn opt_string(e: &mut Vec<String>, o: &Map<String, Value>, key: &str, max: usize) {
    match o.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            if len16(s) > max {
                e.push(max_msg(key, max));
            }
        }
        Some(_) => {
            e.push(max_msg(key, max));
            e.push(format!("{key} must be a string"));
        }
    }
}

/// `@IsOptional() @IsBoolean()`.
fn opt_bool(e: &mut Vec<String>, o: &Map<String, Value>, key: &str) {
    if !matches!(o.get(key), None | Some(Value::Null | Value::Bool(_))) {
        e.push(format!("{key} must be a boolean value"));
    }
}

/// `@IsOptional() @IsArray() @ArrayMaxSize(max) @IsString({ each }) @MaxLength(len, { each })`.
fn opt_string_list(
    e: &mut Vec<String>,
    o: &Map<String, Value>,
    key: &str,
    max_items: usize,
    max_len: usize,
    len_msg: Option<&str>,
) {
    let len_text = len_msg.map_or_else(
        || format!("each value in {key} must be shorter than or equal to {max_len} characters"),
        str::to_owned,
    );
    match o.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => {
            if a.iter().any(|x| x.as_str().is_none_or(|s| len16(s) > max_len)) {
                e.push(len_text);
            }
            if a.iter().any(|x| !x.is_string()) {
                e.push(format!("each value in {key} must be a string"));
            }
            if a.len() > max_items {
                e.push(format!("{key} must contain no more than {max_items} elements"));
            }
        }
        Some(_) => {
            e.push(len_text);
            e.push(format!("each value in {key} must be a string"));
            e.push(format!("{key} must contain no more than {max_items} elements"));
            e.push(format!("{key} must be an array"));
        }
    }
}

fn body_object(v: &Value) -> Result<&Map<String, Value>, HttpError> {
    v.as_object()
        .ok_or_else(|| HttpError::validation(vec!["body must be an object".to_owned()]))
}

/// `CommentRuleDto`: mọi trường tuỳ chọn (null như vắng). Trả object đã kiểm cho [`create_rule`]/[`update_rule`].
pub fn validate_rule_body(v: &Value) -> Result<Map<String, Value>, HttpError> {
    let o = body_object(v)?;
    let mut e = Vec::new();
    opt_string(&mut e, o, "name", 120);
    opt_string(&mut e, o, "page_id", 40);
    opt_string(&mut e, o, "post_id", 500);
    opt_string_list(&mut e, o, "keywords", 30, 200, None);
    opt_string_list(&mut e, o, "exclude_keywords", 30, 200, None);
    opt_string_list(&mut e, o, "public_replies", 10, 2000, Some("Mỗi mục tối đa 2000 ký tự"));
    opt_string(&mut e, o, "private_reply", 2000);
    opt_bool(&mut e, o, "hide_if_phone");
    opt_bool(&mut e, o, "once_per_user");
    if !matches!(o.get("mode"), None | Some(Value::Null))
        && !matches!(o.get("mode"), Some(Value::String(s)) if s == "test" || s == "live")
    {
        e.push("mode must be one of the following values: test, live".to_owned());
    }
    opt_bool(&mut e, o, "is_active");
    if !matches!(o.get("position"), None | Some(Value::Null)) && o.get("position").and_then(int_i32).is_none() {
        e.push("position must be an integer number".to_owned());
    }
    if e.is_empty() {
        Ok(o.clone())
    } else {
        Err(HttpError::validation(e))
    }
}

/// Body `POST /facebook/comments/:id/reply` (`CommentReplyDto`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentReply {
    pub text: String,
    /// `public` hoặc `private`.
    pub mode: String,
}

impl CommentReply {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let o = body_object(v)?;
        let mut e = Vec::new();
        let text = match o.get("text") {
            Some(Value::String(s)) => {
                if len16(s) > MAX_TEXT {
                    e.push("Trả lời tối đa 2000 ký tự".to_owned());
                }
                if s.is_empty() {
                    e.push("Nội dung trống".to_owned());
                }
                s.clone()
            }
            _ => {
                e.push("Trả lời tối đa 2000 ký tự".to_owned());
                e.push("Nội dung trống".to_owned());
                e.push("Nội dung phải là chuỗi".to_owned());
                String::new()
            }
        };
        let mode = match o.get("mode") {
            Some(Value::String(s)) if s == "public" || s == "private" => s.clone(),
            _ => {
                e.push("Cách trả lời phải là public hoặc private".to_owned());
                String::new()
            }
        };
        if e.is_empty() {
            Ok(Self { text, mode })
        } else {
            Err(HttpError::validation(e))
        }
    }
}

/// Body `POST /facebook/comment-rules/dry-run` (`CommentDryRunDto`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunInput {
    pub message: String,
    pub page_id: Option<String>,
    pub post_id: Option<String>,
    pub from_name: Option<String>,
}

impl DryRunInput {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let o = body_object(v)?;
        let mut e = Vec::new();
        let message = match o.get("message") {
            Some(Value::String(s)) => {
                if len16(s) > 5000 {
                    e.push(max_msg("message", 5000));
                }
                if s.is_empty() {
                    e.push("Nhập bình luận mẫu".to_owned());
                }
                s.clone()
            }
            _ => {
                e.push(max_msg("message", 5000));
                e.push("Nhập bình luận mẫu".to_owned());
                e.push("message must be a string".to_owned());
                String::new()
            }
        };
        opt_string(&mut e, o, "page_id", 40);
        opt_string(&mut e, o, "post_id", 500);
        opt_string(&mut e, o, "from_name", 200);
        if !e.is_empty() {
            return Err(HttpError::validation(e));
        }
        let get = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
        Ok(Self {
            message,
            page_id: get("page_id"),
            post_id: get("post_id"),
            from_name: get("from_name"),
        })
    }
}

// ───────────────────────── Luật: làm sạch và lưu ─────────────────────────

/// Dữ liệu luật đã làm sạch (`sanitize`). `Option` ngoài: khoá có mặt; `Option` trong: giá trị `null`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuleData {
    pub name: Option<String>,
    pub page_id: Option<Option<String>>,
    pub post_id: Option<Option<String>>,
    pub keywords: Option<Vec<String>>,
    pub exclude_keywords: Option<Vec<String>>,
    pub public_replies: Option<Vec<String>>,
    pub private_reply: Option<Option<String>>,
    pub hide_if_phone: Option<bool>,
    pub once_per_user: Option<bool>,
    pub mode: Option<String>,
    pub is_active: Option<bool>,
    pub position: Option<i32>,
}

fn text_of<'a>(o: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

fn list_of(o: &Map<String, Value>, key: &str) -> Vec<String> {
    let items: Vec<String> = o
        .get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    clean_list(&items)
}

/// `sanitize(input, creating)`: `null` trên cờ Boolean thành `false`, `mode` sai ⇒ 400, `name` rỗng ⇒ 400.
pub fn sanitize_rule(o: &Map<String, Value>, creating: bool) -> Result<RuleData, HttpError> {
    let mut d = RuleData::default();
    if o.contains_key("name") || creating {
        let name = trim_js(text_of(o, "name").unwrap_or(""));
        if name.is_empty() {
            return Err(HttpError::bad_request("Đặt tên cho luật"));
        }
        d.name = Some(utf16_prefix(name, 120));
    }
    if o.contains_key("page_id") {
        d.page_id = Some(
            text_of(o, "page_id")
                .map(trim_js)
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
        );
    }
    if o.contains_key("post_id") {
        let page_arg = d
            .page_id
            .clone()
            .flatten()
            .or_else(|| text_of(o, "page_id").map(str::to_owned));
        d.post_id = Some(normalize_post_id(text_of(o, "post_id"), page_arg.as_deref())?);
    }
    if o.contains_key("keywords") {
        d.keywords = Some(list_of(o, "keywords"));
    }
    if o.contains_key("exclude_keywords") {
        d.exclude_keywords = Some(list_of(o, "exclude_keywords"));
    }
    if o.contains_key("public_replies") {
        d.public_replies = Some(list_of(o, "public_replies"));
    }
    if o.contains_key("private_reply") {
        d.private_reply = Some(
            text_of(o, "private_reply")
                .map(|t| utf16_prefix(trim_js(t), MAX_TEXT))
                .filter(|t| !t.is_empty()),
        );
    }
    let flag = |k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
    if o.contains_key("hide_if_phone") {
        d.hide_if_phone = Some(flag("hide_if_phone"));
    }
    if o.contains_key("once_per_user") {
        d.once_per_user = Some(flag("once_per_user"));
    }
    if o.contains_key("mode") {
        match text_of(o, "mode") {
            Some(m @ ("test" | "live")) => d.mode = Some(m.to_owned()),
            _ => return Err(HttpError::bad_request("Chế độ phải là \"test\" hoặc \"live\"")),
        }
    }
    if o.contains_key("is_active") {
        d.is_active = Some(flag("is_active"));
    }
    if let Some(p) = o.get("position") {
        d.position = Some(int_i32(p).unwrap_or(0));
    }
    Ok(d)
}

fn not_found_rule() -> AppError {
    HttpError::not_found("Không tìm thấy luật").into()
}

async fn find_rule(conn: &mut PgConnection, id: i32) -> Result<FacebookCommentRule, AppError> {
    sqlx::query_as::<_, FacebookCommentRule>(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_COLS} FROM facebook_comment_rules WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(not_found_rule)
}

/// `GET /facebook/comment-rules` ⇒ `{ data }`.
pub async fn list_rules(conn: &mut PgConnection) -> Result<Vec<FacebookCommentRule>, AppError> {
    sqlx::query_as::<_, FacebookCommentRule>(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_COLS} FROM facebook_comment_rules ORDER BY \"position\" ASC, id ASC"
    )))
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /facebook/comment-rules` (201). `body` đã qua [`validate_rule_body`]. Mặc định chế độ thử.
pub async fn create_rule(
    conn: &mut PgConnection,
    body: &Map<String, Value>,
    user_id: i32,
) -> Result<FacebookCommentRule, AppError> {
    let d = sanitize_rule(body, true)?;
    sqlx::query_as::<_, FacebookCommentRule>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO facebook_comment_rules (name, page_id, post_id, keywords, exclude_keywords, public_replies, \
         private_reply, hide_if_phone, once_per_user, mode, is_active, \"position\", created_by, updated_at) \
         VALUES ($1, $2, $3, COALESCE($4::text[], ARRAY[]::text[]), COALESCE($5::text[], ARRAY[]::text[]), \
         COALESCE($6::text[], ARRAY[]::text[]), $7, COALESCE($8::bool, false), COALESCE($9::bool, true), \
         COALESCE($10::text, 'test'), COALESCE($11::bool, true), COALESCE($12::int, 0), $13, now()) \
         RETURNING {RULE_COLS}"
    )))
    .bind(d.name)
    .bind(d.page_id.flatten())
    .bind(d.post_id.flatten())
    .bind(d.keywords)
    .bind(d.exclude_keywords)
    .bind(d.public_replies)
    .bind(d.private_reply.flatten())
    .bind(d.hide_if_phone)
    .bind(d.once_per_user)
    .bind(d.mode)
    .bind(d.is_active)
    .bind(d.position)
    .bind(user_id)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /facebook/comment-rules/:id`: không thấy ⇒ 404 trước, rồi mới làm sạch (như `updateRule`).
pub async fn update_rule(
    conn: &mut PgConnection,
    id: i32,
    body: &Map<String, Value>,
) -> Result<FacebookCommentRule, AppError> {
    find_rule(&mut *conn, id).await?;
    let d = sanitize_rule(body, false)?;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE facebook_comment_rules SET updated_at = now()");
    if let Some(v) = d.name {
        qb.push(", name = ").push_bind(v);
    }
    if let Some(v) = d.page_id {
        qb.push(", page_id = ").push_bind(v);
    }
    if let Some(v) = d.post_id {
        qb.push(", post_id = ").push_bind(v);
    }
    if let Some(v) = d.keywords {
        qb.push(", keywords = ").push_bind(v);
    }
    if let Some(v) = d.exclude_keywords {
        qb.push(", exclude_keywords = ").push_bind(v);
    }
    if let Some(v) = d.public_replies {
        qb.push(", public_replies = ").push_bind(v);
    }
    if let Some(v) = d.private_reply {
        qb.push(", private_reply = ").push_bind(v);
    }
    if let Some(v) = d.hide_if_phone {
        qb.push(", hide_if_phone = ").push_bind(v);
    }
    if let Some(v) = d.once_per_user {
        qb.push(", once_per_user = ").push_bind(v);
    }
    if let Some(v) = d.mode {
        qb.push(", mode = ").push_bind(v);
    }
    if let Some(v) = d.is_active {
        qb.push(", is_active = ").push_bind(v);
    }
    if let Some(v) = d.position {
        qb.push(", \"position\" = ").push_bind(v);
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(format!(" RETURNING {RULE_COLS}"));
    qb.build_query_as::<FacebookCommentRule>()
        .fetch_one(conn)
        .await
        .map_err(db)
}

/// `DELETE /facebook/comment-rules/:id` (204): bình luận đã xử lý giữ nguyên (`rule_id` không có khoá ngoại).
pub async fn delete_rule(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    find_rule(&mut *conn, id).await?;
    sqlx::query("DELETE FROM facebook_comment_rules WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// `POST /facebook/comment-rules/dry-run`: so khớp với một bình luận mẫu, KHÔNG ghi và KHÔNG gửi gì. `post_id` chuẩn hoá ở đây như
/// controller (`dto.post_id ? normalizePostId(...) : null`).
pub async fn dry_run(conn: &mut PgConnection, input: &DryRunInput) -> Result<Value, AppError> {
    let post_id = match input.post_id.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => normalize_post_id(Some(p), input.page_id.as_deref())?,
        None => None,
    };
    let page: Option<String> = match input.page_id.as_deref().filter(|p| !p.is_empty()) {
        Some(pid) => sqlx::query_scalar("SELECT page_id FROM facebook_pages WHERE page_id = $1")
            .bind(pid)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?,
        None => sqlx::query_scalar("SELECT page_id FROM facebook_pages WHERE is_active ORDER BY id ASC LIMIT 1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?,
    };
    let page_id = page.or_else(|| input.page_id.clone()).unwrap_or_default();
    let message = utf16_prefix(&input.message, 5000);
    let phone = find_vn_phone(Some(message.as_str()));
    let rule = match_rule(conn, &page_id, post_id.as_deref().unwrap_or(""), Some(message.as_str())).await?;
    let actions = rule.as_ref().map_or_else(PlannedActions::default, |r| {
        plan(r, input.from_name.as_deref(), phone.as_deref(), rand_pick())
    });
    Ok(json!({
        "matched_rule": rule.as_ref().map(|r| json!({ "id": r.id, "name": r.name, "mode": r.mode })),
        "phone_found": phone,
        "actions": actions.to_json(),
    }))
}

// ───────────────────────── Danh sách và trả lời tay ─────────────────────────

/// Tham số `GET /facebook/comments` (`limit`, `status`, `unanswered` đều là chuỗi query).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListQuery {
    pub limit: i64,
    pub status: Option<String>,
    pub unanswered: bool,
}

impl ListQuery {
    /// `limit ? Number(limit) || 50 : 50`; `status || undefined`; `unanswered === '1' || 'true'`.
    pub fn from_params(limit: Option<&str>, status: Option<&str>, unanswered: Option<&str>) -> Self {
        let limit = limit
            .filter(|l| !l.is_empty())
            .and_then(|l| trim_js(l).parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n != 0.0)
            .map_or(50, |n| n.trunc() as i64);
        Self {
            limit,
            status: status.filter(|s| !s.is_empty()).map(str::to_owned),
            unanswered: matches!(unanswered, Some("1" | "true")),
        }
    }

    fn page_size(&self) -> i64 {
        self.limit.clamp(1, 100)
    }
}

fn comment_json(row: &FacebookComment, extra: Vec<(&str, Value)>) -> Result<Value, AppError> {
    let mut v = serde_json::to_value(row).map_err(AppError::internal)?;
    if let Some(o) = v.as_object_mut() {
        o.insert("id".to_owned(), Value::String(row.id.0.to_string()));
        for (k, x) in extra {
            o.insert(k.to_owned(), x);
        }
    }
    Ok(v)
}

/// `GET /facebook/comments` ⇒ `{ data }` (bình luận gần nhất và việc Trinity đã làm).
pub async fn list_comments(conn: &mut PgConnection, q: &ListQuery, now: DateTime<Utc>) -> Result<Vec<Value>, AppError> {
    // Lọc "chưa trả lời" nằm trong JSON `actions` ⇒ lấy rộng rồi lọc.
    let take = if q.unanswered { 300 } else { q.page_size() };
    let rows = sqlx::query_as::<_, FacebookComment>(sqlx::AssertSqlSafe(format!(
        "SELECT {COMMENT_COLS} FROM facebook_comments WHERE ($1::text IS NULL OR status = $1::text) \
         ORDER BY created_at DESC, id DESC LIMIT $2"
    )))
    .bind(q.status.as_deref())
    .bind(take)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut kept: Vec<(FacebookComment, PlannedActions)> = rows
        .into_iter()
        .map(|r| {
            let a = PlannedActions::from_json(&r.actions.0);
            (r, a)
        })
        .collect();
    if q.unanswered {
        kept.retain(|(r, a)| !comment_answered(&r.status, a));
        kept.truncate(usize::try_from(q.page_size()).unwrap_or(100));
    }
    let names: Vec<(String, String)> = sqlx::query_as("SELECT page_id, name FROM facebook_pages")
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let mut rule_ids: Vec<i32> = kept.iter().filter_map(|(r, _)| r.rule_id).collect();
    rule_ids.sort_unstable();
    rule_ids.dedup();
    let rule_names: Vec<(i32, String)> = if rule_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, name FROM facebook_comment_rules WHERE id = ANY($1)")
            .bind(&rule_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    let mut out = Vec::with_capacity(kept.len());
    for (r, a) in &kept {
        let page_name = names
            .iter()
            .find(|(p, _)| *p == r.page_id)
            .map_or_else(|| r.page_id.clone(), |(_, n)| n.clone());
        let rule_name = r
            .rule_id
            .and_then(|id| rule_names.iter().find(|(i, _)| *i == id))
            .map(|(_, n)| n.clone());
        let age_ms = now.timestamp_millis() - r.commented_at.0.timestamp_millis();
        out.push(comment_json(
            r,
            vec![
                ("answered", json!(comment_answered(&r.status, a))),
                (
                    "can_private_reply",
                    json!(!private_replied(a) && age_ms <= PRIVATE_REPLY_WINDOW_MS),
                ),
                ("page_name", json!(page_name)),
                ("rule_name", json!(rule_name)),
                ("post_url", json!(post_link(&r.post_id))),
            ],
        )?);
    }
    Ok(out)
}

/// Môi trường gọi của một công ty cho trả lời tay: nguồn env, client Graph (đã gắn `observer` của công ty), `ChannelGuard`.
pub struct CommentCtx<'a> {
    /// Kết nối chỉ được giữ trong từng bước đọc/ghi DB, KHÔNG giữ khi gọi Graph.
    pub db: &'a Db,
    pub env: &'a Env,
    pub graph: &'a GraphClient,
    pub guard: Option<&'a ChannelGuard>,
    pub company: CompanyRef,
}

async fn acquire(ctx: &CommentCtx<'_>) -> Result<trinity_db::TenantConn, AppError> {
    ctx.db
        .tenant(ctx.company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

/// `POST /facebook/comments/:id/reply` (201): nhân viên trả lời tay. `public` = công khai dưới bình luận; `private` = nhắn riêng qua
/// Messenger (Facebook chỉ cho một lần mỗi bình luận, trong 7 ngày).
pub async fn reply_manually(
    ctx: &CommentCtx<'_>,
    id: &str,
    input: &CommentReply,
    actor_user_id: Option<i32>,
    now: DateTime<Utc>,
) -> Result<Value, AppError> {
    let text = trim_js(&input.text);
    if text.is_empty() {
        return Err(HttpError::bad_request("Nội dung trả lời trống").into());
    }
    if len16(text) > MAX_TEXT {
        return Err(HttpError::bad_request(format!("Trả lời tối đa {MAX_TEXT} ký tự")).into());
    }
    if input.mode != "public" && input.mode != "private" {
        return Err(HttpError::bad_request("Cách trả lời phải là public hoặc private").into());
    }
    let not_found = || AppError::from(HttpError::not_found("Không tìm thấy bình luận"));
    let row_id: i64 = if id.len() <= 19 && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
        id.parse().map_err(|_| not_found())?
    } else {
        return Err(not_found());
    };
    let c = sqlx::query_as::<_, FacebookComment>(sqlx::AssertSqlSafe(format!(
        "SELECT {COMMENT_COLS} FROM facebook_comments WHERE id = $1"
    )))
    .bind(row_id)
    .fetch_optional(&mut *acquire(ctx).await?)
    .await
    .map_err(db)?
    .ok_or_else(not_found)?;
    if input.mode == "private" {
        if private_replied(&PlannedActions::from_json(&c.actions.0)) {
            return Err(HttpError::bad_request(
                "Đã nhắn riêng cho bình luận này rồi — Facebook chỉ cho nhắn riêng một lần mỗi bình luận. \
                 Tiếp tục trong hộp thư Messenger.",
            )
            .into());
        }
        if now.timestamp_millis() - c.commented_at.0.timestamp_millis() > PRIVATE_REPLY_WINDOW_MS {
            return Err(HttpError::bad_request(
                "Bình luận đã quá 7 ngày — Facebook không cho nhắn riêng nữa. Hãy trả lời công khai.",
            )
            .into());
        }
    }
    if let Some(g) = ctx.guard {
        g.assert_outbound(ctx.company, OutboundMode::Manual, OutboundScope::Meta)
            .await?;
    }
    let found = {
        let mut conn = acquire(ctx).await?;
        pages::active_page_with_token(&mut conn, ctx.env, &c.page_id).await?
    };
    let Some((_, token)) = found else {
        return Err(HttpError::bad_request("Fanpage chưa kết nối hoặc đã tắt").into());
    };
    let public = input.mode == "public";
    let mut psid: Option<String> = None;
    let sent = if public {
        ctx.graph.reply_to_comment(&token, &c.comment_id, text).await
    } else {
        ctx.graph
            .private_reply(&token, &c.page_id, &c.comment_id, text)
            .await
            .map(|r| {
                psid = r.recipient_id;
                r.message_id
            })
    };
    let reply_id = match sent {
        Ok(id) => id,
        Err(e) => {
            let what = if public {
                "trả lời bình luận"
            } else {
                "nhắn riêng"
            };
            let msg = explain_graph(ctx.db, ctx.company, &e, &c.page_id, what).await;
            return Err(HttpError::bad_request(msg).into());
        }
    };
    // Ghi kết quả: đọc lại `actions` dưới khoá hàng để hai người trả lời cùng lúc không ghi đè nhau.
    let mut tx = ctx
        .db
        .tenant(ctx.company)
        .await
        .map_err(platform_db)?
        .begin()
        .await
        .map_err(platform_db)?;
    let prev_text: String = sqlx::query_scalar("SELECT actions::text FROM facebook_comments WHERE id = $1 FOR UPDATE")
        .bind(c.id.0)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let prev = serde_json::from_str::<Value>(&prev_text).unwrap_or(Value::Null);
    let mut actions = PlannedActions::from_json(&prev);
    let mut manual = actions.manual.take().unwrap_or_default();
    manual.push(ManualReply {
        mode: input.mode.clone(),
        text: text.to_owned(),
        id: reply_id.clone(),
        by: actor_user_id,
        at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    actions.manual = Some(manual);
    let row = sqlx::query_as::<_, FacebookComment>(sqlx::AssertSqlSafe(format!(
        "UPDATE facebook_comments SET actions = $2::text::jsonb, \
         status = CASE WHEN status IN ('received', 'test', 'failed') THEN 'replied' ELSE status END, \
         note = CASE WHEN status IN ('received', 'test', 'failed') THEN NULL ELSE note END \
         WHERE id = $1 RETURNING {COMMENT_COLS}"
    )))
    .bind(c.id.0)
    .bind(trinity_kernel::json::js_json(&actions.to_json()))
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if let Some(p) = &psid
        && sp_begin(&mut tx, "fb_c_conv").await
    {
        let r = remember_conversation(&mut tx, &c.page_id, p, &reply_id, text, c.contact_id).await;
        sp_end(&mut tx, "fb_c_conv", r.is_ok()).await;
        if let Err(e) = r {
            tracing::warn!("Lưu hội thoại sau nhắn riêng lỗi: {e}");
        }
    }
    tx.commit().await.map_err(platform_db)?;
    comment_json(&row, vec![("answered", json!(true))])
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinity_db::types::{PgList, Timestamp};

    fn rule(replies: &[&str], private: Option<&str>, hide: bool) -> FacebookCommentRule {
        let list = |v: &[&str]| PgList(v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        FacebookCommentRule {
            id: 1,
            name: "Luật 1".to_owned(),
            page_id: None,
            post_id: None,
            keywords: list(&[]),
            exclude_keywords: list(&[]),
            public_replies: list(replies),
            private_reply: private.map(str::to_owned),
            hide_if_phone: hide,
            once_per_user: true,
            mode: "live".to_owned(),
            is_active: true,
            position: 0,
            created_by: 1,
            created_at: Timestamp(Utc::now()),
            updated_at: Timestamp(Utc::now()),
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn chuan_hoa_va_khop_tu_khoa() {
        assert_eq!(normalize_vi("  Giá   ĐẸP  "), "gia dep");
        assert!(matches_keywords(Some("Cho em xin GIÁ nhé"), &s(&["giá"]), &[]));
        assert!(matches_keywords(Some("bất kỳ"), &[], &[]));
        assert!(
            matches_keywords(Some("bất kỳ"), &s(&["  "]), &[]),
            "từ khoá rỗng = mọi bình luận"
        );
        assert!(!matches_keywords(Some("xin giá"), &s(&["giá"]), &s(&["xin"])));
        assert!(!matches_keywords(Some("hello"), &s(&["giá"]), &[]));
        assert!(!matches_keywords(None, &s(&["giá"]), &[]));
    }

    #[test]
    fn thay_ten_trong_mau() {
        assert_eq!(fill_template("Chào {ten}!", Some(" Lan ")), "Chào Lan!");
        assert_eq!(fill_template("Chào { TEN }", None), "Chào bạn");
        assert_eq!(fill_template("Chào {ten}", Some("$1 $&")), "Chào $1 $&");
        assert_eq!(fill_template("Chào {ten}", Some("  ")), "Chào bạn");
    }

    #[test]
    fn lam_sach_danh_sach() {
        assert_eq!(clean_list(&s(&[" a ", "", "a", "b", "  "])), s(&["a", "b"]));
        let many: Vec<String> = (0..40).map(|i| format!("k{i}")).collect();
        assert_eq!(clean_list(&many).len(), 30);
    }

    #[test]
    fn chuan_hoa_bai() {
        let ok = |raw: &str, page: Option<&str>| normalize_post_id(Some(raw), page).unwrap();
        assert_eq!(ok("", None), None);
        assert_eq!(ok("  ", Some("1")), None);
        assert_eq!(ok("123456_789012", None).as_deref(), Some("123456_789012"));
        assert_eq!(
            ok("https://www.facebook.com/123456_789012", None).as_deref(),
            Some("123456_789012")
        );
        assert_eq!(
            ok("https://facebook.com/shop/posts/555555?x=1", Some("999999")).as_deref(),
            Some("999999_555555")
        );
        assert_eq!(ok("77777", Some("999999")).as_deref(), Some("999999_77777"));
        assert_eq!(
            ok("https://facebook.com/x?story_fbid=444444&id=1", Some("9")).as_deref(),
            Some("9_444444")
        );
        for bad in ["https://facebook.com/shop/posts/pfbid0abc", "77777", "abc"] {
            assert!(normalize_post_id(Some(bad), None).is_err(), "{bad}");
        }
    }

    #[test]
    fn doc_thoi_gian() {
        let t = |v: Value| to_date(Some(&v)).timestamp();
        assert_eq!(t(json!(1_700_000_000)), 1_700_000_000);
        assert_eq!(t(json!(1_700_000_000_000_i64)), 1_700_000_000);
        assert_eq!(t(json!("1700000000")), 1_700_000_000);
        assert_eq!(t(json!("2023-11-14T22:13:20+0000")), 1_700_000_000);
        assert_eq!(t(json!("2023-11-14T22:13:20Z")), 1_700_000_000);
        let now = Utc::now().timestamp();
        assert!((to_date(None).timestamp() - now).abs() < 5);
        assert!((t(json!("rác")) - now).abs() < 5);
    }

    #[test]
    fn ke_hoach_cua_luat() {
        let a = plan(
            &rule(&["a {ten}", "b"], Some("riêng {ten}"), true),
            Some("Lan"),
            Some("0912345678"),
            3,
        );
        assert_eq!(a.public_reply.as_ref().map(|p| p.text.as_str()), Some("b"));
        assert_eq!(a.private_reply.as_ref().map(|p| p.text.as_str()), Some("riêng Lan"));
        assert!(a.hide.is_some());
        let b = plan(&rule(&[], Some("  "), true), None, None, 0);
        assert_eq!(b, PlannedActions::default());
    }

    #[test]
    fn da_tra_loi_va_nhan_rieng() {
        let none = PlannedActions::default();
        assert!(!comment_answered("received", &none));
        assert!(comment_answered("skipped", &none));
        let public = PlannedActions {
            public_reply: Some(PublicReply {
                id: Some("c1".into()),
                ..PublicReply::default()
            }),
            ..PlannedActions::default()
        };
        assert!(comment_answered("done", &public));
        assert!(!private_replied(&public));
        let empty_id = PlannedActions {
            public_reply: Some(PublicReply {
                id: Some(String::new()),
                ..PublicReply::default()
            }),
            ..PlannedActions::default()
        };
        assert!(!comment_answered("done", &empty_id), "id rỗng là falsy như JS");
        let manual = PlannedActions {
            manual: Some(vec![ManualReply {
                mode: "private".into(),
                ..ManualReply::default()
            }]),
            ..PlannedActions::default()
        };
        assert!(private_replied(&manual) && comment_answered("received", &manual));
    }

    #[test]
    fn actions_json_khong_thua_khoa() {
        let a = PlannedActions {
            hide: Some(HideResult {
                done: Some(true),
                error: None,
            }),
            ..PlannedActions::default()
        };
        assert_eq!(a.to_json(), json!({ "hide": { "done": true } }));
        assert_eq!(PlannedActions::from_json(&json!({ "hide": { "done": true } })), a);
        assert_eq!(PlannedActions::from_json(&json!("rác")), PlannedActions::default());
    }

    #[test]
    fn dong_ket_qua_luat() {
        let mut a = PlannedActions {
            public_reply: Some(PublicReply {
                id: Some("1".into()),
                ..PublicReply::default()
            }),
            private_reply: Some(PrivateReply {
                error: Some("lỗi".into()),
                ..PrivateReply::default()
            }),
            ..PlannedActions::default()
        };
        assert_eq!(
            auto_result_line(Some("R"), "done", &a).as_deref(),
            Some("Luật \"R\": đã trả lời công khai (1 việc lỗi)")
        );
        a.public_reply = None;
        assert_eq!(
            auto_result_line(Some("R"), "failed", &a).as_deref(),
            Some("Luật \"R\": chưa làm được (1 việc lỗi)")
        );
        assert_eq!(
            auto_result_line(Some("R"), "test", &a).as_deref(),
            Some("Luật \"R\" (chạy thử)")
        );
        assert_eq!(auto_result_line(None, "done", &a), None);
    }

    #[test]
    fn noi_dung_chuong_binh_luan() {
        let auto = "Luật \"R\": đã nhắn riêng";
        let (t, b) = comment_notice("Quán A", Some(" Lan "), Some("  giá  bao\n nhiêu "), Some(auto), true);
        assert_eq!(t, "Bình luận mới trên Quán A");
        assert_eq!(b, "Lan: giá bao nhiêu · Luật \"R\": đã nhắn riêng · đã tạo khách mới");
        assert_eq!(comment_notice("P", None, None, None, false).1, "Khách: [không có chữ]");
    }

    #[test]
    fn ten_tam_theo_4_ky_tu_cuoi() {
        assert_eq!(placeholder_name(Some("1234567890")), "Khách bình luận 7890");
        assert_eq!(placeholder_name(None), "Khách bình luận");
    }

    #[test]
    fn kiem_body_luat_nhu_class_validator() {
        let ok = validate_rule_body(&json!({ "name": "x", "keywords": ["a"], "mode": "live", "position": 3 }));
        assert!(ok.is_ok());
        let bad = |v: Value| validate_rule_body(&v).is_err();
        assert!(bad(json!({ "mode": "x" })));
        assert!(bad(json!({ "position": 2_147_483_648_i64 })), "ngoài int4 ⇒ 400");
        assert!(bad(json!({ "position": 1.5 })));
        assert!(bad(json!({ "keywords": "a" })));
        assert!(bad(json!({ "public_replies": vec!["x"; 11] })));
        assert!(bad(json!({ "hide_if_phone": "yes" })));
        assert!(bad(json!({ "name": "n".repeat(121) })));
        assert!(validate_rule_body(&json!({ "name": null, "page_id": null, "mode": null })).is_ok());
        assert!(validate_rule_body(&json!([1])).is_err());
    }

    #[test]
    fn lam_sach_luat() {
        let m = |v: Value| validate_rule_body(&v).unwrap();
        // Tạo: thiếu tên ⇒ 400; null trên cờ Boolean thành false.
        assert!(sanitize_rule(&m(json!({})), true).is_err());
        let d = sanitize_rule(
            &m(json!({ "name": " Tên ", "once_per_user": null, "mode": "live" })),
            true,
        )
        .unwrap();
        assert_eq!(d.name.as_deref(), Some("Tên"));
        assert_eq!(d.once_per_user, Some(false));
        assert_eq!(d.mode.as_deref(), Some("live"));
        assert_eq!(d.page_id, None);
        // Sửa: name null ⇒ 400 (như `(null ?? '').trim()`); mode null ⇒ 400.
        assert!(sanitize_rule(&m(json!({ "name": null })), false).is_err());
        assert!(sanitize_rule(&m(json!({ "mode": null })), false).is_err());
        let body = m(json!({ "page_id": " 123456 ", "post_id": "99999", "position": null }));
        let d = sanitize_rule(&body, false).unwrap();
        assert_eq!(d.page_id, Some(Some("123456".to_owned())));
        assert_eq!(d.post_id, Some(Some("123456_99999".to_owned())));
        assert_eq!(d.position, Some(0));
        // Chỉ có post_id số mà không có Page ⇒ 400.
        assert!(sanitize_rule(&m(json!({ "post_id": "99999" })), false).is_err());
        let d = sanitize_rule(&m(json!({ "private_reply": "   ", "keywords": null })), false).unwrap();
        assert_eq!(d.private_reply, Some(None));
        assert_eq!(d.keywords, Some(Vec::new()));
    }

    #[test]
    fn kiem_body_tra_loi_va_thu_luat() {
        let r = CommentReply::from_json(&json!({ "text": "ok", "mode": "private" })).unwrap();
        assert_eq!((r.text.as_str(), r.mode.as_str()), ("ok", "private"));
        assert!(CommentReply::from_json(&json!({ "text": "", "mode": "public" })).is_err());
        assert!(CommentReply::from_json(&json!({ "text": "x", "mode": "other" })).is_err());
        assert!(CommentReply::from_json(&json!({ "text": "x".repeat(2001), "mode": "public" })).is_err());
        assert!(CommentReply::from_json(&json!({ "mode": "public" })).is_err());
        let d = DryRunInput::from_json(&json!({ "message": "xin giá", "page_id": null })).unwrap();
        assert_eq!((d.message.as_str(), d.page_id), ("xin giá", None));
        assert!(DryRunInput::from_json(&json!({ "message": "" })).is_err());
        assert!(DryRunInput::from_json(&json!({})).is_err());
    }

    #[test]
    fn tham_so_danh_sach() {
        let q = ListQuery::from_params(None, None, None);
        assert_eq!((q.limit, q.page_size(), q.unanswered), (50, 50, false));
        assert_eq!(ListQuery::from_params(Some("abc"), None, None).limit, 50);
        assert_eq!(ListQuery::from_params(Some("0"), None, None).limit, 50);
        assert_eq!(ListQuery::from_params(Some("500"), None, None).page_size(), 100);
        assert_eq!(ListQuery::from_params(Some("-3"), None, None).page_size(), 1);
        let q = ListQuery::from_params(Some("20"), Some("done"), Some("true"));
        assert_eq!((q.limit, q.status.as_deref(), q.unanswered), (20, Some("done"), true));
        assert!(!ListQuery::from_params(None, Some(""), Some("0")).unanswered);
    }
}
