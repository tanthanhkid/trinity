//! Bài nháp đăng đa kênh (`social-drafts.service.ts`, M55a): danh sách, chi tiết, tạo, sửa, xoá. Nháp được thiếu mọi thứ; chỉ
//! kiểm hình dạng + kênh/tệp có thật. Kiểm đầy đủ (giờ hẹn, giới hạn từng mạng) chỉ khi đăng.
//!
//! - Nháp "còn mở" = chưa đăng (`post_id IS NULL`) hoặc giữ chỗ đăng đã kẹt quá 10 phút (`post_id = -1`). Bài đăng không chia
//!   theo người nên nháp cũng chung cả công ty.
//! - Tệp kèm nháp được kiểm với thư viện ([`media::resolve`]) qua kết nối riêng; KHÔNG giữ kết nối pool khi gọi hàm đó.
//! - Sửa luôn đổi `updated_at` (như Prisma `@updatedAt`): `expected_updated_at` của lúc đăng dựa vào đó.
//! - **Chưa có** `POST /social/drafts/:id/publish`: cần dịch vụ tạo bài (M54a). Hằng [`PUBLISHING`], [`STALE_CLAIM_MS`] và
//!   [`DRAFT_COLS`] để M54a dùng lại cho bước giữ chỗ.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use mod_facebook::graph::utf16_prefix;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Connection, PgConnection};
use trinity_db::models::SocialDraft;
use trinity_db::pg_error::app_error;
use trinity_db::{CompanyRef, Db, TenantConn};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::instant::parse_instant_with;
use trinity_kernel::vi::{is_js_whitespace, trim_js};
use trinity_kernel::vn_time::from_millis;

use crate::media::{self, MediaCtx};

pub const MAX_DRAFT_CONTENT: usize = 63_206;
pub const MAX_DRAFT_TARGETS: usize = 20;
/// Số tệp tối đa mỗi bài (`MAX_MEDIA_PER_POST` của `social.config.ts`).
pub const MAX_MEDIA_PER_POST: usize = 10;
/// `post_id` tạm trong lúc đang đăng (không phải id bài thật).
pub const PUBLISHING: i32 = -1;
/// Giữ chỗ lâu hơn thế coi như kẹt (tiến trình chết giữa chừng) ⇒ nháp mở lại.
pub const STALE_CLAIM_MS: i64 = 10 * 60_000;
/// Khoá `source` của lần tạo đã có (nhập CSV tạo lại cùng dòng).
pub const ALREADY_CREATED: &str = "Dòng này đã được tạo ở lần nhập trước — không tạo lại.";
const NOT_FOUND: &str = "Không tìm thấy bài nháp";

pub const DRAFT_COLS: &str = "id, title, content, media, targets, scheduled_at, use_queue, ui, post_id, publishing_at, source, \
                              created_by, created_at, updated_at";
/// Điều kiện "nháp còn mở"; `$N` là mốc quá hạn giữ chỗ (`now - STALE_CLAIM_MS`).
fn open_clause(n: u32) -> String {
    format!("(post_id IS NULL OR (post_id = {PUBLISHING} AND publishing_at < ${n}))")
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn bad(m: &str) -> AppError {
    HttpError::bad_request(m).into()
}

fn ulen(s: &str) -> usize {
    s.encode_utf16().count()
}

fn platform_db(d: trinity_db::DbError) -> AppError {
    HttpError::new(500, d.to_string()).into()
}

async fn acquire(db: &Db, company: CompanyRef) -> Result<TenantConn, AppError> {
    db.tenant(company)
        .await
        .map_err(platform_db)?
        .acquire()
        .await
        .map_err(platform_db)
}

fn stale_cutoff(now_ms: i64) -> Result<DateTime<Utc>, AppError> {
    from_millis(now_ms - STALE_CLAIM_MS).ok_or_else(|| AppError::internal("giờ hệ thống ngoài khoảng"))
}

// ───────────────────────────── kiểu lưu trong JSON ─────────────────────────────

/// Tệp kèm nháp (`DraftMedia`), lưu ở cột `media`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftMedia {
    pub key: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub content_type: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Kênh của nháp (`DraftTarget`), lưu ở cột `targets`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftTarget {
    pub account_id: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
}

// ───────────────────────────── DTO ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaIn {
    pub key: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TargetIn {
    pub account_id: i32,
    pub caption: Option<String>,
    pub options: Option<Map<String, Value>>,
}

/// `SocialUtmDto` (chưa chuẩn hoá).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UtmIn {
    pub campaign: String,
    pub content: Option<String>,
}

