//! Tool đăng bài phần 2 (M44a), nhóm đọc/ghi không cần `confirmed_by_user` (`social-tools.ts`): `list_social_posts`,
//! `get_social_post`, `get_social_post_stats`, `list_social_drafts`, `save_social_draft`, `list_queue_slots`, `set_queue_slots`,
//! `preview_social_post`, `list_social_snippets`, `save_social_snippet`, `refresh_social_post_metrics`, `list_recurring_posts`.
//! Không tool nào đăng thật hay xoá: xem trước và lưu nháp/mẫu/khung giờ chỉ ghi dữ liệu soạn bài của người dùng.
//!
//! Dùng chính `mod-social`. Số liệu (M54b) và bài lặp (M55b) đi qua cổng ở `social_ports.rs`. Hàm dùng chung với nhóm hành động
//! (`social_act.rs`) để `pub(super)`: đọc `captions`/`utm_*` từ tham số AI, giờ hẹn, mô tả bài.

use std::collections::HashMap;

use chrono::{DateTime, SecondsFormat, Utc};
use mod_social::drafts::{self, DraftInput, DraftTarget, MediaIn, TargetIn, UtmIn};
use mod_social::dto::{PostInput, TargetInput};
use mod_social::posts::{self, ListQuery, PostView};
use mod_social::queue;
use mod_social::snippets::{self, SnippetInput};
use serde_json::{Map, Value, json};
use trinity_db::models::SocialDraft;

use super::fanpage::{activity_range, parse_scheduled_at, vn_iso as vn_iso_value, vn_when};
use super::social::{RunFn, SocialDeps, ensure_enabled, port, user_if, vn_iso};
use super::wrapped;
use crate::actions::http_err;
use crate::args::{clamp_limit, opt_int};
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const TZ: &str = "Asia/Ho_Chi_Minh";
const STATUSES: [&str; 6] = ["scheduled", "publishing", "published", "partial", "failed", "cancelled"];
pub(super) const WEEKDAYS: [&str; 7] = [
    "Chủ nhật",
    "Thứ Hai",
    "Thứ Ba",
    "Thứ Tư",
    "Thứ Năm",
    "Thứ Sáu",
    "Thứ Bảy",
];

pub(super) fn register(reg: &mut impl FnMut(&'static str, Option<&'static str>, &'static [&'static str], RunFn)) {
    const P: &[&str] = &["social.post"];
    const W: Option<&str> = Some("crm.write");
    reg("list_social_posts", None, P, list_social_posts);
    reg("get_social_post", None, P, get_social_post);
    reg("get_social_post_stats", None, P, get_social_post_stats);
    reg("list_social_drafts", None, P, list_social_drafts);
    reg("list_queue_slots", None, P, list_queue_slots);
    reg("list_social_snippets", None, P, list_social_snippets);
    reg("preview_social_post", None, P, preview_social_post);
    reg("list_recurring_posts", None, P, list_recurring_posts);
    reg("refresh_social_post_metrics", W, P, refresh_social_post_metrics);
    reg("save_social_draft", W, P, save_social_draft);
    reg("set_queue_slots", W, P, set_queue_slots);
    reg("save_social_snippet", W, P, save_social_snippet);
}

// ------------------------------------------------------------------ dùng chung với social_act

pub(super) fn user(msg: impl Into<String>) -> ToolError {
    ToolError::User(msg.into())
}

/// Lỗi < 500 của dịch vụ ⇒ câu cho AI sửa; còn lại theo `app_err`.
pub(super) fn svc(e: trinity_kernel::error::AppError) -> ToolError {
    user_if(e, |st| st < 500)
}

