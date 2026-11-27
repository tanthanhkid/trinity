//! Kịch bản nhắn tin Messenger nhiều bước (M50 phần 2), chuyển từ `facebook-flows.service.ts`, `facebook-flows.job.ts` và 6 route
//! `flows` (cộng `tick`) của `facebook.controller.ts`.
//!
//! Kiểu ManyChat: kích hoạt bằng từ khoá, link/QR mở chat hoặc tin đầu tiên của khách; mỗi bước là một tin, có thể kèm nút trả lời
//! nhanh (rẽ nhánh), hỏi rồi lưu SĐT/email/ghi chú vào khách, hoặc chờ N phút (tối đa 23 giờ) rồi mới gửi. Luôn nằm trong cửa sổ
//! 24 giờ của Messenger: quá hạn thì lượt kết thúc `expired`, không gửi chủ động. Nhân viên trả lời trong Trinity ⇒ dừng kịch bản
//! (`inbox::reply`). Sửa bước hoặc tắt kịch bản ⇒ các lượt đang dở dừng lại.
//!
//! Chống gửi trùng: mọi bước chuyển trạng thái của một lượt đều đi qua [`FacebookIngest::flow_claim`] (`UPDATE ... WHERE status = <cũ>`,
//! một tiến trình thắng) nên Meta gửi lại webhook hay job chạy song song không gửi hai lần. Mọi chuyển trạng thái sau khi giành đều có
//! điều kiện `status = 'sending'`: kịch bản bị tắt/sửa (lượt thành `stopped`) giữa chừng thì lượt không bị "sống lại".
//!
//! Tạm dừng kênh (`ChannelGuard` tự tạm dừng do Facebook báo chặn/spam) chỉ GIỮ việc: lượt đổi `scheduled` tới hết giờ tạm dừng rồi
//! job gửi tiếp, KHÔNG huỷ. Khoá kênh (`channel_locked`) thì dừng lượt (`stopped`) vì không biết bao giờ mở lại.
//!
//! Quy tắc chung: không giữ kết nối pool khi gọi Graph hoặc `ChannelGuard`, không giữ hai kết nối cùng lúc. Việc phụ sau khi tin đã
//! tới Facebook (ghi hộp thư, lịch sử khách) lỗi chỉ ghi log, không làm lượt `failed`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, PoisonError};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use http::Method;
use mod_channel_guard::{BlockCode, OutboundMode, OutboundScope};
use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{FacebookConversation, FacebookFlow, FacebookFlowRun};
use trinity_db::outbox::publish_integration_event;
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, TenantTx};
use trinity_http::router::{Access, RouteSpec};
use trinity_jobs::{JobSpec, SchedulerError};
use trinity_kernel::error::{AppError, HttpError};

use crate::chat_links::referral_ref;
use crate::comments::{fill_template, matches_keywords};
use crate::dto;
use crate::graph::GraphApiError;
use crate::inbox::{MAX_TEXT, within_messaging_window};
use crate::ingest::{FacebookIngest, db, platform_db, str_of, utf16_prefix};
use crate::messenger::{assigned_to, find_vn_phone};
use crate::pages;

pub const FLOW_TRIGGERS: [&str; 3] = ["keyword", "chat_link", "first_message"];
pub const MAX_STEPS: usize = 20;
pub const MAX_BUTTONS: usize = 10;
pub const MAX_BUTTON_TITLE: usize = 20;
/// 23 giờ: Messenger chỉ cho nhắn trong 24 giờ kể từ tin cuối của khách.
pub const MAX_WAIT_MINUTES: i64 = 23 * 60;
/// Cùng kịch bản không chạy lại cho cùng hội thoại trong khoảng này (Meta gửi lại webhook, khách bấm link liên tục).
pub const RESTART_GUARD_MS: i64 = 10 * 60_000;
/// Số tin tối đa gửi liền trong một lần xử lý (chặn vòng lặp).
const MAX_SENDS_PER_PASS: usize = 10;
const NAME_MAX: usize = 120;
const PAGE_ID_MAX: usize = 40;
const KEYWORD_MAX: usize = 100;
const MAX_KEYWORDS: usize = 30;
const ANSWER_MAX: usize = 1000;
/// Tên job (tệp sở hữu K20) và chu kỳ/trần thời gian (PLAN 4.9: 60 giây, budget 30 giây).
pub const JOB_NAME: &str = "facebook.flows";
pub const JOB_INTERVAL: Duration = Duration::from_secs(60);
pub const JOB_BUDGET: Duration = Duration::from_secs(30);
/// Thời gian chạy tối đa của một lượt job (chừa chỗ cho bước đang gửi dở).
const RUN_BUDGET: Duration = Duration::from_secs(25);
/// `POST /facebook/tick` chạy nền tối đa bằng ngần này, và mỗi công ty kiểm DB tối đa một lần mỗi 20 giây.
const TICK_BUDGET: Duration = Duration::from_secs(40);
const KICK_THROTTLE_MS: i64 = 20_000;
const KICK_FLOWS: u8 = 0;
const KICK_BROADCASTS: u8 = 1;
const PAYLOAD_PREFIX: &str = "FLOW:";

const FLOW_COLS: &str = "id, name, page_id, trigger, keywords, chat_link_id, steps, is_active, starts, completes, created_by, \
                         created_at, updated_at";
const RUN_COLS: &str = "id, flow_id, conversation_id, step_id, status, due_at, note, started_at, updated_at";
const CONV_COLS: &str = "id, page_id, psid, customer_name, contact_id, last_inbound_at, last_message_at, \
                         last_message_preview, unread_count, entry_link_id, created_at";

const NOT_FOUND: &str = "Không tìm thấy kịch bản";
const RETRY_PHONE: &str = "Mình chưa nhận ra số điện thoại, bạn gửi lại giúp mình số di động nhé.";
const RETRY_EMAIL: &str = "Mình chưa nhận ra email, bạn gửi lại giúp mình nhé (vd ten@gmail.com).";
const OUTSIDE_NOTE: &str = "Quá 24 giờ kể từ tin cuối của khách — Messenger không cho gửi chủ động";

/// Trạng thái "đang dở" của một lượt (còn việc phải làm).
fn active_statuses() -> Vec<String> {
    ["waiting_button", "waiting_answer", "scheduled", "sending"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}

// ───────────────────────── thuần (không DB)

/// Giờ hẹn lại khi kênh đang tạm dừng (`ChannelPaused` kèm hạn): hết hạn tạm dừng (tối thiểu 30 giây sau `now`). Khoá kênh hoặc
/// tạm dừng không rõ hạn ⇒ `None` (dừng lượt, vì không biết bao giờ gửi lại được).
pub fn pause_due(code: &BlockCode, until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    match (code, until) {
        (BlockCode::ChannelPaused, Some(u)) => Some(u.max(now + chrono::Duration::seconds(30))),
        _ => None,
    }
}

/// Nút trả lời nhanh: bấm thì đi tới bước `next` (`None` = kết thúc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowButton {
    pub title: String,
    pub next: Option<String>,
}

/// Một bước của kịch bản (`FlowStep`). `{ten}` trong `text` là tên khách.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowStep {
    pub id: String,
    pub text: String,
    /// Chờ bao nhiêu phút rồi mới gửi bước này; chỉ lưu khi > 0.
    pub wait_minutes: Option<i64>,
    /// Nút trả lời nhanh (có ⇒ không rỗng): khách bấm nút nào đi bước đó.
    pub buttons: Option<Vec<FlowButton>>,
    /// Hỏi và chờ khách trả lời rồi lưu vào khách: `phone` / `email` / `note`. Không đi cùng `buttons`.
    pub ask: Option<String>,
    /// Bước sau khi không có nút: `None` = chưa đặt (bước kế trong danh sách); `Some(None)` = kết thúc.
    pub next: Option<Option<String>>,
}

impl FlowStep {
    /// Đúng dạng JSON bản Node lưu (`id, text, wait_minutes?, buttons?, ask?, next?`).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".to_owned(), json!(self.id));
        m.insert("text".to_owned(), json!(self.text));
        if let Some(w) = self.wait_minutes {
            m.insert("wait_minutes".to_owned(), json!(w));
        }
        if let Some(bs) = &self.buttons {
            let list: Vec<Value> = bs.iter().map(|b| json!({ "title": b.title, "next": b.next })).collect();
            m.insert("buttons".to_owned(), Value::Array(list));
        }
        if let Some(a) = &self.ask {
            m.insert("ask".to_owned(), json!(a));
        }
        if let Some(n) = &self.next {
            m.insert("next".to_owned(), json!(n));
        }
        Value::Object(m)
    }

    /// Đọc lại bước đã lưu trong DB (đã qua [`clean_steps`]); bước hỏng bị bỏ.
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let id = o.get("id")?.as_str()?.to_owned();
        let text = o.get("text")?.as_str()?.to_owned();
        let wait_minutes = o.get("wait_minutes").and_then(Value::as_i64).filter(|w| *w > 0);
        let buttons = o.get("buttons").and_then(Value::as_array).map(|a| {
            a.iter()
                .map(|b| FlowButton {
                    title: b.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
                    next: b.get("next").and_then(Value::as_str).map(str::to_owned),
                })
                .collect::<Vec<_>>()
        });
        let buttons = buttons.filter(|b| !b.is_empty());
        let ask = o.get("ask").and_then(Value::as_str).map(str::to_owned);
        let next = o
            .get("next")
            .map(|n| n.as_str().filter(|s| !s.is_empty()).map(str::to_owned));
        Some(Self {
            id,
            text,
            wait_minutes,
            buttons,
            ask,
            next,
        })
    }
}

/// Các bước đã lưu (cột `steps` jsonb) ở dạng cấu trúc.
pub fn steps_from_json(v: &Value) -> Vec<FlowStep> {
    v.as_array()
        .map(|a| a.iter().filter_map(FlowStep::from_value).collect())
        .unwrap_or_default()
}

/// Danh sách bước ở dạng JSON để ghi cột `steps`.
pub fn steps_to_json(steps: &[FlowStep]) -> Value {
    Value::Array(steps.iter().map(FlowStep::to_value).collect())
}