/// `SocialDraftDto`. `Option` ngoài = có gửi hay không; `Option` trong = `null`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DraftInput {
    pub title: Option<Option<String>>,
    pub content: Option<Option<String>>,
    pub media: Option<Vec<MediaIn>>,
    pub targets: Option<Vec<TargetIn>>,
    pub scheduled_at: Option<Option<String>>,
    pub use_queue: Option<bool>,
    pub utm: Option<Option<UtmIn>>,
    pub ui: Option<Option<Map<String, Value>>>,
}

/// `@IsString() @MaxLength(max)` của trường tuỳ chọn tại `path`; thông điệp: MaxLength rồi IsString.
fn string_field(v: Option<&Value>, path: &str, max: usize, errs: &mut Vec<String>) -> Option<Option<String>> {
    match v {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) => {
            if ulen(s) > max {
                errs.push(format!("{path} must be shorter than or equal to {max} characters"));
            }
            Some(Some(s.clone()))
        }
        Some(_) => {
            errs.push(format!("{path} must be shorter than or equal to {max} characters"));
            errs.push(format!("{path} must be a string"));
            None
        }
    }
}

fn unknown_nested(o: &Map<String, Value>, known: &[&str], prefix: &str, errs: &mut Vec<String>) {
    for k in o.keys().filter(|k| !known.contains(&k.as_str())) {
        errs.push(format!("{prefix}property {k} should not exist"));
    }
}

fn parse_media(v: &Value, errs: &mut Vec<String>) -> Vec<MediaIn> {
    let Some(a) = v.as_array() else {
        errs.push("media must be an array".to_owned());
        return Vec::new();
    };
    if a.len() > MAX_MEDIA_PER_POST {
        errs.push(format!("media must contain no more than {MAX_MEDIA_PER_POST} elements"));
    }
    let mut out = Vec::new();
    for (i, item) in a.iter().enumerate() {
        let path = format!("media.{i}");
        if let Some(o) = item.as_object() {
            unknown_nested(o, &["key", "name"], &format!("{path}."), errs);
        }
        let key = match item.get("key") {
            Some(Value::String(s)) => {
                if ulen(s) > 200 {
                    errs.push(format!("{path}.key must be shorter than or equal to 200 characters"));
                }
                Some(s.clone())
            }
            _ => {
                errs.push(format!("{path}.key must be shorter than or equal to 200 characters"));
                errs.push(format!("{path}.key must be a string"));
                None
            }
        };
        let name = string_field(item.get("name"), &format!("{path}.name"), 200, errs).flatten();
        if let Some(key) = key {
            out.push(MediaIn { key, name });
        }
    }
    out
}

/// `account_id` là số nguyên ≥ 1; ngoài i32 thì đặt `overflow` (400 trơn, như `int4` ở mod-contacts) sau khi gom hết lỗi DTO.
fn parse_targets(v: &Value, errs: &mut Vec<String>, overflow: &mut bool) -> Vec<TargetIn> {
    // Bản Node: `targets: null` qua `@IsOptional` rồi `.length` ném TypeError (500). Bản này trả 400.
    let Some(a) = v.as_array() else {
        errs.push("targets must be an array".to_owned());
        return Vec::new();
    };
    if a.len() > MAX_DRAFT_TARGETS {
        errs.push(format!(
            "targets must contain no more than {MAX_DRAFT_TARGETS} elements"
        ));
    }
    let mut out = Vec::new();
    for (i, item) in a.iter().enumerate() {
        let path = format!("targets.{i}");
        if let Some(o) = item.as_object() {
            unknown_nested(o, &["account_id", "caption", "options"], &format!("{path}."), errs);
        }
        let n = item.get("account_id").and_then(Value::as_f64);
        if n.is_none_or(|x| x < 1.0) {
            errs.push(format!("{path}.account_id must not be less than 1"));
        }
        let id = n.filter(|x| x.fract() == 0.0);
        if id.is_none() {
            errs.push(format!("{path}.account_id must be an integer number"));
        }
        let caption = string_field(item.get("caption"), &format!("{path}.caption"), 70_000, errs).flatten();
        let options = match item.get("options") {
            None | Some(Value::Null) => None,
            Some(Value::Object(m)) => Some(m.clone()),
            Some(_) => {
                errs.push(format!("{path}.options must be an object"));
                None
            }
        };
        if let Some(x) = id.filter(|x| *x >= 1.0) {
            if x > f64::from(i32::MAX) {
                *overflow = true;
            } else {
                out.push(TargetIn {
                    account_id: x as i32,
                    caption,
                    options,
                });
            }
        }
    }
    out
}

