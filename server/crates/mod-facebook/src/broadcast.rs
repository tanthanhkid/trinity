//! Gửi tin hàng loạt qua Messenger của Fanpage (M51), chuyển từ `facebook-broadcasts.service.ts`,
//! `facebook-broadcasts.job.ts` và 9 route `broadcasts` của `facebook.controller.ts`.
//!
//! Luật Meta: Page chỉ được nhắn chủ động trong 24 giờ kể từ tin cuối của khách, nên chỉ gửi khách còn trong cửa sổ (kiểm lại ngay
//! trước khi gửi từng người); Human Agent KHÔNG dùng cho tin hàng loạt. Người nhận được chốt lúc tới giờ gửi, trong MỘT giao dịch cùng
//! việc chuyển lượt sang `sending` (cắt giữa chừng thì giao dịch hoàn tác, lượt vẫn `scheduled` và chốt lại từ đầu).
//!
//! Không gửi trùng khi job bị cắt giữa chừng (biên nhận theo từng người nhận, bảng `facebook_broadcast_recipients`):
//! - Mỗi người nhận chỉ được GIÀNH một lần bằng `UPDATE ... SET status='sending' WHERE status='queued'` (một tiến trình thắng).
//! - Đã giành mà chưa ghi kết quả (tiến trình chết trước/trong/sau lời gọi Graph): người nhận kẹt ở `sending`; sau `LEASE_MS` bị
//!   đánh `failed` ("không rõ khách đã nhận chưa"), KHÔNG BAO GIỜ trả về `queued` ⇒ không gửi lại. Chỉ trước khi gọi Graph mà gặp lỗi
//!   hệ thống (chưa gửi gì) mới trả người nhận về `queued`.
//! - Biên nhận `sent` và bộ đếm của lượt được ghi trong MỘT giao dịch; phần ghi tin vào hộp thư, outbox và lịch sử nằm trong
//!   savepoint nên lỗi phần phụ không hoàn tác biên nhận. Lượt đang `sending` được job chạy tiếp từ các người còn `queued`.
//!
//! Hạn mức (K25, `ChannelGuard`): trần người nhận mỗi lượt kiểm lúc bấm gửi và cắt lúc chốt; mỗi tin giữ chỗ `bulk_message` NGUYÊN
//! TỬ trước khi gọi Graph và HOÀN lại đúng khung khi Graph không nhận (lỗi, ngoài cửa sổ, token…). Tạm dừng tự động giữ nguyên
//! người nhận ở `queued` (lượt sau gửi tiếp); khoá kênh hoặc hết hạn mức thì bỏ qua phần còn lại.
//!
//! Quy tắc chung: không giữ kết nối pool khi gọi Graph hoặc `ChannelGuard`, không giữ hai kết nối cùng lúc.
//! Gửi ngay (`scheduled_at` trống) do job chạy mỗi 60 giây nhặt lên; tầng route có thể gọi [`FacebookIngest::broadcasts_run_due`]
//! chạy nền ngay sau `POST .../send` (như `kick()` của bản Node).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use http::Method;
use mod_channel_guard::{BlockCode, ChannelBlocked, ChannelGuard, GuardError, OutboundMode, OutboundScope, QuotaKind};
use regex::{NoExpand, Regex};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::models::{FacebookBroadcast, FacebookBroadcastRecipient, FacebookConversation};
use trinity_db::outbox::publish_integration_event;
use trinity_db::types::JsonValue;
use trinity_db::{CompanyRef, TenantTx};
use trinity_http::router::{Access, RouteSpec};
use trinity_jobs::{JobSpec, SchedulerError};
use trinity_kernel::error::{AppError, HttpError};

use crate::graph::GraphApiError;
use crate::inbox::{MAX_TEXT, MESSAGING_WINDOW_MS, within_messaging_window};
use crate::ingest::{FacebookIngest, db, platform_db, utf16_prefix};
use crate::messenger::assigned_to;
use crate::pages;

/// Tối đa người nhận một lượt (cửa sổ 24 giờ nên con số thực tế thường nhỏ hơn nhiều).
pub const MAX_RECIPIENTS: usize = 2000;
/// Người nhận ở `sending` quá lâu ⇒ không rõ đã gửi chưa ⇒ báo lỗi, không gửi lại.
pub const LEASE_MS: i64 = 10 * 60_000;
/// Hẹn giờ tối đa 7 ngày.
pub const MAX_AHEAD_MS: i64 = 7 * 86_400_000;
/// Số người nhận gửi mỗi lô.
const BATCH: i64 = 20;
/// Tên job (tệp sở hữu K20) và chu kỳ/trần thời gian (`@Interval 60s`, PLAN 4.9: budget 30 giây).
pub const JOB_NAME: &str = "facebook.broadcasts";
pub const JOB_INTERVAL: Duration = Duration::from_secs(60);
pub const JOB_BUDGET: Duration = Duration::from_secs(30);
/// Thời gian chạy tối đa của một lượt job (chừa chỗ cho lô đang gửi dở).
const RUN_BUDGET: Duration = Duration::from_secs(25);

const NAME_REQUIRED: &str = "Đặt tên cho lượt gửi (vd \"Báo lịch khai giảng\").";
const PAGE_REQUIRED: &str = "Chọn Fanpage đang kết nối.";
const TEXT_REQUIRED: &str = "Nhập nội dung tin.";
const NOT_FOUND: &str = "Không tìm thấy lượt gửi";
const STALE_NOTE: &str = "Bị gián đoạn khi đang gửi — không rõ khách đã nhận chưa";
const OUTSIDE_NOTE: &str = "Quá 24 giờ kể từ tin cuối của khách — Messenger không cho gửi";

const BC_COLS: &str = "id, name, page_id, text, audience, status, scheduled_at, total, sent, failed, skipped, source, \
                       created_by, started_at, finished_at, created_at, updated_at";
const RECIPIENT_COLS: &str = "id, broadcast_id, conversation_id, status, note, claimed_at, sent_at";
const CONV_COLS: &str = "id, page_id, psid, customer_name, contact_id, last_inbound_at, last_message_at, \
                         last_message_preview, unread_count, entry_link_id, created_at";
/// Cộng bộ đếm của lượt theo trạng thái người nhận (`$2` = sent|failed|skipped, `$3` = số người).
const BUMP: &str = "UPDATE facebook_broadcasts SET \
                    sent = sent + CASE WHEN $2::text = 'sent' THEN $3::int4 ELSE 0 END, \
                    failed = failed + CASE WHEN $2::text = 'failed' THEN $3::int4 ELSE 0 END, \
                    skipped = skipped + CASE WHEN $2::text = 'skipped' THEN $3::int4 ELSE 0 END, \
                    updated_at = now() WHERE id = $1";
/// Bộ lọc đối tượng: `$1` Page, `$3` link/QR (NULL = không lọc), `$4` nguồn khách (NULL = không lọc).
const AUDIENCE_FILTER: &str = "page_id = $1 AND ($3::int4[] IS NULL OR entry_link_id = ANY($3)) \
                               AND ($4::int4[] IS NULL OR contact_id IN (SELECT id FROM contacts WHERE source_id = ANY($4)))";

// ───────────────────────── thuần (không DB)

/// Bộ lọc người nhận đã làm sạch (`cleanAudience`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Audience {
    pub source_ids: Vec<i32>,
    pub chat_link_ids: Vec<i32>,
}