/// Payload nút: `FLOW:<lượt>:<bước>:<thứ tự nút>`.
pub fn button_payload(run_id: i32, step_id: &str, index: usize) -> String {
    format!("{PAYLOAD_PREFIX}{run_id}:{step_id}:{index}")
}

/// Đọc payload nút ⇒ (lượt, bước, thứ tự nút); sai dạng ⇒ `None`.
pub fn parse_button_payload(payload: Option<&str>) -> Option<(i32, String, usize)> {
    let rest = payload?.strip_prefix(PAYLOAD_PREFIX)?;
    let mut it = rest.split(':');
    let (run, step, idx) = (it.next()?, it.next()?, it.next()?);
    let run_id = js_integer(run).filter(|n| *n > 0).and_then(|n| i32::try_from(n).ok())?;
    let index = js_integer(idx)
        .filter(|n| *n >= 0)
        .and_then(|n| usize::try_from(n).ok())?;
    if step.is_empty() {
        return None;
    }
    Some((run_id, step.to_owned(), index))
}

/// `Number(s)` rồi `Number.isInteger`: chuỗi thập phân thuần (có thể rỗng ⇒ 0).
fn js_integer(s: &str) -> Option<i64> {
    let t = trinity_kernel::vi::trim_js(s);
    if t.is_empty() {
        return Some(0);
    }
    let f: f64 = t.parse().ok()?;
    (f.fract() == 0.0 && f.abs() < 9e15).then_some(f as i64)
}

/// Bước đi sau một bước không có nút: `next` đặt rõ, hoặc bước kế trong danh sách; hết danh sách ⇒ `None` (kết thúc).
pub fn next_after(steps: &[FlowStep], step: &FlowStep) -> Option<String> {
    if let Some(n) = &step.next {
        return n.clone();
    }
    let i = steps.iter().position(|s| s.id == step.id)?;
    steps.get(i + 1).map(|s| s.id.clone())
}

fn bad(msg: impl Into<trinity_kernel::error::Message>) -> HttpError {
    HttpError::bad_request(msg)
}

fn step_id_valid(id: &str) -> bool {
    (1..=16).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `Number(v)` của JS cho giá trị JSON; không đọc được (NaN) ⇒ `None`.
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => js_integer_or_float(s),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn js_integer_or_float(s: &str) -> Option<f64> {
    let t = trinity_kernel::vi::trim_js(s);
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// Chuỗi không rỗng sau khi cắt khoảng trắng.
fn trimmed_string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(trinity_kernel::vi::trim_js)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn clean_step(r: &Value, n: usize) -> Result<FlowStep, HttpError> {
    let empty = Map::new();
    let o = r.as_object().unwrap_or(&empty);
    let id = trimmed_string(o.get("id")).unwrap_or_else(|| format!("s{n}"));
    if !step_id_valid(&id) {
        return Err(bad(format!(
            "Bước {n}: mã bước chỉ gồm chữ, số, \"-\", \"_\" (tối đa 16 ký tự)"
        )));
    }
    let text = trimmed_string(o.get("text")).ok_or_else(|| bad(format!("Bước {n}: chưa có nội dung tin")))?;
    if text.encode_utf16().count() > MAX_TEXT {
        return Err(bad(format!("Bước {n}: tin tối đa {MAX_TEXT} ký tự")));
    }
    let mut step = FlowStep {
        id,
        text,
        wait_minutes: None,
        buttons: None,
        ask: None,
        next: None,
    };
    // `o.wait_minutes !== undefined && !== null && !== 0` (so sánh chặt: chuỗi "0" vẫn đi qua `Number`).
    if let Some(w) = o
        .get("wait_minutes")
        .filter(|v| !v.is_null() && v.as_f64() != Some(0.0))
    {
        let range = format!("Bước {n}: thời gian chờ từ 0 đến {MAX_WAIT_MINUTES} phút (23 giờ)");
        let Some(minutes) = js_number(w).filter(|f| f.fract() == 0.0 && *f >= 0.0 && *f <= MAX_WAIT_MINUTES as f64)
        else {
            return Err(bad(range));
        };
        if minutes > 0.0 {
            step.wait_minutes = Some(minutes as i64);
        }
    }
    let raw_buttons: &[Value] = o.get("buttons").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    if raw_buttons.len() > MAX_BUTTONS {
        return Err(bad(format!("Bước {n}: tối đa {MAX_BUTTONS} nút")));
    }
    if !raw_buttons.is_empty() {
        let mut buttons = Vec::with_capacity(raw_buttons.len());
        for (j, b) in raw_buttons.iter().enumerate() {
            let j = j + 1;
            let bo = b.as_object().unwrap_or(&empty);
            let title = trimmed_string(bo.get("title"))
                .ok_or_else(|| bad(format!("Bước {n}, nút {j}: chưa có chữ trên nút")))?;
            if title.encode_utf16().count() > MAX_BUTTON_TITLE {
                return Err(bad(format!(
                    "Bước {n}, nút {j}: chữ trên nút tối đa {MAX_BUTTON_TITLE} ký tự"
                )));
            }
            buttons.push(FlowButton {
                title,
                next: trimmed_string(bo.get("next")),
            });
        }
        step.buttons = Some(buttons);
    }
    if let Some(a) = o.get("ask").filter(|v| !v.is_null() && v.as_str() != Some("")) {
        let kind = match a {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        if !["phone", "email", "note"].contains(&kind.as_str()) {
            return Err(bad(format!("Bước {n}: kiểu câu hỏi phải là phone, email hoặc note")));
        }
        if step.buttons.is_some() {
            return Err(bad(format!(
                "Bước {n}: bước hỏi khách không kèm nút được — tách thành hai bước"
            )));
        }
        step.ask = Some(kind);
    }
    if let Some(nx) = o.get("next") {
        step.next = Some(trimmed_string(Some(nx)));
    }
    Ok(step)
}

/// Chuẩn hoá và kiểm danh sách bước (`cleanSteps`); lỗi ⇒ 400 bằng câu chữ của bản Node.
pub fn clean_steps(raw: &Value) -> Result<Vec<FlowStep>, HttpError> {
    let arr = match raw {
        Value::Array(a) if !a.is_empty() => a,
        _ => return Err(bad("Kịch bản cần ít nhất một bước")),
    };
    if arr.len() > MAX_STEPS {
        return Err(bad(format!("Kịch bản tối đa {MAX_STEPS} bước")));
    }
    let mut steps = Vec::with_capacity(arr.len());
    for (i, r) in arr.iter().enumerate() {
        steps.push(clean_step(r, i + 1)?);
    }
    let mut ids: HashSet<&str> = HashSet::new();
    for s in &steps {
        if !ids.insert(s.id.as_str()) {
            return Err(bad(format!("Mã bước \"{}\" bị trùng", s.id)));
        }
    }
    let known = |target: Option<&str>, place: String| -> Result<(), HttpError> {
        match target {
            Some(t) if !ids.contains(t) => Err(bad(format!("{place}: bước \"{t}\" không có trong kịch bản"))),
            _ => Ok(()),
        }
    };
    for (i, s) in steps.iter().enumerate() {
        known(s.next.as_ref().and_then(|n| n.as_deref()), format!("Bước {}", i + 1))?;
        for (j, b) in s.buttons.iter().flatten().enumerate() {
            known(b.next.as_deref(), format!("Bước {}, nút {}", i + 1, j + 1))?;
        }
    }
    // Vòng toàn bước tự đi (không nút, không hỏi) ⇒ gửi mãi không dừng.
    let by_id: HashMap<&str, &FlowStep> = steps.iter().map(|s| (s.id.as_str(), s)).collect();
    for start in &steps {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut cur: Option<&FlowStep> = Some(start);
        while let Some(c) = cur {
            if c.buttons.is_some() || c.ask.is_some() {
                break;
            }
            if !seen.insert(c.id.as_str()) {
                return Err(bad(format!(
                    "Các bước tự gửi nối thành vòng (qua bước \"{}\") — thêm nút, câu hỏi hoặc cho một bước kết thúc",
                    c.id
                )));
            }
            cur = next_after(&steps, c).and_then(|nx| by_id.get(nx.as_str()).copied());
        }
    }
    Ok(steps)
}

static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}").expect("regex email hợp lệ"));

/// Email đầu tiên trong câu trả lời của khách.
pub fn find_email(text: &str) -> Option<String> {
    EMAIL.find(text).map(|m| m.as_str().to_owned())
}

/// `[...new Set(keywords.map(trim).filter(Boolean).map(slice(0,100)))].slice(0, 30)`.
pub fn clean_keywords(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in raw {
        let t = trinity_kernel::vi::trim_js(k);
        if t.is_empty() {
            continue;
        }
        let t = utf16_prefix(t, KEYWORD_MAX);
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(MAX_KEYWORDS);
    out
}

static NULL: Value = Value::Null;

/// Body `POST/PATCH /facebook/flows` (`FlowDto`) đã kiểm. Dựng bằng [`FlowInput::from_json`]. `page_id` chỉ dùng khi tạo.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FlowInput {
    pub name: Option<String>,
    pub page_id: Option<String>,
    pub trigger: Option<String>,
    pub keywords: Option<Vec<String>>,
    /// `Some(None)` = bỏ link.
    pub chat_link_id: Option<Option<i32>>,
    /// Chưa làm sạch ([`clean_steps`] chạy ở service). `null` ⇒ `Some(Null)` ⇒ 400 "cần ít nhất một bước" như bản Node.
    pub steps: Option<Value>,
    pub is_active: Option<bool>,
}

impl FlowInput {
    /// `@IsOptional()` cho mọi trường (`null` như vắng, trừ `name`/`page_id`/`steps` mà service coi `null` như rỗng và báo 400 bằng
    /// câu riêng); `trigger` `@IsIn`; `keywords` mảng ≤30 chuỗi ≤100; `chat_link_id` `@ValidateIf(v != null) @IsInt`; `steps` mảng ≤20.
    /// Trường lạ ⇒ 400.
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let o = dto::object(v)?;
        let mut e = Vec::new();
        dto::unknown(
            o,
            &[
                "name",
                "page_id",
                "trigger",
                "keywords",
                "chat_link_id",
                "steps",
                "is_active",
            ],
            &mut e,
        );
        let name = dto::opt_string(o, "name", NAME_MAX, &mut e);
        let page_id = dto::opt_string(o, "page_id", PAGE_ID_MAX, &mut e);
        let trigger = match o.get("trigger") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if FLOW_TRIGGERS.contains(&s.as_str()) => Some(s.clone()),
            Some(_) => {
                e.push("trigger must be one of the following values: keyword, chat_link, first_message".to_owned());
                None
            }
        };
        let keywords = keywords_of(o, &mut e);
        let chat_link_id = dto::nullable_int(o, "chat_link_id", &mut e);
        let steps = match o.get("steps") {
            None => None,
            Some(Value::Null) => Some(Value::Null),
            Some(Value::Array(a)) if a.len() <= MAX_STEPS => Some(Value::Array(a.clone())),
            Some(Value::Array(_)) => {
                e.push(format!("steps must contain no more than {MAX_STEPS} elements"));
                None
            }
            Some(_) => {
                e.push(format!("steps must contain no more than {MAX_STEPS} elements"));
                e.push("steps must be an array".to_owned());
                None
            }
        };
        let is_active = dto::opt_bool(o, "is_active", &mut e);
        dto::finish(e)?;
        Ok(Self {
            name,
            page_id,
            trigger,
            keywords,
            chat_link_id,
            steps,
            is_active,
        })
    }
}