pub(super) fn iso(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `account_ids` ⇒ danh sách số nguyên hợp lệ (phần tử sai bị bỏ như `optInt` + `filter`).
pub(super) fn account_ids(args: &Value) -> Vec<i32> {
    args.get("account_ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| opt_int(Some(v))).collect())
        .unwrap_or_default()
}

pub(super) fn media_keys(args: &Value) -> Vec<String> {
    args.get("media_keys")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Một phần tử `captions`: `caption` `None` = không nhắc tới, `Some(None)` = gửi rỗng (bỏ), `Some(Some)` = chữ mới.
pub(super) struct Cap {
    pub caption: Option<Option<String>>,
    /// Tuỳ chọn gửi đi (chỉ những gì AI đã đặt): `first_comment`.
    pub options: Map<String, Value>,
    /// `facebook_first_comment` gửi rỗng ⇒ bỏ bình luận đầu đã lưu (`CLEARABLE`).
    pub clear_first_comment: bool,
}

pub(super) fn parse_captions(args: &Value) -> Vec<(i32, Cap)> {
    let Some(list) = args.get("captions").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|c| {
            let id = opt_int(c.get("account_id")).filter(|i| *i > 0)?;
            let caption = c
                .get("caption")
                .and_then(Value::as_str)
                .map(|s| Some(s.trim().to_owned()).filter(|t| !t.is_empty()));
            let mut options = Map::new();
            let mut clear = false;
            if let Some(f) = c.get("facebook_first_comment").and_then(Value::as_str) {
                match f.trim() {
                    "" => clear = true,
                    t => {
                        options.insert("first_comment".to_owned(), json!(t));
                    }
                }
            }
            Some((
                id,
                Cap {
                    caption,
                    options,
                    clear_first_comment: clear,
                },
            ))
        })
        .collect()
}

/// Tuỳ chọn đã lưu + phần AI gửi (`mergeOptions`): gửi rỗng thì bỏ `first_comment`.
pub(super) fn merge_options(mut stored: Map<String, Value>, c: Option<&Cap>) -> Map<String, Value> {
    let Some(c) = c else { return stored };
    for (k, v) in &c.options {
        stored.insert(k.clone(), v.clone());
    }
    if c.clear_first_comment {
        stored.remove("first_comment");
    }
    stored
}

/// Kênh + nội dung riêng cho tạo bài/xem trước; `captions` ngoài danh sách kênh ⇒ lỗi.
pub(super) fn targets_for(args: &Value, ids: &[i32]) -> Result<Vec<TargetInput>, ToolError> {
    let caps = parse_captions(args);
    for (id, _) in &caps {
        if !ids.contains(id) {
            return Err(user(format!(
                "captions có account_id {id} không nằm trong account_ids."
            )));
        }
    }
    Ok(ids
        .iter()
        .map(|id| {
            let c = caps.iter().find(|(i, _)| i == id).map(|(_, c)| c);
            TargetInput {
                account_id: *id,
                caption: c.and_then(|c| c.caption.clone()).flatten(),
                options: Some(c.map(|c| c.options.clone()).unwrap_or_default()),
            }
        })
        .collect())
}

/// `utm_campaign`/`utm_content` ⇒ `None` = không nhắc tới (giữ như cũ); `Some(null)` = bỏ UTM; `Some({campaign, content?})`.
pub(super) fn utm_arg(args: &Value) -> Result<Option<Value>, ToolError> {
    let camp = args.get("utm_campaign").and_then(Value::as_str).map(str::trim);
    let content = args
        .get("utm_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty());
    match (camp, content) {
        (None, Some(_)) => Err(user("utm_content cần đi kèm utm_campaign.")),
        (None, None) => Ok(None),
        (Some(""), _) => Ok(Some(Value::Null)),
        (Some(c), Some(x)) => Ok(Some(json!({ "campaign": c, "content": x }))),
        (Some(c), None) => Ok(Some(json!({ "campaign": c }))),
    }
}

/// Giờ ISO UTC của chuỗi RFC 3339 (giá trị cổng) ⇒ "09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)".
pub(super) fn when_of(v: Option<&Value>) -> Option<String> {
    let t = DateTime::parse_from_rfc3339(v?.as_str()?).ok()?;
    Some(vn_when(t.with_timezone(&Utc)))
}

/// Bài cho AI: giờ Việt Nam, trạng thái từng kênh, link bài đã lên (`postForAi`).
pub(super) fn post_for_ai(p: &PostView, base: &str) -> Value {
    let media: Vec<Value> = p
        .media
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| json!(m.get("type").and_then(Value::as_str).unwrap_or("file")))
                .collect()
        })
        .unwrap_or_default();
    let targets: Vec<Value> = p
        .targets
        .iter()
        .map(|t| {
            json!({
                "target_id": t.id,
                "account_id": t.account_id,
                "account_name": t.account_name,
                "network": t.network,
                "status": t.status,
                "caption": t.caption,
                "post_link": t.url,
                "error": t.last_error,
                "published_at": t.published_at.as_ref().map(vn_iso),
                "attempts": t.attempts,
                "metrics": t.metrics,
                "metrics_updated_at": t.metrics_at.as_ref().map(vn_iso),
            })
        })
        .collect();
    json!({
        "post_id": p.id,
        "status": p.status,
        "content": p.content,
        "media": media,
        "created_at": vn_iso(&p.created_at),
        "scheduled_at": p.scheduled_at.as_ref().map(vn_iso),
        "source": p.source,
        "targets": targets,
        "url": format!("{base}/social?post={}", p.id),
    })
}

fn post_id_arg(args: &Value) -> Result<i32, ToolError> {
    opt_int(args.get("post_id"))
        .filter(|i| *i > 0)
        .ok_or_else(|| user("post_id không hợp lệ."))
}

fn hhmm(minute: i32) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

fn weekday_text(w: i32) -> &'static str {
    usize::try_from(w)
        .ok()
        .and_then(|i| WEEKDAYS.get(i))
        .copied()
        .unwrap_or("")
}

