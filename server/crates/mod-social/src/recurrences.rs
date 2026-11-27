//! Bài lặp lại (`social-recurrence.service.ts`): lịch ngày/tuần/tháng theo giờ Việt Nam; máy chủ luôn giữ đúng MỘT bài hẹn
//! sắp tới của mỗi lịch (khoá chống lặp `recur:<id>:<giờ ISO>`), lượt chạy nền [`materialize`] tạo bài kế tiếp.
//!
//! Hàm nhận [`TenantDb`] và xin kết nối ngắn cho từng bước DB; KHÔNG bao giờ giữ kết nối khi gọi [`PostsPort`] (tạo, huỷ,
//! kiểm bài đều tự xin kết nối của chúng). Đồng hồ do người gọi truyền (`now`).
//!
//! Khác bản Node: bỏ cờ `running` theo công ty trong bộ nhớ — hai lượt chạy song song được chặn bằng `advance` có điều kiện
//! (`WHERE next_run_at = <giờ đã đọc>`) và khoá chống lặp của bài; bộ lập lịch K20 cũng chỉ chạy một lượt mỗi công ty.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::models::SocialRecurrence;
use trinity_db::pg_error::app_error;
use trinity_db::types::Timestamp;
use trinity_db::{TenantConn, TenantDb};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::vn_time::{from_millis, js_iso_string};

use crate::dto_recur::RecurrenceBody;
use crate::ports::{CreateFailure, PostInput, PostsPort, RecurrenceGuard, status_of};
use crate::recur::{
    CREATE_AHEAD_MS, MAX_RECURRENCES, MINUTE_MS, RECUR_SOURCE_PREFIX, RECURRENCE_LATE_MS, RecurrenceRule,
    RecurrenceTemplate, UpcomingSpec, is_day, next_within, normalize_rule, normalize_template, upcoming,
};

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

async fn conn(t: &TenantDb) -> Result<TenantConn, AppError> {
    t.acquire().await.map_err(AppError::internal)
}

fn bad(m: impl Into<String>) -> AppError {
    HttpError::bad_request(Message::One(m.into())).into()
}

fn not_found() -> AppError {
    HttpError::not_found("Không tìm thấy bài lặp lại").into()
}

/// Câu lỗi của một lỗi HTTP (để ghi vào `last_error`).
fn message_of(e: &AppError) -> String {
    match e {
        AppError::Http(h) => match h.body().message {
            Message::One(s) => s,
            Message::Many(v) => v.join(", "),
        },
        other => other.to_string(),
    }
}