fn keywords_of(o: &dto::Obj, e: &mut Vec<String>) -> Option<Vec<String>> {
    match o.get("keywords") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => {
            let mut out = Vec::with_capacity(a.len());
            let (mut too_long, mut not_string) = (false, false);
            for k in a {
                match k {
                    Value::String(s) => {
                        too_long |= s.encode_utf16().count() > KEYWORD_MAX;
                        out.push(s.clone());
                    }
                    _ => not_string = true,
                }
            }
            if too_long {
                e.push(format!(
                    "each value in keywords must be shorter than or equal to {KEYWORD_MAX} characters"
                ));
            }
            if not_string {
                e.push("each value in keywords must be a string".to_owned());
            }
            if a.len() > MAX_KEYWORDS {
                e.push(format!("keywords must contain no more than {MAX_KEYWORDS} elements"));
            }
            (!too_long && !not_string && a.len() <= MAX_KEYWORDS).then_some(out)
        }
        Some(_) => {
            e.push(format!("keywords must contain no more than {MAX_KEYWORDS} elements"));
            e.push("keywords must be an array".to_owned());
            None
        }
    }
}

// ───────────────────────── route (K14)

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 6 route `flows` và `tick` của `FacebookController`; nối vào bảng route của binary ở `trinity-bin/src/routes.rs`.
pub fn flow_routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["integrations.webhooks"]);
    let r =
        |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, manage).status_ok(ok).org_feature("facebook_page");
    vec![
        r(Method::GET, "/api/v1/facebook/flows", 200),
        r(Method::POST, "/api/v1/facebook/flows", 201),
        r(Method::GET, "/api/v1/facebook/flows/:id", 200).param_pipes(ID),
        r(Method::GET, "/api/v1/facebook/flows/:id/runs", 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/facebook/flows/:id", 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/facebook/flows/:id", 204).param_pipes(ID),
    ]
}

/// Khai báo job `facebook.flows` (60 giây, budget 30 giây) cho `Scheduler::register`: mỗi công ty chạy
/// [`FacebookIngest::flows_run_due`].
pub fn flows_job(ingest: Arc<FacebookIngest>) -> Result<JobSpec, SchedulerError> {
    JobSpec::new(JOB_NAME, JOB_INTERVAL, JOB_BUDGET, move |company: CompanyRef| {
        let ingest = Arc::clone(&ingest);
        async move {
            ingest
                .flows_run_due(company, RUN_BUDGET, Utc::now())
                .await
                .map(drop)
                .map_err(|e| format!("{e:?}"))
        }
    })
}

// ───────────────────────── DB

fn iso(t: &Timestamp) -> String {
    trinity_kernel::vn_time::js_iso_string(t.0)
}

fn not_found() -> AppError {
    HttpError::not_found(NOT_FOUND).into()
}