/// Mô tả luật lặp (`describeRule`).
pub(super) fn describe_rule(rule: &Value) -> String {
    let n = rule.get("interval").and_then(Value::as_i64).unwrap_or(1);
    let every = |unit: &str| {
        if n > 1 {
            format!(", mỗi {n} {unit}")
        } else {
            String::new()
        }
    };
    let base = match rule.get("freq").and_then(Value::as_str) {
        Some("daily") => format!("Hằng ngày{}", every("ngày")),
        Some("weekly") => {
            let days: Vec<&str> = rule
                .get("weekdays")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_i64)
                        .map(|w| weekday_text(i32::try_from(w).unwrap_or(-1)))
                        .collect()
                })
                .unwrap_or_default();
            let on = if days.is_empty() {
                String::new()
            } else {
                format!(" vào {}", days.join(", "))
            };
            format!("Hằng tuần{}{on}", every("tuần"))
        }
        _ => {
            let day = rule
                .get("month_day")
                .and_then(Value::as_i64)
                .filter(|d| *d != 0)
                .map(|d| format!(" vào ngày {d}"))
                .unwrap_or_default();
            format!("Hằng tháng{}{day}", every("tháng"))
        }
    };
    let time = rule.get("time").and_then(Value::as_str).unwrap_or("");
    format!("{base} lúc {time} (giờ Việt Nam)")
}

/// `active` | `paused` | `finished` (`recurrenceStatus`).
pub(super) fn recurrence_status(r: &Value) -> &'static str {
    let next_empty = r.get("next_run_at").is_none_or(Value::is_null)
        && r.get("next_times").and_then(Value::as_array).is_none_or(Vec::is_empty);
    if !r.get("active").and_then(Value::as_bool).unwrap_or(false) {
        "paused"
    } else if next_empty {
        "finished"
    } else {
        "active"
    }
}

// ------------------------------------------------------------------ bài

fn list_social_posts<'a>(
    _s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let (from, to, label) = activity_range(args.get("from"), args.get("to"), Utc::now())?;
        let status = args
            .get("status")
            .and_then(Value::as_str)
            .filter(|s| STATUSES.contains(s))
            .map(str::to_owned);
        let q = ListQuery {
            status,
            from: Some(from),
            to: Some(to - chrono::Duration::milliseconds(1)),
            limit: clamp_limit(args.get("limit")),
            cursor: opt_int(args.get("cursor")),
        };
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let r = posts::list(&mut conn, &q).await.map_err(app_err)?;
        let list: Vec<Value> = r.data.iter().map(|p| post_for_ai(p, ctx.base_url)).collect();
        wrapped(&json!({ "range": label, "timezone": TZ, "posts": list, "next_cursor": r.next_cursor }))
    })
}

fn get_social_post<'a>(
    _s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let id = post_id_arg(args)?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let p = posts::get(&mut conn, id).await.map_err(app_err)?;
        wrapped(&post_for_ai(&p, ctx.base_url))
    })
}

fn vn_day(t: DateTime<Utc>) -> String {
    (t + chrono::Duration::hours(7)).format("%Y-%m-%d").to_string()
}

fn get_social_post_stats<'a>(
    s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let metrics = port(&s.metrics, "thống kê bài đăng")?;
        let now = Utc::now();
        let given = |k: &str| {
            args.get(k)
                .and_then(Value::as_str)
                .is_some_and(|x| !x.trim().is_empty())
        };
        // Mặc định 30 ngày gần nhất (giờ VN) thay vì "hôm nay" như các tool lịch.
        let from_v = if given("from") {
            args.get("from").cloned()
        } else {
            Some(json!(vn_day(now - chrono::Duration::days(29))))
        };
        let to_v = if given("to") {
            args.get("to").cloned()
        } else {
            Some(json!(vn_day(now)))
        };
        let (from, to, label) = activity_range(from_v.as_ref(), to_v.as_ref(), now)?;
        let top = opt_int(args.get("top"))
            .filter(|t| (1..=20).contains(t))
            .map_or(5, i64::from);
        let r = metrics
            .stats(ctx.principal.company, from, to - chrono::Duration::milliseconds(1), top)
            .await
            .map_err(svc)?;
        let top_posts: Vec<Value> = r
            .get("top")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|t| {
                        let mut o = t.clone();
                        let pid = t.get("post_id").and_then(Value::as_i64).unwrap_or(0);
                        if let Some(m) = o.as_object_mut() {
                            m.insert("published_at".to_owned(), json!(vn_iso_value(t.get("published_at"))));
                            m.insert(
                                "trinity_url".to_owned(),
                                json!(format!("{}/social?post={pid}", ctx.base_url)),
                            );
                        }
                        o
                    })
                    .collect()
            })
            .unwrap_or_default();
        let pick = |k: &str| r.get(k).cloned().unwrap_or(Value::Null);
        wrapped(&json!({
            "range": label,
            "timezone": TZ,
            "totals": pick("totals"),
            "by_channel": pick("by_account"),
            "top_posts": top_posts,
            "posts_without_numbers_yet": pick("without_metrics"),
            "posts_removed_on_channel": pick("removed"),
            "updated_at": vn_iso_value(r.get("updated_at")),
        }))
    })
}