fn parse_utm(v: &Value, errs: &mut Vec<String>) -> Option<UtmIn> {
    let Some(o) = v.as_object() else {
        errs.push("nested property utm must be either object or array".to_owned());
        return None;
    };
    unknown_nested(o, &["campaign", "content"], "utm.", errs);
    let campaign = match o.get("campaign") {
        Some(Value::String(s)) => {
            let n = ulen(s);
            if !(1..=100).contains(&n) {
                errs.push(
                    "utm.campaign must be longer than or equal to 1 and shorter than or equal to 100 characters"
                        .to_owned(),
                );
            }
            Some(s.clone())
        }
        _ => {
            errs.push(
                "utm.campaign must be longer than or equal to 1 and shorter than or equal to 100 characters".to_owned(),
            );
            errs.push("utm.campaign must be a string".to_owned());
            None
        }
    };
    let content = string_field(o.get("content"), "utm.content", 100, errs).flatten();
    campaign.map(|campaign| UtmIn { campaign, content })
}

impl DraftInput {
    /// Kiểm như class-validator (`forbidNonWhitelisted`): thuộc tính lạ trước, rồi từng trường theo thứ tự khai báo.
    /// Body không phải object ⇒ coi như object rỗng. `use_queue: null` ⇒ `false` (service TS: `Boolean(null)`).
    pub fn from_json(body: &Value) -> Result<Self, HttpError> {
        const KNOWN: [&str; 8] = [
            "title",
            "content",
            "media",
            "targets",
            "scheduled_at",
            "use_queue",
            "utm",
            "ui",
        ];
        let mut errs: Vec<String> = Vec::new();
        if let Some(o) = body.as_object() {
            unknown_nested(o, &KNOWN, "", &mut errs);
        }
        let mut overflow = false;
        let mut out = Self {
            title: string_field(body.get("title"), "title", 120, &mut errs),
            content: string_field(body.get("content"), "content", MAX_DRAFT_CONTENT, &mut errs),
            ..Self::default()
        };
        // `media: null` đi qua `@IsOptional` và bị `input.media ?? …` coi như vắng.
        if let Some(v) = body.get("media").filter(|v| !v.is_null()) {
            out.media = Some(parse_media(v, &mut errs));
        }
        if let Some(v) = body.get("targets") {
            out.targets = Some(parse_targets(v, &mut errs, &mut overflow));
        }
        match body.get("scheduled_at") {
            None => {}
            Some(Value::Null) => out.scheduled_at = Some(None),
            Some(Value::String(s)) if parse_instant_with(s, 0).is_some() => out.scheduled_at = Some(Some(s.clone())),
            Some(_) => errs.push("scheduled_at phải là ISO 8601".to_owned()),
        }
        match body.get("use_queue") {
            None => {}
            Some(Value::Null) => out.use_queue = Some(false),
            Some(Value::Bool(b)) => out.use_queue = Some(*b),
            Some(_) => errs.push("use_queue must be a boolean value".to_owned()),
        }
        match body.get("utm") {
            None => {}
            Some(Value::Null) => out.utm = Some(None),
            Some(v) => out.utm = parse_utm(v, &mut errs).map(Some),
        }
        match body.get("ui") {
            None => {}
            Some(Value::Null) => out.ui = Some(None),
            Some(Value::Object(m)) => out.ui = Some(Some(m.clone())),
            Some(_) => errs.push("ui must be an object".to_owned()),
        }
        if !errs.is_empty() {
            return Err(HttpError::validation(errs));
        }
        if overflow {
            return Err(HttpError::nest(400, None));
        }
        Ok(out)
    }
}

// ───────────────────────────── UTM ─────────────────────────────

const UTM_UNSAFE: [char; 7] = ['&', '#', '=', '?', '%', '/', '\\'];

/// `slug` của `social-utm.ts`: bỏ khoảng trắng hai đầu, mỗi nhóm khoảng trắng thành một dấu `-`.
fn utm_slug(v: &str, label: &str, min: usize) -> Result<String, String> {
    let mut s = String::new();
    let mut in_space = false;
    for c in trim_js(v).chars() {
        if is_js_whitespace(c) {
            if !in_space {
                s.push('-');
            }
            in_space = true;
        } else {
            in_space = false;
            s.push(c);
        }
    }
    if ulen(&s) < min {
        return Err(format!("UTM: {label} không được để trống."));
    }
    if ulen(&s) > 100 {
        return Err(format!("UTM: {label} tối đa 100 ký tự."));
    }
    if s.chars().any(|c| UTM_UNSAFE.contains(&c)) {
        return Err(format!("UTM: {label} không được chứa các ký tự & # = ? % /."));
    }
    Ok(s)
}

