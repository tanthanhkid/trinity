//! Tool Fanpage (M44b), 15 tool (+ `get_page_admin_guide`, soạn hướng dẫn cho quản trị viên Page, chỉ đọc): bình luận (`list_facebook_comments`, `list_facebook_comment_rules`, `create_comment_rule`,
//! `update_comment_rule`, `test_comment_rule`), link chat (`list_chat_links`, `create_chat_link`), kịch bản nhắn tin
//! (`list_message_flows`, `create_message_flow`, `update_message_flow`), gửi hàng loạt (`list_messenger_broadcasts`,
//! `send_messenger_broadcast`, `update_messenger_broadcast`) và huỷ (`cancel_messenger_broadcast`, `cancel_scheduled_post`).
//! Không có tool xoá. Tên, mô tả và schema nằm ở hợp đồng đóng băng; ở đây chỉ có scope, quyền và thân chạy, port từ
//! `services/crm/src/integrations/mcp/tools/{facebook-*-tools,cancel-tools}.ts`.
//!
//! Dịch vụ nghiệp vụ của M49 (bình luận), M50 (link chat, kịch bản), M51 (gửi hàng loạt) và bài hẹn giờ (M54a) CHƯA có trên
//! `main`, nên tool chỉ phụ thuộc các trait "port" bên dưới ([`FanpagePorts`]); mỗi crate nghiệp vụ cài trait của mình rồi nối vào
//! [`register_fanpage`] ở `trinity-bin`. Port vắng ⇒ tool trả "Máy chủ này chưa có tính năng …" như bản Node (`deps.x` rỗng).
//! Quy ước của port: lỗi nghiệp vụ 400/404 (`BadRequestException`/`NotFoundException`) trả `ToolError::User` kèm câu nguyên văn.
//!
//! Hành động ra ngoài (luật chạy thật, gửi/sửa tin hàng loạt, huỷ) cần `confirmed_by_user`; thiếu ⇒ không làm gì, trả bản xem
//! trước (gửi hàng loạt: `preview.eligible` = số người nhận, `outside_window` = số khách quá 24 giờ). Chưa chạy được test ở máy này
//! (không biên dịch): xem `NHANH-MAC.txt`.

use std::sync::Arc;

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::{Map, Value, json};
use trinity_db::CompanyRef;
use trinity_kernel::vi::fold_vi;

use super::wrapped;
use crate::ai_output::slice16;
use crate::args::{clamp_limit, opt_int, s};
use crate::deps::{ToolDeps, app_err};
use crate::exec::{ToolCtx, ToolError, ToolOutput, ToolRegistry, ToolRunner, ToolSpec};
use crate::protocol::BoxFuture;

type PortFut<'a, T> = BoxFuture<'a, Result<T, ToolError>>;

const FEATURE_FANPAGE: &str = "facebook_page";
const FEATURE_SOCIAL: &str = "social_posting";
const MAX_TEXT: usize = 2000;
const MAX_WORDS: usize = 30;

// ------------------------------------------------------------------ port

/// Một Fanpage đã kết nối (đọc từ `facebook_pages`; `mod_facebook::pages::list` đủ để cài).
#[derive(Debug, Clone)]
pub struct PageRef {
    pub page_id: String,
    pub name: String,
    pub is_active: bool,
}

pub trait PagesPort: Send + Sync {
    fn pages(&self, company: CompanyRef) -> PortFut<'_, Vec<PageRef>>;
}

/// Truy vấn bình luận: `limit` tối đa 100, `since` = đầu khoảng ngày.
#[derive(Debug, Clone)]
pub struct CommentQuery {
    pub limit: i64,
    pub status: Option<String>,
    pub since: DateTime<Utc>,
}

/// Dịch vụ bình luận tự động (M49). Mọi "hàng" là JSON đúng tên trường của bản Node (`CommentRow`, `CommentRuleView`).
pub trait CommentsPort: Send + Sync {
    /// Hàng có `page_name, post_id, from_name, message, commented_at, created_at (RFC 3339), status, rule_name, actions, note,
    /// hidden, contact_id`.
    fn list_comments(&self, company: CompanyRef, q: CommentQuery) -> PortFut<'_, Vec<Value>>;
    /// Luật có `id, name, page_id, post_id, keywords, exclude_keywords, public_replies, private_reply, hide_if_phone,
    /// once_per_user, mode, is_active, position`.
    fn list_rules(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>>;
    /// `input` chỉ chứa khoá được gửi (`name, page_id, post_id, keywords, exclude_keywords, public_replies, private_reply,
    /// hide_if_phone, once_per_user, mode, is_active, position`).
    fn create_rule(&self, company: CompanyRef, user_id: i32, input: Map<String, Value>) -> PortFut<'_, Value>;
    fn update_rule(&self, company: CompanyRef, id: i32, input: Map<String, Value>) -> PortFut<'_, Value>;
    /// `{ message, page_id, post_id, from_name }` ⇒ `{ matched_rule, … }`; không ghi, không gửi gì.
    fn dry_run(&self, company: CompanyRef, input: Value) -> PortFut<'_, Value>;
    /// Link `.../posts/<số>` hoặc `<page>_<post>` ⇒ id `<page>_<post>`; link hỏng ⇒ `ToolError::User`.
    fn normalize_post_id(&self, raw: &str, page_id: Option<&str>) -> Result<Option<String>, ToolError>;
}

/// Link/QR mở chat (M50): hàng có `id, name, page_name, page_id, url, messenger_url, source_label, is_active, clicks, chats`.
pub trait ChatLinksPort: Send + Sync {
    fn list(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>>;
    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> PortFut<'_, Value>;
}

/// Kịch bản nhắn tin (M50): hàng có `id, name, page_name, page_id, trigger, keywords, chat_link_id, chat_link_name, is_active,
/// steps, starts, completes, running`.
pub trait FlowsPort: Send + Sync {
    fn list(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>>;
    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> PortFut<'_, Value>;
    fn update(&self, company: CompanyRef, id: i32, input: Map<String, Value>) -> PortFut<'_, Value>;
}

/// Gửi hàng loạt (M51). Lượt (`BroadcastView`) có `id, name, page_id, page_name, text, status, scheduled_at (RFC 3339 | null),
/// total, sent, failed, skipped, audience`.
pub trait BroadcastsPort: Send + Sync {
    fn list(&self, company: CompanyRef, limit: i64) -> PortFut<'_, Vec<Value>>;
    /// Người nhận của lượt (`status`, `note`), tối đa `limit`.
    fn recipients(&self, company: CompanyRef, id: i32, limit: i64) -> PortFut<'_, Vec<Value>>;
    fn get(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value>;
    /// Kiểm tên/nội dung/Fanpage; `partial` = sửa (trường vắng được bỏ qua).
    fn validate(&self, company: CompanyRef, input: &Value, partial: bool) -> PortFut<'_, ()>;
    /// Hẹn quá 7 ngày ⇒ `ToolError::User`. Bỏ trống/đã qua = gửi ngay.
    fn check_send_time(&self, at: Option<DateTime<Utc>>) -> Result<(), ToolError>;
    /// `{ eligible, outside_window, sample }` (chỉ đếm; không ghi, không gửi).
    fn preview<'a>(&'a self, company: CompanyRef, page_id: &'a str, audience: &'a Value) -> PortFut<'a, Value>;
    /// Tạo lượt nháp; `source` = `"mcp"`.
    fn create<'a>(&'a self, company: CompanyRef, user_id: i32, input: &'a Value, source: &'a str)
    -> PortFut<'a, Value>;
    fn update(&self, company: CompanyRef, id: i32, input: Map<String, Value>) -> PortFut<'_, Value>;
    /// Gửi ngay (`None`) hoặc hẹn giờ.
    fn send(&self, company: CompanyRef, id: i32, at: Option<DateTime<Utc>>) -> PortFut<'_, Value>;
    /// Đánh thức job gửi (bỏ qua chu kỳ một phút).
    fn kick(&self);
    /// `scheduled ⇒ cancelled`, có điều kiện trạng thái.
    fn cancel_pending(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value>;
}

/// Hướng dẫn nối lại Fanpage cho quản trị viên Page: chỉ soạn văn bản (không gửi, không ghi). `page_id` là id của Facebook.
/// Trả `{ page_id, page_name, recipient, steps, permissions, manage_url, text, sent: false }`; Page lạ ⇒ `ToolError::User`.
pub trait AdminGuidePort: Send + Sync {
    fn compose<'a>(
        &'a self,
        company: CompanyRef,
        page_id: &'a str,
        recipient: Option<String>,
        note: Option<String>,
    ) -> PortFut<'a, Value>;
}

/// Bài đăng đa kênh hẹn giờ (M54a): bài có `id, status, content, scheduled_at, targets: [{ status, account_id, account_name }]`.
pub trait ScheduledPostsPort: Send + Sync {
    fn get(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value>;
    fn cancel(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value>;
}

/// Các dịch vụ mà tool Fanpage cần; trường `None` ⇒ tính năng chưa có trên máy chủ này.
#[derive(Default, Clone)]
pub struct FanpagePorts {
    pub pages: Option<Arc<dyn PagesPort>>,
    pub comments: Option<Arc<dyn CommentsPort>>,
    pub chat_links: Option<Arc<dyn ChatLinksPort>>,
    pub flows: Option<Arc<dyn FlowsPort>>,
    pub broadcasts: Option<Arc<dyn BroadcastsPort>>,
    pub posts: Option<Arc<dyn ScheduledPostsPort>>,
    pub admin_guide: Option<Arc<dyn AdminGuidePort>>,
}

/// Ngữ cảnh chạy của thân tool (không cần DB: test gọi thẳng với port giả).
pub struct Env<'a> {
    pub company: CompanyRef,
    pub user_id: i32,
    pub base_url: &'a str,
    pub now: DateTime<Utc>,
}

// ------------------------------------------------------------------ đăng ký

type RunFn = for<'a> fn(&'a FanpagePorts, &'a Value, &'a Env<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;

struct Tool {
    ports: Arc<FanpagePorts>,
    feature: &'static str,
    run: RunFn,
}

impl ToolRunner for Tool {
    fn run<'a>(&'a self, args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            // Cổng tính năng của công ty (`orgFeatures.isEnabled`).
            feature_on(ctx.deps, ctx.principal, self.feature).await?;
            let env = Env {
                company: ctx.principal.company,
                user_id: ctx.principal.user_id,
                base_url: ctx.base_url,
                now: Utc::now(),
            };
            (self.run)(&self.ports, args, &env).await
        })
    }
}