fn refresh_social_post_metrics<'a>(
    s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let metrics = port(&s.metrics, "thống kê bài đăng")?;
        let id = post_id_arg(args)?;
        let report = metrics.refresh_post(ctx.principal.company, id).await.map_err(svc)?;
        let post = {
            let mut conn = ctx.deps.conn(ctx.principal.company).await?;
            posts::get(&mut conn, id).await.map_err(app_err)?
        };
        let pick = |ids: &[i32]| -> Vec<Value> {
            post.targets
                .iter()
                .filter(|t| ids.contains(&t.id))
                .map(|t| json!({ "target_id": t.id, "account_name": t.account_name, "network": t.network }))
                .collect()
        };
        let (failed, throttled) = (pick(&report.failed), pick(&report.throttled));
        let mut notes: Vec<&str> = Vec::new();
        if !failed.is_empty() {
            notes.push("Một số kênh không trả số lần này — số hiện ra là của lần lấy trước.");
        }
        if !throttled.is_empty() {
            notes.push(
                "Một số kênh vừa được lấy số dưới 1 phút trước nên chưa lấy lại — xem metrics_updated_at; thử lại sau 1 phút.",
            );
        }
        let mut out = post_for_ai(&post, ctx.base_url);
        out["refresh_failed"] = json!(failed);
        out["not_refreshed"] = json!(throttled);
        if !notes.is_empty() {
            out["note"] = json!(notes.join(" "));
        }
        wrapped(&out)
    })
}

// ------------------------------------------------------------------ nháp

fn draft_captions(targets: &[DraftTarget]) -> Vec<Value> {
    targets
        .iter()
        .filter_map(|t| {
            let mut o = Map::new();
            o.insert("account_id".to_owned(), json!(t.account_id));
            if let Some(c) = t.caption.as_deref().filter(|c| !c.is_empty()) {
                o.insert("caption".to_owned(), json!(c));
            }
            if let Some(f) = t.options.as_ref().and_then(|m| m.get("first_comment")) {
                o.insert("facebook_first_comment".to_owned(), f.clone());
            }
            (o.len() > 1).then_some(Value::Object(o))
        })
        .collect()
}

/// Nháp cho AI: giờ Việt Nam, kênh có tên, link mở nháp trên web (`draftForAi`).
fn draft_for_ai(d: &SocialDraft, names: &HashMap<i32, (String, String)>, base: &str) -> Value {
    let media: Vec<Value> = d
        .media
        .0
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    json!({
                        "media_key": m.get("key"),
                        "type": m.get("type").and_then(Value::as_str).unwrap_or("file"),
                        "name": m.get("name"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let targets: Vec<DraftTarget> = serde_json::from_value(d.targets.0.clone()).unwrap_or_default();
    let channels: Vec<Value> = targets
        .iter()
        .map(|t| {
            let n = names.get(&t.account_id);
            json!({ "account_id": t.account_id, "name": n.map(|x| &x.0), "network": n.map(|x| &x.1) })
        })
        .collect();
    let mut out = json!({
        "draft_id": d.id,
        "title": d.title,
        "content": d.content,
        "media": media,
        "channels": channels,
        "captions": draft_captions(&targets),
        "scheduled_at": d.scheduled_at.as_ref().map(vn_iso),
        "use_queue": d.use_queue,
        "source": d.source,
        "updated_at": vn_iso(&d.updated_at),
        "edit_url": format!("{base}/social?tab=drafts&draft={}", d.id),
    });
    let utm = targets
        .iter()
        .filter_map(|t| t.options.as_ref().and_then(|m| m.get("utm")))
        .find(|u| u.get("campaign").and_then(Value::as_str).is_some_and(|c| !c.is_empty()));
    if let Some(u) = utm {
        out["utm_campaign"] = u["campaign"].clone();
        if let Some(c) = u.get("content").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            out["utm_content"] = json!(c);
        }
    }
    out
}

async fn account_names(ctx: &ToolCtx<'_>) -> Result<HashMap<i32, (String, String)>, ToolError> {
    let mut conn = ctx.deps.conn(ctx.principal.company).await?;
    let list = mod_social::accounts::list(&mut conn).await.map_err(app_err)?;
    Ok(list.into_iter().map(|a| (a.id, (a.name, a.network))).collect())
}

fn list_social_drafts<'a>(
    _s: &'a SocialDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let rows = {
            let mut conn = ctx.deps.conn(ctx.principal.company).await?;
            drafts::list(&mut conn, Utc::now().timestamp_millis())
                .await
                .map_err(app_err)?
        };
        let names = account_names(ctx).await?;
        let list: Vec<Value> = rows.iter().map(|d| draft_for_ai(d, &names, ctx.base_url)).collect();
        wrapped(&json!({ "timezone": TZ, "drafts": list }))
    })
}

