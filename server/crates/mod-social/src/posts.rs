//! Bài đăng (`social-posts.service.ts`, phần soạn và lên lịch của M54a): tạo (đăng ngay hoặc hẹn giờ ra nhiều Fanpage), xem
//! trước, danh sách, chi tiết, sửa, đổi giờ, huỷ, thử lại một kênh, gỡ bài khỏi mạng. Job nhận việc và đăng (`claim`,
//! `processOne`, `runDue`, `sweepStale`), số liệu và đồng bộ bài đã xoá thuộc M54b; nháp, khung giờ, mẫu chữ thuộc M55a.
//!
//! - Mỗi bước DB xin MỘT kết nối rồi nhả trước bước kế (kể cả khi gọi `media::resolve`, `ChannelGuard`, Graph); không hàm nào
//!   giữ hai kết nối cùng lúc nên pool một kết nối vẫn chạy.
//! - Hạn mức bài/ngày (`ChannelGuard`): đọc hạn mức TRƯỚC khi mở giao dịch, giữ chỗ TRONG giao dịch tạo bài (tạo lỗi thì hạn mức
//!   cũng hoàn lại), ghi sự kiện "vượt hạn mức" SAU giao dịch.
//! - Mọi lời gọi Graph đi qua [`mod_facebook::graph::GraphClient`] của công ty (chỉ có `delete_object` ở đây).
//! - Không có `kick()`: bản Node gọi `runDue` ngay sau request để đăng liền; ở bản Rust job `social.publish` (M54b) nhặt việc ở
//!   lượt chạy kế tiếp (tối đa 60 giây).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use mod_channel_guard::{ChannelGuard, GuardError, OutboundScope, QuotaKind, ReserveContext};
use mod_facebook::config::{Env, comment_automation_enabled};
use mod_facebook::graph::{GraphClient, utf16_prefix};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::models::{SocialAccount, SocialPost, SocialPostTarget};
use trinity_db::pg_error::app_error;
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, Db, DbError, TenantConn};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::instant::parse_instant_with;
use trinity_kernel::vn_time::{from_millis, js_iso_string};

use crate::accounts::for_publish;
use crate::config::{
    MAX_MEDIA_PER_POST, MAX_SCHEDULE_AHEAD_MS, REMOVED_SOCIAL_NETWORKS, caption_limit, is_social_network,
    network_label, removed_network_message, truncated_at,
};
use crate::dto::{PostInput, TargetInput};
use crate::first_comment::first_comment_of;
use crate::media::{MediaCtx, MediaStore, SocialMedia, resolve as resolve_media};
use crate::ports::{CreateFailure, RecurrenceGuard};
use crate::provider::{PublishErrorKind, classify_graph_error, validate_media, validate_options};
use crate::queue::{NO_QUEUE_SLOTS, next_free};
use crate::recurrences::guard_holds;
use crate::utm::{UtmInput, apply_utm_to_target, js_trim, normalize_utm, utf16_len};

const MINUTE_MS: i64 = 60_000;
const MAX_TARGETS: usize = 20;
const DEFAULT_LIST_LIMIT: i64 = 20;
const MAX_LIST_LIMIT: i64 = 100;
const BAD_ISO: &str = "scheduled_at không đúng định dạng ISO 8601.";
const NOT_FOUND_POST: &str = "Không tìm thấy bài đăng";
const NOT_FOUND_TARGET: &str = "Không tìm thấy kênh của bài";
const ONE_OR_THE_OTHER: &str = "Chỉ chọn một: vào hàng đợi (use_queue) hoặc giờ hẹn cụ thể (scheduled_at).";
const PAST: &str = "Giờ hẹn đã qua — chọn giờ trong tương lai hoặc đăng ngay.";
const TOO_FAR: &str = "Chỉ hẹn trước tối đa 90 ngày.";
const NEED_CHANNEL: &str = "Chọn ít nhất một kênh.";
const NEED_CONTENT: &str = "Bài cần có nội dung hoặc ảnh/video.";
const MEDIA_UNAVAILABLE: &str = "Không kiểm tra được tệp đính kèm lúc này — thử lại sau.";
const NO_COMMENT_PERM: &str =
    "Bình luận đầu tiên cần bật quyền bình luận Fanpage trên máy chủ (FACEBOOK_COMMENT_AUTOMATION)";

const ACCOUNTS_SQL: &str = "SELECT id, network, status, name, external_id FROM social_accounts WHERE id = ANY($1)";
const PAGES_SQL: &str = "SELECT page_id FROM facebook_pages WHERE page_id = ANY($1) AND is_active = true";
const INSERT_POST_SQL: &str = "INSERT INTO social_posts (content, media, scheduled_at, status, source, created_by, updated_at) \
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id";
const INSERT_TARGET_SQL: &str = "INSERT INTO social_post_targets (post_id, account_id, network, caption, options, next_attempt_at, updated_at) \
     VALUES ($1, $2, $3, $4, $5, $6, now())";
const LIST_SQL: &str = "SELECT * FROM social_posts WHERE ($1::text IS NULL OR status = $1::text) \
     AND (($2::timestamptz IS NULL AND $3::timestamptz IS NULL) \
       OR (scheduled_at IS NOT NULL AND ($2::timestamptz IS NULL OR scheduled_at >= $2::timestamptz) \
           AND ($3::timestamptz IS NULL OR scheduled_at <= $3::timestamptz)) \
       OR (scheduled_at IS NULL AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz) \
           AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz))) \
     AND ($4::int4 IS NULL OR id < $4::int4) ORDER BY id DESC LIMIT $5";

// ───────────────────────────── lỗi, kết nối ─────────────────────────────

fn bad(message: impl Into<String>) -> AppError {
    HttpError::bad_request(message.into()).into()
}

fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Lỗi xin kết nối: công ty không xác định/không hoạt động ⇒ 401, đang nâng cấp ⇒ 503, còn lại ⇒ 500.
fn platform_db(d: DbError) -> AppError {
    match d {
        DbError::InvalidCompany(_)
        | DbError::SingleTenant(_)
        | DbError::UnknownCompany(_)
        | DbError::CompanyInactive { .. } => HttpError::unauthorized("Unauthorized").into(),
        DbError::CompanyNotMigrated { .. } => HttpError::service_unavailable(d.to_string()).into(),
        other => HttpError::new(500, other.to_string()).into(),
    }
}

/// Xin một kết nối đã gắn công ty cho MỘT bước DB.
pub(crate) async fn acquire(db: &Db, company: CompanyRef) -> Result<TenantConn, AppError> {
    db.tenant(company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

/// Môi trường của một lần gọi: DB, công ty, kho tệp, env, Graph của công ty, bộ chặn kênh, người gọi, giờ hiện tại (mili giây).
pub struct PostCtx<'a> {
    pub db: &'a Db,
    pub company: CompanyRef,
    pub env: &'a Env,
    pub store: &'a MediaStore,
    pub graph: &'a GraphClient,
    pub guard: &'a ChannelGuard,
    pub user_id: i32,
    pub now_ms: i64,
}

impl PostCtx<'_> {
    fn media(&self) -> MediaCtx<'_> {
        MediaCtx {
            db: self.db,
            company: self.company,
            store: self.store,
            env: self.env,
            user_id: self.user_id,
            now_ms: self.now_ms,
        }
    }

    async fn conn(&self) -> Result<TenantConn, AppError> {
        acquire(self.db, self.company).await
    }
}

// ───────────────────────────── hàm thuần ─────────────────────────────