async fn feature_on(deps: &ToolDeps, p: &crate::auth::Principal, key: &str) -> Result<(), ToolError> {
    let settings = deps.settings_ctx(p);
    let mut conn = deps.conn(p.company).await?;
    let f = mod_settings::features::get(&mut conn, settings)
        .await
        .map_err(app_err)?;
    if f.0.iter().any(|(k, v)| *k == key && *v == Some(false)) {
        return Err(ToolError::User(
            if key == FEATURE_SOCIAL {
                "Tính năng \"Đăng đa kênh\" đang tắt (Cài đặt › Tính năng). / Social posting is turned off for this workspace."
            } else {
                "Tính năng \"Fanpage Facebook\" đang tắt (Cài đặt › Tính năng). / The Facebook Page feature is turned off for this workspace."
            }
            .into(),
        ));
    }
    Ok(())
}

fn reg(
    r: &mut ToolRegistry,
    ports: &Arc<FanpagePorts>,
    name: &'static str,
    write: bool,
    permissions: &'static [&'static str],
    run: RunFn,
) {
    r.register(ToolSpec {
        name,
        scope: write.then_some("crm.write"),
        permissions,
        runner: Arc::new(Tool {
            ports: ports.clone(),
            feature: if name == "cancel_scheduled_post" {
                FEATURE_SOCIAL
            } else {
                FEATURE_FANPAGE
            },
            run,
        }),
    });
}

/// Đăng ký 16 tool Fanpage vào `r` (mỗi tool một dòng riêng, không đụng nhóm khác).
pub fn register_fanpage(r: &mut ToolRegistry, ports: Arc<FanpagePorts>) {
    const WEBHOOKS: &[&str] = &["integrations.webhooks"];
    let p = &ports;
    reg(r, p, "list_facebook_comments", false, WEBHOOKS, list_facebook_comments);
    reg(
        r,
        p,
        "list_facebook_comment_rules",
        false,
        WEBHOOKS,
        list_facebook_comment_rules,
    );
    reg(r, p, "create_comment_rule", true, WEBHOOKS, create_comment_rule);
    reg(r, p, "update_comment_rule", true, WEBHOOKS, update_comment_rule);
    reg(r, p, "test_comment_rule", false, WEBHOOKS, test_comment_rule);
    reg(r, p, "list_chat_links", false, WEBHOOKS, list_chat_links);
    reg(r, p, "create_chat_link", true, WEBHOOKS, create_chat_link);
    reg(r, p, "get_page_admin_guide", false, WEBHOOKS, get_page_admin_guide);
    reg(r, p, "list_message_flows", false, WEBHOOKS, list_message_flows);
    reg(r, p, "create_message_flow", true, WEBHOOKS, create_message_flow);
    reg(r, p, "update_message_flow", true, WEBHOOKS, update_message_flow);
    reg(
        r,
        p,
        "list_messenger_broadcasts",
        false,
        WEBHOOKS,
        list_messenger_broadcasts,
    );
    reg(
        r,
        p,
        "send_messenger_broadcast",
        true,
        WEBHOOKS,
        send_messenger_broadcast,
    );
    reg(
        r,
        p,
        "update_messenger_broadcast",
        true,
        WEBHOOKS,
        update_messenger_broadcast,
    );
    reg(
        r,
        p,
        "cancel_messenger_broadcast",
        true,
        WEBHOOKS,
        cancel_messenger_broadcast,
    );
    reg(
        r,
        p,
        "cancel_scheduled_post",
        true,
        &["social.post"],
        cancel_scheduled_post,
    );
}

// ------------------------------------------------------------------ hàm dùng chung

fn user(msg: &str) -> ToolError {
    ToolError::User(msg.to_owned())
}

fn missing(vi: &str, en: &str) -> ToolError {
    ToolError::User(format!("{vi} / {en}"))
}

/// Cụm từ (đã bỏ dấu) là lời đồng ý.
const YES: &[&str] = &[
    "ok",
    "oke",
    "okie",
    "okay",
    "dong y",
    "duoc",
    "dc",
    "chot",
    "u",
    "uh",
    "um",
    "uk",
    "yes",
    "y",
    "dung roi",
    "dung vay",
    "chuan",
    "chuan roi",
    "lam di",
    "tao di",
    "lam luon",
    "tao luon",
    "lam vay",
    "nhu vay",
    "xac nhan",
    "duyet",
    "go",
    "on",
    "oki",
    "vang",
    "da",
    "khoi hoi lai",
    "khoi hoi",
    "dung hoi lai",
    "tao ngay",
    "lam ngay",
];
/// Cụm từ phủ định / còn đổi ý.
const NO: &[&str] = &[
    "khong", "ko", "k", "chua", "dung tao", "dung lam", "khoan", "doi", "sua lai", "them", "bot", "bo", "thay", "no",
    "not",
];
const NO_ASK: &[&str] = &["khong can hoi lai", "khong can hoi", "ko can hoi lai", "ko can hoi"];
const BENIGN: &[&str] = &[
    "khong can them gi",
    "khong can them",
    "khong can sua",
    "khong can",
    "khong sao",
    "khong van de",
    "khong co gi",
];