fn save_social_draft<'a>(
    s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let p = ctx.principal;
        let id = match args.get("draft_id") {
            None => None,
            Some(v) => Some(
                opt_int(Some(v))
                    .filter(|i| *i > 0)
                    .ok_or_else(|| user("draft_id không hợp lệ."))?,
            ),
        };
        let old: Vec<DraftTarget> = match id {
            Some(i) => {
                let mut conn = ctx.deps.conn(p.company).await?;
                let d = drafts::get(&mut conn, i, Utc::now().timestamp_millis())
                    .await
                    .map_err(svc)?;
                serde_json::from_value(d.targets.0).unwrap_or_default()
            }
            None => Vec::new(),
        };
        let mut input = DraftInput::default();
        if let Some(t) = args.get("title").and_then(Value::as_str) {
            input.title = Some(Some(t.to_owned()));
        }
        if let Some(t) = args.get("content").and_then(Value::as_str) {
            input.content = Some(Some(t.to_owned()));
        }
        if args.get("media_keys").is_some_and(Value::is_array) {
            input.media = Some(
                media_keys(args)
                    .into_iter()
                    .map(|key| MediaIn { key, name: None })
                    .collect(),
            );
        }
        if args.get("scheduled_at").is_some() {
            input.scheduled_at = Some(parse_scheduled_at(args.get("scheduled_at"))?.map(iso));
        }
        if let Some(b) = args.get("use_queue").and_then(Value::as_bool) {
            input.use_queue = Some(b);
        }
        let utm = utm_arg(args)?;
        if let Some(u) = &utm {
            input.utm = Some(match u {
                Value::Null => None,
                o => Some(UtmIn {
                    campaign: o["campaign"].as_str().unwrap_or_default().to_owned(),
                    content: o.get("content").and_then(Value::as_str).map(str::to_owned),
                }),
            });
        }
        let ids: Option<Vec<i32>> = args
            .get("account_ids")
            .is_some_and(Value::is_array)
            .then(|| account_ids(args));
        let caps = parse_captions(args);
        if ids.is_some() || !caps.is_empty() {
            let list: Vec<i32> = ids
                .clone()
                .unwrap_or_else(|| old.iter().map(|t| t.account_id).collect());
            for (aid, _) in &caps {
                if !list.contains(aid) {
                    return Err(user(format!(
                        "captions có account_id {aid} không nằm trong danh sách kênh của nháp."
                    )));
                }
            }
            input.targets = Some(
                list.iter()
                    .map(|aid| {
                        let o = old.iter().find(|t| t.account_id == *aid);
                        let c = caps.iter().find(|(i, _)| i == aid).map(|(_, c)| c);
                        let caption = match c.and_then(|c| c.caption.clone()) {
                            Some(v) => v,
                            None => o.and_then(|t| t.caption.clone()),
                        };
                        let stored = o.and_then(|t| t.options.clone()).unwrap_or_default();
                        TargetIn {
                            account_id: *aid,
                            caption,
                            options: Some(merge_options(stored, c)),
                        }
                    })
                    .collect(),
            );
        }
        // UTM lưu theo từng kênh: nháp chưa có kênh thì không có chỗ lưu ⇒ báo rõ thay vì mất âm thầm.
        let channel_count = input.targets.as_ref().map_or(old.len(), Vec::len);
        if matches!(&utm, Some(v) if !v.is_null()) && channel_count == 0 {
            return Err(user(
                "Nháp chưa có kênh nên chưa gắn UTM được — gửi kèm account_ids (list_social_accounts). / Add account_ids before setting UTM.",
            ));
        }
        let mc = s.media_ctx(ctx.deps, p);
        let saved = match id {
            Some(i) => drafts::update(&mc, i, &input).await,
            None => drafts::create(&mc, &input, "mcp", None).await,
        }
        .map_err(svc)?;
        let names = account_names(ctx).await?;
        let mut out = draft_for_ai(&saved, &names, ctx.base_url);
        out["next_step"] = json!(
            "Nháp ĐÃ LƯU, CHƯA ĐĂNG gì. Người dùng xem/sửa ở edit_url; muốn đăng thì dùng publish_social_draft sau khi họ đồng ý."
        );
        wrapped(&out)
    })
}

// ------------------------------------------------------------------ khung giờ hàng đợi

