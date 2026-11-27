//! Thống kê bài đã đăng (`GET /social/stats`), lấy số ngay một bài (`POST /social/posts/:id/metrics`) — chuyển từ
//! `SocialPostsService.stats` / `refreshPostMetrics` (M54b đã có job lấy số, ở [`crate::jobs`]).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use mod_facebook::graph::{GraphClient, utf16_prefix};
use serde_json::{Map, Value, json};
use trinity_db::models::SocialPostTarget;
use trinity_db::{CompanyRef, Db, select_from};
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::instant::parse_instant_with;
use trinity_kernel::vn_time::js_iso_string;

use crate::config::is_social_network;
use crate::jobs::{Runner, is_removed};
use crate::posts::{PostView, acquire, get};

const DAY_MS: i64 = 86_400_000;
/// Vừa lấy số dưới 1 phút trước thì không gọi mạng lại.
const THROTTLE_MS: i64 = 60_000;

/// Khoảng ngày và số bài nổi bật của `GET /social/stats`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatsQuery {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub top: Option<u64>,
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `from`/`to` hỏng hoặc vắng ⇒ mặc định 30 ngày tính tới bây giờ; `from > to` hoặc quá 366 ngày ⇒ 400; `top` chỉ nhận số nguyên
/// không âm (khác ⇒ bỏ). Số quá lớn thì kẹp (`top` được kẹp 1..=20 ở [`build_stats`]).
pub fn parse_stats_query(
    from: Option<&str>,
    to: Option<&str>,
    top: Option<&str>,
    now: DateTime<Utc>,
) -> Result<StatsQuery, AppError> {
    let parse = |v: Option<&str>| v.and_then(|s| parse_instant_with(s, 0));
    let to = parse(to).unwrap_or(now);
    let from = parse(from).unwrap_or_else(|| to - Duration::milliseconds(30 * DAY_MS));
    if from > to {
        return Err(HttpError::bad_request("Ngày bắt đầu phải trước ngày kết thúc.").into());
    }
    if (to - from).num_milliseconds() > 366 * DAY_MS {
        return Err(HttpError::bad_request("Khoảng thống kê tối đa 1 năm.").into());
    }
    let top = top
        .filter(|s| all_digits(s))
        .map(|s| s.parse::<u64>().unwrap_or(u64::MAX));
    Ok(StatsQuery { from, to, top })
}

// ───────────────────────────── hàm thuần ─────────────────────────────

fn stored(t: &SocialPostTarget) -> Option<&Map<String, Value>> {
    t.metrics.as_ref().and_then(|m| m.0.as_object())
}

fn num(m: &Map<String, Value>, key: &str) -> Option<i64> {
    let v = m.get(key)?;
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
}

fn is_null(m: &Map<String, Value>, key: &str) -> bool {
    m.get(key) == Some(&Value::Null)
}

/// Số đã lưu của kênh; bài đã xoá trên kênh mà chưa từng lấy được số ⇒ coi như không có số (đếm riêng ở `removed`).
fn metrics_of(t: &SocialPostTarget) -> Option<&Map<String, Value>> {
    let m = stored(t)?;
    let removed = m.get("removed").and_then(Value::as_bool) == Some(true);
    let empty = ["views", "reactions", "comments", "shares"]
        .iter()
        .all(|k| is_null(m, k));
    if removed && empty { None } else { Some(m) }
}

/// Tương tác = cảm xúc + bình luận + chia sẻ (không tính lượt xem) (`engagementOf`).
fn engagement(m: Option<&Map<String, Value>>) -> i64 {
    m.map_or(0, |m| {
        ["reactions", "comments", "shares"]
            .iter()
            .map(|k| num(m, k).unwrap_or(0))
            .fold(0_i64, i64::saturating_add)
    })
}

/// `sumMetrics`: `views` là `null` khi không kênh nào có số lượt xem.
fn sum_metrics<'a>(list: impl Iterator<Item = Option<&'a Map<String, Value>>>) -> Value {
    let (mut views, mut reactions, mut comments, mut shares) = (None::<i64>, 0_i64, 0_i64, 0_i64);
    for m in list.flatten() {
        if m.get("views").is_some_and(Value::is_number) {
            views = Some(views.unwrap_or(0).saturating_add(num(m, "views").unwrap_or(0)));
        }
        reactions = reactions.saturating_add(num(m, "reactions").unwrap_or(0));
        comments = comments.saturating_add(num(m, "comments").unwrap_or(0));
        shares = shares.saturating_add(num(m, "shares").unwrap_or(0));
    }
    json!({ "views": views, "reactions": reactions, "comments": comments, "shares": shares })
}

fn merge(a: Value, b: Value) -> Value {
    let (Value::Object(mut a), Value::Object(b)) = (a, b) else {
        return Value::Null;
    };
    a.extend(b);
    Value::Object(a)
}