fn ts(ms: i64) -> Option<Timestamp> {
    from_millis(ms).map(Timestamp)
}

fn iso(ms: i64) -> String {
    js_iso_string(from_millis(ms).unwrap_or_default())
}

fn parse_ms(raw: &str) -> Option<i64> {
    parse_instant_with(raw, 0).map(|d| d.timestamp_millis())
}

/// Khoá tệp đã cắt khoảng trắng, bỏ rỗng, bỏ trùng (giữ thứ tự).
fn clean_keys(keys: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for k in keys {
        let k = js_trim(k);
        if !k.is_empty() && seen.insert(k.to_owned()) {
            out.push(k.to_owned());
        }
    }
    out
}

/// Tổng hợp trạng thái bài từ trạng thái các kênh (`aggregateStatus`).
pub fn aggregate_status(statuses: &[String], scheduled: bool) -> &'static str {
    if statuses.iter().all(|s| s == "cancelled") {
        return "cancelled";
    }
    let live: Vec<&str> = statuses
        .iter()
        .map(String::as_str)
        .filter(|s| *s != "cancelled")
        .collect();
    let any = |name: &str| live.contains(&name);
    let all = |name: &str| live.iter().all(|s| *s == name);
    if any("publishing") {
        return "publishing";
    }
    if any("queued") {
        return match (any("published") || any("failed"), scheduled) {
            (false, true) => "scheduled",
            _ => "publishing",
        };
    }
    if all("published") {
        return "published";
    }
    if all("failed") {
        return "failed";
    }
    "partial"
}

/// Options của một kênh + UTM đã chuẩn hoá. `input_utm`: UTM chung (`None` = theo `options.utm` của kênh, `Some(null)` = bỏ).
/// Có UTM thì `options.utm` = `{ source, medium: 'social', campaign, content? }`.
fn target_options(
    t: &TargetInput,
    input_utm: Option<&Value>,
    network: &str,
) -> Result<(Map<String, Value>, Option<UtmInput>), String> {
    let mut rest = t.options.clone().unwrap_or_default();
    let raw_utm = rest.remove("utm");
    let utm = normalize_utm(input_utm.or(raw_utm.as_ref()))?;
    if let Some(u) = &utm {
        let mut stored = json!({ "source": network, "medium": "social", "campaign": u.campaign });
        if let (Some(c), Some(o)) = (&u.content, stored.as_object_mut()) {
            o.insert("content".to_owned(), Value::String(c.clone()));
        }
        rest.insert("utm".to_owned(), stored);
    }
    Ok((rest, utm))
}

fn caption_of(t: &TargetInput) -> Option<String> {
    t.caption
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn too_long(name: &str, len: usize, with_utm: bool, network: &str, limit: usize) -> String {
    let note = if with_utm { " (đã tính tham số UTM)" } else { "" };
    let label = network_label(network);
    format!("{name}: nội dung dài {len} ký tự{note}, {label} cho tối đa {limit}.")
}

/// Tên mạng kể cả mạng đã gỡ (bài cũ).
fn label_any(network: &str) -> String {
    match REMOVED_SOCIAL_NETWORKS.iter().find(|(k, _)| *k == network) {
        Some((_, label)) => (*label).to_owned(),
        None if is_social_network(network) => network_label(network).to_owned(),
        None => network.to_owned(),
    }
}

/// Câu cho người dùng từ một lỗi: lỗi < 500 giữ nguyên câu, lỗi hạ tầng không lộ chi tiết.
fn user_message(e: AppError) -> String {
    match e {
        AppError::Http(h) if h.status() < 500 => match h.body().message {
            Message::One(s) => s,
            Message::Many(v) => v.join(", "),
        },
        _ => MEDIA_UNAVAILABLE.to_owned(),
    }
}

fn media_json(media: &[SocialMedia]) -> Value {
    serde_json::to_value(media).unwrap_or_else(|_| Value::Array(Vec::new()))
}

fn media_from_json(v: &Value) -> Option<SocialMedia> {
    let o = v.as_object()?;
    Some(SocialMedia {
        key: o.get("key")?.as_str()?.to_owned(),
        r#type: o.get("type")?.as_str()?.to_owned(),
        content_type: o.get("content_type")?.as_str()?.to_owned(),
        size: o.get("size")?.as_u64()?,
    })
}

pub(crate) fn stored_media(v: &Value) -> Vec<SocialMedia> {
    let items = v.as_array().map(Vec::as_slice).unwrap_or_default();
    items.iter().filter_map(media_from_json).collect()
}

/// Giờ hẹn lúc tạo (`validate`): vắng/rỗng ⇒ đăng ngay; đã qua > 1 phút hoặc xa hơn 90 ngày ⇒ 400; qua chưa tới 1 phút ⇒ đăng ngay.
fn schedule_for_create(raw: Option<&str>, now_ms: i64) -> Result<Option<i64>, AppError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let at = parse_ms(raw).ok_or_else(|| bad(BAD_ISO))?;
    let ahead = at - now_ms;
    if ahead < -MINUTE_MS {
        return Err(bad(PAST));
    }
    if ahead > MAX_SCHEDULE_AHEAD_MS {
        return Err(bad(TOO_FAR));
    }
    Ok((ahead > 0).then_some(at))
}

/// Giờ hẹn mới (`newSchedule`): ISO, sau bây giờ ít nhất 1 phút, trong 90 ngày.
pub fn new_schedule(raw: Option<&str>, now_ms: i64) -> Result<i64, AppError> {
    let at = raw.and_then(parse_ms).ok_or_else(|| bad(BAD_ISO))?;
    let ahead = at - now_ms;
    if ahead <= MINUTE_MS {
        return Err(bad(
            "Giờ hẹn phải sau bây giờ ít nhất 1 phút (muốn đăng ngay thì huỷ bài rồi tạo bài mới).",
        ));
    }
    if ahead > MAX_SCHEDULE_AHEAD_MS {
        return Err(bad(TOO_FAR));
    }
    Ok(at)
}

// ───────────────────────────── kiểm bài ─────────────────────────────

/// Kênh đăng (cột cần cho kiểm và xem trước).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccountRow {
    pub id: i32,
    pub network: String,
    pub status: String,
    pub name: String,
    pub external_id: String,
}

/// Một kênh đã kiểm: caption riêng (đã cắt) và options sau UTM.
#[derive(Debug, Clone)]
pub struct ValidTarget {
    pub account: AccountRow,
    pub caption: Option<String>,
    pub options: Map<String, Value>,
}

/// Bài đã kiểm đầy đủ, sẵn sàng ghi.
#[derive(Debug, Clone)]
pub struct Validated {
    pub content: String,
    pub media: Vec<SocialMedia>,
    /// Mili giây UTC; `None` = đăng ngay.
    pub scheduled_at: Option<i64>,
    pub targets: Vec<ValidTarget>,
}