/// `normalizeUtm`: ra `{campaign, content?}` đã chuẩn hoá.
fn normalize_utm(u: &UtmIn) -> Result<Map<String, Value>, AppError> {
    let mut m = Map::new();
    m.insert(
        "campaign".to_owned(),
        Value::String(utm_slug(&u.campaign, "tên chiến dịch (campaign)", 1).map_err(|e| bad(&e))?),
    );
    if let Some(c) = u.content.as_deref().filter(|c| !c.is_empty()) {
        let c = trim_js(c);
        if !c.is_empty() {
            m.insert(
                "content".to_owned(),
                Value::String(utm_slug(c, "utm_content", 1).map_err(|e| bad(&e))?),
            );
        }
    }
    Ok(m)
}

/// Bước UTM của `build`: `utm` có gửi ⇒ thay UTM của mọi kênh (kênh đang có nếu không gửi `targets`); không gửi mà đổi danh
/// sách kênh ⇒ kênh mới theo UTM của các kênh đang có.
fn apply_utm(
    input_utm: &Option<Option<UtmIn>>,
    targets: Option<Vec<DraftTarget>>,
    cur: &[DraftTarget],
) -> Result<Option<Vec<DraftTarget>>, AppError> {
    let Some(utm) = input_utm else {
        let Some(mut t) = targets else { return Ok(None) };
        let cur_utm = cur
            .iter()
            .find_map(|x| x.options.as_ref()?.get("utm").filter(|u| !u.is_null()).cloned());
        if let Some(cu) = cur_utm {
            for x in &mut t {
                let has = x
                    .options
                    .as_ref()
                    .is_some_and(|o| o.get("utm").is_some_and(|u| !u.is_null()));
                if !has {
                    x.options
                        .get_or_insert_with(Map::new)
                        .insert("utm".to_owned(), cu.clone());
                }
            }
        }
        return Ok(Some(t));
    };
    let norm = utm.as_ref().map(normalize_utm).transpose()?;
    let base = targets.unwrap_or_else(|| cur.to_vec());
    Ok(Some(
        base.into_iter()
            .map(|mut x| {
                let mut o = x.options.take().unwrap_or_default();
                o.remove("utm");
                if let Some(n) = &norm {
                    o.insert("utm".to_owned(), Value::Object(n.clone()));
                }
                x.options = if o.is_empty() { None } else { Some(o) };
                x
            })
            .collect(),
    ))
}

// ───────────────────────────── dựng dữ liệu ─────────────────────────────

/// Các trường sẽ ghi (`None` = không đổi).
#[derive(Debug, Default)]
struct Built {
    title: Option<Option<String>>,
    content: Option<String>,
    media: Option<Vec<DraftMedia>>,
    targets: Option<Vec<DraftTarget>>,
    scheduled_at: Option<Option<DateTime<Utc>>>,
    use_queue: Option<bool>,
}