fn removed_target(t: &SocialPostTarget) -> bool {
    is_removed(t.metrics.as_ref().map(|m| &m.0))
}

/// Dựng JSON của `GET /social/stats` từ các lượt đăng đã lấy (mới đăng trước). `content`/`names` tra theo id bài/kênh.
pub fn build_stats(
    q: &StatsQuery,
    targets: &[SocialPostTarget],
    content: &HashMap<i32, String>,
    names: &HashMap<i32, String>,
) -> Value {
    let posts: HashSet<i32> = targets.iter().map(|t| t.post_id).collect();
    let totals = merge(
        json!({ "posts": posts.len(), "published": targets.len() }),
        sum_metrics(targets.iter().map(metrics_of)),
    );
    // Giữ thứ tự kênh xuất hiện lần đầu (như `Map` của JS).
    let mut order: Vec<i32> = Vec::new();
    let mut by_account: HashMap<i32, Vec<&SocialPostTarget>> = HashMap::new();
    for t in targets {
        if !by_account.contains_key(&t.account_id) {
            order.push(t.account_id);
        }
        by_account.entry(t.account_id).or_default().push(t);
    }
    let accounts: Vec<Value> = order
        .iter()
        .filter_map(|id| by_account.get(id).map(|list| (id, list)))
        .map(|(id, list)| {
            let base = json!({
                "account_id": id,
                "account_name": names.get(id),
                "network": list.first().map(|t| t.network.as_str()),
                "published": list.len(),
                // Số lượt đăng đã lấy được số; 0 ⇒ giao diện hiện "—" thay vì 0.
                "with_metrics": list.iter().filter(|t| metrics_of(t).is_some()).count(),
            });
            merge(base, sum_metrics(list.iter().map(|t| metrics_of(t))))
        })
        .collect();
    let limit = usize::try_from(q.top.unwrap_or(5).clamp(1, 20)).unwrap_or(5);
    let mut ranked: Vec<&SocialPostTarget> = targets.iter().filter(|t| metrics_of(t).is_some()).collect();
    let views_of = |t: &SocialPostTarget| metrics_of(t).and_then(|m| num(m, "views")).unwrap_or(0);
    ranked.sort_by(|a, b| {
        engagement(metrics_of(b))
            .cmp(&engagement(metrics_of(a)))
            .then(views_of(b).cmp(&views_of(a)))
    });
    let top: Vec<Value> = ranked
        .into_iter()
        .take(limit)
        .map(|t| {
            json!({
                "post_id": t.post_id,
                "target_id": t.id,
                "account_name": names.get(&t.account_id),
                "network": t.network,
                "content": utf16_prefix(content.get(&t.post_id).map_or("", String::as_str), 160),
                "url": t.url,
                "published_at": t.published_at,
                "metrics": metrics_of(t),
                "engagement": engagement(metrics_of(t)),
                "removed": removed_target(t),
            })
        })
        .collect();
    let stamp = targets
        .iter()
        .filter_map(|t| t.metrics_at.map(|m| m.0))
        .max()
        .map(js_iso_string);
    json!({
        "from": js_iso_string(q.from),
        "to": js_iso_string(q.to),
        "totals": totals,
        "by_account": accounts,
        "top": top,
        // Bài chưa lấy được số lần nào (vừa đăng, hoặc mạng chưa cho lấy).
        "without_metrics": targets.iter().filter(|t| metrics_of(t).is_none() && !removed_target(t)).count(),
        // Lượt đăng mà bài/video đã bị xoá trên kênh.
        "removed": targets.iter().filter(|t| removed_target(t)).count(),
        "updated_at": stamp,
    })
}

// ───────────────────────────── DB ─────────────────────────────