async fn find_flow(conn: &mut PgConnection, id: i32) -> Result<Option<FacebookFlow>, AppError> {
    sqlx::query_as::<_, FacebookFlow>(sqlx::AssertSqlSafe(format!(
        "SELECT {FLOW_COLS} FROM facebook_flows WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

async fn find_run(conn: &mut PgConnection, id: i32) -> Result<Option<FacebookFlowRun>, AppError> {
    sqlx::query_as::<_, FacebookFlowRun>(sqlx::AssertSqlSafe(format!(
        "SELECT {RUN_COLS} FROM facebook_flow_runs WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)
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

/// Thêm `page_name`, `chat_link_name`, `running` (số lượt đang dở) cho từng kịch bản (`views`).
async fn views(conn: &mut PgConnection, rows: &[FacebookFlow]) -> Result<Vec<Value>, AppError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
    let page_ids: Vec<String> = rows.iter().map(|r| r.page_id.clone()).collect();
    let link_ids: Vec<i32> = rows.iter().filter_map(|r| r.chat_link_id).collect();
    let pages: Vec<(String, String)> =
        sqlx::query_as("SELECT page_id, name FROM facebook_pages WHERE page_id = ANY($1)")
            .bind(&page_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let links: Vec<(i32, String)> = sqlx::query_as("SELECT id, name FROM facebook_chat_links WHERE id = ANY($1)")
        .bind(&link_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let running: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT flow_id, count(*) FROM facebook_flow_runs WHERE flow_id = ANY($1) AND status = ANY($2) GROUP BY flow_id",
    )
    .bind(&ids)
    .bind(active_statuses())
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let page_name: HashMap<String, String> = pages.into_iter().collect();
    let link_name: HashMap<i32, String> = links.into_iter().collect();
    let run_count: HashMap<i32, i64> = running.into_iter().collect();
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id, "name": r.name, "page_id": r.page_id, "trigger": r.trigger, "keywords": r.keywords.0,
                "chat_link_id": r.chat_link_id, "steps": r.steps.0, "is_active": r.is_active,
                "starts": r.starts, "completes": r.completes, "created_by": r.created_by,
                "created_at": iso(&r.created_at), "updated_at": iso(&r.updated_at),
                "page_name": page_name.get(&r.page_id),
                "chat_link_name": r.chat_link_id.and_then(|l| link_name.get(&l)),
                "running": run_count.get(&r.id).copied().unwrap_or(0),
            })
        })
        .collect())
}

async fn one_view(conn: &mut PgConnection, row: FacebookFlow) -> Result<Value, AppError> {
    let mut v = views(conn, std::slice::from_ref(&row)).await?;
    v.pop().ok_or_else(|| AppError::internal("kịch bản không có view"))
}

/// Dữ liệu đã chuẩn hoá của `validate`; trường `None` = không đổi (chỉ khi sửa).
#[derive(Default)]
struct Validated {
    name: Option<String>,
    page_id: Option<String>,
    trigger: Option<String>,
    keywords: Option<Vec<String>>,
    chat_link_id: Option<Option<i32>>,
    steps: Option<Vec<FlowStep>>,
    is_active: Option<bool>,
}

/// Cách một lượt nối tiếp sau khi thử gửi một bước.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    Sent,
    /// Lượt đã được ghi kết cục (kết thúc / hẹn lại): người gọi dừng.
    Stopped,
}

impl FacebookIngest {
    async fn flow_begin(&self, company: CompanyRef) -> Result<TenantTx, AppError> {
        self.db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)
    }

    // ───────────── quản trị

    /// `GET /facebook/flows`: mới nhất trước.
    pub async fn list_flows(&self, company: CompanyRef) -> Result<Vec<Value>, AppError> {
        let mut c = self.acquire(company).await?;
        let rows = sqlx::query_as::<_, FacebookFlow>(sqlx::AssertSqlSafe(format!(
            "SELECT {FLOW_COLS} FROM facebook_flows ORDER BY id DESC"
        )))
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
        views(&mut c, &rows).await
    }

    /// `GET /facebook/flows/:id`.
    pub async fn get_flow(&self, company: CompanyRef, id: i32) -> Result<Value, AppError> {
        let mut c = self.acquire(company).await?;
        let row = find_flow(&mut c, id).await?.ok_or_else(not_found)?;
        one_view(&mut c, row).await
    }

    /// `POST /facebook/flows` (201): kịch bản mới mặc định TẮT (`is_active` trống = false).
    pub async fn create_flow(&self, company: CompanyRef, input: &FlowInput, user_id: i32) -> Result<Value, AppError> {
        let d = self.flow_validate(company, input, None).await?;
        let steps = d.steps.as_deref().map(steps_to_json).unwrap_or(Value::Null);
        let mut c = self.acquire(company).await?;
        let row = sqlx::query_as::<_, FacebookFlow>(sqlx::AssertSqlSafe(format!(
            "INSERT INTO facebook_flows (name, page_id, trigger, keywords, chat_link_id, steps, is_active, created_by, updated_at) \
             VALUES ($1, $2, $3, $4::text[], $5, $6::text::jsonb, $7, $8, now()) RETURNING {FLOW_COLS}"
        )))
        .bind(d.name.unwrap_or_default())
        .bind(d.page_id.unwrap_or_default())
        .bind(d.trigger.unwrap_or_default())
        .bind(d.keywords.unwrap_or_default())
        .bind(d.chat_link_id.flatten())
        .bind(trinity_kernel::json::js_json(&steps))
        .bind(d.is_active.unwrap_or(false))
        .bind(user_id)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
        one_view(&mut c, row).await
    }

    /// `PATCH /facebook/flows/:id`: sửa / bật / tắt (không đổi Page). Tắt hoặc đổi bước ⇒ lượt đang dở dừng lại.
    pub async fn update_flow(&self, company: CompanyRef, id: i32, input: &FlowInput) -> Result<Value, AppError> {
        let cur = {
            let mut c = self.acquire(company).await?;
            find_flow(&mut c, id).await?.ok_or_else(not_found)?
        };
        let d = self.flow_validate(company, input, Some(&cur)).await?;
        let stop = input.is_active == Some(false) || d.steps.is_some();
        let mut tx = self.flow_begin(company).await?;
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE facebook_flows SET updated_at = now()");
        if let Some(n) = d.name {
            qb.push(", name = ").push_bind(n);
        }
        if let Some(t) = d.trigger {
            qb.push(", trigger = ").push_bind(t);
        }
        if let Some(k) = d.keywords {
            qb.push(", keywords = ").push_bind(k).push("::text[]");
        }
        if let Some(l) = d.chat_link_id {
            qb.push(", chat_link_id = ").push_bind(l);
        }
        if let Some(s) = &d.steps {
            qb.push(", steps = ")
                .push_bind(trinity_kernel::json::js_json(&steps_to_json(s)))
                .push("::text::jsonb");
        }
        if let Some(a) = d.is_active {
            qb.push(", is_active = ").push_bind(a);
        }
        qb.push(" WHERE id = ")
            .push_bind(id)
            .push(format!(" RETURNING {FLOW_COLS}"));
        let row = qb
            .build_query_as::<FacebookFlow>()
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if stop {
            // Tắt hoặc đổi bước ⇒ lượt đang dở dừng lại (bước cũ có thể không còn).
            sqlx::query(
                "UPDATE facebook_flow_runs SET status = 'stopped', step_id = NULL, due_at = NULL, \
                 note = 'Kịch bản đã sửa hoặc tắt', updated_at = now() WHERE flow_id = $1 AND status = ANY($2)",
            )
            .bind(id)
            .bind(active_statuses())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
        tx.commit().await.map_err(platform_db)?;
        let mut c = self.acquire(company).await?;
        one_view(&mut c, row).await
    }

    /// `DELETE /facebook/flows/:id` (204): xoá kịch bản và lịch sử lượt chạy (tin đã gửi giữ nguyên trong hộp thư).
    pub async fn delete_flow(&self, company: CompanyRef, id: i32) -> Result<(), AppError> {
        {
            let mut c = self.acquire(company).await?;
            find_flow(&mut c, id).await?.ok_or_else(not_found)?;
        }
        let mut tx = self.flow_begin(company).await?;
        sqlx::query("DELETE FROM facebook_flow_runs WHERE flow_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM facebook_flows WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(platform_db)
    }

    /// `GET /facebook/flows/:id/runs`: lượt chạy gần nhất (mặc định 50, tối đa 200) kèm tên khách.
    pub async fn flow_runs(
        &self,
        company: CompanyRef,
        flow_id: i32,
        limit: Option<&str>,
    ) -> Result<Vec<Value>, AppError> {
        // `limit ? Number(limit) || 50 : 50`, rồi kẹp 1..200.
        let n = limit
            .filter(|s| !s.is_empty())
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|f| f.is_finite() && *f != 0.0)
            .map_or(50, |f| f.trunc().clamp(1.0, 200.0) as i64);
        let mut c = self.acquire(company).await?;
        find_flow(&mut c, flow_id).await?.ok_or_else(not_found)?;
        #[allow(clippy::type_complexity)]
        let rows: Vec<(
            i32,
            i32,
            i32,
            Option<String>,
            String,
            Option<Timestamp>,
            Option<String>,
            Timestamp,
            Timestamp,
            Option<String>,
            Option<i32>,
        )> = sqlx::query_as(
            "SELECT r.id, r.flow_id, r.conversation_id, r.step_id, r.status, r.due_at, r.note, r.started_at, r.updated_at, \
             c.customer_name, c.contact_id FROM facebook_flow_runs r \
             LEFT JOIN facebook_conversations c ON c.id = r.conversation_id \
             WHERE r.flow_id = $1 ORDER BY r.started_at DESC, r.id DESC LIMIT $2",
        )
        .bind(flow_id)
        .bind(n)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
        Ok(rows
            .into_iter()
            .map(|r| {
                json!({
                    "id": r.0, "flow_id": r.1, "conversation_id": r.2, "step_id": r.3, "status": r.4,
                    "due_at": r.5.as_ref().map(iso), "note": r.6, "started_at": iso(&r.7), "updated_at": iso(&r.8),
                    "customer_name": r.9, "contact_id": r.10,
                })
            })
            .collect())
    }

    async fn flow_validate(
        &self,
        company: CompanyRef,
        input: &FlowInput,
        cur: Option<&FacebookFlow>,
    ) -> Result<Validated, AppError> {
        let mut out = Validated::default();
        if cur.is_none() || input.name.is_some() {
            let name = trinity_kernel::vi::trim_js(input.name.as_deref().unwrap_or(""));
            if name.is_empty() {
                return Err(bad("Đặt tên cho kịch bản (vd \"Chào khách mới\", \"Báo giá khoá học\")").into());
            }
            out.name = Some(utf16_prefix(name, NAME_MAX));
        }
        if cur.is_none() {
            let page_id = input.page_id.as_deref().unwrap_or("");
            let found: bool = if page_id.is_empty() {
                false
            } else {
                let mut c = self.acquire(company).await?;
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM facebook_pages WHERE page_id = $1)")
                    .bind(page_id)
                    .fetch_one(&mut *c)
                    .await
                    .map_err(db)?
            };
            if !found {
                return Err(bad("Chọn Fanpage đã kết nối").into());
            }
            out.page_id = Some(page_id.to_owned());
        }
        let page_id = cur
            .map(|c| c.page_id.clone())
            .or_else(|| out.page_id.clone())
            .unwrap_or_default();
        let trigger = input
            .trigger
            .clone()
            .or_else(|| cur.map(|c| c.trigger.clone()))
            .filter(|t| FLOW_TRIGGERS.contains(&t.as_str()));
        let Some(trigger) = trigger else {
            return Err(bad("Cách bắt đầu phải là keyword, chat_link hoặc first_message").into());
        };
        if input.trigger.is_some() {
            out.trigger = Some(trigger.clone());
        }
        if let Some(k) = &input.keywords {
            out.keywords = Some(clean_keywords(k));
        }
        let keyword_count = match &out.keywords {
            Some(k) => k.len(),
            None => cur.map_or(0, |c| c.keywords.0.len()),
        };
        if trigger == "keyword" && keyword_count == 0 {
            return Err(bad("Kịch bản theo từ khoá cần ít nhất một từ khoá").into());
        }
        if let Some(l) = input.chat_link_id {
            out.chat_link_id = Some(l);
        }
        let link_id = match out.chat_link_id {
            Some(l) => l,
            None => cur.and_then(|c| c.chat_link_id),
        };
        if trigger == "chat_link" {
            let same_page = match link_id {
                Some(id) => {
                    let mut c = self.acquire(company).await?;
                    let link_page: Option<String> =
                        sqlx::query_scalar("SELECT page_id FROM facebook_chat_links WHERE id = $1")
                            .bind(id)
                            .fetch_optional(&mut *c)
                            .await
                            .map_err(db)?;
                    link_page.as_deref() == Some(page_id.as_str())
                }
                None => false,
            };
            if !same_page {
                return Err(bad("Chọn link/QR mở chat của cùng Fanpage").into());
            }
        } else if input.trigger.is_some() {
            out.chat_link_id = Some(None);
        }
        if cur.is_none() || input.steps.is_some() {
            out.steps = Some(clean_steps(input.steps.as_ref().unwrap_or(&NULL))?);
        }
        out.is_active = input.is_active;
        Ok(out)
    }

    // ───────────── chạy

    /// Gọi từ webhook SAU `ingest_referral` và `ingest_message` (`handleEvent`). `is_new` = tin này vừa được ghi (không phải Meta gửi
    /// lại): chỉ khi đó mới xử lý nút bấm, câu trả lời và từ khoá. Trả `true` nếu có kịch bản chạy hoặc đi tiếp.
    pub async fn handle_flow_event(
        &self,
        company: CompanyRef,
        page_id: &str,
        ev: &Value,
        is_new: bool,
    ) -> Result<bool, AppError> {
        if ev.pointer("/message/is_echo") == Some(&Value::Bool(true)) {
            return Ok(false);
        }
        let Some(psid) = str_of(ev.pointer("/sender/id")) else {
            return Ok(false);
        };
        let conv_id: Option<i32> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar("SELECT id FROM facebook_conversations WHERE page_id = $1 AND psid = $2")
                .bind(page_id)
                .bind(&psid)
                .fetch_optional(&mut *c)
                .await
                .map_err(db)?
        };
        let Some(conv_id) = conv_id else {
            return Ok(false);
        };

        if let Some(code) = referral_ref(ev) {
            let flow = {
                let mut c = self.acquire(company).await?;
                let link: Option<(i32, String, bool)> =
                    sqlx::query_as("SELECT id, page_id, is_active FROM facebook_chat_links WHERE code = $1")
                        .bind(&code)
                        .fetch_optional(&mut *c)
                        .await
                        .map_err(db)?;
                match link {
                    Some((link_id, link_page, true)) if link_page == page_id => {
                        sqlx::query_as::<_, FacebookFlow>(sqlx::AssertSqlSafe(format!(
                            "SELECT {FLOW_COLS} FROM facebook_flows WHERE page_id = $1 AND is_active = true \
                             AND trigger = 'chat_link' AND chat_link_id = $2 ORDER BY id DESC LIMIT 1"
                        )))
                        .bind(page_id)
                        .bind(link_id)
                        .fetch_optional(&mut *c)
                        .await
                        .map_err(db)?
                    }
                    _ => None,
                }
            };
            if let Some(flow) = flow {
                return self.flow_start(company, &flow, conv_id).await;
            }
        }
        if !is_new || ev.get("message").is_none_or(Value::is_null) {
            return Ok(false);
        }

        if let Some((run_id, step_id, index)) =
            parse_button_payload(ev.pointer("/message/quick_reply/payload").and_then(Value::as_str))
        {
            return self.flow_on_button(company, conv_id, run_id, &step_id, index).await;
        }

        let text = ev.pointer("/message/text").and_then(Value::as_str);
        let active: Option<FacebookFlowRun> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_as::<_, FacebookFlowRun>(sqlx::AssertSqlSafe(format!(
                "SELECT {RUN_COLS} FROM facebook_flow_runs WHERE conversation_id = $1 AND status = ANY($2) \
                 ORDER BY id DESC LIMIT 1"
            )))
            .bind(conv_id)
            .bind(active_statuses())
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?
        };
        if let (Some(run), Some(t)) = (&active, text)
            && run.status == "waiting_answer"
            && !t.is_empty()
        {
            return self.flow_on_answer(company, run, t).await;
        }

        if let Some(t) = text.filter(|t| !t.is_empty()) {
            let flows = {
                let mut c = self.acquire(company).await?;
                sqlx::query_as::<_, FacebookFlow>(sqlx::AssertSqlSafe(format!(
                    "SELECT {FLOW_COLS} FROM facebook_flows WHERE page_id = $1 AND is_active = true \
                     AND trigger = 'keyword' ORDER BY id DESC"
                )))
                .bind(page_id)
                .fetch_all(&mut *c)
                .await
                .map_err(db)?
            };
            if let Some(hit) = flows
                .iter()
                .find(|f| !f.keywords.0.is_empty() && matches_keywords(Some(t), &f.keywords.0, &[]))
            {
                return self.flow_start(company, hit, conv_id).await;
            }
        }
        // Đang chờ khách bấm nút / chờ giờ gửi ⇒ tin thường để nhân viên xử lý.
        if active.is_some() {
            return Ok(false);
        }

        let welcome = {
            let mut c = self.acquire(company).await?;
            let inbound: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM facebook_messages WHERE conversation_id = $1 AND direction = 'in'",
            )
            .bind(conv_id)
            .fetch_one(&mut *c)
            .await
            .map_err(db)?;
            if inbound != 1 {
                return Ok(false);
            }
            let had_run: bool =
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM facebook_flow_runs WHERE conversation_id = $1)")
                    .bind(conv_id)
                    .fetch_one(&mut *c)
                    .await
                    .map_err(db)?;
            if had_run {
                return Ok(false);
            }
            sqlx::query_as::<_, FacebookFlow>(sqlx::AssertSqlSafe(format!(
                "SELECT {FLOW_COLS} FROM facebook_flows WHERE page_id = $1 AND is_active = true \
                 AND trigger = 'first_message' ORDER BY id DESC LIMIT 1"
            )))
            .bind(page_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?
        };
        match welcome {
            Some(f) => self.flow_start(company, &f, conv_id).await,
            None => Ok(false),
        }
    }

    /// Bắt đầu kịch bản cho hội thoại: dừng lượt khác đang dở, chạy từ bước đầu. Cùng kịch bản đã chạy trong 10 phút ⇒ bỏ qua.
    pub async fn flow_start(&self, company: CompanyRef, flow: &FacebookFlow, conv_id: i32) -> Result<bool, AppError> {
        let since = Utc::now() - chrono::Duration::milliseconds(RESTART_GUARD_MS);
        let recent: bool = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM facebook_flow_runs WHERE flow_id = $1 AND conversation_id = $2 \
                 AND started_at >= $3)",
            )
            .bind(flow.id)
            .bind(conv_id)
            .bind(since)
            .fetch_one(&mut *c)
            .await
            .map_err(db)?
        };
        if recent {
            return Ok(false);
        }
        let steps = steps_from_json(&flow.steps.0);
        let Some(first) = steps.first() else {
            return Ok(false);
        };
        let mut tx = self.flow_begin(company).await?;
        sqlx::query(
            "UPDATE facebook_flow_runs SET status = 'stopped', step_id = NULL, due_at = NULL, note = $3::text, \
             updated_at = now() WHERE conversation_id = $1 AND status = ANY($2)",
        )
        .bind(conv_id)
        .bind(active_statuses())
        .bind(utf16_prefix(&format!("Chuyển sang kịch bản \"{}\"", flow.name), 300))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("UPDATE facebook_flows SET starts = starts + 1, updated_at = now() WHERE id = $1")
            .bind(flow.id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let run_id: i32 = sqlx::query_scalar(
            "INSERT INTO facebook_flow_runs (flow_id, conversation_id, step_id, status, updated_at) \
             VALUES ($1, $2, $3, 'sending', now()) RETURNING id",
        )
        .bind(flow.id)
        .bind(conv_id)
        .bind(&first.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(platform_db)?;
        self.flow_note(
            company,
            conv_id,
            &format!("Bắt đầu kịch bản nhắn tin \"{}\"", flow.name),
            json!({ "flow_id": flow.id, "run_id": run_id }),
        )
        .await;
        self.flow_advance(company, run_id, conv_id, flow, &steps, Some(first.id.clone()), false)
            .await?;
        Ok(true)
    }

    async fn flow_on_button(
        &self,
        company: CompanyRef,
        conv_id: i32,
        run_id: i32,
        step_id: &str,
        index: usize,
    ) -> Result<bool, AppError> {
        let (run, flow) = {
            let mut c = self.acquire(company).await?;
            let Some(run) = find_run(&mut c, run_id).await? else {
                return Ok(false);
            };
            if run.conversation_id != conv_id
                || run.status != "waiting_button"
                || run.step_id.as_deref() != Some(step_id)
            {
                return Ok(false);
            }
            let Some(flow) = find_flow(&mut c, run.flow_id).await?.filter(|f| f.is_active) else {
                return Ok(false);
            };
            (run, flow)
        };
        let steps = steps_from_json(&flow.steps.0);
        let next = {
            let button = steps
                .iter()
                .find(|s| s.id == step_id)
                .and_then(|s| s.buttons.as_ref())
                .and_then(|b| b.get(index));
            let Some(button) = button else {
                return Ok(false);
            };
            button.next.clone()
        };
        if !self.flow_claim(company, run.id, "waiting_button").await? {
            return Ok(false);
        }
        self.flow_advance(company, run.id, conv_id, &flow, &steps, next, false)
            .await?;
        Ok(true)
    }

    async fn flow_on_answer(&self, company: CompanyRef, run: &FacebookFlowRun, text: &str) -> Result<bool, AppError> {
        let flow = {
            let mut c = self.acquire(company).await?;
            find_flow(&mut c, run.flow_id).await?
        };
        let Some(flow) = flow.filter(|f| f.is_active) else {
            return Ok(false);
        };
        let steps = steps_from_json(&flow.steps.0);
        let Some(step) = steps.iter().find(|s| Some(s.id.as_str()) == run.step_id.as_deref()) else {
            return Ok(false);
        };
        let Some(ask) = step.ask.as_deref() else {
            return Ok(false);
        };
        if !self.flow_claim(company, run.id, "waiting_answer").await? {
            return Ok(false);
        }
        let contact_id: Option<i32> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar::<_, Option<i32>>("SELECT contact_id FROM facebook_conversations WHERE id = $1")
                .bind(run.conversation_id)
                .fetch_optional(&mut *c)
                .await
                .map_err(db)?
                .flatten()
        };
        let answer = utf16_prefix(trinity_kernel::vi::trim_js(text), ANSWER_MAX);
        let mut saved = answer.clone();
        let retried = run.note.as_deref() == Some("retry");
        match ask {
            "phone" => {
                let phone = find_vn_phone(Some(&answer));
                if phone.is_none() && !retried {
                    // Chưa nhận ra số ⇒ hỏi lại MỘT lần, vẫn chờ ở bước này.
                    return self.flow_ask_again(company, run, &flow, step, RETRY_PHONE).await;
                }
                if let (Some(phone), Some(cid)) = (phone, contact_id) {
                    saved = phone.clone();
                    self.flow_save_phone(company, cid, &phone).await;
                }
            }
            "email" => {
                let email = find_email(&answer);
                if email.is_none() && !retried {
                    return self.flow_ask_again(company, run, &flow, step, RETRY_EMAIL).await;
                }
                if let (Some(email), Some(cid)) = (email, contact_id) {
                    saved = email.clone();
                    self.flow_save_email(company, cid, &email).await;
                }
            }
            _ => {}
        }
        self.flow_note(
            company,
            run.conversation_id,
            &format!(
                "Kịch bản \"{}\" — khách trả lời \"{}\": {saved}",
                flow.name,
                utf16_prefix(&step.text, 120)
            ),
            json!({ "flow_id": flow.id, "run_id": run.id, "ask": ask }),
        )
        .await;
        {
            let mut c = self.acquire(company).await?;
            sqlx::query(
                "UPDATE facebook_flow_runs SET note = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'",
            )
            .bind(run.id)
            .execute(&mut *c)
            .await
            .map_err(db)?;
        }
        self.flow_advance(
            company,
            run.id,
            run.conversation_id,
            &flow,
            &steps,
            next_after(&steps, step),
            false,
        )
        .await?;
        Ok(true)
    }

    /// Nhắc khách trả lời lại (một lần) rồi vẫn chờ ở bước hỏi; gửi không được (hết cửa sổ, Page tắt…) thì lượt đã có kết cục riêng.
    async fn flow_ask_again(
        &self,
        company: CompanyRef,
        run: &FacebookFlowRun,
        flow: &FacebookFlow,
        step: &FlowStep,
        text: &str,
    ) -> Result<bool, AppError> {
        let nudge = FlowStep {
            id: step.id.clone(),
            text: text.to_owned(),
            wait_minutes: None,
            buttons: None,
            ask: None,
            next: None,
        };
        if self
            .flow_send(company, run.id, run.conversation_id, flow, &nudge)
            .await?
            == Sent::Sent
        {
            let mut c = self.acquire(company).await?;
            sqlx::query(
                "UPDATE facebook_flow_runs SET status = 'waiting_answer', note = 'retry', updated_at = now() \
                 WHERE id = $1 AND status = 'sending'",
            )
            .bind(run.id)
            .execute(&mut *c)
            .await
            .map_err(db)?;
        }
        Ok(true)
    }

    /// SĐT khách trả lời: điền vào khách nếu chưa có, hoặc vào `phone_2` nếu khác số chính và `phone_2` còn trống. Lỗi chỉ ghi log.
    async fn flow_save_phone(&self, company: CompanyRef, contact_id: i32, phone: &str) {
        let r: Result<(), AppError> = async {
            let mut c = self.acquire(company).await?;
            let cur: Option<(String, Option<String>)> =
                sqlx::query_as("SELECT phone, phone_2 FROM contacts WHERE id = $1")
                    .bind(contact_id)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(db)?;
            let Some((main, second)) = cur else {
                return Ok(());
            };
            let sql = if main.is_empty() {
                "UPDATE contacts SET phone = $2, updated_at = now() WHERE id = $1"
            } else if main != phone && second.as_deref().is_none_or(str::is_empty) {
                "UPDATE contacts SET phone_2 = $2, updated_at = now() WHERE id = $1"
            } else {
                return Ok(());
            };
            sqlx::query(sql)
                .bind(contact_id)
                .bind(phone)
                .execute(&mut *c)
                .await
                .map_err(db)?;
            Ok(())
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Kịch bản không lưu được SĐT vào khách {contact_id}: {e:?}");
        }
    }

    async fn flow_save_email(&self, company: CompanyRef, contact_id: i32, email: &str) {
        let r: Result<(), AppError> = async {
            let mut c = self.acquire(company).await?;
            sqlx::query(
                "UPDATE contacts SET email = $2, updated_at = now() WHERE id = $1 AND (email IS NULL OR email = '')",
            )
            .bind(contact_id)
            .bind(email)
            .execute(&mut *c)
            .await
            .map_err(db)?;
            Ok(())
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Kịch bản không lưu được email vào khách {contact_id}: {e:?}");
        }
    }

    /// Giành lượt (`from` → `sending`): webhook gửi lại hay job chạy song song không gửi trùng. Đúng một tiến trình thắng.
    async fn flow_claim(&self, company: CompanyRef, run_id: i32, from: &str) -> Result<bool, AppError> {
        let mut c = self.acquire(company).await?;
        let n = sqlx::query(
            "UPDATE facebook_flow_runs SET status = 'sending', updated_at = now() WHERE id = $1 AND status = $2",
        )
        .bind(run_id)
        .bind(from)
        .execute(&mut *c)
        .await
        .map_err(db)?
        .rows_affected();
        Ok(n == 1)
    }

    /// Đi từ bước `start`: gửi tin, rồi dừng ở bước có nút/câu hỏi/thời gian chờ, hoặc đi tiếp tới hết. `waited` = bước đầu đã chờ
    /// đủ (job gọi) ⇒ không đặt lịch lại.
    #[allow(clippy::too_many_arguments)]
    async fn flow_advance(
        &self,
        company: CompanyRef,
        run_id: i32,
        conv_id: i32,
        flow: &FacebookFlow,
        steps: &[FlowStep],
        start: Option<String>,
        waited: bool,
    ) -> Result<(), AppError> {
        let mut cur = start;
        let mut skip_wait = waited;
        let mut sent = 0_usize;
        loop {
            let Some(step) = cur.as_deref().and_then(|id| steps.iter().find(|s| s.id == id)) else {
                return self.flow_finish(company, run_id, "done", None, Some(flow.id)).await;
            };
            if sent >= MAX_SENDS_PER_PASS {
                return self
                    .flow_finish(company, run_id, "failed", Some("Quá nhiều tin liên tiếp"), None)
                    .await;
            }
            if let Some(w) = step.wait_minutes.filter(|_| !skip_wait) {
                let due = Utc::now() + chrono::Duration::minutes(w);
                return self
                    .flow_set(company, run_id, "scheduled", Some(&step.id), Some(due))
                    .await;
            }
            skip_wait = false;
            if self.flow_send(company, run_id, conv_id, flow, step).await? == Sent::Stopped {
                return Ok(());
            }
            if step.buttons.is_some() {
                return self
                    .flow_set(company, run_id, "waiting_button", Some(&step.id), None)
                    .await;
            }
            if step.ask.is_some() {
                return self
                    .flow_set(company, run_id, "waiting_answer", Some(&step.id), None)
                    .await;
            }
            cur = next_after(steps, step);
            sent += 1;
        }
    }

    /// Chuyển trạng thái của lượt đang `sending` (không đè lượt đã bị dừng/tắt giữa chừng).
    async fn flow_set(
        &self,
        company: CompanyRef,
        run_id: i32,
        status: &str,
        step_id: Option<&str>,
        due_at: Option<DateTime<Utc>>,
    ) -> Result<(), AppError> {
        let mut c = self.acquire(company).await?;
        sqlx::query(
            "UPDATE facebook_flow_runs SET status = $2::text, step_id = $3::text, due_at = $4, updated_at = now() \
             WHERE id = $1 AND status = 'sending'",
        )
        .bind(run_id)
        .bind(status)
        .bind(step_id)
        .bind(due_at)
        .execute(&mut *c)
        .await
        .map_err(db)?;
        Ok(())
    }

    /// Kết thúc lượt; `done` cộng `completes` của kịch bản.
    async fn flow_finish(
        &self,
        company: CompanyRef,
        run_id: i32,
        status: &str,
        note: Option<&str>,
        flow_id: Option<i32>,
    ) -> Result<(), AppError> {
        let mut tx = self.flow_begin(company).await?;
        sqlx::query(
            "UPDATE facebook_flow_runs SET status = $2::text, step_id = NULL, due_at = NULL, note = $3::text, \
             updated_at = now() WHERE id = $1",
        )
        .bind(run_id)
        .bind(status)
        .bind(note.map(|n| utf16_prefix(n, 300)))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        if status == "done"
            && let Some(f) = flow_id
        {
            sqlx::query("UPDATE facebook_flows SET completes = completes + 1, updated_at = now() WHERE id = $1")
                .bind(f)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(platform_db)
    }

    /// Gửi một bước (trong cửa sổ 24 giờ). Mọi lỗi đều ghi kết cục cho lượt rồi trả [`Sent::Stopped`].
    async fn flow_send(
        &self,
        company: CompanyRef,
        run_id: i32,
        conv_id: i32,
        flow: &FacebookFlow,
        step: &FlowStep,
    ) -> Result<Sent, AppError> {
        let _ = flow;
        let conv = {
            let mut c = self.acquire(company).await?;
            find_conversation(&mut c, conv_id).await?
        };
        let Some(conv) = conv else {
            self.flow_finish(company, run_id, "stopped", Some("Hội thoại không còn"), None)
                .await?;
            return Ok(Sent::Stopped);
        };
        let last_inbound = conv.last_inbound_at.map(|t| t.0.timestamp_millis());
        if !within_messaging_window(last_inbound, Utc::now().timestamp_millis()) {
            self.flow_finish(company, run_id, "expired", Some(OUTSIDE_NOTE), None)
                .await?;
            return Ok(Sent::Stopped);
        }
        // Kịch bản là gửi tự động: khoá kênh / tự tạm dừng (Facebook báo chặn, spam) ⇒ không gửi thêm.
        if let Some(g) = self.guard.as_deref()
            && let Some(r) = g.block_reason(company, OutboundMode::Auto, OutboundScope::Meta).await?
        {
            match pause_due(&r.code, r.until, Utc::now()) {
                // Tạm dừng: hẹn lại bước này sau khi hết tạm dừng (job gửi tiếp); KHÔNG huỷ lượt.
                Some(due) => {
                    let mut c = self.acquire(company).await?;
                    sqlx::query(
                        "UPDATE facebook_flow_runs SET status = 'scheduled', step_id = $2::text, due_at = $3, \
                         note = $4::text, updated_at = now() WHERE id = $1 AND status = 'sending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(due)
                    .bind(utf16_prefix(&r.message, 300))
                    .execute(&mut *c)
                    .await
                    .map_err(db)?;
                }
                _ => {
                    self.flow_finish(company, run_id, "stopped", Some(&r.message), None)
                        .await?;
                }
            }
            return Ok(Sent::Stopped);
        }
        let found = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, &conv.page_id).await?
        };
        let Some((_, token)) = found else {
            self.flow_finish(company, run_id, "failed", Some("Fanpage đã tắt hoặc mất kết nối"), None)
                .await?;
            return Ok(Sent::Stopped);
        };
        let text = fill_template(&step.text, conv.customer_name.as_deref());
        let graph = (self.graph_for)(company);
        let result = match step.buttons.as_deref().filter(|b| !b.is_empty()) {
            Some(buttons) => {
                let quick: Vec<(String, String)> = buttons
                    .iter()
                    .enumerate()
                    .map(|(i, b)| (b.title.clone(), button_payload(run_id, &step.id, i)))
                    .collect();
                graph.send_quick_replies(&token, &conv.psid, &text, &quick).await
            }
            None => graph.send_text(&token, &conv.psid, &text, false).await,
        };
        match result {
            Ok(sent) => {
                if let Err(e) = self.flow_record_out(company, &conv, &sent.message_id, &text).await {
                    tracing::warn!("Ghi tin kịch bản vào hộp thư lỗi (hội thoại {}): {e:?}", conv.id);
                }
                Ok(Sent::Sent)
            }
            Err(e) => {
                self.flow_map_graph_error(company, run_id, &conv.page_id, &e).await?;
                Ok(Sent::Stopped)
            }
        }
    }

    /// Lỗi Graph khi gửi ⇒ kết cục của lượt.
    async fn flow_map_graph_error(
        &self,
        company: CompanyRef,
        run_id: i32,
        page_id: &str,
        e: &GraphApiError,
    ) -> Result<(), AppError> {
        if e.is_outside_window() {
            return self
                .flow_finish(
                    company,
                    run_id,
                    "expired",
                    Some("Quá 24 giờ kể từ tin cuối của khách"),
                    None,
                )
                .await;
        }
        if e.is_token_error()
            && let Ok(mut c) = self.acquire(company).await
        {
            let _ = pages::mark_token_invalid(&mut c, page_id).await;
        }
        self.flow_finish(
            company,
            run_id,
            "failed",
            Some(&format!("Facebook không nhận tin: {e}")),
            None,
        )
        .await
    }

    /// Lưu tin Page vừa gửi vào hộp thư; echo của Meta tới sau bị bỏ qua vì trùng `mid` (echo tới trước thì không ghi lại).
    async fn flow_record_out(
        &self,
        company: CompanyRef,
        conv: &FacebookConversation,
        mid: &str,
        text: &str,
    ) -> Result<(), AppError> {
        let now = Utc::now();
        let mut tx = self.flow_begin(company).await?;
        let inserted: Option<i64> = sqlx::query_scalar(
            "INSERT INTO facebook_messages (conversation_id, mid, direction, text, sent_at) \
             VALUES ($1, $2, 'out', $3, $4) ON CONFLICT (mid) DO NOTHING RETURNING id",
        )
        .bind(conv.id)
        .bind(mid)
        .bind(text)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if inserted.is_some() {
            sqlx::query(
                "UPDATE facebook_conversations SET last_message_at = $2, last_message_preview = $3 WHERE id = $1",
            )
            .bind(conv.id)
            .bind(now)
            .bind(utf16_prefix(text, 200))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
            let assigned = assigned_to(&mut tx, conv.contact_id).await?;
            publish_integration_event(
                &mut tx,
                "messenger.message_sent",
                &json!({
                    "conversation_id": conv.id, "page_id": conv.page_id, "contact_id": conv.contact_id,
                    "contact_assigned_to": assigned, "origin": "flow",
                }),
                conv.id,
                None,
            )
            .await
            .map_err(AppError::internal)?;
        }
        tx.commit().await.map_err(platform_db)
    }

    /// Ghi lịch sử khách (nếu hội thoại đã gắn khách). Lỗi chỉ ghi log.
    async fn flow_note(&self, company: CompanyRef, conv_id: i32, description: &str, meta: Value) {
        let r: Result<(), AppError> = async {
            let mut c = self.acquire(company).await?;
            let conv: Option<(Option<i32>, String, String)> =
                sqlx::query_as("SELECT contact_id, page_id, psid FROM facebook_conversations WHERE id = $1")
                    .bind(conv_id)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(db)?;
            let Some((Some(contact_id), page_id, psid)) = conv else {
                return Ok(());
            };
            let mut metadata = Map::new();
            metadata.insert("facebook_page_id".to_owned(), json!(page_id));
            metadata.insert("psid".to_owned(), json!(psid));
            if let Value::Object(extra) = meta {
                metadata.extend(extra);
            }
            let details = json!({ "description": utf16_prefix(description, 2000), "source": "facebook_messenger" });
            sqlx::query(
                "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
                 VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, NULL)",
            )
            .bind(contact_id)
            .bind(trinity_kernel::json::js_json(&details))
            .bind(trinity_kernel::json::js_json(&Value::Object(metadata)))
            .execute(&mut *c)
            .await
            .map_err(db)?;
            Ok(())
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Ghi lịch sử kịch bản lỗi (hội thoại {conv_id}): {e:?}");
        }
    }

    // ───────────── job

    /// Giờ của bước kịch bản chờ sớm nhất (`None` = không có).
    pub async fn flows_next_due_at(&self, company: CompanyRef) -> Result<Option<DateTime<Utc>>, AppError> {
        let mut c = self.acquire(company).await?;
        let t: Option<Timestamp> =
            sqlx::query_scalar("SELECT min(due_at) FROM facebook_flow_runs WHERE status = 'scheduled'")
                .fetch_one(&mut *c)
                .await
                .map_err(db)?;
        Ok(t.map(|t| t.0))
    }

    /// Một lượt job của một công ty (`runDue`): gửi các bước đã tới giờ trong `budget`. Trả số lượt đã xử lý. Mỗi lượt giành bằng
    /// `UPDATE ... WHERE status = 'scheduled'` nên chạy chồng hay bị cắt giữa chừng không gửi trùng; lượt lỗi ⇒ `failed`.
    pub async fn flows_run_due(
        &self,
        company: CompanyRef,
        budget: Duration,
        now: DateTime<Utc>,
    ) -> Result<usize, AppError> {
        let t0 = Instant::now();
        let mut processed = 0;
        let elapsed = |t0: &Instant| chrono::Duration::from_std(t0.elapsed()).unwrap_or_default();
        while t0.elapsed() < budget {
            let due: Vec<FacebookFlowRun> = {
                let mut c = self.acquire(company).await?;
                sqlx::query_as::<_, FacebookFlowRun>(sqlx::AssertSqlSafe(format!(
                    "SELECT {RUN_COLS} FROM facebook_flow_runs WHERE status = 'scheduled' AND due_at <= $1 \
                     ORDER BY due_at ASC, id ASC LIMIT 20"
                )))
                .bind(now + elapsed(&t0))
                .fetch_all(&mut *c)
                .await
                .map_err(db)?
            };
            if due.is_empty() {
                break;
            }
            let mut claimed_any = false;
            for run in due {
                if t0.elapsed() >= budget {
                    break;
                }
                if !self.flow_claim(company, run.id, "scheduled").await? {
                    continue;
                }
                claimed_any = true;
                let flow = {
                    let mut c = self.acquire(company).await?;
                    find_flow(&mut c, run.flow_id).await?
                };
                let Some(flow) = flow.filter(|f| f.is_active) else {
                    self.flow_finish(company, run.id, "stopped", Some("Kịch bản đã tắt"), None)
                        .await?;
                    continue;
                };
                let steps = steps_from_json(&flow.steps.0);
                if let Err(e) = self
                    .flow_advance(
                        company,
                        run.id,
                        run.conversation_id,
                        &flow,
                        &steps,
                        run.step_id.clone(),
                        true,
                    )
                    .await
                {
                    tracing::error!("Kịch bản {} lượt {} lỗi: {e:?}", flow.id, run.id);
                    self.flow_finish(company, run.id, "failed", Some(&format!("{e:?}")), None)
                        .await?;
                }
                processed += 1;
            }
            // Không giành được lượt nào (tiến trình khác đã nhận hết) ⇒ nhường, tránh quay vòng.
            if !claimed_any {
                break;
            }
        }
        Ok(processed)
    }

    /// `POST /facebook/tick`: web đang mở gọi mỗi phút (bổ sung cho job). Kiểm DB tối đa một lần mỗi 20 giây cho mỗi công ty và loại
    /// việc; có việc tới giờ thì chạy nền (không chạy chồng trong cùng tiến trình). Trả `{ due, next_at }` gộp kịch bản và gửi hàng loạt.
    pub async fn facebook_tick(self: &Arc<Self>, company: CompanyRef, now: DateTime<Utc>) -> Result<Value, AppError> {
        let flows = self.kick_if_due(company, KICK_FLOWS, now).await?;
        let broadcasts = self.kick_if_due(company, KICK_BROADCASTS, now).await?;
        let next_flow = self.flows_next_due_at(company).await?;
        let next_broadcast: Option<Timestamp> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar("SELECT min(scheduled_at) FROM facebook_broadcasts WHERE status = 'scheduled'")
                .fetch_one(&mut *c)
                .await
                .map_err(db)?
        };
        let next = [next_flow, next_broadcast.map(|t| t.0)].into_iter().flatten().min();
        Ok(json!({
            "due": flows || broadcasts,
            "next_at": next.map(trinity_kernel::vn_time::js_iso_string),
        }))
    }

    async fn kick_if_due(
        self: &Arc<Self>,
        company: CompanyRef,
        kind: u8,
        now: DateTime<Utc>,
    ) -> Result<bool, AppError> {
        let now_ms = now.timestamp_millis();
        {
            let mut gate = self.kick_gate.lock().unwrap_or_else(PoisonError::into_inner);
            let e = gate.entry((company, kind)).or_insert((0, false));
            if e.1 || now_ms - e.0 < KICK_THROTTLE_MS {
                return Ok(false);
            }
            e.0 = now_ms;
        }
        let due: bool = {
            let mut c = self.acquire(company).await?;
            if kind == KICK_FLOWS {
                sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM facebook_flow_runs WHERE status = 'scheduled' AND due_at <= $1)",
                )
                .bind(now)
                .fetch_one(&mut *c)
                .await
                .map_err(db)?
            } else {
                sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM facebook_broadcasts WHERE status = 'sending' \
                     OR (status = 'scheduled' AND scheduled_at <= $1))",
                )
                .bind(now)
                .fetch_one(&mut *c)
                .await
                .map_err(db)?
            }
        };
        if !due {
            return Ok(false);
        }
        {
            let mut gate = self.kick_gate.lock().unwrap_or_else(PoisonError::into_inner);
            let e = gate.entry((company, kind)).or_insert((0, false));
            if e.1 {
                return Ok(false);
            }
            e.1 = true;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let r = if kind == KICK_FLOWS {
                me.flows_run_due(company, TICK_BUDGET, Utc::now()).await.map(drop)
            } else {
                me.broadcasts_run_due(company, me.guard.as_deref(), TICK_BUDGET, Utc::now())
                    .await
                    .map(drop)
            };
            if let Err(e) = r {
                tracing::error!("Việc Messenger nền (loại {kind}) lỗi: {e:?}");
            }
            let mut gate = me.kick_gate.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(e) = gate.get_mut(&(company, kind)) {
                e.1 = false;
            }
        });
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(v: Value) -> Vec<FlowStep> {
        clean_steps(&v).expect("hợp lệ")
    }

    fn err(v: Value) -> String {
        match clean_steps(&v) {
            Ok(_) => panic!("lẽ ra lỗi"),
            Err(e) => match e.body().message {
                trinity_kernel::error::Message::One(m) => m,
                trinity_kernel::error::Message::Many(m) => m.join("; "),
            },
        }
    }

    #[test]
    fn payload_nut_di_va_ve() {
        let p = button_payload(12, "s2", 3);
        assert_eq!(p, "FLOW:12:s2:3");
        assert_eq!(parse_button_payload(Some(&p)), Some((12, "s2".to_owned(), 3)));
        assert_eq!(parse_button_payload(None), None);
        assert_eq!(parse_button_payload(Some("OTHER:1:a:0")), None);
        assert_eq!(parse_button_payload(Some("FLOW:0:a:0")), None, "lượt phải dương");
        assert_eq!(parse_button_payload(Some("FLOW:1:a:-1")), None);
        assert_eq!(parse_button_payload(Some("FLOW:1::0")), None);
        assert_eq!(parse_button_payload(Some("FLOW:1:a")), None);
        assert_eq!(parse_button_payload(Some("FLOW:x:a:0")), None);
    }

    #[test]
    fn lam_sach_buoc_co_ban() {
        let s = ok(json!([
            { "text": "  Chào {ten}  " },
            { "id": "b", "text": "Bước hai", "wait_minutes": "30", "next": null },
            { "id": "c", "text": "Hỏi", "ask": "phone", "wait_minutes": 0 },
        ]));
        assert_eq!(s[0].id, "s1");
        assert_eq!(s[0].text, "Chào {ten}");
        assert_eq!(s[1].wait_minutes, Some(30));
        assert_eq!(s[1].next, Some(None), "next null = kết thúc");
        assert_eq!(s[2].wait_minutes, None);
        assert_eq!(s[2].ask.as_deref(), Some("phone"));
        // Vòng JSON giữ đúng các trường.
        let back = steps_from_json(&steps_to_json(&s));
        assert_eq!(back, s);
        assert_eq!(
            steps_to_json(&s[1..2])[0],
            json!({ "id": "b", "text": "Bước hai", "wait_minutes": 30, "next": null })
        );
    }

    #[test]
    fn cau_loi_buoc() {
        assert_eq!(err(json!([])), "Kịch bản cần ít nhất một bước");
        assert_eq!(err(json!("x")), "Kịch bản cần ít nhất một bước");
        assert_eq!(err(json!(vec![json!({ "text": "a" }); 21])), "Kịch bản tối đa 20 bước");
        assert_eq!(
            err(json!([{ "id": "a b", "text": "x" }])),
            "Bước 1: mã bước chỉ gồm chữ, số, \"-\", \"_\" (tối đa 16 ký tự)"
        );
        assert_eq!(err(json!([{ "text": " " }])), "Bước 1: chưa có nội dung tin");
        assert_eq!(
            err(json!([{ "text": "a".repeat(2001) }])),
            "Bước 1: tin tối đa 2000 ký tự"
        );
        assert_eq!(
            err(json!([{ "text": "a", "wait_minutes": 1381 }])),
            "Bước 1: thời gian chờ từ 0 đến 1380 phút (23 giờ)"
        );
        assert_eq!(
            err(json!([{ "text": "a", "wait_minutes": 1.5 }])),
            "Bước 1: thời gian chờ từ 0 đến 1380 phút (23 giờ)"
        );
        assert_eq!(
            err(json!([{ "text": "a", "wait_minutes": -1 }])),
            "Bước 1: thời gian chờ từ 0 đến 1380 phút (23 giờ)"
        );
        assert_eq!(
            err(json!([{ "text": "a", "buttons": [{ "title": "" }] }])),
            "Bước 1, nút 1: chưa có chữ trên nút"
        );
        assert_eq!(
            err(json!([{ "text": "a", "buttons": [{ "title": "x".repeat(21) }] }])),
            "Bước 1, nút 1: chữ trên nút tối đa 20 ký tự"
        );
        let many: Vec<Value> = (0..11).map(|i| json!({ "title": format!("n{i}") })).collect();
        assert_eq!(err(json!([{ "text": "a", "buttons": many }])), "Bước 1: tối đa 10 nút");
        assert_eq!(
            err(json!([{ "text": "a", "ask": "ho_ten" }])),
            "Bước 1: kiểu câu hỏi phải là phone, email hoặc note"
        );
        assert_eq!(
            err(json!([{ "text": "a", "ask": "phone", "buttons": [{ "title": "ok" }] }])),
            "Bước 1: bước hỏi khách không kèm nút được — tách thành hai bước"
        );
        assert_eq!(
            err(json!([{ "id": "a", "text": "x" }, { "id": "a", "text": "y" }])),
            "Mã bước \"a\" bị trùng"
        );
        assert_eq!(
            err(json!([{ "id": "a", "text": "x", "next": "zz" }])),
            "Bước 1: bước \"zz\" không có trong kịch bản"
        );
        assert_eq!(
            err(json!([{ "id": "a", "text": "x", "buttons": [{ "title": "ok", "next": "zz" }] }])),
            "Bước 1, nút 1: bước \"zz\" không có trong kịch bản"
        );
    }

    #[test]
    fn vong_tu_gui_bi_chan_nhung_vong_co_nut_thi_duoc() {
        let m = err(json!([
            { "id": "a", "text": "x", "next": "b" },
            { "id": "b", "text": "y", "next": "a" },
        ]));
        assert!(m.starts_with("Các bước tự gửi nối thành vòng (qua bước \"a\")"), "{m}");
        // Có nút ở giữa thì không phải vòng tự gửi.
        let s = ok(json!([
            { "id": "a", "text": "x", "next": "b" },
            { "id": "b", "text": "y", "buttons": [{ "title": "Lại", "next": "a" }, { "title": "Xong", "next": null }] },
        ]));
        assert_eq!(s.len(), 2);
        // Tự trỏ vào chính mình cũng là vòng.
        assert!(err(json!([{ "id": "a", "text": "x", "next": "a" }])).contains("nối thành vòng"));
    }

    #[test]
    fn tam_dung_giu_viec_khoa_thi_dung() {
        let now = Utc::now();
        let later = now + chrono::Duration::hours(2);
        assert_eq!(pause_due(&BlockCode::ChannelPaused, Some(later), now), Some(later));
        // Hạn đã qua hoặc sát giờ ⇒ hẹn ít nhất 30 giây sau, không để lượt kẹt.
        let soon = pause_due(&BlockCode::ChannelPaused, Some(now), now).unwrap();
        assert_eq!(soon, now + chrono::Duration::seconds(30));
        assert_eq!(pause_due(&BlockCode::ChannelPaused, None, now), None);
        assert_eq!(pause_due(&BlockCode::ChannelLocked, Some(later), now), None);
    }

    #[test]
    fn buoc_ke_tiep() {
        let s = ok(json!([
            { "id": "a", "text": "1" },
            { "id": "b", "text": "2", "next": null },
            { "id": "c", "text": "3", "next": "a" },
        ]));
        assert_eq!(next_after(&s, &s[0]).as_deref(), Some("b"), "không đặt ⇒ bước kế");
        assert_eq!(next_after(&s, &s[1]), None, "next null ⇒ kết thúc");
        assert_eq!(next_after(&s, &s[2]).as_deref(), Some("a"));
        let last = ok(json!([{ "id": "z", "text": "x" }]));
        assert_eq!(next_after(&last, &last[0]), None, "hết danh sách");
    }

    #[test]
    fn email_va_tu_khoa() {
        assert_eq!(
            find_email("em là A, mail: lan.nguyen@gmail.com nhé").as_deref(),
            Some("lan.nguyen@gmail.com")
        );
        assert_eq!(find_email("không có email"), None);
        assert_eq!(find_email("a@b"), None);
        let kw: Vec<String> = [" giá ", "", "giá", "x".repeat(150).as_str()]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let out = clean_keywords(&kw);
        assert_eq!(out.len(), 2, "bỏ rỗng và trùng");
        assert_eq!(out[0], "giá");
        assert_eq!(out[1].chars().count(), 100);
        let many: Vec<String> = (0..40).map(|i| format!("k{i}")).collect();
        assert_eq!(clean_keywords(&many).len(), 30);
    }

    #[test]
    fn body_kiem_class_validator() {
        let v = FlowInput::from_json(&json!({
            "name": "Chào", "page_id": "p1", "trigger": "keyword", "keywords": ["giá"],
            "chat_link_id": null, "steps": [{ "text": "x" }], "is_active": true,
        }))
        .unwrap();
        assert_eq!(v.trigger.as_deref(), Some("keyword"));
        assert_eq!(v.chat_link_id, Some(None));
        assert_eq!(v.is_active, Some(true));
        assert!(v.steps.is_some());

        let e = FlowInput::from_json(&json!({
            "x": 1, "trigger": "abc", "keywords": "a", "steps": {}, "is_active": "yes", "chat_link_id": 1.5,
        }))
        .unwrap_err()
        .to_string();
        for part in [
            "property x should not exist",
            "trigger must be one of the following values: keyword, chat_link, first_message",
            "keywords must be an array",
            "steps must be an array",
            "is_active must be a boolean value",
            "chat_link_id must be an integer number",
        ] {
            assert!(e.contains(part), "thiếu «{part}» trong {e}");
        }
        let long = FlowInput::from_json(&json!({ "keywords": ["x".repeat(101), 5] }))
            .unwrap_err()
            .to_string();
        assert!(long.contains("each value in keywords must be shorter than or equal to 100 characters"));
        assert!(long.contains("each value in keywords must be a string"));
        assert!(FlowInput::from_json(&json!({ "steps": vec![json!({}); 21] })).is_err());
        assert!(FlowInput::from_json(&json!([1])).is_err());
        // null: name rỗng, steps null ⇒ service báo 400; keywords/trigger/is_active null như vắng.
        let n =
            FlowInput::from_json(&json!({ "name": null, "steps": null, "keywords": null, "trigger": null })).unwrap();
        assert_eq!(n.name.as_deref(), Some(""));
        assert_eq!(n.steps, Some(Value::Null));
        assert_eq!((n.keywords, n.trigger), (None, None));
    }

    #[test]
    fn bang_route_va_job() {
        let t = flow_routes();
        assert_eq!(t.len(), 6);
        let rep = trinity_http::router::check::check_embedded(&t, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(JOB_NAME, "facebook.flows");
        assert_eq!((JOB_INTERVAL.as_secs(), JOB_BUDGET.as_secs()), (60, 30));
        assert!(RUN_BUDGET < JOB_BUDGET);
    }
}