fn day_string(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Bài đã tạo của một lịch (`posts` trong view).
#[derive(Debug, Clone, Serialize)]
pub struct PostRef {
    pub id: i32,
    pub status: String,
    pub scheduled_at: Option<Timestamp>,
}

/// Dạng trả ra API (`RecurrenceView`).
#[derive(Debug, Clone, Serialize)]
pub struct RecurrenceView {
    pub id: i32,
    pub title: String,
    pub template: Value,
    pub rule: Value,
    pub starts_on: String,
    pub ends_on: Option<String>,
    pub max_count: Option<i32>,
    pub count: i32,
    pub next_run_at: Option<Timestamp>,
    pub active: bool,
    pub last_error: Option<String>,
    pub created_by: i32,
    /// 3 lần đăng tới (tính ra, không lưu; rỗng khi đang tạm dừng).
    pub next_times: Vec<Timestamp>,
    /// Bài đã tạo gần đây (mới nhất trước), tối đa 5.
    pub posts: Vec<PostRef>,
}

#[derive(Debug, sqlx::FromRow)]
struct PostRow {
    id: i32,
    status: String,
    scheduled_at: Option<Timestamp>,
    source: String,
}

fn rule_of(r: &SocialRecurrence) -> Result<RecurrenceRule, AppError> {
    serde_json::from_value(r.rule.0.clone())
        .map_err(|e| AppError::internal(format!("luật lặp của lịch #{} hỏng: {e}", r.id)))
}

fn template_of(r: &SocialRecurrence) -> Result<RecurrenceTemplate, AppError> {
    serde_json::from_value(r.template.0.clone())
        .map_err(|e| AppError::internal(format!("khuôn bài của lịch #{} hỏng: {e}", r.id)))
}

fn ends_on_of(r: &SocialRecurrence) -> Option<String> {
    r.ends_on.map(|d| day_string(d.0))
}

fn view(r: &SocialRecurrence, posts: &[PostRow], now: DateTime<Utc>) -> Result<RecurrenceView, AppError> {
    let rule = rule_of(r)?;
    let starts_on = day_string(r.starts_on.0);
    let ends_on = ends_on_of(r);
    let spec = UpcomingSpec {
        rule: &rule,
        starts_on: &starts_on,
        ends_on: ends_on.as_deref(),
        max_count: r.max_count.map(i64::from),
        count: i64::from(r.count),
        active: r.active,
    };
    let pending = posts.iter().any(|p| p.status == "scheduled");
    let next_times = upcoming(&spec, pending, 3, now.timestamp_millis())
        .into_iter()
        .map(Timestamp)
        .collect();
    Ok(RecurrenceView {
        id: r.id,
        title: r.title.clone(),
        template: r.template.0.clone(),
        rule: r.rule.0.clone(),
        starts_on,
        ends_on,
        max_count: r.max_count,
        count: r.count,
        next_run_at: r.next_run_at,
        active: r.active,
        last_error: r.last_error.clone(),
        created_by: r.created_by,
        next_times,
        posts: posts
            .iter()
            .take(5)
            .map(|p| PostRef {
                id: p.id,
                status: p.status.clone(),
                scheduled_at: p.scheduled_at,
            })
            .collect(),
    })
}

// ---------- đọc ----------

async fn row(db_: &TenantDb, id: i32) -> Result<SocialRecurrence, AppError> {
    let mut c = conn(db_).await?;
    sqlx::query_as::<_, SocialRecurrence>("SELECT * FROM social_recurrences WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?
        .ok_or_else(not_found)
}

/// Bài hẹn đang chờ của lịch (mới nhất), nếu có: (id bài, khoá `source`).
async fn pending_post(c: &mut PgConnection, id: i32) -> Result<Option<(i32, String)>, AppError> {
    sqlx::query_as::<_, (i32, String)>(
        "SELECT id, source FROM social_posts WHERE starts_with(source, $1) AND status = 'scheduled' ORDER BY id DESC LIMIT 1",
    )
    .bind(format!("{RECUR_SOURCE_PREFIX}{id}:"))
    .fetch_optional(c)
    .await
    .map_err(db)
}

/// `GET /social/recurrences` ⇒ `{ data }`.
pub async fn list(db_: &TenantDb, now: DateTime<Utc>) -> Result<Vec<RecurrenceView>, AppError> {
    let mut c = conn(db_).await?;
    let rows = sqlx::query_as::<_, SocialRecurrence>("SELECT * FROM social_recurrences ORDER BY id DESC LIMIT 200")
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let posts = sqlx::query_as::<_, PostRow>(
        "SELECT id, status, scheduled_at, source FROM social_posts WHERE starts_with(source, $1) ORDER BY id DESC LIMIT 500",
    )
    .bind(RECUR_SOURCE_PREFIX)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    drop(c);
    let mut by: HashMap<i32, Vec<PostRow>> = HashMap::new();
    for p in posts {
        // `recur:<id>:…`
        let id = p
            .source
            .strip_prefix(RECUR_SOURCE_PREFIX)
            .and_then(|s| s.split_once(':'))
            .and_then(|(n, _)| n.parse::<i32>().ok())
            .filter(|n| *n != 0);
        if let Some(id) = id {
            by.entry(id).or_default().push(p);
        }
    }
    rows.iter()
        .map(|r| view(r, by.get(&r.id).map_or(&[][..], Vec::as_slice), now))
        .collect()
}

async fn posts_of(db_: &TenantDb, id: i32, limit: i64) -> Result<Vec<PostRow>, AppError> {
    let mut c = conn(db_).await?;
    sqlx::query_as::<_, PostRow>(
        "SELECT id, status, scheduled_at, source FROM social_posts WHERE starts_with(source, $1) ORDER BY id DESC LIMIT $2",
    )
    .bind(format!("{RECUR_SOURCE_PREFIX}{id}:"))
    .bind(limit)
    .fetch_all(&mut *c)
    .await
    .map_err(db)
}

/// Một lịch kèm bài đã tạo.
pub async fn get(db_: &TenantDb, id: i32, now: DateTime<Utc>) -> Result<RecurrenceView, AppError> {
    let r = row(db_, id).await?;
    let posts = posts_of(db_, id, 50).await?;
    view(&r, &posts, now)
}

// ---------- ghi ----------

/// Kết quả chuẩn hoá một thân tạo/sửa (đã ghép với bản cũ).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Normalized {
    pub title: String,
    pub template: RecurrenceTemplate,
    pub rule: RecurrenceRule,
    pub starts_on: String,
    pub ends_on: Option<String>,
    pub max_count: Option<i64>,
}

fn merge(base: Option<&Value>, patch: Option<&Map<String, Value>>) -> Value {
    match patch {
        Some(p) => {
            let mut out = base.and_then(Value::as_object).cloned().unwrap_or_default();
            for (k, v) in p {
                out.insert(k.clone(), v.clone());
            }
            Value::Object(out)
        }
        None => base.cloned().unwrap_or(Value::Null),
    }
}

fn post_input(t: &RecurrenceTemplate, scheduled: Option<DateTime<Utc>>) -> PostInput {
    PostInput {
        content: t.content.clone(),
        media_keys: t.media_keys.clone(),
        targets: t.targets.clone(),
        utm: t.utm.clone(),
        scheduled_at: scheduled,
        use_queue: false,
        source: None,
    }
}

/// Ghép phần sửa vào bản cũ rồi kiểm toàn bộ (kể cả kênh/tệp, như lúc tạo bài).
async fn normalized<P: PostsPort>(
    posts: &P,
    user_id: i32,
    input: &RecurrenceBody,
    base: Option<&SocialRecurrence>,
) -> Result<Normalized, AppError> {
    let title = input
        .title
        .clone()
        .or_else(|| base.map(|b| b.title.clone()))
        .unwrap_or_default()
        .trim()
        .to_owned();
    if title.is_empty() || title.encode_utf16().count() > 120 {
        return Err(bad("Tên bài lặp lại từ 1 đến 120 ký tự."));
    }
    let template = normalize_template(&merge(base.map(|b| &b.template.0), input.template.as_ref()))?;
    let rule = normalize_rule(&merge(base.map(|b| &b.rule.0), input.rule.as_ref()))?;
    let starts_on = input
        .starts_on
        .clone()
        .or_else(|| base.map(|b| day_string(b.starts_on.0)));
    let Some(starts_on) = starts_on.filter(|s| is_day(s)) else {
        return Err(bad("starts_on phải có dạng YYYY-MM-DD."));
    };
    let ends_on = match &input.ends_on {
        Some(v) => v.clone(),
        None => base.and_then(ends_on_of),
    };
    if let Some(e) = &ends_on {
        if !is_day(e) {
            return Err(bad("ends_on phải có dạng YYYY-MM-DD."));
        }
        if *e < starts_on {
            return Err(bad("Ngày kết thúc phải sau ngày bắt đầu."));
        }
    }
    let max_count = match input.max_count {
        Some(v) => v.map(i64::from),
        None => base.and_then(|b| b.max_count).map(i64::from),
    };
    if max_count.is_some_and(|m| !(1..=1000).contains(&m)) {
        return Err(bad("max_count phải từ 1 đến 1000."));
    }
    posts.validate(user_id, &post_input(&template, None)).await?;
    Ok(Normalized {
        title,
        template,
        rule,
        starts_on,
        ends_on,
        max_count,
    })
}

/// Lần đăng đầu tiên sau `now` còn nằm trong `ends_on` / `max_count`.
fn first_run(
    rule: &RecurrenceRule,
    starts_on: &str,
    ends_on: Option<&str>,
    max_count: Option<i64>,
    count: i64,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    if max_count.is_some_and(|m| count >= m) {
        return None;
    }
    next_within(rule, now, starts_on, ends_on)
}

/// Kết quả [`preview`].
#[derive(Debug, Clone, Serialize)]
pub struct RecurrencePreview {
    #[serde(flatten)]
    pub normalized: Normalized,
    /// 3 lần đăng tới.
    pub times: Vec<Timestamp>,
}

/// Xem trước (không ghi gì): kiểm như lúc lưu và tính 3 lần đăng tới. `id` có ⇒ ghép phần sửa vào lịch đó (bài hẹn đang
/// chờ coi như sẽ bị huỷ nên không tính vào `count`). Dùng cho tool MCP; không có route riêng ở bản Node.
pub async fn preview<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    user_id: i32,
    input: &RecurrenceBody,
    id: Option<i32>,
    now: DateTime<Utc>,
) -> Result<RecurrencePreview, AppError> {
    let base = match id {
        Some(i) => Some(row(db_, i).await?),
        None => None,
    };
    let v = normalized(posts, user_id, input, base.as_ref()).await?;
    let pending = match &base {
        Some(b) => {
            let mut c = conn(db_).await?;
            pending_post(&mut c, b.id).await?.is_some()
        }
        None => false,
    };
    let count = base
        .as_ref()
        .map_or(0, |b| i64::from((b.count - i32::from(pending)).max(0)));
    let spec = UpcomingSpec {
        rule: &v.rule,
        starts_on: &v.starts_on,
        ends_on: v.ends_on.as_deref(),
        max_count: v.max_count,
        count,
        active: true,
    };
    let times = upcoming(&spec, false, 3, now.timestamp_millis())
        .into_iter()
        .map(Timestamp)
        .collect();
    Ok(RecurrencePreview { normalized: v, times })
}