async fn fetch_accounts(c: &PostCtx<'_>, ids: &[i32]) -> Result<HashMap<i32, AccountRow>, AppError> {
    let mut conn = c.conn().await?;
    let rows: Vec<AccountRow> = sqlx::query_as(ACCOUNTS_SQL)
        .bind(ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    Ok(rows.into_iter().map(|a| (a.id, a)).collect())
}

/// Kiểm toàn bộ bài, KHÔNG ghi gì (`validate`). `keep`: tệp đã lưu của bài đang sửa — giữ nguyên khoá thì dùng lại, không bắt
/// `resolve` lại (tệp đã ẩn khỏi thư viện vẫn giữ cho bài hẹn giờ).
pub async fn validate(c: &PostCtx<'_>, input: &PostInput, keep: Option<&[SocialMedia]>) -> Result<Validated, AppError> {
    let content = js_trim(&input.content).to_owned();
    let keys = clean_keys(&input.media_keys);
    if keys.len() > MAX_MEDIA_PER_POST {
        return Err(bad(format!("Tối đa {MAX_MEDIA_PER_POST} tệp mỗi bài.")));
    }
    let same = keep.is_some_and(|k| k.len() == keys.len() && k.iter().all(|m| keys.contains(&m.key)));
    let media = match keep {
        Some(k) if same => k.to_vec(),
        _ => resolve_media(&c.media(), &keys).await?,
    };
    if content.is_empty() && media.is_empty() {
        return Err(bad(NEED_CONTENT));
    }
    let scheduled_at = schedule_for_create(input.scheduled_at.as_deref(), c.now_ms)?;
    let targets = &input.targets;
    if targets.is_empty() {
        return Err(bad(NEED_CHANNEL));
    }
    if targets.len() > MAX_TARGETS {
        return Err(bad(format!("Tối đa {MAX_TARGETS} kênh mỗi bài.")));
    }
    let mut seen: HashSet<i32> = HashSet::new();
    let ids: Vec<i32> = targets
        .iter()
        .map(|t| t.account_id)
        .filter(|id| seen.insert(*id))
        .collect();
    if ids.len() != targets.len() {
        return Err(bad("Mỗi kênh chỉ chọn một lần."));
    }
    let by_id = fetch_accounts(c, &ids).await?;
    let mut resolved: Vec<ValidTarget> = Vec::with_capacity(targets.len());
    for t in targets {
        let id = t.account_id;
        let account = by_id
            .get(&id)
            .filter(|a| a.status != "disabled")
            .ok_or_else(|| bad(format!("Không tìm thấy kênh #{id}.")))?;
        // Kênh mạng đã gỡ mà chưa qua migration 0021 (vẫn active): báo đúng lý do, không lộ tên kênh — cùng câu với xem trước.
        if let Some(m) = removed_network_message(&account.network) {
            return Err(bad(format!("Kênh #{id}: {m}")));
        }
        let name = &account.name;
        if account.status != "active" {
            return Err(bad(format!("Kênh \"{name}\" cần liên kết lại trước khi đăng.")));
        }
        if !is_social_network(&account.network) {
            return Err(bad(format!("Kênh \"{name}\" không hợp lệ.")));
        }
        let caption = caption_of(t);
        let text = caption.as_deref().unwrap_or(&content);
        if let Some(m) = validate_media(&media) {
            return Err(bad(m));
        }
        let (options, utm) = target_options(t, input.utm.as_ref(), &account.network).map_err(bad)?;
        // Giới hạn ký tự tính trên nội dung SAU khi gắn UTM (liên kết dài ra); nội dung lưu vẫn sạch.
        let (sent_text, sent_options) = apply_utm_to_target(&account.network, text, &options);
        let len = utf16_len(&sent_text);
        let limit = caption_limit(&account.network).unwrap_or(usize::MAX);
        if len > limit {
            return Err(bad(too_long(name, len, utm.is_some(), &account.network, limit)));
        }
        if let Some(m) = validate_options(&sent_options) {
            return Err(bad(m));
        }
        resolved.push(ValidTarget {
            account: account.clone(),
            caption,
            options,
        });
    }
    check_first_comments(c, &resolved).await?;
    Ok(Validated {
        content,
        media,
        scheduled_at,
        targets: resolved,
    })
}

/// Facebook — bình luận đầu tiên đăng bằng token của kết nối "Fanpage Facebook" có quyền bình luận: kiểm ngay lúc tạo bài
/// (không để bài báo "đã đăng" mà bình luận lặng lẽ không lên).
async fn check_first_comments(c: &PostCtx<'_>, resolved: &[ValidTarget]) -> Result<(), AppError> {
    let wants: Vec<&ValidTarget> = resolved
        .iter()
        .filter(|r| r.account.network == "facebook" && first_comment_of(&r.options).is_some())
        .collect();
    if wants.is_empty() {
        return Ok(());
    }
    if !comment_automation_enabled(c.env) {
        return Err(bad(format!(
            "{NO_COMMENT_PERM} rồi kết nối lại Fanpage ở Cài đặt › Kết nối › Fanpage Facebook."
        )));
    }
    let page_ids: Vec<String> = wants.iter().map(|r| r.account.external_id.clone()).collect();
    let connected: HashSet<String> = {
        let mut conn = c.conn().await?;
        let rows: Vec<(String,)> = sqlx::query_as(PAGES_SQL)
            .bind(&page_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
        rows.into_iter().map(|r| r.0).collect()
    };
    for r in wants {
        if !connected.contains(&r.account.external_id) {
            let name = &r.account.name;
            return Err(bad(format!(
                "Bình luận đầu tiên: Fanpage \"{name}\" chưa kết nối ở Cài đặt › Kết nối › Fanpage Facebook."
            )));
        }
    }
    Ok(())
}

// ───────────────────────────── xem trước ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PreviewMedia {
    pub key: String,
    #[serde(rename = "type")]
    pub r#type: String,
}

/// Bản xem trước một kênh: đúng chữ sẽ gửi (sau UTM).
#[derive(Debug, Clone, Serialize)]
pub struct TargetPreview {
    pub account_id: i32,
    pub account_name: String,
    pub network: Option<String>,
    pub text: String,
    /// Facebook: bình luận đầu tiên (sau UTM).
    pub first_comment: Option<String>,
    pub length: usize,
    pub limit: Option<usize>,
    /// Vị trí mạng gập "Xem thêm" (xấp xỉ); `null` = hiện đủ.
    pub truncated_at: Option<usize>,
    pub media: Vec<PreviewMedia>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostPreview {
    pub scheduled_at: Option<String>,
    pub from_queue: bool,
    /// Cảnh báo chung (tệp, giờ hẹn, hàng đợi).
    pub warnings: Vec<String>,
    pub targets: Vec<TargetPreview>,
}

/// Giờ đăng của bản xem trước: chỉ ĐỌC khung trống (không giữ chỗ). Trả `(giờ, từ hàng đợi)` và ghi cảnh báo vào `general`.
async fn preview_schedule(
    c: &PostCtx<'_>,
    input: &PostInput,
    general: &mut Vec<String>,
) -> Result<(Option<i64>, bool), AppError> {
    let raw = input.scheduled_at.as_deref().filter(|s| !s.is_empty());
    if input.use_queue && raw.is_some() {
        general.push(ONE_OR_THE_OTHER.to_owned());
        return Ok((None, false));
    }
    if input.use_queue {
        let mut conn = c.conn().await?;
        let slots = next_free(&mut conn, 1, c.now_ms).await?;
        return Ok(match slots.first() {
            Some(slot) => (Some(slot.timestamp_millis()), true),
            None => {
                general.push(NO_QUEUE_SLOTS.to_owned());
                (None, false)
            }
        });
    }
    let Some(raw) = raw else {
        return Ok((None, false));
    };
    let Some(at) = parse_ms(raw) else {
        general.push(BAD_ISO.to_owned());
        return Ok((None, false));
    };
    let ahead = at - c.now_ms;
    if ahead < -MINUTE_MS {
        general.push(PAST.to_owned());
    } else if ahead > MAX_SCHEDULE_AHEAD_MS {
        general.push(TOO_FAR.to_owned());
    } else if ahead > 0 {
        return Ok((Some(at), false));
    }
    Ok((None, false))
}

/// Xem trước từng kênh sẽ đăng gì — đúng chữ lúc đăng gửi (sau UTM), KHÔNG ghi gì, KHÔNG giữ khung hàng đợi. Khác [`validate`]: lỗi
/// giới hạn/tệp/quyền không ném mà gom vào `warnings` để người soạn vừa xem vừa sửa. Chỉ ném khi đầu vào không dùng được.
pub async fn preview(c: &PostCtx<'_>, input: &PostInput) -> Result<PostPreview, AppError> {
    let content = js_trim(&input.content).to_owned();
    let targets = &input.targets;
    if targets.is_empty() {
        return Err(bad(NEED_CHANNEL));
    }
    if targets.len() > MAX_TARGETS {
        return Err(bad(format!("Tối đa {MAX_TARGETS} kênh mỗi bài.")));
    }
    let mut general: Vec<String> = Vec::new();
    let all_keys = clean_keys(&input.media_keys);
    if all_keys.len() > MAX_MEDIA_PER_POST {
        general.push(format!("Tối đa {MAX_MEDIA_PER_POST} tệp mỗi bài."));
    }
    let keys: Vec<String> = all_keys.into_iter().take(MAX_MEDIA_PER_POST).collect();
    let mut media: Vec<SocialMedia> = Vec::new();
    if !keys.is_empty() {
        match resolve_media(&c.media(), &keys).await {
            Ok(m) => media = m,
            // Lỗi kiểm tệp của người dùng (400…) thì hiện; lỗi hạ tầng (kho tệp, mạng) không lộ chi tiết nội bộ.
            Err(e) => general.push(user_message(e)),
        }
    }
    if content.is_empty() && media.is_empty() {
        general.push(NEED_CONTENT.to_owned());
    }
    let (scheduled_at, from_queue) = preview_schedule(c, input, &mut general).await?;
    let ids: Vec<i32> = targets.iter().map(|t| t.account_id).collect();
    let by_id = fetch_accounts(c, &ids).await?;
    let mut seen: HashSet<i32> = HashSet::new();
    let mut out: Vec<TargetPreview> = Vec::with_capacity(targets.len());
    for t in targets {
        let mut warnings: Vec<String> = Vec::new();
        if !seen.insert(t.account_id) {
            warnings.push("Kênh này được chọn nhiều lần — mỗi kênh chỉ chọn một lần.".to_owned());
        }
        let account = by_id
            .get(&t.account_id)
            .filter(|a| a.status != "disabled" && is_social_network(&a.network));
        let Some(account) = account else {
            // Kênh đã gỡ / không dùng được: như `validate` — coi là không có, không trả tên/mạng thật. Mạng đã gỡ còn active
            // (chưa qua migration 0021) ⇒ nói lý do, vẫn không lộ tên.
            let removed = by_id
                .get(&t.account_id)
                .filter(|a| a.status != "disabled")
                .and_then(|a| removed_network_message(&a.network));
            let why = match removed {
                Some(m) => format!("Kênh #{}: {m}", t.account_id),
                None => format!("Không tìm thấy kênh #{}.", t.account_id),
            };
            warnings.push(why);
            out.push(TargetPreview {
                account_id: t.account_id,
                account_name: format!("#{}", t.account_id),
                network: None,
                text: String::new(),
                first_comment: None,
                length: 0,
                limit: None,
                truncated_at: None,
                media: Vec::new(),
                warnings,
            });
            continue;
        };
        out.push(preview_target(c, input, t, account, &content, &media, warnings));
    }
    Ok(PostPreview {
        scheduled_at: scheduled_at.map(iso),
        from_queue,
        warnings: general,
        targets: out,
    })
}

fn preview_target(
    c: &PostCtx<'_>,
    input: &PostInput,
    t: &TargetInput,
    account: &AccountRow,
    content: &str,
    media: &[SocialMedia],
    mut warnings: Vec<String>,
) -> TargetPreview {
    let network = account.network.as_str();
    let name = &account.name;
    if account.status != "active" {
        warnings.push(format!("Kênh \"{name}\" cần liên kết lại trước khi đăng."));
    }
    let caption = caption_of(t);
    let (options, utm) = match target_options(t, input.utm.as_ref(), network) {
        Ok(v) => v,
        Err(m) => {
            warnings.push(m);
            let mut rest = t.options.clone().unwrap_or_default();
            rest.remove("utm");
            (rest, None)
        }
    };
    let (text, sent_options) = apply_utm_to_target(network, caption.as_deref().unwrap_or(content), &options);
    let length = utf16_len(&text);
    let limit = caption_limit(network);
    if limit.is_some_and(|l| length > l) {
        warnings.push(too_long(
            name,
            length,
            utm.is_some(),
            network,
            limit.unwrap_or(usize::MAX),
        ));
    }
    warnings.extend(validate_media(media));
    warnings.extend(validate_options(&sent_options));
    let first_comment = first_comment_of(&sent_options);
    if first_comment.is_some() && !comment_automation_enabled(c.env) {
        warnings.push(format!("{NO_COMMENT_PERM}."));
    }
    TargetPreview {
        account_id: account.id,
        account_name: name.clone(),
        network: Some(network.to_owned()),
        truncated_at: truncated_at(network, &text),
        text,
        first_comment,
        length,
        limit,
        media: media
            .iter()
            .map(|m| PreviewMedia {
                key: m.key.clone(),
                r#type: m.r#type.clone(),
            })
            .collect(),
        warnings,
    }
}

// ───────────────────────────── dạng trả ra ─────────────────────────────

/// Một kênh của bài kèm tên kênh (`SocialPostTarget` + `account_name`).
#[derive(Debug, Clone, Serialize)]
pub struct TargetView {
    pub id: i32,
    pub post_id: i32,
    pub account_id: i32,
    pub network: String,
    pub caption: Option<String>,
    pub options: Value,
    pub status: String,
    pub attempts: i32,
    pub next_attempt_at: Timestamp,
    pub claimed_at: Option<Timestamp>,
    pub external_post_id: Option<String>,
    pub url: Option<String>,
    pub last_error: Option<String>,
    pub published_at: Option<Timestamp>,
    pub metrics: Option<Value>,
    pub metrics_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub account_name: Option<String>,
}

/// Bài kèm các kênh (`PostWithTargets`).
#[derive(Debug, Clone, Serialize)]
pub struct PostView {
    pub id: i32,
    pub content: String,
    pub media: Value,
    pub scheduled_at: Option<Timestamp>,
    pub status: String,
    pub source: String,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub targets: Vec<TargetView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostList {
    pub data: Vec<PostView>,
    pub next_cursor: Option<i32>,
}

fn target_view(t: SocialPostTarget, account_name: Option<String>) -> TargetView {
    TargetView {
        id: t.id,
        post_id: t.post_id,
        account_id: t.account_id,
        network: t.network,
        caption: t.caption,
        options: t.options.0,
        status: t.status,
        attempts: t.attempts,
        next_attempt_at: t.next_attempt_at,
        claimed_at: t.claimed_at,
        external_post_id: t.external_post_id,
        url: t.url,
        last_error: t.last_error,
        published_at: t.published_at,
        metrics: t.metrics.map(|m| m.0),
        metrics_at: t.metrics_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
        account_name,
    }
}

fn post_view(p: SocialPost, targets: Vec<TargetView>) -> PostView {
    PostView {
        id: p.id,
        content: p.content,
        media: p.media.0,
        scheduled_at: p.scheduled_at,
        status: p.status,
        source: p.source,
        created_by: p.created_by,
        created_at: p.created_at,
        updated_at: p.updated_at,
        targets,
    }
}

// ───────────────────────────── đọc ─────────────────────────────

async fn find_post(conn: &mut PgConnection, id: i32) -> Result<Option<SocialPost>, AppError> {
    sqlx::query_as("SELECT * FROM social_posts WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

async fn find_target(conn: &mut PgConnection, id: i32) -> Result<Option<SocialPostTarget>, AppError> {
    sqlx::query_as("SELECT * FROM social_post_targets WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

async fn targets_of(conn: &mut PgConnection, post_id: i32) -> Result<Vec<SocialPostTarget>, AppError> {
    sqlx::query_as("SELECT * FROM social_post_targets WHERE post_id = $1 ORDER BY id ASC")
        .bind(post_id)
        .fetch_all(conn)
        .await
        .map_err(db)
}

/// Gắn các kênh (kèm tên kênh) vào bài.
async fn with_targets(conn: &mut PgConnection, posts: Vec<SocialPost>) -> Result<Vec<PostView>, AppError> {
    if posts.is_empty() {
        return Ok(Vec::new());
    }
    let post_ids: Vec<i32> = posts.iter().map(|p| p.id).collect();
    let targets: Vec<SocialPostTarget> =
        sqlx::query_as("SELECT * FROM social_post_targets WHERE post_id = ANY($1) ORDER BY id ASC")
            .bind(&post_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let account_ids: Vec<i32> = targets
        .iter()
        .map(|t| t.account_id)
        .collect::<HashSet<i32>>()
        .into_iter()
        .collect();
    let named: Vec<(i32, String)> = sqlx::query_as("SELECT id, name FROM social_accounts WHERE id = ANY($1)")
        .bind(&account_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let names: HashMap<i32, String> = named.into_iter().collect();
    let mut out = Vec::with_capacity(posts.len());
    for p in posts {
        let mut views = Vec::new();
        for t in targets.iter().filter(|t| t.post_id == p.id) {
            let name = names.get(&t.account_id).cloned();
            views.push(target_view(t.clone(), name));
        }
        out.push(post_view(p, views));
    }
    Ok(out)
}

/// `GET /social/posts/:id`: bài kèm trạng thái từng kênh.
pub async fn get(conn: &mut PgConnection, id: i32) -> Result<PostView, AppError> {
    let post = find_post(&mut *conn, id)
        .await?
        .ok_or_else(|| HttpError::not_found(NOT_FOUND_POST))?;
    let mut views = with_targets(conn, vec![post]).await?;
    views.pop().ok_or_else(|| HttpError::not_found(NOT_FOUND_POST).into())
}

/// Bộ lọc của `GET /social/posts` (`status`, `from`, `to`, `limit`, `cursor`).
#[derive(Debug, Clone, PartialEq)]
pub struct ListQuery {
    pub status: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub limit: i64,
    pub cursor: Option<i32>,
}

impl ListQuery {
    /// `limit`/`cursor` chỉ nhận chuỗi số (`/^\d+$/`), giá trị khác bỏ qua; `limit` kẹp 1–100 (mặc định 20); `cursor` 0 là không
    /// lọc, ngoài int4 ⇒ 400; `from`/`to` không đọc được thì bỏ qua; `status` rỗng không lọc.
    pub fn from_query(
        status: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
        limit: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Self, HttpError> {
        fn digits(v: Option<&str>) -> Option<&str> {
            v.filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        }
        let limit = digits(limit)
            .map(|s| i64::try_from(s.parse::<u64>().unwrap_or(u64::MAX)).unwrap_or(i64::MAX))
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .clamp(1, MAX_LIST_LIMIT);
        let cursor = match digits(cursor) {
            None => None,
            Some(s) => match s.parse::<i32>() {
                Ok(0) => None,
                Ok(n) => Some(n),
                Err(_) => return Err(HttpError::bad_request("cursor không hợp lệ")),
            },
        };
        let date = |v: Option<&str>| v.and_then(|s| parse_instant_with(s, 0));
        Ok(Self {
            status: status.filter(|s| !s.is_empty()).map(str::to_owned),
            from: date(from),
            to: date(to),
            limit,
            cursor,
        })
    }
}

/// `GET /social/posts` ⇒ `{ data, next_cursor }`, mới nhất trước. Lịch: bài hẹn giờ theo giờ hẹn, bài đăng ngay theo giờ tạo.
pub async fn list(conn: &mut PgConnection, q: &ListQuery) -> Result<PostList, AppError> {
    let mut rows: Vec<SocialPost> = sqlx::query_as(LIST_SQL)
        .bind(&q.status)
        .bind(q.from.map(Timestamp))
        .bind(q.to.map(Timestamp))
        .bind(q.cursor)
        .bind(q.limit + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let limit = usize::try_from(q.limit).unwrap_or(1);
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = if more { rows.last().map(|p| p.id) } else { None };
    let data = with_targets(conn, rows).await?;
    Ok(PostList { data, next_cursor })
}

/// Đọc lại bài trên một kết nối mới (sau khi nhả kết nối của bước ghi).
async fn reload(c: &PostCtx<'_>, id: i32) -> Result<PostView, AppError> {
    let mut conn = c.conn().await?;
    get(&mut conn, id).await
}

// ───────────────────────────── trạng thái ─────────────────────────────

/// Tính lại trạng thái bài từ trạng thái các kênh (`refreshStatus`).
pub async fn refresh_status(conn: &mut PgConnection, post_id: i32, now_ms: i64) -> Result<(), AppError> {
    let row: Option<(Option<Timestamp>,)> = sqlx::query_as("SELECT scheduled_at FROM social_posts WHERE id = $1")
        .bind(post_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some((scheduled_at,)) = row else {
        return Ok(());
    };
    let statuses: Vec<(String,)> = sqlx::query_as("SELECT status FROM social_post_targets WHERE post_id = $1")
        .bind(post_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let statuses: Vec<String> = statuses.into_iter().map(|s| s.0).collect();
    let scheduled = scheduled_at.is_some_and(|t| t.0.timestamp_millis() > now_ms);
    sqlx::query("UPDATE social_posts SET status = $2, updated_at = now() WHERE id = $1")
        .bind(post_id)
        .bind(aggregate_status(&statuses, scheduled))
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

// ───────────────────────────── tạo ─────────────────────────────

/// Đọc hạn mức bài/ngày của gói TRƯỚC khi mở giao dịch; `None` khi không áp hạn mức (bản cài một công ty).
async fn prepare_quota(c: &PostCtx<'_>) -> Result<Option<ReserveContext>, AppError> {
    let guard = c.guard;
    let reserved = guard.prepare_reserve(c.company, QuotaKind::Post, OutboundScope::Meta);
    Ok(reserved.await?)
}

/// Điều kiện thêm của giao dịch tạo bài (cổng M55b): lịch lặp còn nguyên, khoá nguồn chưa có bài.
#[derive(Default)]
pub(crate) struct CreateExtra<'a> {
    pub guard: Option<&'a RecurrenceGuard>,
    pub dedupe: bool,
}

/// Lỗi của [`insert_post`].
pub(crate) enum InsertFail {
    Guard(GuardError),
    Changed,
    Duplicate,
}

impl From<GuardError> for InsertFail {
    fn from(e: GuardError) -> Self {
        Self::Guard(e)
    }
}

impl From<AppError> for InsertFail {
    fn from(e: AppError) -> Self {
        Self::Guard(e.into())
    }
}

/// Ghi bài và các kênh trong MỘT giao dịch, giữ chỗ hạn mức cùng giao dịch (tạo lỗi thì hạn mức cũng hoàn lại).
async fn insert_post(
    c: &PostCtx<'_>,
    conn: &mut PgConnection,
    v: &Validated,
    source: &str,
    quota: Option<&ReserveContext>,
    extra: &CreateExtra<'_>,
) -> Result<i32, InsertFail> {
    let mut tx = sqlx::Acquire::begin(&mut *conn).await.map_err(db)?;
    // Bài do lịch lặp tạo: khoá dòng lịch rồi kiểm còn nguyên NGAY TRONG giao dịch (M55b), sau đó chống trùng khoá nguồn.
    if let Some(g) = extra.guard
        && !guard_holds(&mut tx, g).await?
    {
        return Err(InsertFail::Changed);
    }
    if extra.dedupe {
        let key = utf16_prefix(source, 80);
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&key)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let dup: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM social_posts WHERE source = $1)")
            .bind(&key)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if dup {
            return Err(InsertFail::Duplicate);
        }
    }
    if let Some(q) = quota {
        let amount = u32::try_from(v.targets.len()).unwrap_or(u32::MAX);
        c.guard.reserve_in(&mut tx, q, amount).await?;
    }
    let scheduled = v.scheduled_at.and_then(ts);
    let status = match scheduled {
        Some(_) => "scheduled",
        None => "publishing",
    };
    let post_id: i32 = sqlx::query_scalar(INSERT_POST_SQL)
        .bind(&v.content)
        .bind(media_json(&v.media))
        .bind(scheduled)
        .bind(status)
        .bind(utf16_prefix(source, 80))
        .bind(c.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    let next_attempt_at = scheduled.or_else(|| ts(c.now_ms));
    for t in &v.targets {
        sqlx::query(INSERT_TARGET_SQL)
            .bind(post_id)
            .bind(t.account.id)
            .bind(&t.account.network)
            .bind(&t.caption)
            .bind(Value::Object(t.options.clone()))
            .bind(next_attempt_at)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(post_id)
}

/// `POST /social/posts` ⇒ 201 + bài: đăng ngay (bỏ trống `scheduled_at`) hoặc hẹn giờ ra nhiều kênh. `use_queue` đặt vào khung
/// trống gần nhất của hàng đợi (không có khung ⇒ 400). Bài đăng ngay ở trạng thái `publishing`, việc đăng do job M54b nhận.
pub async fn create(c: &PostCtx<'_>, input: &PostInput) -> Result<PostView, AppError> {
    let id = match create_with(c, input, &CreateExtra::default()).await {
        Ok(id) => id,
        Err(CreateFailure::Failed(e)) => return Err(e),
        // Không có điều kiện lịch lặp thì không bao giờ `Changed`.
        Err(CreateFailure::Changed) => return Err(HttpError::new(409, "Lịch lặp đã đổi").into()),
    };
    reload(c, id).await
}

/// Lõi của [`create`], dùng chung với cổng `PostsPort` của bài lặp/nhập CSV (M55b): trả id bài.
pub(crate) async fn create_with(
    c: &PostCtx<'_>,
    input: &PostInput,
    extra: &CreateExtra<'_>,
) -> Result<i32, CreateFailure> {
    let mut input = input.clone();
    let queued = input.scheduled_at.as_deref().is_some_and(|s| !s.is_empty());
    if input.use_queue && queued {
        return Err(CreateFailure::Failed(bad(ONE_OR_THE_OTHER)));
    }
    if input.use_queue {
        let slots = {
            let mut conn = c.conn().await?;
            next_free(&mut conn, 1, c.now_ms).await?
        };
        let slot = slots.first().ok_or_else(|| bad(NO_QUEUE_SLOTS))?;
        input.scheduled_at = Some(iso(slot.timestamp_millis()));
    }
    let v = validate(c, &input, None).await?;
    let quota = prepare_quota(c).await?;
    let source = input.source.as_deref().unwrap_or("web");
    let inserted = {
        let mut conn = c.conn().await?;
        insert_post(c, &mut conn, &v, source, quota.as_ref(), extra).await
    };
    match inserted {
        Ok(id) => Ok(id),
        Err(InsertFail::Changed) => Err(CreateFailure::Changed),
        Err(InsertFail::Duplicate) => Err(CreateFailure::Failed(
            HttpError::new(409, "Bài của lượt này đã được tạo").into(),
        )),
        Err(InsertFail::Guard(mut e)) => {
            // Hết hạn mức: ghi sự kiện SAU giao dịch (đã nhả kết nối).
            c.guard.record_blocked(c.company, &mut e).await;
            Err(CreateFailure::Failed(e.into()))
        }
    }
}

// ───────────────────────────── sửa, đổi giờ ─────────────────────────────

/// Bài còn sửa được: đang hẹn giờ, còn hơn 1 phút mới tới giờ, mọi kênh chưa huỷ đều còn chờ (chưa kênh nào bắt đầu đăng).
pub async fn editable(
    conn: &mut PgConnection,
    id: i32,
    now_ms: i64,
) -> Result<(SocialPost, Vec<SocialPostTarget>), AppError> {
    let post = find_post(&mut *conn, id)
        .await?
        .ok_or_else(|| HttpError::not_found("Không tìm thấy bài"))?;
    let targets = targets_of(conn, id).await?;
    let live: Vec<SocialPostTarget> = targets.into_iter().filter(|t| t.status != "cancelled").collect();
    let waiting = live.iter().all(|t| t.status == "queued");
    let Some(at) = post.scheduled_at.filter(|_| !live.is_empty() && waiting) else {
        return Err(bad("Chỉ sửa được bài đang hẹn giờ mà chưa kênh nào bắt đầu đăng."));
    };
    if at.0.timestamp_millis() <= now_ms + MINUTE_MS {
        return Err(bad("Bài sắp tới giờ đăng — không sửa được nữa. Huỷ bài nếu cần."));
    }
    Ok((post, live))
}

/// Thay toàn bộ các kênh còn chờ và nội dung bài trong một giao dịch; kênh nào vừa bị job nhận đăng (không còn `queued`) ⇒ 409.
async fn replace_targets(
    c: &PostCtx<'_>,
    conn: &mut PgConnection,
    id: i32,
    live_ids: &[i32],
    v: &Validated,
    at: i64,
    quota: Option<(&ReserveContext, u32)>,
) -> Result<(), GuardError> {
    let mut tx = sqlx::Acquire::begin(&mut *conn).await.map_err(db)?;
    let removed = sqlx::query("DELETE FROM social_post_targets WHERE id = ANY($1) AND status = 'queued'")
        .bind(live_ids)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if removed.rows_affected() != live_ids.len() as u64 {
        return Err(GuardError::App(
            HttpError::conflict("Bài vừa bắt đầu đăng — không sửa được nữa.").into(),
        ));
    }
    // Kênh từng huỷ nay chọn lại: xoá dòng đã huỷ (mỗi bài một dòng / kênh) rồi tạo mới bên dưới.
    let account_ids: Vec<i32> = v.targets.iter().map(|t| t.account.id).collect();
    sqlx::query("DELETE FROM social_post_targets WHERE post_id = $1 AND status = 'cancelled' AND account_id = ANY($2)")
        .bind(id)
        .bind(&account_ids)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let scheduled = ts(at);
    sqlx::query(
        "UPDATE social_posts SET content = $2, media = $3, scheduled_at = $4, status = 'scheduled', updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&v.content)
    .bind(media_json(&v.media))
    .bind(scheduled)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    // Sửa bài thêm kênh đích ⇒ phần tăng thêm phải qua hạn mức/khoá kênh, cùng giao dịch (kênh cũ đã tính lúc tạo).
    if let Some((q, added)) = quota {
        c.guard.reserve_in(&mut tx, q, added).await?;
    }
    for t in &v.targets {
        sqlx::query(INSERT_TARGET_SQL)
            .bind(id)
            .bind(t.account.id)
            .bind(&t.account.network)
            .bind(&t.caption)
            .bind(Value::Object(t.options.clone()))
            .bind(scheduled)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(())
}

/// `PATCH /social/posts/:id`: sửa bài đang hẹn giờ (nội dung, tệp, giờ, danh sách kênh, tuỳ chọn từng kênh) — kiểm lại như lúc
/// tạo. `scheduled_at` bắt buộc và phải sau bây giờ ít nhất 1 phút.
pub async fn update(c: &PostCtx<'_>, id: i32, input: &PostInput) -> Result<PostView, AppError> {
    let (post, live) = {
        let mut conn = c.conn().await?;
        editable(&mut conn, id, c.now_ms).await?
    };
    let at = new_schedule(input.scheduled_at.as_deref(), c.now_ms)?;
    let stored = stored_media(&post.media.0);
    let mut checked = input.clone();
    checked.scheduled_at = Some(iso(at));
    let v = validate(c, &checked, Some(&stored)).await?;
    // Kênh đích MỚI (tài khoản chưa có trong các kênh đang chờ) mới tốn hạn mức; đổi kênh này lấy kênh khác vẫn là kênh mới.
    let existing: HashSet<i32> = live.iter().map(|t| t.account_id).collect();
    let added = v.targets.iter().filter(|t| !existing.contains(&t.account.id)).count();
    let quota = match added {
        0 => None,
        _ => prepare_quota(c).await?,
    };
    let live_ids: Vec<i32> = live.iter().map(|t| t.id).collect();
    let amount = u32::try_from(added).unwrap_or(u32::MAX);
    let replaced = {
        let mut conn = c.conn().await?;
        let q = quota.as_ref().map(|q| (q, amount));
        replace_targets(c, &mut conn, id, &live_ids, &v, at, q).await
    };
    if let Err(mut e) = replaced {
        c.guard.record_blocked(c.company, &mut e).await;
        return Err(e.into());
    }
    {
        let mut conn = c.conn().await?;
        refresh_status(&mut conn, id, c.now_ms).await?;
    }
    reload(c, id).await
}

/// `POST /social/posts/:id/reschedule`: chỉ đổi giờ hẹn (kéo-thả trên lịch).
pub async fn reschedule(c: &PostCtx<'_>, id: i32, scheduled_at: &str) -> Result<PostView, AppError> {
    let mut conn = c.conn().await?;
    let (_, live) = editable(&mut conn, id, c.now_ms).await?;
    let at = new_schedule(Some(scheduled_at), c.now_ms)?;
    let live_ids: Vec<i32> = live.iter().map(|t| t.id).collect();
    let mut tx = sqlx::Acquire::begin(&mut *conn).await.map_err(db)?;
    let moved = sqlx::query(
        "UPDATE social_post_targets SET next_attempt_at = $2, updated_at = now() WHERE id = ANY($1) AND status = 'queued'",
    )
    .bind(&live_ids)
    .bind(ts(at))
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    if moved.rows_affected() != live_ids.len() as u64 {
        return Err(HttpError::conflict("Bài vừa bắt đầu đăng — không đổi giờ được nữa.").into());
    }
    sqlx::query("UPDATE social_posts SET scheduled_at = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(ts(at))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    drop(conn);
    reload(c, id).await
}

// ───────────────────────────── huỷ, thử lại, gỡ ─────────────────────────────

/// `POST /social/posts/:id/cancel`: huỷ các kênh chưa đăng (`queued`, `failed`); bài đã lên mạng thì không gỡ ở đây.
pub async fn cancel(c: &PostCtx<'_>, id: i32) -> Result<PostView, AppError> {
    let mut conn = c.conn().await?;
    let post = get(&mut conn, id).await?;
    let changed = sqlx::query(
        "UPDATE social_post_targets SET status = 'cancelled', updated_at = now() \
         WHERE post_id = $1 AND status IN ('queued', 'failed')",
    )
    .bind(id)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    let had_cancelled = post.targets.iter().any(|t| t.status == "cancelled");
    if changed.rows_affected() == 0 && !had_cancelled {
        return Err(bad("Không còn kênh nào chờ đăng để huỷ."));
    }
    refresh_status(&mut conn, id, c.now_ms).await?;
    get(&mut conn, id).await
}

/// `POST /social/targets/:id/retry`: thử lại một kênh bị lỗi (người dùng đã sửa quyền / liên kết lại). Là một lượt đăng mới nên
/// qua hạn mức/khoá kênh như lúc tạo; cập nhật lỗi thì hoàn lại hạn mức. Job M54b nhận việc ở lượt kế tiếp.
pub async fn retry(c: &PostCtx<'_>, target_id: i32) -> Result<PostView, AppError> {
    let target = {
        let mut conn = c.conn().await?;
        let t = find_target(&mut conn, target_id)
            .await?
            .ok_or_else(|| HttpError::not_found(NOT_FOUND_TARGET))?;
        if t.status != "failed" {
            return Err(bad("Chỉ thử lại được kênh đang báo lỗi."));
        }
        if let Some(m) = removed_network_message(&t.network) {
            return Err(bad(m));
        }
        let account = fetch_account(&mut conn, t.account_id).await?;
        if account.is_none_or(|a| a.status != "active") {
            return Err(bad("Kênh cần liên kết lại trước khi thử lại."));
        }
        t
    };
    let guard = c.guard;
    let reserved = guard.reserve(c.company, QuotaKind::Post, 1, OutboundScope::Meta);
    let bucket = reserved.await?;
    let updated = {
        let mut conn = c.conn().await?;
        sqlx::query(
            "UPDATE social_post_targets SET status = 'queued', attempts = 0, next_attempt_at = now(), last_error = NULL, \
             updated_at = now() WHERE id = $1",
        )
        .bind(target_id)
        .execute(&mut *conn)
        .await
        .map_err(db)
    };
    if let Err(e) = updated {
        guard.refund(c.company, QuotaKind::Post, 1, bucket).await;
        return Err(e);
    }
    {
        let mut conn = c.conn().await?;
        refresh_status(&mut conn, target.post_id, c.now_ms).await?;
    }
    reload(c, target.post_id).await
}

async fn fetch_account(conn: &mut PgConnection, id: i32) -> Result<Option<SocialAccount>, AppError> {
    sqlx::query_as("SELECT * FROM social_accounts WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)
}

/// `DELETE /social/targets/:id/remote`: gỡ bài đã đăng khỏi Facebook (xoá đối tượng bằng token Page). Gỡ nội dung KHÔNG bị khoá
/// kênh/tạm dừng chặn (dọn dẹp, không gửi thêm). Bài đã bị xoá thẳng trên mạng từ trước chỉ đồng bộ trạng thái. Kênh thành
/// `cancelled`, `url` xoá.
pub async fn delete_remote(c: &PostCtx<'_>, target_id: i32) -> Result<PostView, AppError> {
    let (target, account) = {
        let mut conn = c.conn().await?;
        let t = find_target(&mut conn, target_id)
            .await?
            .ok_or_else(|| HttpError::not_found(NOT_FOUND_TARGET))?;
        if t.status != "published" || t.external_post_id.is_none() {
            return Err(bad("Kênh này chưa có bài đã đăng để gỡ."));
        }
        if let Some(m) = removed_network_message(&t.network) {
            let label = label_any(&t.network);
            return Err(bad(format!("{m} Gỡ bài trực tiếp trên {label}.")));
        }
        let account = fetch_account(&mut conn, t.account_id).await?;
        let usable = account
            .filter(|a| a.status != "disabled" && is_social_network(&a.network))
            .ok_or_else(|| bad("Kênh đã bị gỡ khỏi Trinity — gỡ bài trực tiếp trên mạng."))?;
        (t, usable)
    };
    let external_id = target.external_post_id.clone().unwrap_or_default();
    let publishable = for_publish(c.env, &account)?;
    let mut note = "Đã gỡ bài khỏi mạng".to_owned();
    // Không giữ kết nối khi gọi Graph.
    if let Err(e) = c.graph.delete_object(&publishable.access_token, &external_id).await {
        let classified = classify_graph_error(&e);
        // Bài đã bị xoá thẳng trên mạng từ trước: không còn gì để gỡ, chỉ đồng bộ trạng thái.
        if classified.kind != PublishErrorKind::Gone {
            return Err(bad(classified.message));
        }
        note = "Bài đã bị xoá trên mạng từ trước".to_owned();
    }
    let mut conn = c.conn().await?;
    sqlx::query(
        "UPDATE social_post_targets SET status = 'cancelled', last_error = $2, url = NULL, updated_at = now() WHERE id = $1",
    )
    .bind(target_id)
    .bind(note)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    refresh_status(&mut conn, target.post_id, c.now_ms).await?;
    get(&mut conn, target.post_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn gop_trang_thai() {
        assert_eq!(aggregate_status(&[], true), "cancelled");
        assert_eq!(aggregate_status(&st(&["cancelled", "cancelled"]), true), "cancelled");
        assert_eq!(aggregate_status(&st(&["queued", "queued"]), true), "scheduled");
        assert_eq!(aggregate_status(&st(&["queued"]), false), "publishing");
        assert_eq!(aggregate_status(&st(&["queued", "published"]), true), "publishing");
        assert_eq!(aggregate_status(&st(&["queued", "failed"]), true), "publishing");
        assert_eq!(aggregate_status(&st(&["publishing", "published"]), true), "publishing");
        assert_eq!(aggregate_status(&st(&["published", "cancelled"]), false), "published");
        assert_eq!(aggregate_status(&st(&["failed", "cancelled"]), false), "failed");
        assert_eq!(aggregate_status(&st(&["published", "failed"]), false), "partial");
    }

    #[test]
    fn gio_hen() {
        let now = 1_800_000_000_000;
        let iso_at = |ms: i64| iso(ms);
        assert_eq!(schedule_for_create(None, now).unwrap(), None);
        assert_eq!(schedule_for_create(Some(""), now).unwrap(), None);
        let future = iso_at(now + 3_600_000);
        assert_eq!(schedule_for_create(Some(&future), now).unwrap(), Some(now + 3_600_000));
        // Qua chưa tới 1 phút ⇒ đăng ngay; xa hơn ⇒ 400.
        let just_past = iso_at(now - 30_000);
        assert_eq!(schedule_for_create(Some(&just_past), now).unwrap(), None);
        let past = iso_at(now - 120_000);
        assert!(schedule_for_create(Some(&past), now).is_err());
        let far = iso_at(now + MAX_SCHEDULE_AHEAD_MS + 1000);
        assert!(schedule_for_create(Some(&far), now).is_err());
        assert!(schedule_for_create(Some("x"), now).is_err());
        // Giờ mới của bài: phải sau 1 phút.
        let soon = iso_at(now + 30_000);
        assert!(new_schedule(Some(&soon), now).is_err());
        assert!(new_schedule(None, now).is_err());
        let ok = iso_at(now + 120_000);
        assert_eq!(new_schedule(Some(&ok), now).unwrap(), now + 120_000);
    }

    #[test]
    fn options_va_utm() {
        let t = TargetInput {
            account_id: 1,
            caption: None,
            options: json!({"first_comment": "hi", "utm": {"campaign": "kenh"}})
                .as_object()
                .cloned(),
        };
        // Không có UTM chung ⇒ theo options của kênh.
        let (o, utm) = target_options(&t, None, "facebook").unwrap();
        assert_eq!(utm.unwrap().campaign, "kenh");
        assert_eq!(o["utm"]["source"], "facebook");
        assert_eq!(o["utm"]["medium"], "social");
        assert_eq!(o["utm"]["campaign"], "kenh");
        assert_eq!(o["first_comment"], "hi");
        // UTM chung đè lên kênh; `null` bỏ hẳn.
        let shared = json!({"campaign": "chung", "content": "a b"});
        let (o, _) = target_options(&t, Some(&shared), "facebook").unwrap();
        assert_eq!(o["utm"]["campaign"], "chung");
        assert_eq!(o["utm"]["content"], "a-b");
        let (o, utm) = target_options(&t, Some(&Value::Null), "facebook").unwrap();
        assert!(utm.is_none() && !o.contains_key("utm"));
        let wrong = json!({"campaign": "a&b"});
        assert!(target_options(&t, Some(&wrong), "facebook").is_err());
    }

    #[test]
    fn tep_da_luu() {
        let stored = json!([
            {"key": "social/u1_a.png", "type": "image", "content_type": "image/png", "size": 5},
            {"key": "x"}
        ]);
        let m = stored_media(&stored);
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].key.as_str(), m[0].size), ("social/u1_a.png", 5));
        assert_eq!(media_json(&m)[0]["type"], "image");
        assert!(stored_media(&Value::Null).is_empty());
        assert_eq!(clean_keys(&st(&[" a ", "", "a", "b"])), ["a", "b"]);
    }

    #[test]
    fn bo_loc_danh_sach() {
        let q = ListQuery::from_query(None, None, None, None, None).unwrap();
        assert_eq!((q.limit, q.cursor, q.status), (20, None, None));
        let q = ListQuery::from_query(Some(""), Some("x"), None, Some("0"), Some("0")).unwrap();
        assert_eq!((q.limit, q.cursor, q.status, q.from), (1, None, None, None));
        let q = ListQuery::from_query(Some("scheduled"), Some("2026-12-01"), None, Some("500"), Some("7")).unwrap();
        assert_eq!((q.limit, q.cursor), (100, Some(7)));
        assert_eq!(q.status.as_deref(), Some("scheduled"));
        assert!(q.from.is_some() && q.to.is_none());
        let q = ListQuery::from_query(None, None, None, Some("-5"), Some("abc")).unwrap();
        assert_eq!((q.limit, q.cursor), (20, None));
        assert!(ListQuery::from_query(None, None, None, None, Some("99999999999")).is_err());
    }

    #[test]
    fn nhan_mang() {
        assert_eq!(label_any("facebook"), "Facebook Page");
        assert_eq!(label_any("tiktok"), "TikTok");
        assert_eq!(label_any("lạ"), "lạ");
    }
}