/// `ids()` của bản Node: số nguyên dương trong `int4`, bỏ trùng giữ thứ tự, tối đa 50.
fn clean_ids(v: Option<&Value>) -> Vec<i32> {
    let Some(arr) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<i32> = Vec::new();
    for x in arr {
        // `Number(x)`: số, chuỗi số, `true`/`null` (1/0); còn lại là NaN.
        let n = match x {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => {
                let t = trinity_kernel::vi::trim_js(s);
                if t.is_empty() { Some(0.0) } else { t.parse::<f64>().ok() }
            }
            Value::Bool(b) => Some(f64::from(u8::from(*b))),
            Value::Null => Some(0.0),
            _ => None,
        };
        let Some(n) = n else {
            continue;
        };
        if n.fract() == 0.0 && n >= 1.0 && n <= f64::from(i32::MAX) {
            let id = n as i32;
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out.truncate(50);
    out
}

impl Audience {
    /// `cleanAudience`: không phải object ⇒ rỗng.
    pub fn from_value(a: &Value) -> Self {
        let o = a.as_object();
        Self {
            source_ids: clean_ids(o.and_then(|o| o.get("source_ids"))),
            chat_link_ids: clean_ids(o.and_then(|o| o.get("chat_link_ids"))),
        }
    }

    /// Chỉ ghi khoá có giá trị (như `cleanAudience`).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        if !self.source_ids.is_empty() {
            m.insert("source_ids".to_owned(), json!(self.source_ids));
        }
        if !self.chat_link_ids.is_empty() {
            m.insert("chat_link_ids".to_owned(), json!(self.chat_link_ids));
        }
        Value::Object(m)
    }

    fn sources(&self) -> Option<Vec<i32>> {
        (!self.source_ids.is_empty()).then(|| self.source_ids.clone())
    }

    fn links(&self) -> Option<Vec<i32>> {
        (!self.chat_link_ids.is_empty()).then(|| self.chat_link_ids.clone())
    }
}

/// `fillTemplate`: `{ten}` (không phân biệt hoa thường, cho phép khoảng trắng trong ngoặc) thành tên khách (không có thì "bạn"),
/// cắt còn 2000 đơn vị UTF-16.
pub fn fill_template(text: &str, name: Option<&str>) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\{\s*ten\s*\}").expect("regex hợp lệ"));
    let who = name
        .map(trinity_kernel::vi::trim_js)
        .filter(|n| !n.is_empty())
        .unwrap_or("bạn");
    let filled = RE.replace_all(text, NoExpand(who));
    utf16_prefix(&filled, MAX_TEXT)
}

/// Giờ gửi thật (`sendTime`): bỏ trống hoặc đã qua = ngay; quá 7 ngày hoặc không đọc được ⇒ 400.
pub fn send_time(at: Option<&str>, now: DateTime<Utc>) -> Result<DateTime<Utc>, HttpError> {
    let Some(s) = at.filter(|s| !s.is_empty()) else {
        return Ok(now);
    };
    let Some(t) = trinity_kernel::instant::parse_instant_with(s, 0) else {
        return Err(HttpError::bad_request("Giờ hẹn không hợp lệ."));
    };
    if t.timestamp_millis() > now.timestamp_millis() + MAX_AHEAD_MS {
        return Err(HttpError::bad_request(
            "Hẹn tối đa 7 ngày tới — Messenger chỉ cho nhắn khách trong 24 giờ từ tin cuối của họ, nên hẹn xa thường không còn ai nhận.",
        ));
    }
    Ok(t.max(now))
}

fn body_object(v: &Value) -> Result<&Map<String, Value>, HttpError> {
    v.as_object()
        .ok_or_else(|| HttpError::validation(vec!["body must be an object".to_owned()]))
}

/// `@IsOptional() @IsString() @MaxLength(max)`: vắng ⇒ `None`; `null` ⇒ chuỗi rỗng (class-validator bỏ qua, service coi là rỗng nên
/// báo 400 "thiếu", không để NULL chạm cột NOT NULL); không phải chuỗi hoặc quá dài ⇒ ghi lỗi. Độ dài tính theo UTF-16.
fn opt_string(o: &Map<String, Value>, key: &str, max: usize, errors: &mut Vec<String>) -> Option<String> {
    match o.get(key) {
        None => None,
        Some(Value::Null) => Some(String::new()),
        Some(Value::String(s)) => {
            if s.encode_utf16().count() > max {
                errors.push(format!("{key} must be shorter than or equal to {max} characters"));
                None
            } else {
                Some(s.clone())
            }
        }
        Some(_) => {
            errors.push(format!("{key} must be shorter than or equal to {max} characters"));
            errors.push(format!("{key} must be a string"));
            None
        }
    }
}

/// Body `POST/PATCH /facebook/broadcasts` (`BroadcastDto`): mọi trường tuỳ chọn ở tầng DTO; thiếu thì service báo 400.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BroadcastInput {
    pub name: Option<String>,
    pub page_id: Option<String>,
    pub text: Option<String>,
    /// `Some(Null)` hoặc không phải object ⇒ lọc rỗng (`cleanAudience`).
    pub audience: Option<Value>,
}

impl BroadcastInput {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let o = body_object(v)?;
        let mut e = Vec::new();
        let name = opt_string(o, "name", 120, &mut e);
        let page_id = opt_string(o, "page_id", 40, &mut e);
        let text = opt_string(o, "text", 2000, &mut e);
        if !e.is_empty() {
            return Err(HttpError::validation(e));
        }
        Ok(Self {
            name,
            page_id,
            text,
            audience: o.get("audience").cloned(),
        })
    }
}

/// Body `POST /facebook/broadcasts/preview` (`BroadcastPreviewDto`): `page_id` chuỗi ≤ 40 bắt buộc.
pub fn parse_preview(v: &Value) -> Result<(String, Audience), HttpError> {
    let o = body_object(v)?;
    let page_id = match o.get("page_id") {
        Some(Value::String(s)) if s.encode_utf16().count() <= 40 => s.clone(),
        Some(Value::String(_)) => {
            return Err(HttpError::validation(vec![
                "page_id must be shorter than or equal to 40 characters".to_owned(),
            ]));
        }
        _ => {
            return Err(HttpError::validation(vec![
                "page_id must be shorter than or equal to 40 characters".to_owned(),
                "page_id must be a string".to_owned(),
            ]));
        }
    };
    let audience = o.get("audience").map(Audience::from_value).unwrap_or_default();
    Ok((page_id, audience))
}

/// Body `POST /facebook/broadcasts/:id/send` (`BroadcastSendDto`): `scheduled_at` chuỗi ≤ 40, `null` như vắng.
pub fn parse_send(v: &Value) -> Result<Option<String>, HttpError> {
    let o = body_object(v)?;
    match o.get("scheduled_at") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.encode_utf16().count() <= 40 => Ok(Some(s.clone())),
        Some(Value::String(_)) => Err(HttpError::validation(vec![
            "scheduled_at must be shorter than or equal to 40 characters".to_owned(),
        ])),
        Some(_) => Err(HttpError::validation(vec![
            "scheduled_at must be shorter than or equal to 40 characters".to_owned(),
            "scheduled_at must be a string".to_owned(),
        ])),
    }
}

/// Bản trả về của một lượt: cột của bảng, `audience` đã làm sạch và `page_name`.
fn view_json(b: &FacebookBroadcast, names: &HashMap<String, String>) -> Result<Value, AppError> {
    // trinity-lint: allow-json-value (model cần vá thêm khoá rồi trả Value (hoặc ghi cột jsonb), giữ hành vi cũ; không phải đường ghi chuỗi JSON thẳng)
    let mut v = serde_json::to_value(b).map_err(AppError::internal)?;
    v["audience"] = Audience::from_value(&b.audience.0).to_value();
    v["page_name"] = names.get(&b.page_id).map_or(Value::Null, |n| json!(n));
    Ok(v)
}

// ───────────────────────── route (K14)