/// `foldVi` của `view-config.ts`: NFD bỏ dấu, `đ` → `d`, chữ thường, mọi ký tự ngoài `[a-z0-9]` thành một khoảng trắng.
fn fold_words(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in fold_vi(s).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

/// Lời người dùng có phải là lời đồng ý (không kèm phủ định / yêu cầu đổi) không (`isUserConfirmation`).
pub fn is_user_confirmation(words: Option<&Value>) -> bool {
    let raw = words.and_then(Value::as_str).unwrap_or("");
    let mut w = format!(" {} ", fold_words(raw));
    if w.trim().is_empty() {
        return false;
    }
    for a in NO_ASK {
        w = w.replace(&format!(" {a} "), " khoi hoi lai ");
    }
    for b in BENIGN {
        w = w.replace(&format!(" {b} "), " ");
    }
    if NO.iter().any(|k| w.contains(&format!(" {k} "))) {
        return false;
    }
    YES.iter().any(|k| w.contains(&format!(" {k} ")))
}

fn vn_dt(d: DateTime<Utc>) -> chrono::DateTime<chrono::FixedOffset> {
    d.with_timezone(&chrono::FixedOffset::east_opt(7 * 3600).expect("+07:00 hợp lệ"))
}

/// `2026-10-12T18:26:05+07:00`; vắng/sai ⇒ `None` (`vnIso`).
pub fn vn_iso(v: Option<&Value>) -> Option<String> {
    let t = DateTime::parse_from_rfc3339(v?.as_str()?).ok()?;
    Some(
        vn_dt(t.with_timezone(&Utc))
            .format("%Y-%m-%dT%H:%M:%S+07:00")
            .to_string(),
    )
}

const WEEKDAYS: [&str; 7] = [
    "Chủ nhật",
    "Thứ Hai",
    "Thứ Ba",
    "Thứ Tư",
    "Thứ Năm",
    "Thứ Sáu",
    "Thứ Bảy",
];

/// `09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)` (`vnWhen`).
pub fn vn_when(d: DateTime<Utc>) -> String {
    let t = vn_dt(d);
    let wd = WEEKDAYS[usize::try_from(t.weekday().num_days_from_sunday()).unwrap_or(0)];
    format!("{} {wd} {} (giờ Việt Nam)", t.format("%H:%M"), t.format("%d/%m/%Y"))
}

fn vn_when_str(v: Option<&Value>) -> Option<String> {
    let t = DateTime::parse_from_rfc3339(v?.as_str()?).ok()?;
    Some(vn_when(t.with_timezone(&Utc)))
}

/// `scheduled_at` giờ Việt Nam `YYYY-MM-DDTHH:mm` (hoặc có múi giờ) ⇒ UTC; vắng ⇒ `None` (`parseScheduledAt`).
pub fn parse_scheduled_at(raw: Option<&Value>) -> Result<Option<DateTime<Utc>>, ToolError> {
    let Some(text) = raw.and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let v = text.replacen(' ', "T", 1);
    let parsed = DateTime::parse_from_rfc3339(&v)
        .map(|t| t.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            DateTime::parse_from_str(&v, "%Y-%m-%dT%H:%M%:z")
                .map(|t| t.with_timezone(&Utc))
                .ok()
        })
        .or_else(|| {
            v.strip_suffix(['Z', 'z'])
                .and_then(|x| NaiveDateTime::parse_from_str(x, "%Y-%m-%dT%H:%M").ok())
                .map(|n| n.and_utc())
        })
        .or_else(|| {
            ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"]
                .iter()
                .find_map(|f| NaiveDateTime::parse_from_str(&v, f).ok())
                .and_then(|n| {
                    chrono::FixedOffset::east_opt(7 * 3600)?
                        .from_local_datetime(&n)
                        .single()
                        .map(|t| t.with_timezone(&Utc))
                })
        });
    parsed.map(Some).ok_or_else(|| {
        ToolError::User(format!(
            "scheduled_at \"{}\" không đúng dạng — dùng YYYY-MM-DDTHH:mm theo giờ Việt Nam, vd 2026-10-20T09:00. / Invalid scheduled_at; use YYYY-MM-DDTHH:mm in Vietnam time.",
            slice16(text, 40)
        ))
    })
}

fn vn_day_start(d: &str) -> Option<DateTime<Utc>> {
    let n = NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0)?;
    // Chỉ nhận đúng 10 ký tự `YYYY-MM-DD` như `DAY` của bản Node.
    if d.len() != 10 {
        return None;
    }
    chrono::FixedOffset::east_opt(7 * 3600)?
        .from_local_datetime(&n)
        .single()
        .map(|t| t.with_timezone(&Utc))
}

/// Khoảng `[from, to)` theo giờ VN từ hai ngày (gồm cả ngày `to`); mặc định hôm nay; tối đa 92 ngày (`activityRange`).
pub fn activity_range(
    from: Option<&Value>,
    to: Option<&Value>,
    now: DateTime<Utc>,
) -> Result<(DateTime<Utc>, DateTime<Utc>, String), ToolError> {
    let today = vn_dt(now).format("%Y-%m-%d").to_string();
    let pick = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    let (fr, tr) = (pick(from), pick(to));
    let f = fr.clone().or_else(|| tr.clone()).unwrap_or_else(|| today.clone());
    let t = tr
        .clone()
        .unwrap_or_else(|| if fr.is_some() { f.clone() } else { today });
    for d in [&f, &t] {
        if vn_day_start(d).is_none() {
            return Err(ToolError::User(format!(
                "Ngày “{}” không hợp lệ — dùng dạng YYYY-MM-DD.",
                slice16(d, 20)
            )));
        }
    }
    let start = vn_day_start(&f).ok_or_else(|| user("Ngày không hợp lệ."))?;
    let end = vn_day_start(&t).ok_or_else(|| user("Ngày không hợp lệ."))? + chrono::Duration::days(1);
    if end <= start {
        return Err(user("from phải trước hoặc bằng to."));
    }
    if end - start > chrono::Duration::days(92) {
        return Err(user("Khoảng tối đa 92 ngày."));
    }
    let label = if f == t { f } else { format!("{f} → {t}") };
    Ok((start, end, label))
}

fn out(v: &Value) -> Result<ToolOutput, ToolError> {
    wrapped(v)
}

fn need<'a, T>(p: &'a Option<Arc<T>>, vi: &str, en: &str) -> Result<&'a Arc<T>, ToolError>
where
    T: ?Sized,
{
    p.as_ref().ok_or_else(|| missing(vi, en))
}

fn comments(p: &FanpagePorts) -> Result<&Arc<dyn CommentsPort>, ToolError> {
    need(
        &p.comments,
        "Máy chủ này chưa có tính năng bình luận Fanpage.",
        "Facebook comment automation is not available on this server.",
    )
}

fn admin_guide(p: &FanpagePorts) -> Result<&Arc<dyn AdminGuidePort>, ToolError> {
    need(
        &p.admin_guide,
        "Máy chủ này chưa có tính năng hướng dẫn quản trị viên Page.",
        "Page admin guides are not available on this server.",
    )
}

fn chat_links(p: &FanpagePorts) -> Result<&Arc<dyn ChatLinksPort>, ToolError> {
    need(
        &p.chat_links,
        "Máy chủ này chưa có tính năng link mở chat.",
        "Chat entry links are not available on this server.",
    )
}

fn flows(p: &FanpagePorts) -> Result<&Arc<dyn FlowsPort>, ToolError> {
    need(
        &p.flows,
        "Máy chủ này chưa có tính năng kịch bản nhắn tin.",
        "Messenger flows are not available on this server.",
    )
}

fn broadcasts(p: &FanpagePorts) -> Result<&Arc<dyn BroadcastsPort>, ToolError> {
    need(
        &p.broadcasts,
        "Máy chủ này chưa có tính năng gửi tin hàng loạt.",
        "Messenger broadcasts are not available on this server.",
    )
}