fn parse_day_date(s: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| bad("Ngày không hợp lệ."))
}

/// `POST /social/recurrences` ⇒ 201 `{ data }`.
pub async fn create<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    user_id: i32,
    input: &RecurrenceBody,
    now: DateTime<Utc>,
) -> Result<RecurrenceView, AppError> {
    {
        let mut c = conn(db_).await?;
        let active: i64 = sqlx::query_scalar("SELECT count(*) FROM social_recurrences WHERE active")
            .fetch_one(&mut *c)
            .await
            .map_err(db)?;
        if active >= MAX_RECURRENCES {
            return Err(bad(format!("Tối đa {MAX_RECURRENCES} bài lặp lại đang chạy.")));
        }
    }
    let v = normalized(posts, user_id, input, None).await?;
    let first = first_run(&v.rule, &v.starts_on, v.ends_on.as_deref(), v.max_count, 0, now)
        .ok_or_else(|| bad("Với ngày bắt đầu/kết thúc này không có lần đăng nào trong tương lai."))?;
    let template = serde_json::to_value(&v.template).map_err(AppError::internal)?;
    let rule = serde_json::to_value(&v.rule).map_err(AppError::internal)?;
    let id: i32 = {
        let mut c = conn(db_).await?;
        sqlx::query_scalar(
            "INSERT INTO social_recurrences (title, template, rule, starts_on, ends_on, max_count, next_run_at, created_by, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id",
        )
        .bind(&v.title)
        .bind(template)
        .bind(rule)
        .bind(parse_day_date(&v.starts_on)?)
        .bind(v.ends_on.as_deref().map(parse_day_date).transpose()?)
        .bind(v.max_count.and_then(|m| i32::try_from(m).ok()))
        .bind(first)
        .bind(user_id)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?
    };
    materialize_one(db_, posts, id, now).await;
    get(db_, id, now).await
}