/// Kiểm nhẹ → các trường sẽ ghi. `existing` = tệp đang có trong nháp, khỏi kiểm lại với thư viện.
async fn build(
    c: &MediaCtx<'_>,
    input: &DraftInput,
    existing: &[DraftMedia],
    cur_targets: &[DraftTarget],
) -> Result<Built, AppError> {
    let mut out = Built::default();
    if let Some(q) = input.use_queue {
        out.use_queue = Some(q);
        if q && input
            .scheduled_at
            .as_ref()
            .is_some_and(|s| s.as_deref().is_some_and(|s| !s.is_empty()))
        {
            return Err(bad("Chỉ chọn một: vào hàng đợi hoặc giờ hẹn cụ thể."));
        }
        if q {
            out.scheduled_at = Some(None);
        }
    }
    if let Some(t) = &input.title {
        out.title = Some(
            t.as_deref()
                .map(trim_js)
                .filter(|s| !s.is_empty())
                .map(|s| utf16_prefix(s, 120)),
        );
    }
    if let Some(content) = &input.content {
        match content {
            Some(s) if ulen(s) <= MAX_DRAFT_CONTENT => out.content = Some(s.clone()),
            _ => return Err(bad(&format!("Nội dung tối đa {MAX_DRAFT_CONTENT} ký tự."))),
        }
    }
    if let Some(s) = &input.scheduled_at {
        match s.as_deref().filter(|s| !s.is_empty()) {
            None => out.scheduled_at = Some(None),
            Some(s) => {
                let t = parse_instant_with(s, 0).ok_or_else(|| bad("scheduled_at không đúng định dạng ISO 8601."))?;
                out.scheduled_at = Some(Some(t));
                if input.use_queue.is_none() {
                    out.use_queue = Some(false);
                }
            }
        }
    }
    if let Some(list) = &input.targets {
        if list.len() > MAX_DRAFT_TARGETS {
            return Err(bad(&format!("Tối đa {MAX_DRAFT_TARGETS} kênh mỗi bài.")));
        }
        let ids: Vec<i32> = list.iter().map(|t| t.account_id).collect();
        let uniq: HashSet<i32> = ids.iter().copied().collect();
        if uniq.len() != ids.len() {
            return Err(bad("Mỗi kênh chỉ chọn một lần."));
        }
        let have: HashSet<i32> = {
            let mut conn = acquire(c.db, c.company).await?;
            let rows: Vec<(i32,)> =
                sqlx::query_as("SELECT id FROM social_accounts WHERE id = ANY($1) AND status <> 'disabled'")
                    .bind(&ids)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(db)?;
            rows.into_iter().map(|r| r.0).collect()
        };
        if let Some(missing) = ids.iter().find(|id| !have.contains(id)) {
            return Err(bad(&format!("Không tìm thấy kênh #{missing}.")));
        }
        out.targets = Some(
            list.iter()
                .map(|t| DraftTarget {
                    account_id: t.account_id,
                    caption: t.caption.clone().filter(|s| !trim_js(s).is_empty()),
                    options: t.options.clone().filter(|o| !o.is_empty()),
                })
                .collect(),
        );
    }
    out.targets = apply_utm(&input.utm, out.targets.take(), cur_targets)?;
    if let Some(list) = &input.media {
        let mut keys: Vec<String> = Vec::new();
        for m in list {
            let k = trim_js(&m.key);
            if !k.is_empty() && !keys.iter().any(|x| x == k) {
                keys.push(k.to_owned());
            }
        }
        if keys.len() > MAX_MEDIA_PER_POST {
            return Err(bad(&format!("Tối đa {MAX_MEDIA_PER_POST} tệp mỗi bài.")));
        }
        let fresh: Vec<String> = keys
            .iter()
            .filter(|k| !existing.iter().any(|m| &m.key == *k))
            .cloned()
            .collect();
        let resolved = if fresh.is_empty() {
            Vec::new()
        } else {
            media::resolve(c, &fresh).await?
        };
        let mut media_out = Vec::with_capacity(keys.len());
        for k in &keys {
            let mut m = match existing.iter().find(|m| &m.key == k) {
                Some(m) => m.clone(),
                None => {
                    let r = resolved
                        .iter()
                        .find(|r| &r.key == k)
                        .ok_or_else(|| bad("Tệp không hợp lệ"))?;
                    DraftMedia {
                        key: r.key.clone(),
                        r#type: r.r#type.clone(),
                        content_type: r.content_type.clone(),
                        size: r.size,
                        name: None,
                    }
                }
            };
            // Tên: bản gửi sau cùng của khoá trong danh sách thắng (như `new Map(list.map(...))`), rồi tên đang có.
            let given = list
                .iter()
                .rev()
                .find(|x| trim_js(&x.key) == k)
                .and_then(|x| x.name.clone());
            if let Some(name) = given.or_else(|| m.name.clone()).filter(|n| !n.is_empty()) {
                m.name = Some(utf16_prefix(&name, 200));
            }
            media_out.push(m);
        }
        out.media = Some(media_out);
    }
    Ok(out)
}

// ───────────────────────────── DB ─────────────────────────────

/// `GET /social/drafts` ⇒ `{ data }`: nháp còn mở, mới sửa trước, tối đa 100.
pub async fn list(conn: &mut PgConnection, now_ms: i64) -> Result<Vec<SocialDraft>, AppError> {
    sqlx::query_as::<_, SocialDraft>(sqlx::AssertSqlSafe(format!(
        "SELECT {DRAFT_COLS} FROM social_drafts WHERE {} ORDER BY updated_at DESC LIMIT 100",
        open_clause(1)
    )))
    .bind(stale_cutoff(now_ms)?)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)
}