fn pages(p: &FanpagePorts) -> Result<&Arc<dyn PagesPort>, ToolError> {
    need(
        &p.pages,
        "Máy chủ này chưa đọc được danh sách Fanpage.",
        "Facebook Pages are not available on this server.",
    )
}

/// `page_id` gửi lên, hoặc Fanpage duy nhất đang kết nối.
async fn resolve_page(p: &FanpagePorts, env: &Env<'_>, args: &Value) -> Result<String, ToolError> {
    if let Some(id) = s(args, "page_id").map(str::trim).filter(|t| !t.is_empty()) {
        return Ok(id.to_owned());
    }
    let active: Vec<PageRef> = pages(p)?
        .pages(env.company)
        .await?
        .into_iter()
        .filter(|x| x.is_active)
        .collect();
    match active.as_slice() {
        [one] => Ok(one.page_id.clone()),
        [] => Err(missing(
            "Chưa kết nối Fanpage nào (Cài đặt › Kết nối & AI › Fanpage Facebook).",
            "No Facebook Page linked yet.",
        )),
        many => Err(ToolError::User(format!(
            "Có {} Fanpage, cần chọn page_id: {}. / Several Pages — pass page_id.",
            many.len(),
            many.iter()
                .map(|x| format!("{} = {}", x.name, x.page_id))
                .collect::<Vec<_>>()
                .join("; ")
        ))),
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn bool_of(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn arr_of(v: &Value, k: &str) -> Vec<Value> {
    v.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Số trong khoá, đã làm tròn xuống kiểu `i32` hợp lệ; sai ⇒ lỗi đối số.
fn id_arg(args: &Value, k: &str) -> Result<i32, ToolError> {
    opt_int(args.get(k)).ok_or_else(|| ToolError::User(format!("{k} không hợp lệ. / Invalid {k}.")))
}

fn json_field(v: &Value, k: &str) -> Value {
    v.get(k).cloned().unwrap_or(Value::Null)
}

const CONFIRM_FIRST: &str = "confirmed_by_user";

/// `cleanList`: bỏ trùng, cắt khoảng trắng và độ dài, tối đa 30 mục.
pub fn clean_list(v: &[Value]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for x in v {
        let t = match x {
            Value::String(s) => s.trim().to_owned(),
            other => other.to_string().trim().to_owned(),
        };
        if t.is_empty() {
            continue;
        }
        let t = slice16(&t, MAX_TEXT);
        if !seen.contains(&t) {
            seen.push(t);
        }
    }
    seen.truncate(MAX_WORDS);
    seen
}

/// `cleanAudience`: `source_ids` / `chat_link_ids` là số nguyên 1..=2^31-1, bỏ trùng, tối đa 50; rỗng thì bỏ khoá.
pub fn clean_audience(source_ids: Option<&Value>, chat_link_ids: Option<&Value>) -> Value {
    fn ids(v: Option<&Value>) -> Vec<i32> {
        let mut out: Vec<i32> = Vec::new();
        if let Some(Value::Array(a)) = v {
            for x in a {
                if let Some(n) = opt_int(Some(x))
                    && !out.contains(&n)
                {
                    out.push(n);
                }
            }
        }
        out.truncate(50);
        out
    }
    let mut m = Map::new();
    let (sv, lv) = (ids(source_ids), ids(chat_link_ids));
    if !sv.is_empty() {
        m.insert("source_ids".into(), json!(sv));
    }
    if !lv.is_empty() {
        m.insert("chat_link_ids".into(), json!(lv));
    }
    Value::Object(m)
}

fn post_link(post_id: &str) -> String {
    format!("https://www.facebook.com/{post_id}")
}

/// id bài dạng `<page>_<post>` (hai dãy chữ số) ⇒ link, còn lại ⇒ `null`.
fn link_of(post_id: Option<&str>) -> Value {
    let ok = post_id.and_then(|id| id.split_once('_')).is_some_and(|(a, b)| {
        !a.is_empty() && !b.is_empty() && a.bytes().all(|c| c.is_ascii_digit()) && b.bytes().all(|c| c.is_ascii_digit())
    });
    match post_id {
        Some(id) if ok => json!(post_link(id)),
        _ => Value::Null,
    }
}

// ------------------------------------------------------------------ bình luận

const RULES_URL: &str = "/connections?muc=facebook&xem=binh-luan";
const COMMENT_STATUSES: [&str; 5] = ["received", "done", "test", "skipped", "failed"];

fn rule_for_ai(r: &Value, names: &[PageRef]) -> Value {
    let page_id = str_of(r, "page_id");
    let page = match page_id {
        Some(id) => names
            .iter()
            .find(|n| n.page_id == id)
            .map_or_else(|| "Page không còn kết nối".to_owned(), |n| n.name.clone()),
        None => "Mọi Page".to_owned(),
    };
    json!({
        "rule_id": json_field(r, "id"),
        "name": json_field(r, "name"),
        "page": page,
        "post_link": link_of(str_of(r, "post_id")),
        "all_posts": str_of(r, "post_id").is_none_or(str::is_empty),
        "keywords": json_field(r, "keywords"),
        "exclude_keywords": json_field(r, "exclude_keywords"),
        "public_replies": json_field(r, "public_replies"),
        "private_reply": json_field(r, "private_reply"),
        "hide_if_phone": json_field(r, "hide_if_phone"),
        "once_per_user": json_field(r, "once_per_user"),
        "mode": json_field(r, "mode"),
        "is_active": json_field(r, "is_active"),
        "position": json_field(r, "position"),
    })
}

fn list_facebook_comments<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = comments(p)?;
        let (from, to, label) = activity_range(args.get("from"), args.get("to"), env.now)?;
        let status = s(args, "status")
            .filter(|x| COMMENT_STATUSES.contains(x))
            .map(str::to_owned);
        let rows = svc
            .list_comments(
                env.company,
                CommentQuery {
                    limit: 100,
                    status,
                    since: from,
                },
            )
            .await?;
        let keep = usize::try_from(clamp_limit(args.get("limit"))).unwrap_or(20);
        let comments: Vec<Value> = rows
            .iter()
            .filter(|r| {
                str_of(r, "created_at")
                    .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                    .is_some_and(|t| t.with_timezone(&Utc) < to)
            })
            .take(keep)
            .map(|r| {
                let contact_id = r.get("contact_id").and_then(Value::as_i64);
                json!({
                    "page": json_field(r, "page_name"),
                    "post_link": link_of(str_of(r, "post_id")),
                    "from_name": json_field(r, "from_name"),
                    "message": json_field(r, "message"),
                    "commented_at": vn_iso(r.get("commented_at")),
                    "status": json_field(r, "status"),
                    "rule": json_field(r, "rule_name"),
                    "actions": json_field(r, "actions"),
                    "note": json_field(r, "note"),
                    "hidden": json_field(r, "hidden"),
                    "contact_id": contact_id,
                    "contact_url": contact_id.map(|id| format!("{}/contacts/{id}", env.base_url)),
                })
            })
            .collect();
        out(&json!({
            "range": label,
            "timezone": "Asia/Ho_Chi_Minh",
            "comments": comments,
            "manage_url": format!("{}{RULES_URL}", env.base_url),
        }))
    })
}

async fn all_pages(p: &FanpagePorts, env: &Env<'_>) -> Result<Vec<PageRef>, ToolError> {
    match &p.pages {
        Some(x) => x.pages(env.company).await,
        None => Ok(Vec::new()),
    }
}

fn list_facebook_comment_rules<'a>(
    p: &'a FanpagePorts,
    _args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = comments(p)?;
        let rules = svc.list_rules(env.company).await?;
        let names = all_pages(p, env).await?;
        out(&json!({
            "rules": rules.iter().map(|r| rule_for_ai(r, &names)).collect::<Vec<_>>(),
            "manage_url": format!("{}{RULES_URL}", env.base_url),
        }))
    })
}