fn slots_json(slots: &[queue::QueueSlot]) -> Vec<Value> {
    slots
        .iter()
        .map(|x| json!({ "weekday": x.weekday, "weekday_text": weekday_text(x.weekday), "time": hhmm(x.minute) }))
        .collect()
}

fn list_queue_slots<'a>(
    _s: &'a SocialDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let slots = queue::slots(&mut conn).await.map_err(app_err)?;
        let next = queue::next_free(&mut conn, 5, Utc::now().timestamp_millis())
            .await
            .map_err(app_err)?;
        let next: Vec<String> = next.into_iter().map(vn_when).collect();
        wrapped(&json!({ "timezone": TZ, "slots": slots_json(&slots), "next_free": next }))
    })
}

/// `"HH:mm"` ⇒ phút trong ngày (đúng `^(\d{2}):(\d{2})$`; ngoài 0–1439 do `parse_slots` báo).
fn parse_hhmm(v: Option<&Value>) -> Result<i64, ToolError> {
    let text = v.and_then(Value::as_str).unwrap_or_default();
    let b = text.as_bytes();
    let ok = b.len() == 5 && b[2] == b':' && [0, 1, 3, 4].iter().all(|i| b[*i].is_ascii_digit());
    if !ok {
        let shown: String = text.chars().take(10).collect();
        return Err(user(format!("time \"{shown}\" không đúng dạng HH:mm.")));
    }
    let n = |r: std::ops::Range<usize>| text[r].parse::<i64>().unwrap_or(0);
    Ok(n(0..2) * 60 + n(3..5))
}

fn set_queue_slots<'a>(
    _s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let raw: &[Value] = args
            .get("slots")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        // Xoá hết khung là việc của màn web: một lần gửi nhầm "[]" không được xoá lịch cả công ty.
        if raw.is_empty() {
            return Err(user(
                "Cần ít nhất một khung. Muốn thêm khung thì gửi khung đang có (list_queue_slots) cộng khung mới; xoá hết khung làm ở màn Lịch của Trinity. / At least one slot is required.",
            ));
        }
        let mut list: Vec<Value> = Vec::with_capacity(raw.len());
        for x in raw {
            let minute = parse_hhmm(x.get("time"))?;
            list.push(json!({ "weekday": x.get("weekday").cloned().unwrap_or(Value::Null), "minute": minute }));
        }
        let parsed = queue::parse_slots(&json!({ "slots": list })).map_err(http_err)?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let saved = queue::set_slots(&mut conn, &parsed).await.map_err(svc)?;
        wrapped(&json!({
            "timezone": TZ,
            "slots": slots_json(&saved),
            "next_step": "Đã lưu khung giờ hàng đợi; chưa đăng gì. Dùng use_queue trong create_social_post / publish_social_draft để đặt bài vào khung trống.",
        }))
    })
}

// ------------------------------------------------------------------ xem trước

fn preview_social_post<'a>(
    s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let infra = s.infra()?;
        let p = ctx.principal;
        let ids = account_ids(args);
        let use_queue = args.get("use_queue").and_then(Value::as_bool) == Some(true);
        let input = PostInput {
            content: args
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            media_keys: media_keys(args),
            targets: targets_for(args, &ids)?,
            scheduled_at: if use_queue {
                None
            } else {
                parse_scheduled_at(args.get("scheduled_at"))?.map(iso)
            },
            use_queue,
            utm: utm_arg(args)?,
            source: None,
        };
        let graph = (infra.graph_for)(p.company);
        let c = s.post_ctx(ctx.deps, p, infra, &graph);
        let pr = posts::preview(&c, &input).await.map_err(svc)?;
        let when = pr
            .scheduled_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map_or_else(|| "Đăng ngay".to_owned(), |t| vn_when(t.with_timezone(&Utc)));
        wrapped(&json!({
            "scheduled_at": when,
            "from_queue": pr.from_queue,
            "warnings": pr.warnings,
            "channels": pr.targets,
            "next_step": "ĐÂY CHỈ LÀ XEM TRƯỚC — CHƯA ĐĂNG gì. Cho người dùng xem từng kênh (nhất là warnings); họ đồng ý thì gọi create_social_post với confirmed_by_user. truncated_at là mốc xấp xỉ, mỗi mạng đổi theo thiết bị.",
        }))
    })
}

// ------------------------------------------------------------------ mẫu chữ

fn snippet_for_ai(r: &trinity_db::models::SocialSnippet) -> Value {
    json!({ "id": r.id, "name": r.name, "content": r.content, "is_default": r.is_default })
}

fn list_social_snippets<'a>(
    _s: &'a SocialDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let rows = snippets::list(&mut conn, None).await.map_err(app_err)?;
        let of = |kind: &str| -> Vec<Value> { rows.iter().filter(|r| r.kind == kind).map(snippet_for_ai).collect() };
        wrapped(&json!({ "hashtags": of("hashtags"), "signatures": of("signature") }))
    })
}