/// `GET /social/stats`: số là lần lấy gần nhất, không gọi mạng. Mỗi bước DB một kết nối.
pub async fn stats(db: &Db, company: CompanyRef, q: &StatsQuery) -> Result<Value, AppError> {
    let mut conn = acquire(db, company).await?;
    let targets: Vec<SocialPostTarget> = sqlx::query_as(select_from::<SocialPostTarget>(
        " WHERE status = 'published' AND published_at >= $1 AND published_at <= $2 ORDER BY published_at DESC",
    ))
    .bind(q.from)
    .bind(q.to)
    .fetch_all(&mut *conn)
    .await
    .map_err(AppError::internal)?;
    let post_ids: Vec<i32> = targets
        .iter()
        .map(|t| t.post_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let account_ids: Vec<i32> = targets
        .iter()
        .map(|t| t.account_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let posts: Vec<(i32, String)> = sqlx::query_as("SELECT id, content FROM social_posts WHERE id = ANY($1)")
        .bind(&post_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(AppError::internal)?;
    let accounts: Vec<(i32, String)> = sqlx::query_as("SELECT id, name FROM social_accounts WHERE id = ANY($1)")
        .bind(&account_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(AppError::internal)?;
    drop(conn);
    Ok(build_stats(
        q,
        &targets,
        &posts.into_iter().collect(),
        &accounts.into_iter().collect(),
    ))
}

/// Kết quả lấy số một bài: id kênh (target) không trả số lần này và id kênh bị bỏ qua vì vừa lấy dưới 1 phút.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefreshOutcome {
    pub failed: Vec<i32>,
    pub throttled: Vec<i32>,
}

/// `POST /social/posts/:id/metrics`: lấy ngay mọi kênh đã đăng của bài (bỏ qua kênh vừa lấy dưới 1 phút, kênh trên mạng đã gỡ và
/// kênh bài đã bị xoá) rồi trả bài. Mỗi bước DB một kết nối, nhả trước khi gọi Graph.
pub async fn refresh_post(
    runner: &Runner,
    db: &Db,
    company: CompanyRef,
    graph: &GraphClient,
    post_id: i32,
    now_ms: i64,
) -> Result<PostView, AppError> {
    refresh_post_report(runner, db, company, graph, post_id, now_ms)
        .await
        .map(|(post, _)| post)
}

/// Như [`refresh_post`] nhưng báo thêm kênh nào không lấy được / bị bỏ qua (cho tool MCP).
pub async fn refresh_post_report(
    runner: &Runner,
    db: &Db,
    company: CompanyRef,
    graph: &GraphClient,
    post_id: i32,
    now_ms: i64,
) -> Result<(PostView, RefreshOutcome), AppError> {
    let post = {
        let mut conn = acquire(db, company).await?;
        get(&mut conn, post_id).await?
    };
    let mut outcome = RefreshOutcome::default();
    for t in &post.targets {
        let skip = t.status != "published"
            || t.external_post_id.is_none()
            || is_removed(t.metrics.as_ref())
            || !is_social_network(&t.network);
        if skip {
            continue;
        }
        if t.metrics_at
            .is_some_and(|m| now_ms - m.0.timestamp_millis() < THROTTLE_MS)
        {
            outcome.throttled.push(t.id);
            continue;
        }
        let row: Option<SocialPostTarget> = {
            let mut conn = acquire(db, company).await?;
            sqlx::query_as(select_from::<SocialPostTarget>(" WHERE id = $1"))
                .bind(t.id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(AppError::internal)?
        };
        if let Some(row) = row
            && !runner.fetch_target_metrics(company, graph, &row).await
        {
            outcome.failed.push(t.id);
        }
    }
    let mut conn = acquire(db, company).await?;
    Ok((get(&mut conn, post_id).await?, outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn khoang_ngay() {
        let now = at("2030-06-30T00:00:00Z");
        let q = parse_stats_query(None, None, None, now).unwrap();
        assert_eq!((q.to, q.from), (now, at("2030-05-31T00:00:00Z")));
        assert_eq!(q.top, None);
        // `from` hỏng ⇒ mặc định; `to` hỏng ⇒ bây giờ.
        let q = parse_stats_query(Some("x"), Some("2030-01-31T00:00:00Z"), Some("7"), now).unwrap();
        assert_eq!(q.from, at("2030-01-01T00:00:00Z"));
        assert_eq!(q.top, Some(7));
        assert_eq!(parse_stats_query(None, Some("zzz"), Some("-1"), now).unwrap().top, None);
        assert_eq!(
            parse_stats_query(None, None, Some("99999999999999999999999"), now)
                .unwrap()
                .top,
            Some(u64::MAX)
        );
        let e = parse_stats_query(Some("2031-01-01"), Some("2030-01-01"), None, now).unwrap_err();
        assert_eq!(e.response(true).0, 400);
        let e = parse_stats_query(Some("2020-01-01"), Some("2030-01-01"), None, now).unwrap_err();
        assert_eq!(e.response(true).0, 400);
        // Đúng 366 ngày vẫn qua.
        assert!(parse_stats_query(Some("2029-01-01T00:00:00Z"), Some("2030-01-02T00:00:00Z"), None, now).is_ok());
    }

    #[test]
    fn tong_so_va_tuong_tac() {
        let a = json!({"views": 10, "reactions": 2, "comments": 1, "shares": 0});
        let b = json!({"views": null, "reactions": 3, "comments": null, "shares": 4});
        let (a, b) = (a.as_object().unwrap(), b.as_object().unwrap());
        let s = sum_metrics([Some(a), Some(b), None].into_iter());
        assert_eq!(s, json!({"views": 10, "reactions": 5, "comments": 1, "shares": 4}));
        let none = sum_metrics([Some(b)].into_iter());
        assert_eq!(none["views"], Value::Null);
        assert_eq!(engagement(Some(a)), 3);
        assert_eq!(engagement(Some(b)), 7);
        assert_eq!(engagement(None), 0);
    }

    #[test]
    fn gop_json() {
        assert_eq!(merge(json!({"a": 1}), json!({"b": 2})), json!({"a": 1, "b": 2}));
    }
}