/// Đầu vào tool ⇒ chỉ các khoá AI gửi (khoá thiếu giữ nguyên khi sửa).
fn rule_input(args: &Value) -> Map<String, Value> {
    let mut d = Map::new();
    if let Some(n) = s(args, "name") {
        d.insert("name".into(), json!(n));
    }
    if let Some(v) = args.get("page_id") {
        d.insert("page_id".into(), if v.is_string() { v.clone() } else { Value::Null });
    }
    if let Some(v) = args.get("post_link") {
        d.insert("post_id".into(), if v.is_string() { v.clone() } else { Value::Null });
    }
    for k in ["keywords", "exclude_keywords", "public_replies"] {
        if let Some(Value::Array(a)) = args.get(k) {
            d.insert(k.into(), Value::Array(a.clone()));
        }
    }
    if let Some(v) = args.get("private_reply") {
        d.insert(
            "private_reply".into(),
            if v.is_string() { v.clone() } else { Value::Null },
        );
    }
    for k in ["hide_if_phone", "once_per_user"] {
        if let Some(Value::Bool(b)) = args.get(k) {
            d.insert(k.into(), json!(b));
        }
    }
    if let Some(m @ ("test" | "live")) = s(args, "mode") {
        d.insert("mode".into(), json!(m));
    }
    if let Some(Value::Bool(b)) = args.get("active") {
        d.insert("is_active".into(), json!(b));
    }
    if let Some(n) = args.get("position").and_then(Value::as_i64) {
        d.insert("position".into(), json!(n));
    }
    d
}

/// Luật chạy thật trên Fanpage (trả lời công khai, nhắn riêng, ẩn bình luận) ⇒ cần lời đồng ý.
fn goes_live(mode: &str, active: bool) -> bool {
    mode == "live" && active
}

fn need_approval(preview: &Value) -> Result<ToolOutput, ToolError> {
    out(&json!({
        "saved": false,
        "preview": preview,
        "next_step": "CHƯA LƯU. Luật này sẽ trả lời/nhắn/ẩn bình luận THẬT trên Fanpage. Đưa người dùng xem từ khoá, câu trả lời công khai, tin nhắn riêng; người dùng đồng ý thì gọi lại y hệt với confirmed_by_user. Muốn thử trước thì đặt mode = \"test\" (không cần đồng ý) hoặc dùng test_comment_rule.",
    }))
}

fn str_list(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

fn has_action(public_replies: &[Value], private_reply: Option<&str>, hide_if_phone: bool) -> bool {
    !clean_list(public_replies).is_empty() || private_reply.is_some_and(|t| !t.trim().is_empty()) || hide_if_phone
}

/// Link bài đọc không được ⇒ báo ngay; id bài phải thuộc đúng Page của luật.
fn check_post_link(
    svc: &Arc<dyn CommentsPort>,
    post: Option<&str>,
    page_id: Option<&str>,
) -> Result<Option<String>, ToolError> {
    let Some(raw) = post.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let id = svc.normalize_post_id(raw, page_id)?;
    if let (Some(id), Some(page)) = (id.as_deref(), page_id)
        && !id.starts_with(&format!("{page}_"))
    {
        return Err(user(
            "Bài này thuộc Fanpage khác với page_id của luật. Chọn đúng Page của bài, hoặc bỏ page_id. / The post belongs to another Page.",
        ));
    }
    Ok(id)
}

async fn check_page(p: &FanpagePorts, env: &Env<'_>, page_id: Option<&str>) -> Result<(), ToolError> {
    let Some(id) = page_id.filter(|t| !t.is_empty()) else {
        return Ok(());
    };
    if all_pages(p, env).await?.iter().any(|x| x.page_id == id) {
        return Ok(());
    }
    Err(ToolError::User(format!(
        "Không có Fanpage page_id = {id} đã kết nối. / Unknown page_id."
    )))
}

fn create_comment_rule<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = comments(p)?;
        let mut input = rule_input(args);
        let pr = str_list(input.get("public_replies"));
        let private = input.get("private_reply").and_then(Value::as_str).map(str::to_owned);
        let hide = input.get("hide_if_phone").and_then(Value::as_bool).unwrap_or(false);
        if !has_action(&pr, private.as_deref(), hide) {
            return Err(user(
                "Luật cần ít nhất một việc: public_replies, private_reply hoặc hide_if_phone = true. / The rule needs at least one action.",
            ));
        }
        let mode = input.get("mode").and_then(Value::as_str).unwrap_or("test").to_owned();
        let active = input.get("is_active").and_then(Value::as_bool).unwrap_or(true);
        let page = input.get("page_id").and_then(Value::as_str).map(str::to_owned);
        check_page(p, env, page.as_deref()).await?;
        let post = input.get("post_id").and_then(Value::as_str).map(str::to_owned);
        check_post_link(svc, post.as_deref(), page.as_deref())?;
        input.insert("mode".into(), json!(mode));
        input.insert("is_active".into(), json!(active));
        if goes_live(&mode, active) && !is_user_confirmation(args.get(CONFIRM_FIRST)) {
            return need_approval(&Value::Object(input));
        }
        let r = svc.create_rule(env.company, env.user_id, input).await?;
        let next = if goes_live(str_of(&r, "mode").unwrap_or(""), bool_of(&r, "is_active")) {
            "Luật đang chạy thật."
        } else if str_of(&r, "mode") == Some("test") {
            "Luật ở chế độ thử: chỉ ghi lại việc sẽ làm. Khi người dùng muốn chạy thật thì dùng update_comment_rule đặt mode = \"live\"."
        } else {
            "Luật đang tắt."
        };
        let names = all_pages(p, env).await?;
        out(&json!({
            "saved": true,
            "rule": rule_for_ai(&r, &names),
            "next_step": next,
            "manage_url": format!("{}{RULES_URL}", env.base_url),
        }))
    })
}

fn update_comment_rule<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = comments(p)?;
        let id = id_arg(args, "rule_id")?;
        let rules = svc.list_rules(env.company).await?;
        let cur = rules
            .iter()
            .find(|r| r.get("id").and_then(Value::as_i64) == Some(i64::from(id)))
            .ok_or_else(|| {
                ToolError::User(format!(
                    "Không có luật rule_id = {id}. Xem list_facebook_comment_rules. / No rule with this id."
                ))
            })?;
        let mut input = rule_input(args);
        if input.is_empty() {
            return Err(user("Không có trường nào để sửa. / Nothing to change."));
        }
        let mode = input
            .get("mode")
            .and_then(Value::as_str)
            .or_else(|| str_of(cur, "mode"))
            .unwrap_or("test")
            .to_owned();
        let active = input
            .get("is_active")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| bool_of(cur, "is_active"));
        let cosmetic = input.keys().all(|k| k == "name" || k == "position");
        let cur_page = str_of(cur, "page_id").map(str::to_owned);
        let page: Option<String> = match input.get("page_id") {
            Some(v) => v.as_str().map(str::to_owned),
            None => cur_page.clone(),
        };
        if let Some(v) = input.get("page_id") {
            check_page(p, env, v.as_str()).await?;
        }
        let post_in = input.get("post_id").map(|v| v.as_str().map(str::to_owned));
        let normalized = check_post_link(svc, post_in.as_ref().and_then(Option::as_deref), page.as_deref())?;
        // Link dạng /posts/<số> cần Page để ghép id: chuẩn hoá theo Page hiệu lực.
        if post_in.as_ref().is_some_and(Option::is_some) {
            input.insert("post_id".into(), normalized.map_or(Value::Null, Value::String));
        }
        let after_replies = match input.get("public_replies") {
            Some(v) => str_list(Some(v)),
            None => arr_of(cur, "public_replies"),
        };
        let after_private = match input.get("private_reply") {
            Some(v) => v.as_str().map(str::to_owned),
            None => str_of(cur, "private_reply").map(str::to_owned),
        };
        let after_hide = input
            .get("hide_if_phone")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| bool_of(cur, "hide_if_phone"));
        if active && !has_action(&after_replies, after_private.as_deref(), after_hide) {
            return Err(user(
                "Sau khi sửa luật không còn việc nào (public_replies, private_reply, hide_if_phone). Giữ ít nhất một việc, hoặc tắt luật (active=false). / The rule would have no action left.",
            ));
        }
        // Luật áp cho một bài mà đổi Page: id bài cũ không bao giờ khớp ⇒ bắt chọn lại bài.
        if let Some(new_page) = input.get("page_id")
            && new_page.as_str().map(str::to_owned) != cur_page
            && str_of(cur, "post_id").is_some_and(|t| !t.is_empty())
            && !input.contains_key("post_id")
        {
            return Err(user(
                "Luật đang áp cho một bài cụ thể; đổi Page thì gửi kèm post_link của bài trên Page mới, hoặc post_link = null để áp mọi bài. / Changing the page of a post-scoped rule needs post_link too.",
            ));
        }
        if goes_live(&mode, active) && !cosmetic && !is_user_confirmation(args.get(CONFIRM_FIRST)) {
            let names = all_pages(p, env).await?;
            return need_approval(&json!({
                "rule_id": id,
                "current": rule_for_ai(cur, &names),
                "changes": Value::Object(input),
            }));
        }
        let r = svc.update_rule(env.company, id, input).await?;
        let names = all_pages(p, env).await?;
        out(&json!({
            "saved": true,
            "rule": rule_for_ai(&r, &names),
            "manage_url": format!("{}{RULES_URL}", env.base_url),
        }))
    })
}