fn save_social_snippet<'a>(
    _s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let id = match args.get("snippet_id") {
            None => None,
            Some(v) => Some(
                opt_int(Some(v))
                    .filter(|i| *i > 0)
                    .ok_or_else(|| user("snippet_id không hợp lệ."))?,
            ),
        };
        // Chỉ những trường AI đã gửi (đúng kiểu); kiểm chi tiết do `SnippetInput::from_json` như lúc gọi qua web.
        let mut body = Map::new();
        for k in ["kind", "name", "content"] {
            if let Some(v) = args.get(k).filter(|v| v.is_string()) {
                body.insert(k.to_owned(), v.clone());
            }
        }
        if let Some(v) = args.get("is_default").filter(|v| v.is_boolean()) {
            body.insert("is_default".to_owned(), v.clone());
        }
        let input = SnippetInput::from_json(&Value::Object(body)).map_err(http_err)?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let saved = match id {
            Some(i) => snippets::update(&mut conn, i, &input).await,
            None => snippets::create(&mut conn, ctx.principal.user_id, &input).await,
        }
        .map_err(svc)?;
        let mut out = snippet_for_ai(&saved);
        out["kind"] = json!(saved.kind);
        out["next_step"] = json!("Mẫu ĐÃ LƯU; chưa đăng gì. Dùng list_social_snippets để lấy lại khi soạn bài.");
        wrapped(&out)
    })
}

// ------------------------------------------------------------------ bài lặp

fn list_recurring_posts<'a>(
    s: &'a SocialDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let rows = rec.list(ctx.principal.company).await.map_err(svc)?;
        let list: Vec<Value> = rows.iter().map(recurrence_for_ai).collect();
        wrapped(&json!({ "timezone": TZ, "recurrences": list }))
    })
}