/// `GET /social/drafts/:id`; không có hoặc đã đăng ⇒ 404.
pub async fn get(conn: &mut PgConnection, id: i32, now_ms: i64) -> Result<SocialDraft, AppError> {
    sqlx::query_as::<_, SocialDraft>(sqlx::AssertSqlSafe(format!(
        "SELECT {DRAFT_COLS} FROM social_drafts WHERE id = $2 AND {}",
        open_clause(1)
    )))
    .bind(stale_cutoff(now_ms)?)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

/// Kiểm đầu vào như lúc lưu nhưng KHÔNG ghi (nhập CSV: xem trước từng dòng nháp).
pub async fn check(c: &MediaCtx<'_>, input: &DraftInput) -> Result<(), AppError> {
    build(c, input, &[], &[]).await.map(drop)
}

/// `POST /social/drafts` (201). `dedupe_source`: khoá duy nhất của lần tạo; đã có nháp mang khoá này ⇒ 409.
pub async fn create(
    c: &MediaCtx<'_>,
    input: &DraftInput,
    source: &str,
    dedupe_source: Option<&str>,
) -> Result<SocialDraft, AppError> {
    let b = build(c, input, &[], &[]).await?;
    let source = utf16_prefix(dedupe_source.unwrap_or(source), 80);
    let title = b.title.flatten();
    let content = b.content.unwrap_or_default();
    let media = serde_json::to_value(b.media.unwrap_or_default()).map_err(AppError::internal)?;
    let targets = serde_json::to_value(b.targets.unwrap_or_default()).map_err(AppError::internal)?;
    let scheduled = b.scheduled_at.flatten();
    let use_queue = b.use_queue.unwrap_or(false);
    let ui: Option<Value> = input.ui.clone().flatten().map(Value::Object);

    let mut conn = acquire(c.db, c.company).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    if let Some(d) = dedupe_source {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(d)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let dup: Option<(i32,)> = sqlx::query_as("SELECT id FROM social_drafts WHERE source = $1 LIMIT 1")
            .bind(d)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if dup.is_some() {
            return Err(HttpError::conflict(ALREADY_CREATED).into());
        }
    }
    let row = sqlx::query_as::<_, SocialDraft>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO social_drafts (title, content, media, targets, scheduled_at, use_queue, ui, source, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING {DRAFT_COLS}"
    )))
    .bind(title)
    .bind(content)
    .bind(media)
    .bind(targets)
    .bind(scheduled)
    .bind(use_queue)
    .bind(ui)
    .bind(source)
    .bind(c.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(row)
}

/// `PATCH /social/drafts/:id`: chỉ trường có gửi đổi; nháp đang đăng hoặc đã đăng ⇒ 409; giữ chỗ đã kẹt thì mở lại hẳn.
pub async fn update(c: &MediaCtx<'_>, id: i32, input: &DraftInput) -> Result<SocialDraft, AppError> {
    let cur: Option<SocialDraft> = {
        let mut conn = acquire(c.db, c.company).await?;
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {DRAFT_COLS} FROM social_drafts WHERE id = $1"
        )))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
    };
    let Some(cur) = cur else {
        return Err(HttpError::not_found(NOT_FOUND).into());
    };
    let cur_media: Vec<DraftMedia> = serde_json::from_value(cur.media.0.clone()).unwrap_or_default();
    let cur_targets: Vec<DraftTarget> = serde_json::from_value(cur.targets.0.clone()).unwrap_or_default();
    let b = build(c, input, &cur_media, &cur_targets).await?;
    // Sửa nội dung/kênh/tệp/giờ mà không kèm trạng thái màn soạn (vd trợ lý AI sửa) ⇒ bỏ trạng thái cũ, màn soạn dựng lại.
    let touched = b.content.is_some()
        || b.media.is_some()
        || b.targets.is_some()
        || b.scheduled_at.is_some()
        || b.use_queue.is_some();
    let set_ui = input.ui.is_some() || touched;
    let ui: Option<Value> = input.ui.clone().flatten().map(Value::Object);
    let media = b
        .media
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(AppError::internal)?;
    let targets = b
        .targets
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(AppError::internal)?;
    let (set_title, title) = (b.title.is_some(), b.title.flatten());
    let (set_sched, sched) = (b.scheduled_at.is_some(), b.scheduled_at.flatten());

    let mut conn = acquire(c.db, c.company).await?;
    let row = sqlx::query_as::<_, SocialDraft>(sqlx::AssertSqlSafe(format!(
        "UPDATE social_drafts SET \
           title = CASE WHEN $2 THEN $3 ELSE title END, \
           content = CASE WHEN $4 THEN $5 ELSE content END, \
           media = CASE WHEN $6 THEN $7 ELSE media END, \
           targets = CASE WHEN $8 THEN $9 ELSE targets END, \
           scheduled_at = CASE WHEN $10 THEN $11 ELSE scheduled_at END, \
           use_queue = CASE WHEN $12 THEN $13 ELSE use_queue END, \
           ui = CASE WHEN $14 THEN $15 ELSE ui END, \
           post_id = NULL, publishing_at = NULL, updated_at = now() \
         WHERE id = $1 AND {} RETURNING {DRAFT_COLS}",
        open_clause(16)
    )))
    .bind(id)
    .bind(set_title)
    .bind(title)
    .bind(b.content.is_some())
    .bind(b.content)
    .bind(media.is_some())
    .bind(media)
    .bind(targets.is_some())
    .bind(targets)
    .bind(set_sched)
    .bind(sched)
    .bind(b.use_queue.is_some())
    .bind(b.use_queue)
    .bind(set_ui)
    .bind(ui)
    .bind(stale_cutoff(c.now_ms)?)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    row.ok_or_else(|| HttpError::conflict("Nháp này đang được đăng hoặc đã đăng, không sửa được nữa.").into())
}