fn test_comment_rule<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = comments(p)?;
        let page = s(args, "page_id").map(str::trim).filter(|t| !t.is_empty());
        let post_id = match s(args, "post_link") {
            Some(raw) => svc.normalize_post_id(raw, page)?,
            None => None,
        };
        let r = svc
            .dry_run(
                env.company,
                json!({
                    "message": s(args, "message").unwrap_or(""),
                    "page_id": page,
                    "post_id": post_id,
                    "from_name": s(args, "from_name"),
                }),
            )
            .await?;
        let note = match r.get("matched_rule").filter(|m| !m.is_null()) {
            Some(m) if str_of(m, "mode") == Some("test") => {
                "Luật khớp đang ở chế độ thử — khi có bình luận thật chỉ ghi lại, không gửi."
            }
            Some(_) => "Luật khớp đang chạy thật.",
            None => "Không luật nào khớp — bình luận này sẽ không được xử lý.",
        };
        let mut data = match r {
            Value::Object(m) => m,
            other => Map::from_iter([("result".to_owned(), other)]),
        };
        data.insert("note".into(), json!(note));
        out(&Value::Object(data))
    })
}

// ------------------------------------------------------------------ link chat

const CHAT_MANAGE: &str = "/connections?muc=facebook&xem=link-chat";

fn link_for_ai(l: &Value, base: &str) -> Value {
    let id = l.get("id").and_then(Value::as_i64).unwrap_or(0);
    let url = str_of(l, "url").or_else(|| str_of(l, "messenger_url"));
    json!({
        "link_id": json_field(l, "id"),
        "name": json_field(l, "name"),
        "page": json_field(l, "page_name"),
        "page_id": json_field(l, "page_id"),
        "url": url,
        "contact_source": str_of(l, "source_label").unwrap_or("nguồn mặc định của Page"),
        "active": json_field(l, "is_active"),
        "clicks": json_field(l, "clicks"),
        "chats": json_field(l, "chats"),
        "qr_url": format!("{base}{CHAT_MANAGE}&link={id}"),
    })
}

fn list_chat_links<'a>(
    p: &'a FanpagePorts,
    _args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = chat_links(p)?;
        let rows = svc.list(env.company).await?;
        out(&json!({
            "links": rows.iter().map(|l| link_for_ai(l, env.base_url)).collect::<Vec<_>>(),
            "manage_url": format!("{}{CHAT_MANAGE}", env.base_url),
        }))
    })
}

fn create_chat_link<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = chat_links(p)?;
        let page_id = resolve_page(p, env, args).await?;
        let mut input = json!({ "name": s(args, "name").unwrap_or(""), "page_id": page_id });
        if let Some(n) = opt_int(args.get("source_id"))
            && let Some(m) = input.as_object_mut()
        {
            m.insert("source_id".into(), json!(n));
        }
        let l = svc.create(env.company, env.user_id, input).await?;
        let mut data = link_for_ai(&l, env.base_url);
        if let Some(m) = data.as_object_mut() {
            m.insert("next_step".into(), json!("Gửi url hoặc mở qr_url để tải mã QR in ấn."));
        }
        out(&data)
    })
}

fn get_page_admin_guide<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = admin_guide(p)?;
        let page_id = resolve_page(p, env, args).await?;
        let opt = |k: &str| s(args, k).map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
        let mut data = svc
            .compose(env.company, &page_id, opt("recipient"), opt("note"))
            .await?;
        if let Some(m) = data.as_object_mut() {
            m.insert(
                "next_step".into(),
                json!("Đưa nguyên văn text cho người dùng để họ tự gửi cho quản trị viên Page. Trinity không gửi gì."),
            );
        }
        out(&data)
    })
}

// ------------------------------------------------------------------ kịch bản

const FLOW_MANAGE: &str = "/connections?muc=facebook&xem=kich-ban";

fn trigger_vi(t: &str) -> &str {
    match t {
        "keyword" => "khách nhắn có từ khoá",
        "chat_link" => "khách vào qua link/QR",
        "first_message" => "tin đầu tiên của khách mới",
        other => other,
    }
}

fn flow_for_ai(f: &Value, base: &str) -> Value {
    let trigger = str_of(f, "trigger").unwrap_or("");
    let id = f.get("id").and_then(Value::as_i64).unwrap_or(0);
    let mut m = Map::new();
    m.insert("flow_id".into(), json_field(f, "id"));
    m.insert("name".into(), json_field(f, "name"));
    m.insert("page".into(), json_field(f, "page_name"));
    m.insert("page_id".into(), json_field(f, "page_id"));
    m.insert("trigger".into(), json!(trigger));
    m.insert("trigger_text".into(), json!(trigger_vi(trigger)));
    if trigger == "keyword" {
        m.insert("keywords".into(), json_field(f, "keywords"));
    }
    if trigger == "chat_link" {
        m.insert(
            "chat_link".into(),
            json!({ "link_id": json_field(f, "chat_link_id"), "name": json_field(f, "chat_link_name") }),
        );
    }
    m.insert("active".into(), json_field(f, "is_active"));
    m.insert("steps".into(), json_field(f, "steps"));
    m.insert("started".into(), json_field(f, "starts"));
    m.insert("completed".into(), json_field(f, "completes"));
    m.insert("running_now".into(), json_field(f, "running"));
    m.insert("edit_url".into(), json!(format!("{base}{FLOW_MANAGE}&kich-ban={id}")));
    Value::Object(m)
}

fn list_message_flows<'a>(
    p: &'a FanpagePorts,
    _args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = flows(p)?;
        let rows = svc.list(env.company).await?;
        out(&json!({
            "flows": rows.iter().map(|f| flow_for_ai(f, env.base_url)).collect::<Vec<_>>(),
            "manage_url": format!("{}{FLOW_MANAGE}", env.base_url),
        }))
    })
}