/// Một lịch lặp cho AI (`list_recurring_posts`): thời điểm đổi sang giờ Việt Nam.
pub(super) fn recurrence_for_ai(r: &Value) -> Value {
    let tpl = r.get("template").cloned().unwrap_or(Value::Null);
    let targets = tpl.get("targets").and_then(Value::as_array);
    let account_ids: Vec<Value> = targets
        .map(|a| a.iter().filter_map(|t| t.get("account_id").cloned()).collect())
        .unwrap_or_default();
    let next: Vec<Option<String>> = r
        .get("next_times")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|t| when_of(Some(t))).collect())
        .unwrap_or_default();
    let recent: Vec<Value> = r
        .get("posts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|p| {
                    json!({
                        "post_id": p.get("id"),
                        "status": p.get("status"),
                        "scheduled_at": vn_iso_value(p.get("scheduled_at")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let media_count = tpl.get("media_keys").and_then(Value::as_array).map_or(0, Vec::len);
    json!({
        "recurrence_id": r.get("id"),
        "title": r.get("title"),
        "status": recurrence_status(r),
        "rule": describe_rule(r.get("rule").unwrap_or(&Value::Null)),
        "content": tpl.get("content"),
        "account_ids": account_ids,
        "media_count": media_count,
        "utm_campaign": tpl.get("utm").and_then(|u| u.get("campaign")),
        "starts_on": r.get("starts_on"),
        "ends_on": r.get("ends_on"),
        "max_count": r.get("max_count"),
        "posts_created": r.get("count"),
        "next_times": next,
        "last_error": r.get("last_error"),
        "recent_posts": recent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gio_phut() {
        assert_eq!(hhmm(0), "00:00");
        assert_eq!(hhmm(570), "09:30");
        assert_eq!(hhmm(1439), "23:59");
        assert_eq!(parse_hhmm(Some(&json!("09:30"))).unwrap(), 570);
        assert_eq!(parse_hhmm(Some(&json!("23:59"))).unwrap(), 1439);
        // Đúng dạng nhưng ngoài ngày: `parse_slots` mới báo (minute ≤ 1439).
        assert_eq!(parse_hhmm(Some(&json!("25:00"))).unwrap(), 1500);
        for bad in [json!("9:30"), json!("0930"), json!("09:3x"), json!(930), Value::Null] {
            assert!(parse_hhmm(Some(&bad)).is_err(), "{bad}");
        }
        assert_eq!(weekday_text(0), "Chủ nhật");
        assert_eq!(weekday_text(6), "Thứ Bảy");
        assert_eq!(weekday_text(7), "");
    }

    #[test]
    fn utm_giu_bo_dat() {
        assert_eq!(utm_arg(&json!({})).unwrap(), None);
        assert_eq!(utm_arg(&json!({ "utm_campaign": "  " })).unwrap(), Some(Value::Null));
        assert_eq!(
            utm_arg(&json!({ "utm_campaign": " thu ", "utm_content": "a" })).unwrap(),
            Some(json!({ "campaign": "thu", "content": "a" }))
        );
        assert_eq!(
            utm_arg(&json!({ "utm_campaign": "thu", "utm_content": " " })).unwrap(),
            Some(json!({ "campaign": "thu" }))
        );
        assert!(utm_arg(&json!({ "utm_content": "a" })).is_err());
    }

    #[test]
    fn captions_va_tuy_chon() {
        let args = json!({
            "captions": [
                { "account_id": 3, "caption": " Chào ", "facebook_first_comment": " link " },
                { "account_id": 4, "caption": "  ", "facebook_first_comment": "" },
                { "account_id": 5 },
                { "caption": "thiếu id" },
            ]
        });
        let caps = parse_captions(&args);
        assert_eq!(caps.len(), 3);
        assert_eq!(caps[0].1.caption, Some(Some("Chào".to_owned())));
        assert_eq!(caps[0].1.options.get("first_comment"), Some(&json!("link")));
        assert_eq!(caps[1].1.caption, Some(None));
        assert!(caps[1].1.clear_first_comment);
        assert_eq!(caps[2].1.caption, None);

        // Gửi rỗng ⇒ bỏ bình luận đầu đã lưu; kênh không nhắc tới giữ nguyên.
        let mut stored = Map::new();
        stored.insert("first_comment".to_owned(), json!("cũ"));
        stored.insert("utm".to_owned(), json!({ "campaign": "x" }));
        let merged = merge_options(stored.clone(), Some(&caps[1].1));
        assert!(merged.get("first_comment").is_none());
        assert!(merged.get("utm").is_some());
        assert_eq!(merge_options(stored.clone(), None), stored);
        assert_eq!(
            merge_options(stored, Some(&caps[0].1)).get("first_comment"),
            Some(&json!("link"))
        );

        let t = targets_for(&args, &[3, 4, 5]).unwrap();
        assert_eq!(t[0].caption.as_deref(), Some("Chào"));
        assert_eq!(t[1].caption, None);
        assert!(targets_for(&args, &[3]).is_err());
    }

    #[test]
    fn mo_ta_luat_lap() {
        let r = json!({ "freq": "weekly", "interval": 2, "weekdays": [1, 3], "time": "09:00" });
        assert_eq!(
            describe_rule(&r),
            "Hằng tuần, mỗi 2 tuần vào Thứ Hai, Thứ Tư lúc 09:00 (giờ Việt Nam)"
        );
        let d = json!({ "freq": "daily", "interval": 1, "time": "19:30" });
        assert_eq!(describe_rule(&d), "Hằng ngày lúc 19:30 (giờ Việt Nam)");
        let m = json!({ "freq": "monthly", "interval": 3, "month_day": 15, "time": "08:00" });
        assert_eq!(
            describe_rule(&m),
            "Hằng tháng, mỗi 3 tháng vào ngày 15 lúc 08:00 (giờ Việt Nam)"
        );
    }

    #[test]
    fn trang_thai_lich_lap() {
        let live =
            json!({ "active": true, "next_run_at": "2026-11-28T02:00:00Z", "next_times": ["2026-11-28T02:00:00Z"] });
        assert_eq!(recurrence_status(&live), "active");
        let paused = json!({ "active": false, "next_run_at": null, "next_times": [] });
        assert_eq!(recurrence_status(&paused), "paused");
        let done = json!({ "active": true, "next_run_at": null, "next_times": [] });
        assert_eq!(recurrence_status(&done), "finished");
    }

    #[test]
    fn lich_lap_cho_ai_doi_gio_viet_nam() {
        let r = json!({
            "id": 7, "title": "Chào tuần", "active": true,
            "next_run_at": "2026-11-30T02:00:00Z", "next_times": ["2026-11-30T02:00:00Z"],
            "template": { "content": "Hi", "media_keys": ["a", "b"], "targets": [{ "account_id": 3 }], "utm": { "campaign": "w" } },
            "rule": { "freq": "daily", "interval": 1, "time": "09:00" },
            "count": 4, "posts": [{ "id": 11, "status": "published", "scheduled_at": "2026-11-23T02:00:00Z" }]
        });
        let v = recurrence_for_ai(&r);
        assert_eq!(v["recurrence_id"], 7);
        assert_eq!(v["status"], "active");
        assert_eq!(v["media_count"], 2);
        assert_eq!(v["account_ids"], json!([3]));
        assert_eq!(v["utm_campaign"], "w");
        assert_eq!(v["next_times"][0], "09:00 Thứ Hai 30/11/2026 (giờ Việt Nam)");
        assert_eq!(v["recent_posts"][0]["scheduled_at"], "2026-11-23T09:00:00+07:00");
    }
}