/// `PATCH /social/recurrences/:id`: sửa chỉ áp cho bài sau — huỷ bài hẹn đang chờ (không xoá), tính lại lần kế tiếp từ
/// bây giờ rồi tạo lại.
pub async fn update<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    user_id: i32,
    id: i32,
    input: &RecurrenceBody,
    now: DateTime<Utc>,
) -> Result<RecurrenceView, AppError> {
    let base = row(db_, id).await?;
    let v = normalized(posts, user_id, input, Some(&base)).await?;
    // Ngắt lần chạy đang chờ TRƯỚC (next_run_at = null) rồi mới huỷ bài chờ — lượt chạy nền chen vào sẽ bỏ bài.
    {
        let mut c = conn(db_).await?;
        sqlx::query("UPDATE social_recurrences SET next_run_at = NULL, updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *c)
            .await
            .map_err(db)?;
    }
    cancel_pending(db_, posts, id).await?;
    let fresh = row(db_, id).await?;
    let next = first_run(
        &v.rule,
        &v.starts_on,
        v.ends_on.as_deref(),
        v.max_count,
        i64::from(fresh.count),
        now,
    );
    let template = serde_json::to_value(&v.template).map_err(AppError::internal)?;
    let rule = serde_json::to_value(&v.rule).map_err(AppError::internal)?;
    {
        let mut c = conn(db_).await?;
        sqlx::query(
            "UPDATE social_recurrences SET title = $2, template = $3, rule = $4, starts_on = $5, ends_on = $6, max_count = $7, \
             next_run_at = $8, last_error = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(&v.title)
        .bind(template)
        .bind(rule)
        .bind(parse_day_date(&v.starts_on)?)
        .bind(v.ends_on.as_deref().map(parse_day_date).transpose()?)
        .bind(v.max_count.and_then(|m| i32::try_from(m).ok()))
        .bind(next)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    }
    if base.active {
        materialize_one(db_, posts, id, now).await;
    }
    get(db_, id, now).await
}

/// `POST /social/recurrences/:id/pause`: tạm dừng, huỷ bài hẹn đang chờ (không xoá).
pub async fn pause<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    id: i32,
    now: DateTime<Utc>,
) -> Result<RecurrenceView, AppError> {
    row(db_, id).await?;
    // Tắt TRƯỚC rồi mới huỷ bài chờ: lượt chạy nền đang dở sẽ thấy lịch đã tắt (kiểm trong giao dịch tạo bài) và bỏ bài.
    {
        let mut c = conn(db_).await?;
        sqlx::query("UPDATE social_recurrences SET active = false, updated_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *c)
            .await
            .map_err(db)?;
    }
    cancel_pending(db_, posts, id).await?;
    get(db_, id, now).await
}

/// `POST /social/recurrences/:id/resume`: tính lại lần đăng kế tiếp từ bây giờ.
pub async fn resume<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    id: i32,
    now: DateTime<Utc>,
) -> Result<RecurrenceView, AppError> {
    let r = row(db_, id).await?;
    // Cùng giới hạn như lúc tạo: tạm dừng hàng loạt, tạo thêm rồi tiếp tục cũng không vượt được.
    if !r.active {
        let mut c = conn(db_).await?;
        let active: i64 = sqlx::query_scalar("SELECT count(*) FROM social_recurrences WHERE active")
            .fetch_one(&mut *c)
            .await
            .map_err(db)?;
        if active >= MAX_RECURRENCES {
            return Err(bad(format!(
                "Tối đa {MAX_RECURRENCES} bài lặp lại đang chạy — tạm dừng bớt lịch khác trước."
            )));
        }
    }
    cancel_pending(db_, posts, id).await?;
    let fresh = row(db_, id).await?;
    let rule = rule_of(&r)?;
    let next = first_run(
        &rule,
        &day_string(r.starts_on.0),
        ends_on_of(&r).as_deref(),
        r.max_count.map(i64::from),
        i64::from(fresh.count),
        now,
    );
    {
        let mut c = conn(db_).await?;
        sqlx::query(
            "UPDATE social_recurrences SET active = true, next_run_at = $2, last_error = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(next)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    }
    materialize_one(db_, posts, id, now).await;
    get(db_, id, now).await
}

/// `DELETE /social/recurrences/:id` ⇒ 204: tạm dừng (huỷ bài chờ) rồi xoá lịch. Bài đã đăng giữ nguyên.
pub async fn remove<P: PostsPort>(db_: &TenantDb, posts: &P, id: i32) -> Result<(), AppError> {
    row(db_, id).await?;
    {
        let mut c = conn(db_).await?;
        sqlx::query(
            "UPDATE social_recurrences SET active = false, next_run_at = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    }
    cancel_pending(db_, posts, id).await?;
    let mut c = conn(db_).await?;
    sqlx::query("DELETE FROM social_recurrences WHERE id = $1")
        .bind(id)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    Ok(())
}

/// Huỷ bài hẹn đang chờ của lịch (nếu có) và trả lại 1 lần cho `count` — bài đó chưa lên mạng.
async fn cancel_pending<P: PostsPort>(db_: &TenantDb, posts: &P, id: i32) -> Result<(), AppError> {
    let pending = {
        let mut c = conn(db_).await?;
        pending_post(&mut c, id).await?
    };
    let Some((post_id, _)) = pending else {
        return Ok(());
    };
    if let Err(e) = posts.cancel(post_id).await {
        // Đã bắt đầu đăng / đã huỷ.
        return if status_of(&e).is_some_and(|s| s < 500) {
            Ok(())
        } else {
            Err(e)
        };
    }
    let mut c = conn(db_).await?;
    // Bài huỷ trả lại khoá chống lặp (source): lần tạo lại cùng giờ (sửa / tạm dừng rồi tiếp tục) không bị coi là trùng mà mất bài.
    sqlx::query(
        "UPDATE social_posts SET source = LEFT('cancelled:' || source, 80) WHERE id = $1 AND starts_with(source, $2)",
    )
    .bind(post_id)
    .bind(RECUR_SOURCE_PREFIX)
    .execute(&mut *c)
    .await
    .map_err(db)?;
    sqlx::query("UPDATE social_recurrences SET count = GREATEST(count - 1, 0) WHERE id = $1")
        .bind(id)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    Ok(())
}

// ---------- chạy nền ----------

/// Điều kiện "lịch còn nguyên" cho giao dịch tạo bài: khoá dòng lịch rồi kiểm còn bật và đúng giờ chạy. Cài đặt
/// [`PostsPort::create`] gọi hàm này trên kết nối của giao dịch; `false` ⇒ huỷ giao dịch, trả `CreateFailure::Changed`.
pub async fn guard_holds(c: &mut PgConnection, g: &RecurrenceGuard) -> Result<bool, AppError> {
    let still: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM social_recurrences WHERE id = $1 AND active AND next_run_at = $2 FOR UPDATE",
    )
    .bind(g.recurrence_id)
    .bind(g.at)
    .fetch_optional(c)
    .await
    .map_err(db)?;
    Ok(still.is_some())
}

/// Kết quả một lượt [`materialize`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MaterializeResult {
    pub created: u32,
    pub skipped: u32,
    pub paused: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Created,
    Skipped,
    Paused,
}

/// Gọi mỗi lượt tick: với mỗi lịch đang chạy mà chưa có bài hẹn sắp tới thì tạo đúng một bài (khoá chống lặp
/// `recur:<id>:<giờ ISO>`), rồi tăng `count` và dời `next_run_at` bằng cập nhật có điều kiện — hai tick song song chỉ một
/// bên dời được. Lỗi của một lịch chỉ ghi log, không chặn lịch khác.
pub async fn materialize<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    now: DateTime<Utc>,
) -> Result<MaterializeResult, AppError> {
    let rows = {
        let mut c = conn(db_).await?;
        sqlx::query_as::<_, SocialRecurrence>(
            "SELECT * FROM social_recurrences WHERE active AND next_run_at IS NOT NULL ORDER BY id ASC LIMIT 200",
        )
        .fetch_all(&mut *c)
        .await
        .map_err(db)?
    };
    let mut out = MaterializeResult::default();
    for r in &rows {
        match run_one(db_, posts, r, now).await {
            Ok(Outcome::Created) => out.created += 1,
            Ok(Outcome::Skipped) => out.skipped += 1,
            Ok(Outcome::Paused) => out.paused += 1,
            Err(e) => tracing::error!("Bài lặp lại #{} lỗi: {e}", r.id),
        }
    }
    Ok(out)
}

/// Tạo ngay bài kế tiếp sau khi lưu/sửa/tiếp tục. Lịch đã lưu xong nên lỗi hạ tầng ở đây KHÔNG được thành lỗi 500
/// (người dùng thử lại sẽ tạo lịch thứ hai) — ghi log, lượt chạy nền sau sẽ tạo bài.
async fn materialize_one<P: PostsPort>(db_: &TenantDb, posts: &P, id: i32, now: DateTime<Utc>) {
    let res: Result<(), AppError> = async {
        let r = row(db_, id).await?;
        if !r.active || r.next_run_at.is_none() {
            return Ok(());
        }
        run_one(db_, posts, &r, now).await.map(|_| ())
    }
    .await;
    if let Err(e) = res {
        tracing::error!("Bài lặp lại #{id}: chưa tạo được bài kế tiếp, lượt chạy nền sẽ thử lại — {e}");
    }
}

/// Dời `next_run_at` từ `from` sang `to` (hoặc null khi hết), kèm `count` tăng `inc`. `true` nếu CHÍNH lượt này dời được.
async fn advance(
    db_: &TenantDb,
    id: i32,
    from: DateTime<Utc>,
    to: Option<DateTime<Utc>>,
    inc: i32,
) -> Result<bool, AppError> {
    let mut c = conn(db_).await?;
    let done = sqlx::query(
        "UPDATE social_recurrences SET next_run_at = $3, count = count + $4, updated_at = now() WHERE id = $1 AND next_run_at = $2",
    )
    .bind(id)
    .bind(from)
    .bind(to)
    .bind(inc)
    .execute(&mut *c)
    .await
    .map_err(db)?;
    Ok(done.rows_affected() == 1)
}

async fn run_one<P: PostsPort>(
    db_: &TenantDb,
    posts: &P,
    r: &SocialRecurrence,
    now: DateTime<Utc>,
) -> Result<Outcome, AppError> {
    let Some(Timestamp(mut at)) = r.next_run_at else {
        return Ok(Outcome::Skipped);
    };
    let rule = rule_of(r)?;
    let starts_on = day_string(r.starts_on.0);
    let ends_on = ends_on_of(r);
    let max = r.max_count.map(i64::from);
    let after = |from: DateTime<Utc>, c: i64| -> Option<DateTime<Utc>> {
        if max.is_some_and(|m| c >= m) {
            None
        } else {
            next_within(&rule, from, &starts_on, ends_on.as_deref())
        }
    };
    let key = |d: DateTime<Utc>| format!("{RECUR_SOURCE_PREFIX}{}:{}", r.id, js_iso_string(d));

    let pending = {
        let mut c = conn(db_).await?;
        pending_post(&mut c, r.id).await?
    };
    // Đã có bài chờ: nếu đó chính là bài của `next_run_at` (lần trước tạo xong mà chưa kịp dời) thì dời nốt; còn lại là bình thường.
    if let Some((_, source)) = pending {
        if source == key(at) {
            advance(db_, r.id, at, after(at, i64::from(r.count) + 1), 1).await?;
        }
        return Ok(Outcome::Skipped);
    }
    let now_ms = now.timestamp_millis();
    // Trễ quá 1 giờ (máy ngủ): nhảy tới lần kế tiếp ở tương lai, không đăng muộn.
    if at.timestamp_millis() < now_ms - RECURRENCE_LATE_MS {
        let Some(floor) = from_millis(now_ms - RECURRENCE_LATE_MS) else {
            return Ok(Outcome::Skipped);
        };
        let to = after(floor, i64::from(r.count));
        if !advance(db_, r.id, at, to, 0).await? {
            return Ok(Outcome::Skipped);
        }
        let Some(to) = to else {
            return Ok(Outcome::Skipped);
        };
        at = to;
    }
    // Xa hơn 90 ngày: chờ.
    if at.timestamp_millis() > now_ms + CREATE_AHEAD_MS {
        return Ok(Outcome::Skipped);
    }
    let fresh = {
        let mut c = conn(db_).await?;
        sqlx::query_as::<_, SocialRecurrence>("SELECT * FROM social_recurrences WHERE id = $1")
            .bind(r.id)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?
    };
    let Some(fresh) = fresh else {
        return Ok(Outcome::Skipped);
    };
    if !fresh.active || fresh.next_run_at.map(|t| t.0) != Some(at) {
        return Ok(Outcome::Skipped);
    }
    let count = i64::from(fresh.count);
    if max.is_some_and(|m| count >= m) {
        advance(db_, fresh.id, at, None, 0).await?;
        return Ok(Outcome::Skipped);
    }
    // Giờ hẹn phải cách bây giờ ≥ 1 phút (trễ ít thì đăng trong vài phút tới).
    let scheduled = from_millis(at.timestamp_millis().max(now_ms + 2 * MINUTE_MS));
    let input = post_input(&template_of(r)?, scheduled);
    let guard = RecurrenceGuard {
        recurrence_id: r.id,
        at,
    };
    match posts.create(r.created_by, &input, &key(at), Some(guard)).await {
        Ok(_) => {}
        Err(CreateFailure::Changed) => return Ok(Outcome::Skipped),
        Err(CreateFailure::Failed(e)) => {
            match status_of(&e) {
                Some(409) => {
                    // Bài đã có (tick khác tạo) — chỉ dời nốt.
                    advance(db_, r.id, at, after(at, count + 1), 1).await?;
                    return Ok(Outcome::Skipped);
                }
                Some(s) if s < 500 => {
                    // Kênh gỡ liên kết, tệp mất… — dừng hẳn để khỏi lặp lỗi, người dùng sửa rồi bấm Tiếp tục.
                    let msg: String = message_of(&e).chars().take(1000).collect();
                    let mut c = conn(db_).await?;
                    sqlx::query("UPDATE social_recurrences SET active = false, last_error = $2, updated_at = now() WHERE id = $1")
                    .bind(r.id)
                    .bind(&msg)
                    .execute(&mut *c)
                    .await
                    .map_err(db)?;
                    tracing::warn!("Bài lặp lại #{} tạm dừng: {msg}", r.id);
                    return Ok(Outcome::Paused);
                }
                _ => return Err(e),
            }
        }
    }
    advance(db_, r.id, at, after(at, count + 1), 1).await?;
    Ok(Outcome::Created)
}