/// Tạo kịch bản — GHI THẲNG nhưng mặc định TẮT: không nhắn ai cho tới khi bật.
fn create_message_flow<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = flows(p)?;
        let page_id = resolve_page(p, env, args).await?;
        let mut input = Map::new();
        input.insert("name".into(), json!(s(args, "name").unwrap_or("")));
        input.insert("page_id".into(), json!(page_id));
        input.insert("trigger".into(), json_field(args, "trigger"));
        if let Some(Value::Array(a)) = args.get("keywords") {
            input.insert("keywords".into(), Value::Array(a.clone()));
        }
        if let Some(n) = opt_int(args.get("chat_link_id")) {
            input.insert("chat_link_id".into(), json!(n));
        }
        input.insert("steps".into(), json_field(args, "steps"));
        input.insert(
            "is_active".into(),
            json!(args.get("active") == Some(&Value::Bool(true))),
        );
        let f = svc.create(env.company, env.user_id, Value::Object(input)).await?;
        let next = if bool_of(&f, "is_active") {
            "Kịch bản đã bật."
        } else {
            "Kịch bản đang TẮT — người dùng mở edit_url để xem lại rồi bật."
        };
        let mut data = flow_for_ai(&f, env.base_url);
        if let Some(m) = data.as_object_mut() {
            m.insert("next_step".into(), json!(next));
        }
        out(&data)
    })
}

fn update_message_flow<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = flows(p)?;
        let mut input = Map::new();
        if let Some(n) = s(args, "name") {
            input.insert("name".into(), json!(n));
        }
        if let Some(t) = s(args, "trigger") {
            input.insert("trigger".into(), json!(t));
        }
        if let Some(Value::Array(a)) = args.get("keywords") {
            input.insert("keywords".into(), Value::Array(a.clone()));
        }
        if let Some(n) = opt_int(args.get("chat_link_id")) {
            input.insert("chat_link_id".into(), json!(n));
        }
        if let Some(v) = args.get("steps") {
            input.insert("steps".into(), v.clone());
        }
        if let Some(Value::Bool(b)) = args.get("active") {
            input.insert("is_active".into(), json!(b));
        }
        if input.is_empty() {
            return Err(user("Không có trường nào để sửa. / Nothing to change."));
        }
        let f = svc.update(env.company, id_arg(args, "flow_id")?, input).await?;
        let mut data = flow_for_ai(&f, env.base_url);
        if let Some(m) = data.as_object_mut() {
            m.insert(
                "next_step".into(),
                json!(if bool_of(&f, "is_active") {
                    "Kịch bản đang bật."
                } else {
                    "Kịch bản đang TẮT."
                }),
            );
        }
        out(&data)
    })
}

// ------------------------------------------------------------------ gửi hàng loạt

const BC_MANAGE: &str = "/connections?muc=facebook&xem=gui-hang-loat";

fn status_vi(s: &str) -> &str {
    match s {
        "draft" => "nháp",
        "scheduled" => "chờ gửi",
        "sending" => "đang gửi",
        "done" => "đã xong",
        "cancelled" => "đã huỷ",
        other => other,
    }
}

fn broadcast_for_ai(b: &Value, base: &str) -> Value {
    let status = str_of(b, "status").unwrap_or("");
    let id = b.get("id").and_then(Value::as_i64).unwrap_or(0);
    json!({
        "broadcast_id": json_field(b, "id"),
        "name": json_field(b, "name"),
        "page": json_field(b, "page_name"),
        "text": json_field(b, "text"),
        "status": status,
        "status_text": status_vi(status),
        "scheduled_at": vn_when_str(b.get("scheduled_at")),
        "recipients": json_field(b, "total"),
        "sent": json_field(b, "sent"),
        "failed": json_field(b, "failed"),
        "skipped_outside_24h": json_field(b, "skipped"),
        "filter": json_field(b, "audience"),
        "url": format!("{base}{BC_MANAGE}&luot={id}"),
    })
}

fn with_fields(base: Value, extra: &[(&str, Value)]) -> Value {
    let mut m = match base {
        Value::Object(m) => m,
        other => Map::from_iter([("value".to_owned(), other)]),
    };
    for (k, v) in extra {
        m.insert((*k).to_owned(), v.clone());
    }
    Value::Object(m)
}

fn list_messenger_broadcasts<'a>(
    p: &'a FanpagePorts,
    _args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = broadcasts(p)?;
        let rows = svc.list(env.company, 20).await?;
        let mut list: Vec<Value> = Vec::with_capacity(rows.len());
        for b in &rows {
            let base = broadcast_for_ai(b, env.base_url);
            let count = |k: &str| b.get(k).and_then(Value::as_i64).unwrap_or(0);
            let problems = count("failed") + count("skipped");
            if problems == 0 {
                list.push(base);
                continue;
            }
            // Lý do lỗi / bỏ qua (gộp theo nội dung) để AI nói đúng nguyên nhân thay vì đoán.
            let id = i32::try_from(b.get("id").and_then(Value::as_i64).unwrap_or(0)).unwrap_or(0);
            let mut reasons: Vec<(String, i64)> = Vec::new();
            for r in svc.recipients(env.company, id, 200).await? {
                let st = str_of(&r, "status").unwrap_or("");
                if (st == "failed" || st == "skipped")
                    && let Some(note) = str_of(&r, "note").filter(|t| !t.is_empty())
                {
                    match reasons.iter_mut().find(|(k, _)| k == note) {
                        Some((_, n)) => *n += 1,
                        None => reasons.push((note.to_owned(), 1)),
                    }
                }
            }
            let top: Vec<Value> = reasons
                .into_iter()
                .take(5)
                .map(|(reason, count)| json!({ "reason": reason, "count": count }))
                .collect();
            list.push(with_fields(base, &[("problems", json!(top))]));
        }
        out(&json!({ "broadcasts": list, "manage_url": format!("{}{BC_MANAGE}", env.base_url) }))
    })
}

fn when_text(at: Option<DateTime<Utc>>) -> String {
    at.map_or_else(|| "Gửi ngay".to_owned(), |t| format!("Hẹn gửi lúc {}", vn_when(t)))
}

/// Gửi hàng loạt — tin đi thẳng tới khách nên phải có lời đồng ý. Thiếu `confirmed_by_user` ⇒ không tạo gì, trả bản xem trước.
fn send_messenger_broadcast<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = broadcasts(p)?;
        let page_id = resolve_page(p, env, args).await?;
        let audience = clean_audience(args.get("source_ids"), args.get("chat_link_ids"));
        let at = parse_scheduled_at(args.get("scheduled_at"))?;
        let input = json!({
            "name": s(args, "name").unwrap_or(""),
            "page_id": page_id,
            "text": s(args, "text").unwrap_or(""),
            "audience": audience,
        });
        svc.validate(env.company, &input, false).await?;
        svc.check_send_time(at)?; // quá 7 ngày ⇒ báo ngay, không để tới lúc gửi
        let preview = svc.preview(env.company, &page_id, &audience).await?;
        let eligible = preview.get("eligible").and_then(Value::as_i64).unwrap_or(0);
        let when = when_text(at);
        if !is_user_confirmation(args.get(CONFIRM_FIRST)) {
            let next = if eligible == 0 && at.is_none() {
                "Hiện không có khách nào nhắn Page trong 24 giờ qua khớp bộ lọc — gửi lúc này sẽ không ai nhận. Báo người dùng.".to_owned()
            } else {
                let base = "CHƯA GỬI. Đưa người dùng xem nội dung, số người nhận (eligible) và số khách quá 24h không nhận được (outside_window); người dùng đồng ý thì gọi lại với confirmed_by_user.";
                if at.is_some() {
                    format!("{base} Người nhận chốt lúc tới giờ hẹn nên con số có thể khác.")
                } else {
                    base.to_owned()
                }
            };
            return out(&json!({
                "started": false,
                "preview": with_fields(preview, &[("when", json!(when)), ("text", json_field(&input, "text"))]),
                "next_step": next,
            }));
        }
        let created = svc.create(env.company, env.user_id, &input, "mcp").await?;
        let id = i32::try_from(created.get("id").and_then(Value::as_i64).unwrap_or(0)).unwrap_or(0);
        let b = svc.send(env.company, id, at).await?;
        if at.is_none() {
            svc.kick();
        }
        out(&with_fields(
            broadcast_for_ai(&b, env.base_url),
            &[
                ("started", json!(true)),
                ("expected_recipients", json!(eligible)),
                (
                    "next_step",
                    json!(format!(
                        "{when}. Tin gửi chạy nền theo lô; xem tiến độ bằng list_messenger_broadcasts hoặc mở url."
                    )),
                ),
            ],
        ))
    })
}