const ID: &[&str] = &["param.id:ParseIntPipe"];

/// 9 route `broadcasts` của `FacebookController`; nối vào bảng route của mô-đun ở tầng router (x-router-facebook-zalo).
pub fn broadcast_routes() -> Vec<RouteSpec> {
    let manage = Access::Can(&["integrations.webhooks"]);
    let r =
        |m: Method, p: &'static str, ok: u16| RouteSpec::new(m, p, manage).status_ok(ok).org_feature("facebook_page");
    vec![
        r(Method::GET, "/api/v1/facebook/broadcasts", 200),
        r(Method::POST, "/api/v1/facebook/broadcasts", 201),
        r(Method::POST, "/api/v1/facebook/broadcasts/preview", 200),
        r(Method::GET, "/api/v1/facebook/broadcasts/:id", 200).param_pipes(ID),
        r(Method::PATCH, "/api/v1/facebook/broadcasts/:id", 200).param_pipes(ID),
        r(Method::DELETE, "/api/v1/facebook/broadcasts/:id", 204).param_pipes(ID),
        r(Method::GET, "/api/v1/facebook/broadcasts/:id/recipients", 200).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/broadcasts/:id/send", 200).param_pipes(ID),
        r(Method::POST, "/api/v1/facebook/broadcasts/:id/cancel", 200).param_pipes(ID),
    ]
}

/// Khai báo job `facebook.broadcasts` (60 giây, budget 30 giây) cho `Scheduler::register`: mỗi công ty chạy
/// [`FacebookIngest::broadcasts_run_due`].
pub fn broadcast_job(ingest: Arc<FacebookIngest>, guard: Option<Arc<ChannelGuard>>) -> Result<JobSpec, SchedulerError> {
    JobSpec::new(JOB_NAME, JOB_INTERVAL, JOB_BUDGET, move |company: CompanyRef| {
        let ingest = Arc::clone(&ingest);
        let guard = guard.clone();
        async move {
            ingest
                .broadcasts_run_due(company, guard.as_deref(), RUN_BUDGET, Utc::now())
                .await
                .map(drop)
                .map_err(|e| format!("{e:?}"))
        }
    })
}

// ───────────────────────── DB

/// Kết quả một lượt [`FacebookIngest::broadcasts_run_due`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunStats {
    pub started: usize,
    pub sent: usize,
    pub failed: usize,
    pub skipped: usize,
}

#[derive(Default)]
struct BatchStats {
    sent: usize,
    failed: usize,
    skipped: usize,
    left: i64,
    paused: bool,
}

/// Ngữ cảnh gửi một lô.
struct BatchCtx<'a> {
    company: CompanyRef,
    guard: Option<&'a ChannelGuard>,
    now: DateTime<Utc>,
    id: i32,
    name: String,
    page_id: String,
    text: String,
    created_by: i32,
    token: Option<String>,
}

/// Kết cục của một người nhận sau khi đã giành.
struct Done {
    status: &'static str,
    note: Option<String>,
    /// Tin đã tới Facebook: hội thoại, `message_id`, nội dung đã điền.
    sent: Option<(FacebookConversation, String, String)>,
    /// Phần còn `queued` bị đánh trạng thái này (Page mất kết nối, khoá kênh, hết hạn mức).
    stop_rest: Option<&'static str>,
}

#[allow(clippy::large_enum_variant)]
enum Delivery {
    /// Tạm dừng xuất hiện giữa lúc kiểm và lúc giữ chỗ: trả người nhận về `queued`.
    Pause,
    Done(Done),
}

fn settled(status: &'static str, note: impl Into<String>, stop_rest: Option<&'static str>) -> Delivery {
    Delivery::Done(Done {
        status,
        note: Some(note.into()),
        sent: None,
        stop_rest,
    })
}

async fn side_begin(tx: &mut TenantTx) -> bool {
    sqlx::query("SAVEPOINT fb_bc_side").execute(&mut **tx).await.is_ok()
}

async fn side_end(tx: &mut TenantTx, ok: bool) {
    if !ok {
        let _ = sqlx::query("ROLLBACK TO SAVEPOINT fb_bc_side").execute(&mut **tx).await;
    }
    let _ = sqlx::query("RELEASE SAVEPOINT fb_bc_side").execute(&mut **tx).await;
}

/// Khách khớp bộ lọc trong cửa sổ 24 giờ (id, tên; mới nhất trước, tối đa [`MAX_RECIPIENTS`]) và số khách khớp bộ lọc nhưng đã
/// quá 24 giờ.
async fn audience_query(
    conn: &mut PgConnection,
    page_id: &str,
    a: &Audience,
    now: DateTime<Utc>,
) -> Result<(Vec<(i32, Option<String>)>, i64), AppError> {
    let since = now - chrono::Duration::milliseconds(MESSAGING_WINDOW_MS);
    let eligible: Vec<(i32, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, customer_name FROM facebook_conversations WHERE {AUDIENCE_FILTER} AND last_inbound_at >= $2 \
         ORDER BY last_inbound_at DESC, id DESC LIMIT {MAX_RECIPIENTS}"
    )))
    .bind(page_id)
    .bind(since)
    .bind(a.links())
    .bind(a.sources())
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let outside: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM facebook_conversations WHERE {AUDIENCE_FILTER} \
         AND (last_inbound_at < $2 OR last_inbound_at IS NULL)"
    )))
    .bind(page_id)
    .bind(since)
    .bind(a.links())
    .bind(a.sources())
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    Ok((eligible, outside))
}

async fn page_is_active(conn: &mut PgConnection, page_id: &str) -> Result<bool, AppError> {
    let r: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM facebook_pages WHERE page_id = $1 AND is_active = true")
            .bind(page_id)
            .fetch_optional(conn)
            .await
            .map_err(db)?;
    Ok(r.is_some())
}