/// `DELETE /social/drafts/:id` (204); nháp đang đăng hoặc đã đăng không xoá được (404).
pub async fn remove(conn: &mut PgConnection, id: i32, now_ms: i64) -> Result<(), AppError> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(
        "DELETE FROM social_drafts WHERE id = $2 AND {}",
        open_clause(1)
    )))
    .bind(stale_cutoff(now_ms)?)
    .bind(id)
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    if r.rows_affected() == 0 {
        return Err(HttpError::not_found(NOT_FOUND).into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msgs(v: &Value) -> Vec<String> {
        let e = DraftInput::from_json(v).unwrap_err();
        let (_, b) = AppError::from(e).response(true);
        serde_json::from_value(serde_json::to_value(&b.message).unwrap()).unwrap_or_default()
    }

    #[test]
    fn dto_rong_va_day_du() {
        assert_eq!(DraftInput::from_json(&json!({})).unwrap(), DraftInput::default());
        let d = DraftInput::from_json(&json!({
            "title": null, "content": "xin chào", "media": [{"key":"a.png","name":"A"}],
            "targets": [{"account_id": 3, "caption": "c", "options": {"x": 1}}],
            "scheduled_at": "2026-12-01T03:00:00Z", "use_queue": false, "utm": {"campaign": "tet"},
            "ui": {"step": 2}
        }))
        .unwrap();
        assert_eq!(d.title, Some(None));
        assert_eq!(d.content, Some(Some("xin chào".to_owned())));
        assert_eq!(d.media.as_ref().unwrap()[0].name.as_deref(), Some("A"));
        assert_eq!(d.targets.as_ref().unwrap()[0].account_id, 3);
        assert_eq!(d.use_queue, Some(false));
        assert!(matches!(d.utm, Some(Some(_))) && matches!(d.ui, Some(Some(_))));
        // null: media bỏ qua, use_queue thành false, scheduled_at là "xoá giờ".
        let n = DraftInput::from_json(
            &json!({"media": null, "use_queue": null, "scheduled_at": null, "utm": null, "ui": null}),
        )
        .unwrap();
        assert_eq!(
            (n.media, n.use_queue, n.scheduled_at, n.utm, n.ui),
            (None, Some(false), Some(None), Some(None), Some(None))
        );
    }

    #[test]
    fn dto_thong_diep_class_validator() {
        assert_eq!(msgs(&json!({"zz":1})), ["property zz should not exist"]);
        assert_eq!(
            msgs(&json!({"title":"a".repeat(121)})),
            ["title must be shorter than or equal to 120 characters"]
        );
        assert_eq!(
            msgs(&json!({"scheduled_at":"hôm qua"})),
            ["scheduled_at phải là ISO 8601"]
        );
        assert_eq!(msgs(&json!({"scheduled_at":""})), ["scheduled_at phải là ISO 8601"]);
        assert_eq!(msgs(&json!({"scheduled_at":5})), ["scheduled_at phải là ISO 8601"]);
        assert_eq!(msgs(&json!({"use_queue":"yes"})), ["use_queue must be a boolean value"]);
        assert_eq!(msgs(&json!({"ui":[]})), ["ui must be an object"]);
        assert_eq!(msgs(&json!({"media":"x"})), ["media must be an array"]);
        assert_eq!(
            msgs(&json!({"media":[{"key":1}]})),
            [
                "media.0.key must be shorter than or equal to 200 characters",
                "media.0.key must be a string"
            ]
        );
        assert_eq!(
            msgs(&json!({"targets":[{"account_id":0,"x":1}]})),
            [
                "targets.0.property x should not exist",
                "targets.0.account_id must not be less than 1"
            ]
        );
        assert_eq!(
            msgs(&json!({"targets":[{"account_id":1.5}]})),
            ["targets.0.account_id must be an integer number"]
        );
        assert_eq!(msgs(&json!({"targets":null})), ["targets must be an array"]);
        assert_eq!(
            msgs(&json!({"utm":"x"})),
            ["nested property utm must be either object or array"]
        );
        assert_eq!(
            msgs(&json!({"utm":{"campaign":""}})),
            ["utm.campaign must be longer than or equal to 1 and shorter than or equal to 100 characters"]
        );
        let many: Vec<Value> = (1..=11).map(|i| json!({"key": format!("k{i}.png")})).collect();
        assert_eq!(
            msgs(&json!({ "media": many })),
            ["media must contain no more than 10 elements"]
        );
        let t: Vec<Value> = (1..=21).map(|i| json!({"account_id": i})).collect();
        assert_eq!(
            msgs(&json!({ "targets": t })),
            ["targets must contain no more than 20 elements"]
        );
    }

    #[test]
    fn so_ngoai_i32_la_400_tron() {
        let e = DraftInput::from_json(&json!({"targets":[{"account_id": 3_000_000_000_i64}]})).unwrap_err();
        let (s, b) = AppError::from(e).response(true);
        assert_eq!(s, 400);
        assert_eq!(serde_json::to_value(&b.message).unwrap(), json!("Bad Request"));
    }

    #[test]
    fn utm_chuan_hoa() {
        let u = |c: &str, ct: Option<&str>| UtmIn {
            campaign: c.to_owned(),
            content: ct.map(str::to_owned),
        };
        let m = normalize_utm(&u("  tết  2027 \n sale ", Some(" bài 1 "))).unwrap();
        assert_eq!(Value::Object(m), json!({"campaign":"tết-2027-sale","content":"bài-1"}));
        assert_eq!(
            Value::Object(normalize_utm(&u("a", Some("   "))).unwrap()),
            json!({"campaign":"a"})
        );
        for bad in ["a&b", "a=b", "a?b", "a#b", "a%b", "a/b", "a\\b", "   "] {
            assert_eq!(normalize_utm(&u(bad, None)).unwrap_err().response(true).0, 400, "{bad}");
        }
        assert!(normalize_utm(&u(&"a".repeat(101), None)).is_err());
        assert!(normalize_utm(&u(&"a".repeat(100), None)).is_ok());
    }

    fn tgt(id: i32, utm: Option<&str>) -> DraftTarget {
        DraftTarget {
            account_id: id,
            caption: None,
            options: utm.map(|c| json!({"utm": {"campaign": c}, "k": 1}).as_object().unwrap().clone()),
        }
    }

    #[test]
    fn utm_theo_kenh_dang_co() {
        // Đổi danh sách kênh, không gửi utm ⇒ kênh mới nhận UTM đang có; kênh đã có UTM giữ nguyên.
        let out = apply_utm(
            &None,
            Some(vec![tgt(1, Some("x")), tgt(2, None)]),
            &[tgt(9, Some("cu"))],
        )
        .unwrap()
        .unwrap();
        assert_eq!(out[0].options.as_ref().unwrap()["utm"], json!({"campaign":"x"}));
        assert_eq!(out[1].options.as_ref().unwrap()["utm"], json!({"campaign":"cu"}));
        // Không gửi cả hai ⇒ không đổi.
        assert!(apply_utm(&None, None, &[tgt(1, Some("x"))]).unwrap().is_none());
        // utm = null ⇒ bỏ UTM trên kênh đang có, giữ options khác; options rỗng thì bỏ hẳn.
        let out = apply_utm(&Some(None), None, &[tgt(1, Some("x")), tgt(2, None)])
            .unwrap()
            .unwrap();
        assert_eq!(out[0].options.as_ref().unwrap().keys().collect::<Vec<_>>(), ["k"]);
        assert_eq!(out[1].options, None);
        // utm mới ⇒ đè lên mọi kênh.
        let u = Some(Some(UtmIn {
            campaign: "mới  nè".to_owned(),
            content: None,
        }));
        let out = apply_utm(&u, Some(vec![tgt(1, Some("x"))]), &[]).unwrap().unwrap();
        assert_eq!(out[0].options.as_ref().unwrap()["utm"], json!({"campaign":"mới-nè"}));
    }

    #[test]
    fn luu_tru_json_giu_dang_node() {
        let m = DraftMedia {
            key: "a.png".into(),
            r#type: "image".into(),
            content_type: "image/png".into(),
            size: 5,
            name: None,
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({"key":"a.png","type":"image","content_type":"image/png","size":5})
        );
        let t = DraftTarget {
            account_id: 3,
            caption: Some("c".into()),
            options: None,
        };
        assert_eq!(serde_json::to_value(&t).unwrap(), json!({"account_id":3,"caption":"c"}));
        let back: Vec<DraftTarget> = serde_json::from_value(json!([{"account_id":3}])).unwrap();
        assert_eq!(back[0].caption, None);
    }
}