/// Sửa lượt chưa chạy (nháp / chờ gửi): nội dung, bộ lọc, giờ gửi. Cần `confirmed_by_user`, thiếu thì không sửa gì.
fn update_messenger_broadcast<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = broadcasts(p)?;
        if args.get("scheduled_at").is_some_and(Value::is_string) && args.get("send_now") == Some(&Value::Bool(true)) {
            return Err(user(
                "Chọn một: scheduled_at hoặc send_now. / Pass either scheduled_at or send_now.",
            ));
        }
        let at = parse_scheduled_at(args.get("scheduled_at"))?;
        let id = id_arg(args, "broadcast_id")?;
        let cur = svc.get(env.company, id).await?;
        let status = str_of(&cur, "status").unwrap_or("");
        if status != "draft" && status != "scheduled" {
            return Err(ToolError::User(format!(
                "Lượt này {} — không sửa được. / This broadcast already ran or was cancelled.",
                status_vi(status)
            )));
        }
        let mut input = Map::new();
        if let Some(n) = s(args, "name") {
            input.insert("name".into(), json!(n));
        }
        if let Some(t) = s(args, "text") {
            input.insert("text".into(), json!(t));
        }
        let has_src = args.get("source_ids").is_some_and(Value::is_array);
        let has_link = args.get("chat_link_ids").is_some_and(Value::is_array);
        if has_src || has_link {
            let cur_aud = cur.get("audience");
            let src = if has_src {
                args.get("source_ids")
            } else {
                cur_aud.and_then(|a| a.get("source_ids"))
            };
            let lnk = if has_link {
                args.get("chat_link_ids")
            } else {
                cur_aud.and_then(|a| a.get("chat_link_ids"))
            };
            input.insert("audience".into(), clean_audience(src, lnk));
        }
        let send_now = args.get("send_now") == Some(&Value::Bool(true));
        if input.is_empty() && at.is_none() && !send_now {
            return Err(user("Không có trường nào để sửa. / Nothing to change."));
        }
        svc.validate(env.company, &Value::Object(input.clone()), true).await?;
        svc.check_send_time(at)?;
        if !is_user_confirmation(args.get(CONFIRM_FIRST)) {
            let page_id = str_of(&cur, "page_id").unwrap_or("").to_owned();
            let aud = input
                .get("audience")
                .or_else(|| cur.get("audience"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let preview = svc.preview(env.company, &page_id, &aud).await?;
            let when = if send_now {
                "Gửi ngay".to_owned()
            } else if let Some(t) = at {
                format!("Hẹn gửi lúc {}", vn_when(t))
            } else if status == "scheduled" && cur.get("scheduled_at").is_some_and(|v| !v.is_null()) {
                format!(
                    "Giữ giờ hẹn {}",
                    vn_when_str(cur.get("scheduled_at")).unwrap_or_default()
                )
            } else {
                "Vẫn là nháp (chưa gửi)".to_owned()
            };
            let text = input.get("text").cloned().unwrap_or_else(|| json_field(&cur, "text"));
            return out(&json!({
                "saved": false,
                "current": broadcast_for_ai(&cur, env.base_url),
                "preview": with_fields(preview, &[("when", json!(when)), ("text", text)]),
                "next_step": "CHƯA SỬA. Đưa người dùng xem nội dung, giờ gửi và số người nhận; người dùng đồng ý thì gọi lại với confirmed_by_user.",
            }));
        }
        let mut b = if input.is_empty() {
            cur
        } else {
            svc.update(env.company, id, input).await?
        };
        if send_now || at.is_some() {
            b = svc.send(env.company, id, if send_now { None } else { at }).await?;
            if send_now {
                svc.kick();
            }
        }
        out(&with_fields(
            broadcast_for_ai(&b, env.base_url),
            &[("saved", json!(true))],
        ))
    })
}

fn cancel_messenger_broadcast<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = broadcasts(p)?;
        let id = id_arg(args, "broadcast_id")?;
        let b = svc.get(env.company, id).await?;
        let status = str_of(&b, "status").unwrap_or("");
        if status != "scheduled" {
            return Err(ToolError::User(format!(
                "Lượt này {} — chỉ huỷ được lượt đang chờ tới giờ gửi. / Only broadcasts waiting for their send time can be cancelled.",
                status_vi(status)
            )));
        }
        if !is_user_confirmation(args.get(CONFIRM_FIRST)) {
            return out(&json!({
                "cancelled": false,
                "preview": broadcast_for_ai(&b, env.base_url),
                "next_step": "CHƯA HUỶ. Đưa người dùng xem lượt gửi sẽ huỷ; người dùng đồng ý thì gọi lại với confirmed_by_user.",
            }));
        }
        let after = svc.cancel_pending(env.company, id).await?;
        out(&with_fields(
            broadcast_for_ai(&after, env.base_url),
            &[("cancelled", json!(true))],
        ))
    })
}

fn cancel_scheduled_post<'a>(
    p: &'a FanpagePorts,
    args: &'a Value,
    env: &'a Env<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let svc = need(
            &p.posts,
            "Máy chủ này chưa có tính năng đăng đa kênh.",
            "Social posting is not available on this server.",
        )?;
        let id = id_arg(args, "post_id")?;
        let post = svc.get(env.company, id).await?;
        let targets = arr_of(&post, "targets");
        let status = str_of(&post, "status").unwrap_or("");
        let target_status = |t: &Value| str_of(t, "status").unwrap_or("").to_owned();
        let account = |t: &Value| match str_of(t, "account_name") {
            Some(n) => n.to_owned(),
            None => format!("#{}", t.get("account_id").and_then(Value::as_i64).unwrap_or(0)),
        };
        let all_pending = targets
            .iter()
            .all(|t| matches!(target_status(t).as_str(), "queued" | "cancelled"));
        if status != "scheduled" || !all_pending {
            return Err(ToolError::User(format!(
                "Bài #{id} đang ở trạng thái \"{status}\" — chỉ huỷ được bài đang hẹn giờ, chưa kênh nào đăng. / Only scheduled, unpublished posts can be cancelled."
            )));
        }
        let channels: Vec<String> = targets
            .iter()
            .filter(|t| target_status(t) == "queued")
            .map(account)
            .collect();
        if !is_user_confirmation(args.get(CONFIRM_FIRST)) {
            return out(&json!({
                "cancelled": false,
                "preview": {
                    "post_id": id,
                    "content": json_field(&post, "content"),
                    "scheduled_at": vn_when_str(post.get("scheduled_at")),
                    "channels": channels,
                },
                "next_step": "CHƯA HUỶ. Đưa người dùng xem bài sẽ huỷ; người dùng đồng ý thì gọi lại với confirmed_by_user.",
            }));
        }
        let after = svc.cancel(env.company, id).await?;
        // Tới giờ đúng lúc huỷ: kênh đã bắt đầu đăng thì không huỷ được — báo thật thay vì báo huỷ hết.
        let started: Vec<Value> = arr_of(&after, "targets")
            .iter()
            .filter(|t| target_status(t) != "cancelled")
            .map(|t| json!({ "account": account(t), "status": target_status(t) }))
            .collect();
        let mut data = json!({
            "cancelled": started.is_empty(),
            "post_id": id,
            "status": json_field(&after, "status"),
            "channels": channels,
        });
        if !started.is_empty()
            && let Some(m) = data.as_object_mut()
        {
            m.insert("already_started".into(), json!(started));
            m.insert(
                "note".into(),
                json!("Bài vừa tới giờ đăng — các kênh trong already_started đã bắt đầu đăng nên không huỷ được; gỡ bài đã đăng ở màn Đăng đa kênh của Trinity."),
            );
        }
        out(&data)
    })
}

#[cfg(test)]
mod tests;