async fn find_broadcast(conn: &mut PgConnection, id: i32) -> Result<Option<FacebookBroadcast>, AppError> {
    sqlx::query_as::<_, FacebookBroadcast>(sqlx::AssertSqlSafe(format!(
        "SELECT {BC_COLS} FROM facebook_broadcasts WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

/// Dữ liệu đã chuẩn hoá của `validate`; trường `None` = không đổi (chỉ khi sửa).
struct Validated {
    name: Option<String>,
    page_id: Option<String>,
    text: Option<String>,
    audience: Option<Audience>,
}

impl FacebookIngest {
    async fn bc_begin(&self, company: CompanyRef) -> Result<TenantTx, AppError> {
        self.db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)
    }

    async fn bc_page_names(&self, company: CompanyRef) -> Result<HashMap<String, String>, AppError> {
        let mut c = self.acquire(company).await?;
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT page_id, name FROM facebook_pages")
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
        Ok(rows.into_iter().collect())
    }

    /// `GET /facebook/broadcasts`: 50 lượt mới nhất.
    pub async fn list_broadcasts(&self, company: CompanyRef) -> Result<Value, AppError> {
        let rows = {
            let mut c = self.acquire(company).await?;
            sqlx::query_as::<_, FacebookBroadcast>(sqlx::AssertSqlSafe(format!(
                "SELECT {BC_COLS} FROM facebook_broadcasts ORDER BY id DESC LIMIT 50"
            )))
            .fetch_all(&mut *c)
            .await
            .map_err(db)?
        };
        let names = self.bc_page_names(company).await?;
        let data = rows
            .iter()
            .map(|b| view_json(b, &names))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({ "data": data }))
    }

    /// `GET /facebook/broadcasts/:id`: không có ⇒ 404.
    pub async fn get_broadcast(&self, company: CompanyRef, id: i32) -> Result<Value, AppError> {
        let found = find_broadcast(&mut *self.acquire(company).await?, id).await?;
        let Some(b) = found else {
            return Err(HttpError::not_found(NOT_FOUND).into());
        };
        let names = self.bc_page_names(company).await?;
        view_json(&b, &names)
    }

    /// `GET /facebook/broadcasts/:id/recipients`: 200 người nhận đầu tiên kèm tên khách (ai đã nhận, ai bị bỏ qua).
    pub async fn broadcast_recipients(&self, company: CompanyRef, id: i32) -> Result<Value, AppError> {
        self.get_broadcast(company, id).await?;
        let mut c = self.acquire(company).await?;
        let rows = sqlx::query_as::<_, FacebookBroadcastRecipient>(sqlx::AssertSqlSafe(format!(
            "SELECT {RECIPIENT_COLS} FROM facebook_broadcast_recipients WHERE broadcast_id = $1 ORDER BY id ASC LIMIT 200"
        )))
        .bind(id)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
        let conv_ids: Vec<i32> = rows.iter().map(|r| r.conversation_id).collect();
        let convs: Vec<(i32, Option<String>, Option<i32>)> =
            sqlx::query_as("SELECT id, customer_name, contact_id FROM facebook_conversations WHERE id = ANY($1)")
                .bind(&conv_ids)
                .fetch_all(&mut *c)
                .await
                .map_err(db)?;
        drop(c);
        let by: HashMap<i32, (Option<String>, Option<i32>)> = convs.into_iter().map(|(i, n, c)| (i, (n, c))).collect();
        let mut data = Vec::new();
        for r in &rows {
            // trinity-lint: allow-json-value (model cần vá thêm khoá rồi trả Value (hoặc ghi cột jsonb), giữ hành vi cũ; không phải đường ghi chuỗi JSON thẳng)
            let mut v = serde_json::to_value(r).map_err(AppError::internal)?;
            let (name, contact) = by.get(&r.conversation_id).cloned().unwrap_or((None, None));
            v["customer_name"] = json!(name);
            v["contact_id"] = json!(contact);
            data.push(v);
        }
        Ok(json!({ "data": data }))
    }

    /// `validate`: tên, Page đang kết nối và nội dung (cắt khoảng trắng); `partial` = sửa (trường vắng thì giữ).
    async fn bc_validate(
        &self,
        company: CompanyRef,
        input: &BroadcastInput,
        partial: bool,
    ) -> Result<Validated, AppError> {
        let mut out = Validated {
            name: None,
            page_id: None,
            text: None,
            audience: None,
        };
        if input.name.is_some() || !partial {
            let name = trinity_kernel::vi::trim_js(input.name.as_deref().unwrap_or(""));
            if name.is_empty() {
                return Err(HttpError::bad_request(NAME_REQUIRED).into());
            }
            out.name = Some(utf16_prefix(name, 120));
        }
        if input.page_id.is_some() || !partial {
            let page_id = input.page_id.as_deref().unwrap_or("");
            let ok = page_is_active(&mut *self.acquire(company).await?, page_id).await?;
            if !ok {
                return Err(HttpError::bad_request(PAGE_REQUIRED).into());
            }
            out.page_id = Some(page_id.to_owned());
        }
        if input.text.is_some() || !partial {
            let text = trinity_kernel::vi::trim_js(input.text.as_deref().unwrap_or(""));
            if text.is_empty() {
                return Err(HttpError::bad_request(TEXT_REQUIRED).into());
            }
            if text.encode_utf16().count() > MAX_TEXT {
                return Err(HttpError::bad_request(format!("Nội dung tối đa {MAX_TEXT} ký tự.")).into());
            }
            out.text = Some(text.to_owned());
        }
        if let Some(a) = &input.audience {
            out.audience = Some(Audience::from_value(a));
        }
        Ok(out)
    }

    /// Kiểm tên, Page và nội dung như lúc tạo (`partial` = như lúc sửa) mà KHÔNG ghi gì: để tool MCP báo lỗi trước khi xin xác nhận.
    pub async fn check_broadcast(
        &self,
        company: CompanyRef,
        input: &BroadcastInput,
        partial: bool,
    ) -> Result<(), AppError> {
        self.bc_validate(company, input, partial).await.map(|_| ())
    }

    /// `POST /facebook/broadcasts`: tạo bản nháp (201).
    pub async fn create_broadcast(
        &self,
        company: CompanyRef,
        input: &BroadcastInput,
        actor_user_id: i32,
        source: &str,
    ) -> Result<Value, AppError> {
        let v = self.bc_validate(company, input, false).await?;
        let audience = v.audience.unwrap_or_default().to_value();
        let id: i32 = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar(
                "INSERT INTO facebook_broadcasts (name, page_id, text, audience, created_by, source, updated_at) \
                 VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, now()) RETURNING id",
            )
            .bind(v.name)
            .bind(v.page_id)
            .bind(v.text)
            .bind(trinity_kernel::json::js_json(&audience))
            .bind(actor_user_id)
            .bind(source)
            .fetch_one(&mut *c)
            .await
            .map_err(db)?
        };
        self.get_broadcast(company, id).await
    }

    /// `PATCH /facebook/broadcasts/:id`: chỉ sửa được lượt `draft`/`scheduled`; có điều kiện trạng thái nên lượt vừa chuyển sang
    /// `sending` (người nhận đã chốt theo bản cũ) thì không sửa nữa.
    pub async fn update_broadcast(
        &self,
        company: CompanyRef,
        id: i32,
        input: &BroadcastInput,
    ) -> Result<Value, AppError> {
        let found = find_broadcast(&mut *self.acquire(company).await?, id).await?;
        let Some(b) = found else {
            return Err(HttpError::not_found(NOT_FOUND).into());
        };
        if b.status != "draft" && b.status != "scheduled" {
            return Err(HttpError::bad_request("Lượt gửi đã chạy — không sửa được nữa.").into());
        }
        let v = self.bc_validate(company, input, true).await?;
        let n = {
            let mut c = self.acquire(company).await?;
            sqlx::query(
                "UPDATE facebook_broadcasts SET name = COALESCE($2::text, name), page_id = COALESCE($3::text, page_id), \
                 text = COALESCE($4::text, text), audience = COALESCE($5::text::jsonb, audience), updated_at = now() \
                 WHERE id = $1 AND status IN ('draft', 'scheduled')",
            )
            .bind(id)
            .bind(v.name)
            .bind(v.page_id)
            .bind(v.text)
            .bind(v.audience.map(|a| trinity_kernel::json::js_json(&a.to_value())))
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected()
        };
        if n != 1 {
            return Err(HttpError::bad_request("Lượt gửi vừa bắt đầu chạy — không sửa được nữa.").into());
        }
        self.get_broadcast(company, id).await
    }

    /// `DELETE /facebook/broadcasts/:id` (204): xoá lượt nháp/đã huỷ/đã xong (tin đã gửi giữ nguyên trong hộp thư).
    pub async fn delete_broadcast(&self, company: CompanyRef, id: i32) -> Result<(), AppError> {
        let found = find_broadcast(&mut *self.acquire(company).await?, id).await?;
        let Some(b) = found else {
            return Err(HttpError::not_found(NOT_FOUND).into());
        };
        if b.status == "sending" || b.status == "scheduled" {
            return Err(HttpError::bad_request("Lượt gửi đang chờ/đang chạy — bấm Huỷ trước.").into());
        }
        let mut tx = self.bc_begin(company).await?;
        sqlx::query("DELETE FROM facebook_broadcast_recipients WHERE broadcast_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM facebook_broadcasts WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(platform_db)
    }

    /// `POST /facebook/broadcasts/preview`: số khách sẽ nhận nếu gửi ngay, số khách khớp nhưng quá 24 giờ, 5 tên mẫu.
    pub async fn preview_broadcast(
        &self,
        company: CompanyRef,
        page_id: &str,
        audience: &Audience,
        now: DateTime<Utc>,
    ) -> Result<Value, AppError> {
        let mut c = self.acquire(company).await?;
        if !page_is_active(&mut c, page_id).await? {
            return Err(HttpError::bad_request(PAGE_REQUIRED).into());
        }
        let (eligible, outside) = audience_query(&mut c, page_id, audience, now).await?;
        let sample: Vec<String> = eligible
            .iter()
            .take(5)
            .map(|(_, n)| n.clone().unwrap_or_else(|| "Khách".to_owned()))
            .collect();
        Ok(json!({ "eligible": eligible.len(), "outside_window": outside, "sample": sample }))
    }

    /// `POST /facebook/broadcasts/:id/send`: gửi ngay hoặc hẹn giờ (`at`); người nhận chốt lúc tới giờ gửi. Khoá kênh, trần người
    /// nhận của gói và (với giờ hẹn rơi vào lúc còn tạm dừng) tạm dừng tự động chặn ngay từ đây.
    pub async fn send_broadcast(
        &self,
        company: CompanyRef,
        guard: Option<&ChannelGuard>,
        id: i32,
        at: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Value, AppError> {
        let found = find_broadcast(&mut *self.acquire(company).await?, id).await?;
        let Some(b) = found else {
            return Err(HttpError::not_found(NOT_FOUND).into());
        };
        if b.status != "draft" && b.status != "scheduled" {
            return Err(HttpError::bad_request("Lượt này đã gửi hoặc đã huỷ — tạo lượt mới.").into());
        }
        let when = send_time(at, now)?;
        if let Some(g) = guard.filter(|g| g.enforced()) {
            g.assert_outbound(company, OutboundMode::Manual, OutboundScope::Meta)
                .await?;
            let gate = g.block_reason(company, OutboundMode::Auto, OutboundScope::Meta).await?;
            if let Some(r) = gate
                && r.code == BlockCode::ChannelPaused
                && r.until.is_some_and(|u| when < u)
            {
                return Err(GuardError::from(ChannelBlocked::new(r.code, r.message)).into());
            }
            let eligible = {
                let mut c = self.acquire(company).await?;
                audience_query(&mut c, &b.page_id, &Audience::from_value(&b.audience.0), now)
                    .await?
                    .0
                    .len()
            };
            g.assert_recipients(company, u32::try_from(eligible).unwrap_or(u32::MAX))
                .await?;
        }
        let n = {
            let mut c = self.acquire(company).await?;
            sqlx::query(
                "UPDATE facebook_broadcasts SET status = 'scheduled', scheduled_at = $2, updated_at = now() \
                 WHERE id = $1 AND status IN ('draft', 'scheduled')",
            )
            .bind(id)
            .bind(when)
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected()
        };
        if n != 1 {
            return Err(HttpError::bad_request("Lượt này vừa bắt đầu gửi — không đổi giờ được nữa.").into());
        }
        self.get_broadcast(company, id).await
    }

    /// `POST /facebook/broadcasts/:id/cancel`: lượt chờ giờ gửi về `cancelled`; đang gửi thì dừng, người chưa gửi ghi "bỏ qua".
    pub async fn cancel_broadcast(&self, company: CompanyRef, id: i32) -> Result<Value, AppError> {
        let found = find_broadcast(&mut *self.acquire(company).await?, id).await?;
        let Some(b) = found else {
            return Err(HttpError::not_found(NOT_FOUND).into());
        };
        if b.status == "done" || b.status == "cancelled" {
            return Err(HttpError::bad_request("Lượt gửi đã kết thúc.").into());
        }
        if b.status == "draft" {
            return Err(HttpError::bad_request("Lượt nháp chưa gửi — không cần huỷ.").into());
        }
        let mut tx = self.bc_begin(company).await?;
        let n = sqlx::query(
            "UPDATE facebook_broadcast_recipients SET status = 'skipped', note = 'Đã huỷ lượt gửi' \
             WHERE broadcast_id = $1 AND status = 'queued'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        let done = sqlx::query(
            "UPDATE facebook_broadcasts SET status = 'cancelled', finished_at = now(), skipped = skipped + $2, \
             updated_at = now() WHERE id = $1 AND status IN ('scheduled', 'sending')",
        )
        .bind(id)
        .bind(i32::try_from(n).unwrap_or(i32::MAX))
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if done != 1 {
            // Vừa kết thúc ở tiến trình khác: bỏ giao dịch (hoàn tác phần người nhận).
            return Err(HttpError::bad_request("Lượt gửi đã kết thúc.").into());
        }
        tx.commit().await.map_err(platform_db)?;
        self.get_broadcast(company, id).await
    }

    // ───────────────────────── chạy nền

    /// Một lượt job của một công ty (`runDue`): bắt đầu các lượt tới giờ (chốt người nhận), đánh `failed` người nhận kẹt, rồi gửi
    /// tiếp các lượt đang chạy theo lô trong `budget`. Cắt giữa chừng rồi gọi lại thì gửi tiếp từ người còn `queued`, không trùng.
    pub async fn broadcasts_run_due(
        &self,
        company: CompanyRef,
        guard: Option<&ChannelGuard>,
        budget: Duration,
        now: DateTime<Utc>,
    ) -> Result<RunStats, AppError> {
        let t0 = Instant::now();
        let mut out = RunStats::default();
        let due: Vec<i32> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar(
                "SELECT id FROM facebook_broadcasts WHERE status = 'scheduled' AND scheduled_at <= $1 \
                 ORDER BY scheduled_at ASC, id ASC LIMIT 5",
            )
            .bind(now)
            .fetch_all(&mut *c)
            .await
            .map_err(db)?
        };
        for id in due {
            if self.bc_start(company, guard, id, now).await? {
                out.started += 1;
            }
        }
        self.bc_sweep_stale(company, now).await?;
        let running: Vec<i32> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar("SELECT id FROM facebook_broadcasts WHERE status = 'sending' ORDER BY id ASC LIMIT 5")
                .fetch_all(&mut *c)
                .await
                .map_err(db)?
        };
        for id in running {
            while t0.elapsed() < budget {
                let r = self.bc_send_batch(company, guard, id, now).await?;
                out.sent += r.sent;
                out.failed += r.failed;
                out.skipped += r.skipped;
                if r.left == 0 || r.paused {
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Chốt danh sách người nhận (khách trong 24 giờ khớp bộ lọc) và chuyển lượt sang `sending` trong MỘT giao dịch. Chỉ một tiến
    /// trình thắng nhờ `UPDATE ... WHERE status = 'scheduled' AND scheduled_at <= now`; lượt vừa bị dời giờ thì chưa tới lượt.
    async fn bc_start(
        &self,
        company: CompanyRef,
        guard: Option<&ChannelGuard>,
        id: i32,
        now: DateTime<Utc>,
    ) -> Result<bool, AppError> {
        // Phòng thủ: người nhận lúc tới giờ có thể đã tăng so với lúc bấm gửi ⇒ cắt theo trần của gói (đọc TRƯỚC khi mở giao dịch).
        let cap = match guard {
            Some(g) => g.recipient_cap(company).await,
            None => u32::MAX,
        };
        let cap = usize::try_from(cap).unwrap_or(usize::MAX);
        let mut tx = self.bc_begin(company).await?;
        let claimed: Option<(String, JsonValue)> = sqlx::query_as(
            "UPDATE facebook_broadcasts SET status = 'sending', started_at = $2, updated_at = now() \
             WHERE id = $1 AND status = 'scheduled' AND scheduled_at <= $2 RETURNING page_id, audience",
        )
        .bind(id)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        let Some((page_id, audience)) = claimed else {
            return Ok(false);
        };
        let (eligible, _) = audience_query(&mut tx, &page_id, &Audience::from_value(&audience.0), now).await?;
        if eligible.len() > cap {
            tracing::warn!(
                "Lượt gửi hàng loạt #{id}: {} người nhận, cắt còn {cap} theo hạn mức gói",
                eligible.len()
            );
        }
        let ids: Vec<i32> = eligible.iter().take(cap).map(|(i, _)| *i).collect();
        if ids.is_empty() {
            sqlx::query(
                "UPDATE facebook_broadcasts SET total = 0, status = 'done', finished_at = $2, updated_at = now() \
                 WHERE id = $1",
            )
            .bind(id)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        } else {
            sqlx::query(
                "INSERT INTO facebook_broadcast_recipients (broadcast_id, conversation_id) \
                 SELECT $1, UNNEST($2::int4[]) ON CONFLICT (broadcast_id, conversation_id) DO NOTHING",
            )
            .bind(id)
            .bind(&ids)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
            sqlx::query("UPDATE facebook_broadcasts SET total = $2, updated_at = now() WHERE id = $1")
                .bind(id)
                .bind(i32::try_from(ids.len()).unwrap_or(i32::MAX))
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(platform_db)?;
        Ok(true)
    }

    /// Người nhận kẹt ở `sending` quá [`LEASE_MS`] (tiến trình chết giữa chừng) ⇒ `failed`, KHÔNG gửi lại; cộng `failed` của lượt.
    async fn bc_sweep_stale(&self, company: CompanyRef, now: DateTime<Utc>) -> Result<(), AppError> {
        let before = now - chrono::Duration::milliseconds(LEASE_MS);
        let mut c = self.acquire(company).await?;
        sqlx::query(
            "WITH s AS (UPDATE facebook_broadcast_recipients SET status = 'failed', note = $2 \
                        WHERE status = 'sending' AND claimed_at < $1 RETURNING broadcast_id) \
             UPDATE facebook_broadcasts b SET failed = b.failed + x.n, updated_at = now() \
             FROM (SELECT broadcast_id, count(*)::int4 AS n FROM s GROUP BY broadcast_id) x WHERE b.id = x.broadcast_id",
        )
        .bind(before)
        .bind(STALE_NOTE)
        .execute(&mut *c)
        .await
        .map_err(db)?;
        Ok(())
    }

    async fn bc_left(&self, company: CompanyRef, id: i32) -> Result<i64, AppError> {
        let mut c = self.acquire(company).await?;
        sqlx::query_scalar(
            "SELECT count(*) FROM facebook_broadcast_recipients WHERE broadcast_id = $1 AND status = 'queued'",
        )
        .bind(id)
        .fetch_one(&mut *c)
        .await
        .map_err(db)
    }

    async fn bc_send_batch(
        &self,
        company: CompanyRef,
        guard: Option<&ChannelGuard>,
        id: i32,
        now: DateTime<Utc>,
    ) -> Result<BatchStats, AppError> {
        let mut r = BatchStats::default();
        let (head, queue) = {
            let mut c = self.acquire(company).await?;
            let head: Option<(String, String, String, String, i32)> =
                sqlx::query_as("SELECT status, name, page_id, text, created_by FROM facebook_broadcasts WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(db)?;
            let queue: Vec<(i32, i32)> = sqlx::query_as(
                "SELECT id, conversation_id FROM facebook_broadcast_recipients \
                 WHERE broadcast_id = $1 AND status = 'queued' ORDER BY id ASC LIMIT $2",
            )
            .bind(id)
            .bind(BATCH)
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
            (head, queue)
        };
        let Some((status, name, page_id, text, created_by)) = head else {
            return Ok(r);
        };
        if status != "sending" {
            return Ok(r);
        }
        if queue.is_empty() {
            self.bc_finish_if_done(company, id).await?;
            return Ok(r);
        }
        let token = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, &page_id)
                .await?
                .map(|(_, t)| t)
        };
        let b = BatchCtx {
            company,
            guard,
            now,
            id,
            name,
            page_id,
            text,
            created_by,
            token,
        };
        for (rid, conv_id) in queue {
            // Tạm dừng (Facebook báo chặn/spam, hoặc giới hạn chung của app): GIỮ người nhận ở `queued`, lượt sau gửi tiếp.
            if let Some(g) = guard
                && let Some(gate) = g.block_reason(company, OutboundMode::Auto, OutboundScope::Meta).await?
                && gate.code == BlockCode::ChannelPaused
            {
                r.paused = true;
                r.left = self.bc_left(company, id).await?;
                return Ok(r);
            }
            // Giành người nhận: đúng một tiến trình thắng (cũng là điểm chặn gửi trùng khi chạy lại).
            let claimed = {
                let mut c = self.acquire(company).await?;
                sqlx::query(
                    "UPDATE facebook_broadcast_recipients SET status = 'sending', claimed_at = now() \
                     WHERE id = $1 AND status = 'queued'",
                )
                .bind(rid)
                .execute(&mut *c)
                .await
                .map_err(db)?
                .rows_affected()
            };
            if claimed == 0 {
                continue;
            }
            let delivery = match self.bc_deliver(&b, conv_id).await {
                Ok(d) => d,
                Err(e) => {
                    // Lỗi hệ thống TRƯỚC khi gọi Graph (chưa gửi gì): trả người nhận về hàng đợi rồi báo lỗi.
                    self.bc_unclaim(company, rid).await;
                    return Err(e);
                }
            };
            let done = match delivery {
                Delivery::Pause => {
                    self.bc_unclaim(company, rid).await;
                    r.paused = true;
                    r.left = self.bc_left(company, id).await?;
                    return Ok(r);
                }
                Delivery::Done(d) => d,
            };
            self.bc_settle(&b, rid, &done).await?;
            match done.status {
                "sent" => r.sent += 1,
                "failed" => r.failed += 1,
                _ => r.skipped += 1,
            }
            if let Some(stop) = done.stop_rest {
                // Page mất kết nối: phần còn lại báo lỗi luôn; hết hạn mức/khoá kênh: bỏ qua phần còn lại.
                let n = self.bc_stop_rest(&b, stop, done.note.as_deref()).await?;
                match stop {
                    "failed" => r.failed += n,
                    _ => r.skipped += n,
                }
                break;
            }
        }
        r.left = self.bc_left(company, id).await?;
        if r.left == 0 {
            self.bc_finish_if_done(company, id).await?;
        }
        Ok(r)
    }

    /// Trả người nhận (đã giành, CHƯA gọi Graph) về `queued`. Lỗi chỉ ghi log: nếu không trả được thì quá hạn sẽ bị đánh `failed`.
    async fn bc_unclaim(&self, company: CompanyRef, rid: i32) {
        let r = async {
            let mut c = self.acquire(company).await?;
            sqlx::query(
                "UPDATE facebook_broadcast_recipients SET status = 'queued', claimed_at = NULL \
                 WHERE id = $1 AND status = 'sending'",
            )
            .bind(rid)
            .execute(&mut *c)
            .await
            .map_err(db)
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Không trả được người nhận {rid} về hàng đợi: {e}");
        }
    }

    /// Mọi việc từ lúc giành tới lúc có kết cục. Chỉ trả `Err` khi CHƯA gọi Graph; sau khi gọi Graph luôn trả `Ok`.
    async fn bc_deliver(&self, b: &BatchCtx<'_>, conversation_id: i32) -> Result<Delivery, AppError> {
        let Some(token) = b.token.as_deref() else {
            return Ok(settled("failed", "Fanpage đã tắt hoặc mất kết nối", Some("failed")));
        };
        let found = {
            let mut c = self.acquire(b.company).await?;
            sqlx::query_as::<_, FacebookConversation>(sqlx::AssertSqlSafe(format!(
                "SELECT {CONV_COLS} FROM facebook_conversations WHERE id = $1"
            )))
            .bind(conversation_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?
        };
        let Some(conv) = found else {
            return Ok(settled("skipped", "Hội thoại không còn", None));
        };
        let last_inbound = conv.last_inbound_at.map(|t| t.0.timestamp_millis());
        if !within_messaging_window(last_inbound, b.now.timestamp_millis()) {
            return Ok(settled("skipped", OUTSIDE_NOTE, None));
        }
        let text = fill_template(&b.text, conv.customer_name.as_deref());
        // Hạn mức tin hàng loạt/ngày của gói (đếm nguyên tử TRƯỚC khi gọi Meta); khoá kênh / tự tạm dừng cũng dừng ở đây.
        let mut bucket = None;
        if let Some(g) = b.guard {
            match g
                .reserve(b.company, QuotaKind::BulkMessage, 1, OutboundScope::Meta)
                .await
            {
                Ok(got) => bucket = got,
                Err(GuardError::Blocked(blocked)) if blocked.code == BlockCode::ChannelPaused => {
                    return Ok(Delivery::Pause);
                }
                Err(GuardError::Blocked(blocked)) => {
                    return Ok(settled("skipped", blocked.message, Some("skipped")));
                }
                Err(GuardError::App(e)) => return Err(e),
            }
        }
        let graph = (self.graph_for)(b.company);
        match graph.send_text(token, &conv.psid, &text, false).await {
            Ok(sent) => Ok(Delivery::Done(Done {
                status: "sent",
                note: None,
                sent: Some((conv, sent.message_id, text)),
                stop_rest: None,
            })),
            Err(e) => {
                // Tin chưa tới Facebook ⇒ hoàn hạn mức đã giữ chỗ (đúng khung).
                if let Some(g) = b.guard {
                    g.refund(b.company, QuotaKind::BulkMessage, 1, bucket).await;
                }
                Ok(self.bc_map_graph_error(b, &conv, &e).await)
            }
        }
    }

    /// Lỗi Graph khi gửi ⇒ kết cục của người nhận (`deliver` của bản Node).
    async fn bc_map_graph_error(&self, b: &BatchCtx<'_>, conv: &FacebookConversation, e: &GraphApiError) -> Delivery {
        if e.is_outside_window() {
            return settled("skipped", "Quá 24 giờ kể từ tin cuối của khách", None);
        }
        if e.is_config_error() {
            let note = format!(
                "Cấu hình kết nối Facebook của máy chủ sai: {}",
                utf16_prefix(&e.message, 160)
            );
            return settled("failed", note, Some("failed"));
        }
        if e.is_token_error() {
            if let Ok(mut c) = self.acquire(b.company).await {
                let _ = pages::mark_token_invalid(&mut c, &b.page_id).await;
            }
            return settled(
                "failed",
                "Fanpage mất kết nối (token hết hạn) — kết nối lại rồi tạo lượt mới",
                Some("failed"),
            );
        }
        tracing::warn!("Gửi hàng loạt #{} → hội thoại {} lỗi: {e}", b.id, conv.id);
        settled("failed", format!("Facebook không nhận tin: {e}"), None)
    }

    /// Ghi kết cục của MỘT người nhận trong một giao dịch: biên nhận + bộ đếm là việc chính; tin vào hộp thư, outbox và lịch sử khách
    /// nằm trong savepoint (lỗi chỉ ghi log, không hoàn tác biên nhận).
    async fn bc_settle(&self, b: &BatchCtx<'_>, rid: i32, done: &Done) -> Result<(), AppError> {
        let mut tx = self.bc_begin(b.company).await?;
        let n = sqlx::query(
            "UPDATE facebook_broadcast_recipients SET status = $2::text, note = $3::text, \
             sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE NULL END WHERE id = $1 AND status = 'sending'",
        )
        .bind(rid)
        .bind(done.status)
        .bind(done.note.as_deref().map(|n| utf16_prefix(n, 300)))
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if n == 1 {
            sqlx::query(BUMP)
                .bind(b.id)
                .bind(done.status)
                .bind(1_i32)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        if let Some((conv, mid, text)) = &done.sent
            && side_begin(&mut tx).await
        {
            let res = bc_record_out(&mut tx, b, conv, mid, text).await;
            side_end(&mut tx, res.is_ok()).await;
            if let Err(e) = res {
                tracing::warn!("Ghi tin gửi hàng loạt #{} vào hộp thư lỗi: {e}", b.id);
            }
        }
        tx.commit().await.map_err(platform_db)
    }

    /// Đánh trạng thái `stop` cho mọi người còn `queued` của lượt và cộng bộ đếm. Trả số người.
    async fn bc_stop_rest(&self, b: &BatchCtx<'_>, stop: &'static str, note: Option<&str>) -> Result<usize, AppError> {
        let mut tx = self.bc_begin(b.company).await?;
        let n = sqlx::query(
            "UPDATE facebook_broadcast_recipients SET status = $2::text, note = $3::text \
             WHERE broadcast_id = $1 AND status = 'queued'",
        )
        .bind(b.id)
        .bind(stop)
        .bind(
            note.map(|n| utf16_prefix(n, 300))
                .unwrap_or_else(|| "Fanpage mất kết nối".to_owned()),
        )
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        sqlx::query(BUMP)
            .bind(b.id)
            .bind(stop)
            .bind(i32::try_from(n).unwrap_or(i32::MAX))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(platform_db)?;
        Ok(usize::try_from(n).unwrap_or(usize::MAX))
    }

    /// Hết người nhận chờ/đang gửi ⇒ lượt `done` (một tiến trình thắng nhờ điều kiện trạng thái) và phát outbox
    /// `messenger.broadcast_finished` (trong savepoint: lỗi không hoàn tác việc chốt).
    async fn bc_finish_if_done(&self, company: CompanyRef, id: i32) -> Result<(), AppError> {
        let pending: i64 = {
            let mut c = self.acquire(company).await?;
            sqlx::query_scalar(
                "SELECT count(*) FROM facebook_broadcast_recipients \
                 WHERE broadcast_id = $1 AND status IN ('queued', 'sending')",
            )
            .bind(id)
            .fetch_one(&mut *c)
            .await
            .map_err(db)?
        };
        if pending > 0 {
            return Ok(());
        }
        let mut tx = self.bc_begin(company).await?;
        let row: Option<(String, String, i32, i32, i32, i32, i32)> = sqlx::query_as(
            "UPDATE facebook_broadcasts SET status = 'done', finished_at = now(), updated_at = now() \
             WHERE id = $1 AND status = 'sending' RETURNING name, page_id, total, sent, failed, skipped, created_by",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        let Some((name, page_id, total, sent, failed, skipped, created_by)) = row else {
            return Ok(());
        };
        if side_begin(&mut tx).await {
            let payload = json!({
                "broadcast_id": id, "page_id": page_id, "name": name, "status": "done",
                "total": total, "sent": sent, "failed": failed, "skipped": skipped,
            });
            let res =
                publish_integration_event(&mut tx, "messenger.broadcast_finished", &payload, id, Some(created_by))
                    .await;
            side_end(&mut tx, res.is_ok()).await;
            if let Err(e) = res {
                tracing::warn!("Sự kiện webhook lượt gửi #{id} xong lỗi: {e}");
            }
        }
        tx.commit().await.map_err(platform_db)
    }
}

/// Lưu tin vào hộp thư + ghi lịch sử khách. Echo của Meta tới sau bị bỏ qua vì trùng `mid`.
async fn bc_record_out(
    tx: &mut TenantTx,
    b: &BatchCtx<'_>,
    conv: &FacebookConversation,
    mid: &str,
    text: &str,
) -> Result<(), AppError> {
    let now = Utc::now();
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO facebook_messages (conversation_id, mid, direction, text, sent_at) \
         VALUES ($1, $2, 'out', $3, $4) ON CONFLICT (mid) DO NOTHING RETURNING id",
    )
    .bind(conv.id)
    .bind(mid)
    .bind(text)
    .bind(now)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    if inserted.is_some() {
        sqlx::query("UPDATE facebook_conversations SET last_message_at = $2, last_message_preview = $3 WHERE id = $1")
            .bind(conv.id)
            .bind(now)
            .bind(utf16_prefix(text, 200))
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        let assigned = assigned_to(tx, conv.contact_id).await?;
        publish_integration_event(
            tx,
            "messenger.message_sent",
            &json!({
                "conversation_id": conv.id, "page_id": conv.page_id, "contact_id": conv.contact_id,
                "contact_assigned_to": assigned, "origin": "broadcast",
            }),
            conv.id,
            Some(b.created_by),
        )
        .await
        .map_err(AppError::internal)?;
    }
    if let Some(cid) = conv.contact_id {
        let description = utf16_prefix(&format!("Gửi tin hàng loạt \"{}\" qua Messenger: {text}", b.name), 2000);
        let details = json!({ "description": description, "source": "facebook_messenger" });
        let metadata = json!({ "facebook_page_id": conv.page_id, "psid": conv.psid, "broadcast_id": b.id });
        sqlx::query(
            "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
             VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, $4)",
        )
        .bind(cid)
        .bind(trinity_kernel::json::js_json(&details))
        .bind(trinity_kernel::json::js_json(&metadata))
        .bind(b.created_by)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW_MS: i64 = 1_800_000_000_000;

    fn now() -> DateTime<Utc> {
        DateTime::from_timestamp_millis(NOW_MS).unwrap()
    }

    fn msgs(e: &HttpError) -> String {
        format!("{:?}", e.body().message)
    }

    #[test]
    fn khop_hop_dong_routes_json() {
        let table = broadcast_routes();
        assert_eq!(table.len(), 9);
        let rep = trinity_http::router::check::check_embedded(&table, false);
        assert!(rep.ok(), "{:#?}", rep.problems);
        assert_eq!(rep.declared, 9);
    }

    #[test]
    fn lam_sach_bo_loc() {
        let a = Audience::from_value(
            &json!({ "source_ids": [3, 3, "4", 0, -1, 2.5, 3_000_000_000_i64, "x", null], "chat_link_ids": [7] }),
        );
        assert_eq!(a.source_ids, vec![3, 4]);
        assert_eq!(a.chat_link_ids, vec![7]);
        assert_eq!(a.to_value(), json!({ "source_ids": [3, 4], "chat_link_ids": [7] }));
        // Không phải object / mảng rỗng ⇒ bỏ khoá.
        assert_eq!(Audience::from_value(&json!(null)).to_value(), json!({}));
        assert_eq!(
            Audience::from_value(&json!({ "source_ids": "1" })).to_value(),
            json!({})
        );
        let many: Vec<i32> = (1..=80).collect();
        assert_eq!(
            Audience::from_value(&json!({ "source_ids": many })).source_ids.len(),
            50,
            "tối đa 50"
        );
    }

    #[test]
    fn dien_mau_ten() {
        assert_eq!(fill_template("Chào {ten}!", Some("  An ")), "Chào An!");
        assert_eq!(fill_template("Chào { TEN } và {Ten}", None), "Chào bạn và bạn");
        assert_eq!(fill_template("Chào {ten}", Some("   ")), "Chào bạn");
        // Tên chứa `$1` không bị hiểu là nhóm thay thế.
        assert_eq!(fill_template("{ten}", Some("a$1b")), "a$1b");
        assert_eq!(fill_template(&"x".repeat(2500), None).len(), 2000);
    }

    #[test]
    fn gio_gui() {
        assert_eq!(send_time(None, now()).unwrap(), now());
        assert_eq!(send_time(Some(""), now()).unwrap(), now());
        // Đã qua = ngay.
        assert_eq!(send_time(Some("2020-01-01T00:00:00Z"), now()).unwrap(), now());
        // Tương lai gần giữ nguyên (2027-01-15T08:00:00Z = 1_800_000_000_000).
        let later = send_time(Some("2027-01-15T09:00:00Z"), now()).unwrap();
        assert_eq!(later.timestamp_millis(), NOW_MS + 3_600_000);
        // Quá 7 ngày hoặc rác ⇒ 400.
        assert_eq!(
            send_time(Some("2027-02-15T09:00:00Z"), now()).unwrap_err().status(),
            400
        );
        assert_eq!(send_time(Some("không phải giờ"), now()).unwrap_err().status(), 400);
    }

    #[test]
    fn kiem_body_tao_sua() {
        let ok = BroadcastInput::from_json(
            &json!({ "name": "A", "page_id": "p", "text": "t", "audience": { "source_ids": [1] } }),
        )
        .unwrap();
        assert_eq!(ok.name.as_deref(), Some("A"));
        assert!(ok.audience.is_some());
        assert_eq!(
            BroadcastInput::from_json(&json!({})).unwrap(),
            BroadcastInput::default()
        );
        // null ⇒ chuỗi rỗng (service sẽ báo thiếu), không bao giờ NULL.
        let n = BroadcastInput::from_json(&json!({ "name": null })).unwrap();
        assert_eq!(n.name.as_deref(), Some(""));
        let e = BroadcastInput::from_json(&json!({ "name": 5, "text": "x".repeat(2001), "page_id": "p".repeat(41) }))
            .unwrap_err();
        let m = msgs(&e);
        assert!(m.contains("name must be a string"), "{m}");
        assert!(m.contains("text must be shorter than or equal to 2000"), "{m}");
        assert!(m.contains("page_id must be shorter than or equal to 40"), "{m}");
        assert!(BroadcastInput::from_json(&json!([1])).is_err());
    }

    #[test]
    fn kiem_body_xem_truoc_va_gui() {
        let (p, a) = parse_preview(&json!({ "page_id": "p1", "audience": { "chat_link_ids": [2] } })).unwrap();
        assert_eq!((p.as_str(), a.chat_link_ids), ("p1", vec![2]));
        assert!(msgs(&parse_preview(&json!({})).unwrap_err()).contains("page_id must be a string"));
        assert!(parse_preview(&json!({ "page_id": "p".repeat(41) })).is_err());
        assert!(parse_preview(&json!({ "page_id": null })).is_err());
        assert_eq!(parse_send(&json!({})).unwrap(), None);
        assert_eq!(parse_send(&json!({ "scheduled_at": null })).unwrap(), None);
        assert_eq!(
            parse_send(&json!({ "scheduled_at": "2027-01-01T00:00:00Z" }))
                .unwrap()
                .as_deref(),
            Some("2027-01-01T00:00:00Z")
        );
        assert!(parse_send(&json!({ "scheduled_at": 5 })).is_err());
        assert!(parse_send(&json!({ "scheduled_at": "x".repeat(41) })).is_err());
    }

    #[test]
    fn khai_bao_job() {
        assert_eq!(JOB_NAME, "facebook.broadcasts");
        assert_eq!((JOB_INTERVAL.as_secs(), JOB_BUDGET.as_secs()), (60, 30));
        assert!(RUN_BUDGET < JOB_BUDGET);
    }
}
