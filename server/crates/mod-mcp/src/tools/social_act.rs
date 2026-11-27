//! Tool đăng bài phần 2 (M44a), nhóm hành động theo khung ghi M42 (`action-social-tools.ts`, `action-recurring-tools.ts`):
//! `create_social_post`, `update_scheduled_post`, `reschedule_social_post`, `retry_social_post_target`, `publish_social_draft`,
//! `import_social_posts`, `create_recurring_post`, `update_recurring_post`, `set_recurring_post_active`. Không có tool huỷ/xoá
//! (huỷ bài hẹn là `cancel_scheduled_post` của M44b).
//!
//! Luật chung: `prepare` kiểm và dựng bản xem trước, KHÔNG ghi gì; bài công khai cần `confirmed_by_user` (lời đồng ý thật, kiểm bằng
//! `is_user_confirmation` của M44b) — thiếu thì không làm gì và trả lại bản xem trước trong câu lỗi. `execute` chạy từ tham số đã lưu:
//! chế độ duyệt có thể chờ tới 24 giờ, nên bài sửa chỉ lưu PHẦN SỬA và ghép lại với bài hiện tại lúc chạy; khung hàng đợi chọn lúc
//! xem trước được kiểm lại (đã qua/đã có bài khác ⇒ dời sang khung trống kế tiếp, báo `moved_from`).
//!
//! Dịch vụ qua cổng (`social_ports.rs`): đăng nháp, nhập hàng loạt, bài lặp. Cổng vắng ⇒ "chưa có tính năng".

use chrono::{DateTime, Utc};
use mod_social::drafts::{self, DraftTarget};
use mod_social::dto::{PostInput, TargetInput};
use mod_social::media::SocialMedia;
use mod_social::posts::{self, PostView, Validated};
use mod_social::queue;
use serde_json::{Map, Value, json};
use trinity_db::models::{SocialDraft, SocialPost};

use super::fanpage::{is_user_confirmation, parse_scheduled_at, vn_when};
use super::social::{SocialDeps, ensure_enabled_for, port};
use super::social_ports::DraftOverrides;
use super::social_read::{
    account_ids, describe_rule, iso, media_keys, merge_options, parse_captions, recurrence_status, svc, targets_for,
    user, utm_arg, when_of,
};
use crate::actions::{ActionCx, ActionDef, Prepared, line, lines, shown};
use crate::ai_output::slice16;
use crate::args::opt_int;
use crate::deps::{ToolDeps, app_err};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

pub(crate) static CREATE_SOCIAL_POST: ActionDef = ActionDef {
    name: "create_social_post",
    label: "Đăng bài mạng xã hội",
    permissions: &["social.post"],
    prepare: create_prepare,
    execute: create_execute,
    structure: false,
};
pub(crate) static UPDATE_SCHEDULED_POST: ActionDef = ActionDef {
    name: "update_scheduled_post",
    label: "Sửa bài đang hẹn giờ",
    permissions: &["social.post"],
    prepare: update_prepare,
    execute: update_execute,
    structure: false,
};
pub(crate) static RESCHEDULE_SOCIAL_POST: ActionDef = ActionDef {
    name: "reschedule_social_post",
    label: "Đổi giờ bài hẹn",
    permissions: &["social.post"],
    prepare: reschedule_prepare,
    execute: reschedule_execute,
    structure: false,
};
pub(crate) static RETRY_SOCIAL_POST_TARGET: ActionDef = ActionDef {
    name: "retry_social_post_target",
    label: "Thử đăng lại một kênh",
    permissions: &["social.post"],
    prepare: retry_prepare,
    execute: retry_execute,
    structure: false,
};
pub(crate) static PUBLISH_SOCIAL_DRAFT: ActionDef = ActionDef {
    name: "publish_social_draft",
    label: "Đăng bài nháp",
    permissions: &["social.post"],
    prepare: publish_prepare,
    execute: publish_execute,
    structure: false,
};
pub(crate) static IMPORT_SOCIAL_POSTS: ActionDef = ActionDef {
    name: "import_social_posts",
    label: "Nhập nhiều bài mạng xã hội",
    permissions: &["social.post"],
    prepare: import_prepare,
    execute: import_execute,
    structure: false,
};
pub(crate) static CREATE_RECURRING_POST: ActionDef = ActionDef {
    name: "create_recurring_post",
    label: "Tạo bài lặp lại",
    permissions: &["social.post"],
    prepare: recur_create_prepare,
    execute: recur_create_execute,
    structure: false,
};
pub(crate) static UPDATE_RECURRING_POST: ActionDef = ActionDef {
    name: "update_recurring_post",
    label: "Sửa bài lặp lại",
    permissions: &["social.post"],
    prepare: recur_update_prepare,
    execute: recur_update_execute,
    structure: false,
};
pub(crate) static SET_RECURRING_POST_ACTIVE: ActionDef = ActionDef {
    name: "set_recurring_post_active",
    label: "Tạm dừng / tiếp tục bài lặp lại",
    permissions: &["social.post"],
    prepare: recur_active_prepare,
    execute: recur_active_execute,
    structure: false,
};

/// 9 hành động đăng bài; `actions::find` tìm cả ở đây (M42 `all()` giữ nguyên 8 hành động CRM).
pub(crate) fn all() -> [&'static ActionDef; 9] {
    [
        &CREATE_SOCIAL_POST,
        &UPDATE_SCHEDULED_POST,
        &RESCHEDULE_SOCIAL_POST,
        &RETRY_SOCIAL_POST_TARGET,
        &PUBLISH_SOCIAL_DRAFT,
        &IMPORT_SOCIAL_POSTS,
        &CREATE_RECURRING_POST,
        &UPDATE_RECURRING_POST,
        &SET_RECURRING_POST_ACTIVE,
    ]
}

pub(crate) fn find(name: &str) -> Option<&'static ActionDef> {
    all().into_iter().find(|a| a.name == name)
}

// ------------------------------------------------------------------ dùng chung

const NO_SOCIAL: &str = "Máy chủ này chưa có tính năng đăng đa kênh. / Social posting is not available on this server.";
const NO_SLOT: &str = "Chưa đặt khung giờ hàng đợi (Đăng đa kênh › Lịch › Khung giờ), hoặc các khung trong 90 ngày tới đã kín. / No free queue slot; set weekly slots first.";

/// `SocialDeps` của máy chủ + tính năng `social_posting` bật.
async fn gate<'a>(cx: &'a ActionCx<'a>) -> Result<&'a SocialDeps, ToolError> {
    let s = social_of(cx.deps)?;
    ensure_enabled_for(cx.principal, cx.deps).await?;
    Ok(s)
}

fn social_of(deps: &ToolDeps) -> Result<&SocialDeps, ToolError> {
    deps.social
        .as_deref()
        .ok_or_else(|| ToolError::User(NO_SOCIAL.to_owned()))
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn at_ms(ms: i64) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp_millis(ms)
}

fn id_arg(args: &Value, key: &str) -> Result<i32, ToolError> {
    opt_int(args.get(key))
        .filter(|i| *i > 0)
        .ok_or_else(|| user(format!("{key} không hợp lệ.")))
}

/// Chưa có lời đồng ý ⇒ không làm gì, trả bản xem trước (`assertPostConfirmed`).
pub(super) fn assert_post_confirmed(words: Option<&Value>, details: &[Value]) -> Result<(), ToolError> {
    if is_user_confirmation(words) {
        return Ok(());
    }
    let said = words
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .map_or_else(|| "(trống)".to_owned(), |w| format!("“{}”", slice16(w, 80)));
    let text = |d: &Value, k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let plan = details
        .iter()
        .map(|d| format!("{}: {}", text(d, "label"), text(d, "value")))
        .collect::<Vec<_>>()
        .join(" | ");
    Err(ToolError::User(format!(
        "Chưa đăng gì: chưa có lời người dùng đồng ý với bài này (confirmed_by_user = {said}). Bài dự kiến — {plan}. \
         Bài lên mạng xã hội là công khai: người dùng xem nội dung, kênh và giờ đăng ở trên, sửa nếu cần, rồi đồng ý; \
         confirmed_by_user là câu đồng ý đó. / Nothing posted: no user approval of this post (confirmed_by_user = {said}). \
         Planned post: {plan}"
    )))
}

/// Dữ liệu dựng bản xem trước, lấy từ `Validated` hoặc từ bản xem trước của cổng bài lặp.
struct Chan {
    name: String,
    network: String,
    caption: Option<String>,
    first_comment: Option<String>,
}

struct Src {
    channels: Vec<Chan>,
    content: String,
    media: Vec<String>,
    /// `campaign=…[, content=…]` của UTM gắn trong tuỳ chọn kênh.
    utm: Option<String>,
}

fn utm_text(options: &[&Map<String, Value>]) -> Option<String> {
    let u = options
        .iter()
        .filter_map(|o| o.get("utm"))
        .find(|u| u.get("campaign").and_then(Value::as_str).is_some_and(|c| !c.is_empty()))?;
    let campaign = u.get("campaign").and_then(Value::as_str).unwrap_or_default();
    let content = u
        .get("content")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(|c| format!(", content={c}"))
        .unwrap_or_default();
    Some(format!(
        "campaign={campaign}{content} (utm_source = tên mạng từng kênh, utm_medium=social; gắn vào các liên kết khi đăng)"
    ))
}

fn first_comment_of(options: &Map<String, Value>) -> Option<String> {
    options.get("first_comment").and_then(Value::as_str).map(str::to_owned)
}

fn src_from_validated(v: &Validated) -> Src {
    let opts: Vec<&Map<String, Value>> = v.targets.iter().map(|t| &t.options).collect();
    Src {
        channels: v
            .targets
            .iter()
            .map(|t| Chan {
                name: t.account.name.clone(),
                network: t.account.network.clone(),
                caption: t.caption.clone(),
                first_comment: first_comment_of(&t.options),
            })
            .collect(),
        content: v.content.clone(),
        media: v.media.iter().map(|m| m.r#type.clone()).collect(),
        utm: utm_text(&opts),
    }
}

/// `validated` của `RecurrencePort::preview`: `{ content, targets: [{ account_name, network, caption, options }], media: [{ type }] }`.
fn src_from_preview(v: &Value) -> Src {
    let empty = Map::new();
    let list: &[Value] = v
        .get("targets")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let opts: Vec<&Map<String, Value>> = list
        .iter()
        .map(|t| t.get("options").and_then(Value::as_object).unwrap_or(&empty))
        .collect();
    let text = |t: &Value, k: &str| t.get(k).and_then(Value::as_str).map(str::to_owned);
    Src {
        channels: list
            .iter()
            .zip(&opts)
            .map(|(t, o)| Chan {
                name: text(t, "account_name").unwrap_or_default(),
                network: text(t, "network").unwrap_or_default(),
                caption: text(t, "caption").filter(|c| !c.is_empty()),
                first_comment: first_comment_of(o),
            })
            .collect(),
        content: v.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(),
        media: v
            .get("media")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.get("type").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        utm: utm_text(&opts),
    }
}

/// Dòng xem trước của bài (`postDetails`); `when` `None` ⇒ bỏ dòng "Giờ đăng" (bài lặp có luật riêng).
fn post_lines(src: &Src, when: Option<&str>) -> Vec<Value> {
    let channels = src
        .channels
        .iter()
        .map(|c| format!("{} ({})", c.name, c.network))
        .collect::<Vec<_>>()
        .join(", ");
    let mut items = vec![
        line("Kênh", Some(&channels), 500),
        when.and_then(|w| line("Giờ đăng", Some(w), 200)),
        line("Nội dung", Some(&src.content), 2000),
    ];
    for c in &src.channels {
        items.push(line(
            &format!("Nội dung riêng — {}", c.name),
            c.caption.as_deref(),
            1000,
        ));
    }
    for c in src.channels.iter().filter(|c| c.network == "facebook") {
        items.push(line(
            &format!("Bình luận đầu tiên — {}", c.name),
            c.first_comment.as_deref(),
            500,
        ));
    }
    items.push(src.utm.as_deref().and_then(|u| line("UTM", Some(u), 300)));
    let media = src.media.join(", ");
    items.push(line("Tệp đính kèm", Some(&media), 200));
    lines(items)
}

/// "Hẹn lúc …" hoặc "Đăng ngay" của bài đã kiểm.
fn when_of_validated(v: &Validated) -> String {
    v.scheduled_at
        .and_then(at_ms)
        .map_or_else(|| "Đăng ngay".to_owned(), |d| format!("Hẹn lúc {}", vn_when(d)))
}

fn post_details(v: &Validated) -> Vec<Value> {
    post_lines(&src_from_validated(v), Some(&when_of_validated(v)))
}

/// Tham số đã lưu của bài ⇒ đầu vào `mod-social`; thiếu khoá ⇒ rỗng. `utm`: vắng = giữ, `null` = bỏ.
fn post_input_from_params(p: &Value) -> PostInput {
    let targets = p
        .get("targets")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(TargetInput {
                        account_id: opt_int(t.get("account_id"))?,
                        caption: t.get("caption").and_then(Value::as_str).map(str::to_owned),
                        options: t.get("options").and_then(Value::as_object).cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    PostInput {
        content: p.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(),
        media_keys: media_keys(p),
        targets,
        scheduled_at: p.get("scheduled_at").and_then(Value::as_str).map(str::to_owned),
        use_queue: false,
        utm: p.get("utm").cloned(),
        source: None,
    }
}

fn post_params(input: &PostInput, queued: bool) -> Value {
    let targets: Vec<Value> = input
        .targets
        .iter()
        .map(|t| json!({ "account_id": t.account_id, "caption": t.caption, "options": t.options }))
        .collect();
    let mut p = json!({
        "content": input.content,
        "media_keys": input.media_keys,
        "targets": targets,
        "scheduled_at": input.scheduled_at,
    });
    if let Some(u) = &input.utm {
        p["utm"] = u.clone();
    }
    if queued {
        p["queued"] = json!(true);
    }
    p
}

/// `use_queue`: chọn luôn khung trống gần nhất để bản xem trước và tham số đã lưu có đúng giờ đó.
async fn queue_time(cx: &ActionCx<'_>, args: &Value) -> Result<Option<DateTime<Utc>>, ToolError> {
    if args.get("use_queue").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    if args
        .get("scheduled_at")
        .and_then(Value::as_str)
        .is_some_and(|t| !t.trim().is_empty())
    {
        return Err(user(
            "Chỉ chọn một trong use_queue hoặc scheduled_at. / Use either use_queue or scheduled_at, not both.",
        ));
    }
    next_slot(cx).await?.map(Some).ok_or_else(|| user(NO_SLOT))
}

async fn next_slot(cx: &ActionCx<'_>) -> Result<Option<DateTime<Utc>>, ToolError> {
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    let list = queue::next_free(&mut conn, 1, now_ms()).await.map_err(app_err)?;
    Ok(list.into_iter().next())
}

/// Lúc chạy: khung chốt lúc xem trước đã qua hoặc có bài khác chiếm ⇒ khung trống kế tiếp (`recheckQueued`).
async fn recheck_queued(cx: &ActionCx<'_>, at: Option<&str>) -> Result<(DateTime<Utc>, Option<String>), ToolError> {
    let parsed = at
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc));
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    let now = now_ms();
    if let Some(a) = parsed
        && queue::is_free(&mut conn, a.timestamp_millis(), now)
            .await
            .map_err(app_err)?
    {
        return Ok((a, None));
    }
    let slot = queue::next_free(&mut conn, 1, now)
        .await
        .map_err(app_err)?
        .into_iter()
        .next()
        .ok_or_else(|| {
            user("Khung hàng đợi đã chọn không còn trống và hàng đợi đã kín (hoặc chưa đặt khung). / No free queue slot left.")
        })?;
    Ok((slot, parsed.map(vn_when)))
}

const MOVED_NOTE: &str = "Khung đã chọn lúc xem trước không còn trống nên bài vào khung trống kế tiếp.";

fn post_result(p: &PostView, moved_from: Option<String>) -> Value {
    let targets: Vec<Value> = p
        .targets
        .iter()
        .map(|t| json!({ "target_id": t.id, "account": t.account_name, "status": t.status }))
        .collect();
    let mut out = json!({
        "post_id": p.id,
        "status": p.status,
        "scheduled_at": p.scheduled_at.as_ref().map(|t| vn_when(t.0)),
        "targets": targets,
    });
    if let Some(m) = moved_from {
        out["moved_from"] = json!(m);
        out["note"] = json!(MOVED_NOTE);
    }
    out
}

fn stored_media(v: &Value) -> Vec<SocialMedia> {
    let items: &[Value] = v.as_array().map_or(&[][..], Vec::as_slice);
    items
        .iter()
        .filter_map(|m| {
            let o = m.as_object()?;
            Some(SocialMedia {
                key: o.get("key")?.as_str()?.to_owned(),
                r#type: o.get("type")?.as_str()?.to_owned(),
                content_type: o.get("content_type")?.as_str()?.to_owned(),
                size: o.get("size")?.as_u64()?,
            })
        })
        .collect()
}

// ------------------------------------------------------------------ create_social_post

fn create_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let p = cx.principal;
        let queued = queue_time(cx, args).await?;
        let ids = account_ids(args);
        let scheduled = match queued {
            Some(q) => Some(q),
            None => parse_scheduled_at(args.get("scheduled_at"))?,
        };
        let input = PostInput {
            content: args
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            media_keys: media_keys(args),
            targets: targets_for(args, &ids)?,
            scheduled_at: scheduled.map(iso),
            use_queue: false,
            utm: utm_arg(args)?,
            source: None,
        };
        let infra = s.infra()?;
        let graph = (infra.graph_for)(p.company);
        let pc = s.post_ctx(cx.deps, p, infra, &graph);
        let v = posts::validate(&pc, &input, None).await.map_err(svc)?;
        let details = post_details(&v);
        assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        let when = when_of_validated(&v).replacen("Hẹn lúc", "Hẹn đăng lúc", 1);
        let mut saved = input;
        saved.scheduled_at = v.scheduled_at.and_then(at_ms).map(iso);
        Ok(Prepared {
            params: post_params(&saved, queued.is_some()),
            summary: shown(&format!("{when} bài lên {} kênh", v.targets.len()), 300),
            details,
            impact: None,
        })
    })
}

fn create_execute<'a>(params: &'a Value, cx: &'a ActionCx<'a>, _draft: i32) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let p = cx.principal;
        let mut input = post_input_from_params(params);
        let mut moved_from = None;
        if params.get("queued").and_then(Value::as_bool) == Some(true) {
            let (slot, moved) = recheck_queued(cx, input.scheduled_at.as_deref()).await?;
            input.scheduled_at = Some(iso(slot));
            moved_from = moved;
        }
        input.source = Some("mcp".to_owned());
        let infra = s.infra()?;
        let graph = (infra.graph_for)(p.company);
        let pc = s.post_ctx(cx.deps, p, infra, &graph);
        let post = posts::create(&pc, &input).await.map_err(svc)?;
        Ok(post_result(&post, moved_from))
    })
}

// ------------------------------------------------------------------ update_scheduled_post

/// Phần sửa + bài HIỆN TẠI ⇒ đầu vào đầy đủ cho `posts::update` (trường không sửa giữ như bài đang có), đã kiểm như lúc chạy.
async fn resolve_post_update(
    s: &SocialDeps,
    cx: &ActionCx<'_>,
    id: i32,
    patch: &Value,
) -> Result<(PostInput, Validated, SocialPost), ToolError> {
    let p = cx.principal;
    let infra = s.infra()?;
    let graph = (infra.graph_for)(p.company);
    let pc = s.post_ctx(cx.deps, p, infra, &graph);
    let (post, live) = {
        let mut conn = cx.deps.conn(p.company).await?;
        posts::editable(&mut conn, id, pc.now_ms).await.map_err(svc)?
    };
    let ids: Vec<i32> = if patch.get("account_ids").is_some_and(Value::is_array) {
        account_ids(patch)
    } else {
        live.iter().map(|t| t.account_id).collect()
    };
    let caps = parse_captions(patch);
    for (aid, _) in &caps {
        if !ids.contains(aid) {
            return Err(user(format!(
                "captions có account_id {aid} không nằm trong danh sách kênh của bài."
            )));
        }
    }
    let inherited = live
        .iter()
        .filter_map(|t| t.options.0.get("utm"))
        .find(|u| !u.is_null())
        .cloned();
    let targets: Vec<TargetInput> = ids
        .iter()
        .map(|aid| {
            let old = live.iter().find(|t| t.account_id == *aid);
            let c = caps.iter().find(|(i, _)| i == aid).map(|(_, c)| c);
            let caption = match c.and_then(|c| c.caption.clone()) {
                Some(v) => v,
                None => old.and_then(|t| t.caption.clone()),
            };
            // Kênh mới thêm vào bài đang gắn UTM thì gắn theo (không để một kênh "sạch" lẫn các kênh có UTM).
            let base: Map<String, Value> = match old {
                Some(t) => t.options.0.as_object().cloned().unwrap_or_default(),
                None => inherited
                    .clone()
                    .map(|u| Map::from_iter([("utm".to_owned(), u)]))
                    .unwrap_or_default(),
            };
            TargetInput {
                account_id: *aid,
                caption,
                options: Some(merge_options(base, c)),
            }
        })
        .collect();
    let stored = stored_media(&post.media.0);
    let scheduled_at = patch
        .get("scheduled_at")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| post.scheduled_at.as_ref().map(|t| iso(t.0)));
    let input = PostInput {
        content: patch
            .get("content")
            .and_then(Value::as_str)
            .map_or_else(|| post.content.clone(), str::to_owned),
        media_keys: stored.iter().map(|m| m.key.clone()).collect(),
        targets,
        scheduled_at,
        use_queue: false,
        utm: patch.get("utm").cloned(),
        source: None,
    };
    // Cùng luật với lúc chạy: sau bây giờ ≥ 1 phút, trong 90 ngày.
    posts::new_schedule(input.scheduled_at.as_deref(), pc.now_ms).map_err(svc)?;
    let v = posts::validate(&pc, &input, Some(&stored)).await.map_err(svc)?;
    Ok((input, v, post))
}

fn update_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let id = id_arg(args, "post_id")?;
        // Chỉ lưu PHẦN SỬA (không chụp cả bài): bài sửa trên giao diện trong lúc chờ duyệt không bị ghi đè.
        let mut patch = Map::new();
        if let Some(c) = args.get("content").and_then(Value::as_str) {
            patch.insert("content".to_owned(), json!(c));
        }
        if args.get("account_ids").is_some_and(Value::is_array) {
            patch.insert("account_ids".to_owned(), json!(account_ids(args)));
        }
        if let Some(c) = args.get("captions").filter(|c| c.is_array()) {
            patch.insert("captions".to_owned(), c.clone());
        }
        if let Some(at) = parse_scheduled_at(args.get("scheduled_at"))? {
            patch.insert("scheduled_at".to_owned(), json!(iso(at)));
        }
        if let Some(u) = utm_arg(args)? {
            patch.insert("utm".to_owned(), u);
        }
        let patch = Value::Object(patch);
        let (_, v, _) = resolve_post_update(s, cx, id, &patch).await?;
        let details = post_details(&v);
        assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        Ok(Prepared {
            params: json!({ "post_id": id, "patch": patch }),
            summary: shown(&format!("Sửa bài hẹn giờ #{id}"), 300),
            details,
            impact: None,
        })
    })
}

fn update_execute<'a>(params: &'a Value, cx: &'a ActionCx<'a>, _draft: i32) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let id = id_arg(params, "post_id")?;
        let patch = params.get("patch").cloned().unwrap_or_else(|| json!({}));
        // Ghép phần sửa với bài HIỆN TẠI (không phải lúc chuẩn bị) rồi kiểm lại.
        let (input, _, _) = resolve_post_update(s, cx, id, &patch).await?;
        let p = cx.principal;
        let infra = s.infra()?;
        let graph = (infra.graph_for)(p.company);
        let pc = s.post_ctx(cx.deps, p, infra, &graph);
        let post = posts::update(&pc, id, &input).await.map_err(svc)?;
        let targets: Vec<Value> = post
            .targets
            .iter()
            .filter(|t| t.status != "cancelled")
            .map(|t| json!({ "account": t.account_name, "status": t.status }))
            .collect();
        Ok(json!({
            "post_id": post.id,
            "status": post.status,
            "scheduled_at": post.scheduled_at.as_ref().map(|t| vn_when(t.0)),
            "targets": targets,
        }))
    })
}

// ------------------------------------------------------------------ reschedule_social_post

fn reschedule_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        gate(cx).await?;
        let id = id_arg(args, "post_id")?;
        let at = parse_scheduled_at(args.get("scheduled_at"))?
            .ok_or_else(|| user("Thiếu scheduled_at (giờ Việt Nam, YYYY-MM-DDTHH:mm)."))?;
        let post = {
            let mut conn = cx.deps.conn(cx.principal.company).await?;
            posts::editable(&mut conn, id, now_ms()).await.map_err(svc)?.0
        };
        // Cùng luật với lúc chạy: sau bây giờ ≥ 1 phút, trong 90 ngày.
        posts::new_schedule(Some(&iso(at)), now_ms()).map_err(svc)?;
        let old = post.scheduled_at.as_ref().map(|t| vn_when(t.0));
        let new = vn_when(at);
        Ok(Prepared {
            params: json!({ "post_id": id, "scheduled_at": iso(at) }),
            summary: shown(&format!("Đổi giờ bài #{id} sang {new}"), 300),
            details: lines(vec![
                line("Giờ cũ", old.as_deref(), 200),
                line("Giờ mới", Some(&new), 200),
                line("Nội dung", Some(&post.content), 300),
            ]),
            impact: None,
        })
    })
}

fn reschedule_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let id = id_arg(params, "post_id")?;
        let at = params.get("scheduled_at").and_then(Value::as_str).unwrap_or_default();
        let p = cx.principal;
        let infra = s.infra()?;
        let graph = (infra.graph_for)(p.company);
        let pc = s.post_ctx(cx.deps, p, infra, &graph);
        let post = posts::reschedule(&pc, id, at).await.map_err(svc)?;
        Ok(json!({ "post_id": post.id, "scheduled_at": post.scheduled_at.as_ref().map(|t| vn_when(t.0)) }))
    })
}

// ------------------------------------------------------------------ retry_social_post_target

fn retry_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        gate(cx).await?;
        let id = id_arg(args, "target_id")?;
        let row: Option<(i32, String, String, Option<String>)> =
            sqlx::query_as("SELECT post_id, network, status, last_error FROM social_post_targets WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *cx.deps.conn(cx.principal.company).await?)
                .await
                .map_err(crate::actions::internal)?;
        let Some((post_id, network, status, last_error)) = row else {
            return Err(user("Không tìm thấy target_id này."));
        };
        if status != "failed" {
            return Err(user("Chỉ thử lại được kênh đang báo lỗi."));
        }
        Ok(Prepared {
            params: json!({ "target_id": id }),
            summary: shown(&format!("Thử đăng lại bài #{post_id} trên kênh {network}"), 300),
            details: lines(vec![line("Lỗi lần trước", last_error.as_deref(), 500)]),
            impact: None,
        })
    })
}

fn retry_execute<'a>(params: &'a Value, cx: &'a ActionCx<'a>, _draft: i32) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let id = id_arg(params, "target_id")?;
        let p = cx.principal;
        let infra = s.infra()?;
        let graph = (infra.graph_for)(p.company);
        let pc = s.post_ctx(cx.deps, p, infra, &graph);
        let post = posts::retry(&pc, id).await.map_err(svc)?;
        Ok(json!({ "post_id": post.id, "status": post.status }))
    })
}

// ------------------------------------------------------------------ publish_social_draft

/// Nháp + giờ ghi đè ⇒ đầu vào bài (`toPostInput`): giờ ghi đè thay giờ của nháp và bỏ "vào hàng đợi".
fn draft_post_input(d: &SocialDraft, ov: &DraftOverrides) -> PostInput {
    let keys: Vec<String> = d
        .media
        .0
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("key").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let targets: Vec<DraftTarget> = serde_json::from_value(d.targets.0.clone()).unwrap_or_default();
    let (scheduled_at, use_queue) = match &ov.scheduled_at {
        Some(o) => (o.clone(), false),
        None => (
            d.scheduled_at.as_ref().map(|t| iso(t.0)),
            d.use_queue && d.scheduled_at.is_none(),
        ),
    };
    PostInput {
        content: d.content.clone(),
        media_keys: keys,
        targets: targets
            .into_iter()
            .map(|t| TargetInput {
                account_id: t.account_id,
                caption: t.caption,
                options: t.options,
            })
            .collect(),
        scheduled_at,
        use_queue,
        utm: None,
        source: Some("mcp".to_owned()),
    }
}

fn publish_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let p = cx.principal;
        let queued = queue_time(cx, args).await?;
        let id = id_arg(args, "draft_id")?;
        // Chỉ lưu {draft_id, phiên bản, giờ ghi đè}; lúc chạy kiểm nháp còn đúng phiên bản đã xem.
        let mut ov = DraftOverrides::default();
        if let Some(q) = queued {
            ov.scheduled_at = Some(Some(iso(q)));
        } else if args.get("scheduled_at").is_some_and(Value::is_string) {
            ov.scheduled_at = Some(parse_scheduled_at(args.get("scheduled_at"))?.map(iso));
        }
        let draft = {
            let mut conn = cx.deps.conn(p.company).await?;
            drafts::get(&mut conn, id, now_ms()).await.map_err(svc)?
        };
        let mut input = draft_post_input(&draft, &ov);
        let mut from_queue = queued.is_some();
        // Nháp tự chọn "Vào hàng đợi" (không có giờ cụ thể): chốt khung ngay để bản xem trước đúng giờ sẽ đăng.
        if input.use_queue {
            let slot = next_slot(cx).await?.ok_or_else(|| {
                user("Nháp chọn đăng vào hàng đợi nhưng chưa có khung trống (Đăng đa kênh › Lịch › Khung giờ). / No free queue slot.")
            })?;
            ov.scheduled_at = Some(Some(iso(slot)));
            input = draft_post_input(&draft, &ov);
            from_queue = true;
        }
        if input.scheduled_at.is_some() {
            posts::new_schedule(input.scheduled_at.as_deref(), now_ms()).map_err(svc)?;
        }
        let infra = s.infra()?;
        let graph = (infra.graph_for)(p.company);
        let pc = s.post_ctx(cx.deps, p, infra, &graph);
        let v = posts::validate(&pc, &input, None).await.map_err(svc)?;
        let details = post_details(&v);
        assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        let when = when_of_validated(&v).replacen("Hẹn lúc", "Hẹn đăng lúc", 1);
        let mut params = json!({ "draft_id": id, "version": iso(draft.updated_at.0) });
        if let Some(o) = &ov.scheduled_at {
            params["scheduled_at"] = json!(o);
        }
        if from_queue {
            params["queued"] = json!(true);
        }
        Ok(Prepared {
            params,
            summary: shown(&format!("{when} bài nháp #{id} lên {} kênh", v.targets.len()), 300),
            details,
            impact: None,
        })
    })
}

fn publish_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let publisher = port(&s.draft_publisher, "đăng bài nháp")?;
        let id = id_arg(params, "draft_id")?;
        let mut ov = DraftOverrides::default();
        let mut moved_from = None;
        if params.get("queued").and_then(Value::as_bool) == Some(true) {
            let (slot, moved) = recheck_queued(cx, params.get("scheduled_at").and_then(Value::as_str)).await?;
            ov.scheduled_at = Some(Some(iso(slot)));
            moved_from = moved;
        } else if let Some(v) = params.get("scheduled_at") {
            ov.scheduled_at = Some(v.as_str().map(str::to_owned));
        }
        let version = params
            .get("version")
            .and_then(Value::as_str)
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc));
        let r = publisher
            .publish(cx.principal.company, cx.principal.user_id, id, ov, version)
            .await
            .map_err(svc)?;
        let targets: Vec<Value> = r
            .get("targets")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|t| json!({ "target_id": t.get("id"), "account": t.get("account_name"), "status": t.get("status") }))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = json!({
            "post_id": r.get("id"),
            "status": r.get("status"),
            "scheduled_at": when_of(r.get("scheduled_at")),
            "targets": targets,
        });
        if let Some(m) = moved_from {
            out["moved_from"] = json!(m);
            out["note"] = json!(MOVED_NOTE);
        }
        Ok(out)
    })
}

// ------------------------------------------------------------------ import_social_posts

/// Các dòng AI gửi ⇒ dòng chuẩn hoá cho `ImportPort` (`rowsFromStructured`): giờ hẹn ⇒ ISO UTC (thiếu múi giờ = giờ Việt Nam).
fn normalize_rows(raw: &Value) -> Result<Value, ToolError> {
    let list: &[Value] = raw.as_array().map_or(&[][..], Vec::as_slice);
    let mut out = Vec::with_capacity(list.len());
    for (i, r) in list.iter().enumerate() {
        let at = parse_scheduled_at(r.get("scheduled_at")).map_err(|e| match e {
            ToolError::User(m) => user(format!("Dòng {}: {m}", i + 1)),
            other => other,
        })?;
        let text = |k: &str| {
            r.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
        };
        out.push(json!({
            "content": r.get("content").and_then(Value::as_str).unwrap_or_default(),
            "account_ids": account_ids(r),
            "scheduled_at": at.map(iso),
            "use_queue": r.get("use_queue").and_then(Value::as_bool).unwrap_or(false),
            "media_keys": media_keys(r),
            "first_comment": text("first_comment"),
            "utm_campaign": text("utm_campaign"),
        }));
    }
    Ok(Value::Array(out))
}

/// Dòng xem trước từng dòng nhập: kênh — giờ — nội dung, hoặc lỗi (`importDetails`).
fn import_details(plan: &Value) -> Vec<Value> {
    let rows: &[Value] = plan
        .get("rows")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    rows.iter()
        .map(|r| {
            let pv = r.get("preview").unwrap_or(&Value::Null);
            let at = when_of(pv.get("scheduled_at"));
            let when = if pv.get("use_queue").and_then(Value::as_bool) == Some(true) {
                format!("hàng đợi{}", at.map(|a| format!(" ({a})")).unwrap_or_default())
            } else {
                at.unwrap_or_else(|| "không có giờ".to_owned())
            };
            let names: Vec<&str> = pv
                .get("channels")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|c| c.get("name").and_then(Value::as_str)).collect())
                .unwrap_or_default();
            let who = if names.is_empty() {
                "chưa chọn kênh".to_owned()
            } else {
                names.join(", ")
            };
            let excerpt = pv
                .get("content_excerpt")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
                .unwrap_or("(chỉ có tệp)");
            let head = format!("{who} — {when} — {excerpt}");
            let ok = r.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let value = if ok {
                head
            } else {
                let errs: Vec<&str> = r
                    .get("errors")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                format!("{head} — LỖI: {}", errs.join(" "))
            };
            json!({ "label": format!("Dòng {}", r.get("row").and_then(Value::as_i64).unwrap_or(0)), "value": shown(&value, 500) })
        })
        .collect()
}

fn import_mode(args: &Value) -> Result<&'static str, ToolError> {
    match args.get("mode").and_then(Value::as_str) {
        Some("drafts") => Ok("drafts"),
        Some("schedule") => Ok("schedule"),
        _ => Err(user(
            "mode phải là \"drafts\" hoặc \"schedule\". / mode must be drafts or schedule.",
        )),
    }
}

fn import_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let importer = port(&s.importer, "nhập nhiều bài")?;
        let mode = import_mode(args)?;
        let rows = normalize_rows(args.get("rows").unwrap_or(&Value::Null))?;
        let n = rows.as_array().map_or(0, Vec::len);
        if n == 0 || n > 50 {
            return Err(user("rows cần từ 1 đến 50 dòng. / rows needs 1 to 50 entries."));
        }
        let plan = importer
            .plan(cx.principal.company, cx.principal.user_id, rows.clone(), mode)
            .await
            .map_err(svc)?;
        let details = import_details(&plan);
        let count = |k: &str| plan.get(k).and_then(Value::as_i64).unwrap_or(0);
        if count("ok_count") == 0 {
            let all = details
                .iter()
                .map(|d| {
                    let t = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                    format!("{}: {}", t("label"), t("value"))
                })
                .collect::<Vec<_>>()
                .join(" | ");
            return Err(user(format!(
                "Không dòng nào hợp lệ nên chưa tạo gì. {all} / No valid row; nothing created."
            )));
        }
        // Nháp không đăng gì ⇒ không cần xác nhận; bài hẹn giờ là công khai ⇒ cần lời đồng ý sau khi xem từng dòng.
        if mode == "schedule" {
            assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        }
        let summary = if mode == "drafts" {
            format!("Lưu {} bài nháp từ {} dòng", count("ok_count"), count("total"))
        } else {
            format!("Tạo {} bài hẹn giờ từ {} dòng", count("ok_count"), count("total"))
        };
        Ok(Prepared {
            // Chỉ lưu dòng đã chuẩn hoá + băm: lúc chạy kiểm lại và từ chối nếu khác bản đã xem.
            params: json!({ "mode": mode, "rows": rows, "plan_hash": plan.get("plan_hash") }),
            summary: shown(&summary, 300),
            details,
            impact: None,
        })
    })
}

fn import_execute<'a>(params: &'a Value, cx: &'a ActionCx<'a>, _draft: i32) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let importer = port(&s.importer, "nhập nhiều bài")?;
        let mode = import_mode(params)?;
        let rows = params.get("rows").cloned().unwrap_or(Value::Null);
        let hash = params.get("plan_hash").and_then(Value::as_str).unwrap_or_default();
        let r = importer
            .import(cx.principal.company, cx.principal.user_id, rows, mode, hash)
            .await
            .map_err(|e| match svc(e) {
                ToolError::User(m) => user(format!(
                    "{m} / If the data changed since the preview, call again without confirmed_by_user to preview."
                )),
                other => other,
            })?;
        let created = r.get("created").cloned().unwrap_or_else(|| json!([]));
        Ok(json!({
            "mode": r.get("mode"),
            "created_count": created.as_array().map_or(0, Vec::len),
            "created": created,
            "skipped": r.get("skipped").cloned().unwrap_or_else(|| json!([])),
        }))
    })
}

// ------------------------------------------------------------------ bài lặp

fn text_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// Các trường luật lặp AI đã gửi (`ruleFromArgs`).
fn rule_from_args(args: &Value) -> Map<String, Value> {
    let mut r = Map::new();
    if let Some(f) = args.get("freq").and_then(Value::as_str) {
        r.insert("freq".to_owned(), json!(f));
    }
    if let Some(n) = opt_int(args.get("interval")) {
        r.insert("interval".to_owned(), json!(n));
    }
    if let Some(a) = args.get("weekdays").and_then(Value::as_array) {
        let days: Vec<i32> = a.iter().filter_map(|v| opt_int(Some(v))).collect();
        r.insert("weekdays".to_owned(), json!(days));
    }
    if let Some(n) = opt_int(args.get("month_day")) {
        r.insert("month_day".to_owned(), json!(n));
    }
    if let Some(t) = text_arg(args, "time") {
        r.insert("time".to_owned(), json!(t));
    }
    r
}

/// Mẫu bài lặp từ `captions` (kênh + nội dung riêng + tuỳ chọn), có UTM (không có/`null` ⇒ không khoá).
fn recurrence_template(args: &Value, ids: &[i32], utm: Option<&Value>) -> Result<Value, ToolError> {
    let targets: Vec<Value> = targets_for(args, ids)?
        .into_iter()
        .map(|t| json!({ "account_id": t.account_id, "caption": t.caption, "options": t.options }))
        .collect();
    let mut tpl = json!({
        "content": args.get("content").and_then(Value::as_str).unwrap_or_default(),
        "media_keys": media_keys(args),
        "targets": targets,
    });
    if let Some(u) = utm.filter(|u| !u.is_null()) {
        tpl["utm"] = u.clone();
    }
    Ok(tpl)
}

/// Đầu vào tạo lịch lặp (`RecurrenceInput`) từ tham số AI.
fn recurrence_input_from_args(args: &Value) -> Result<Value, ToolError> {
    let ids = account_ids(args);
    let utm = utm_arg(args)?;
    let template = recurrence_template(args, &ids, utm.as_ref())?;
    let content = args.get("content").and_then(Value::as_str).unwrap_or_default();
    let squashed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = text_arg(args, "title")
        .or_else(|| Some(squashed.chars().take(60).collect::<String>()).filter(|t| !t.is_empty()))
        .unwrap_or_else(|| "Bài lặp lại".to_owned());
    Ok(json!({
        "title": title,
        "template": template,
        "rule": Value::Object(rule_from_args(args)),
        "starts_on": text_arg(args, "starts_on"),
        "ends_on": text_arg(args, "ends_on"),
        "max_count": opt_int(args.get("max_count")),
    }))
}

/// Phần sửa lịch lặp (chỉ lưu những gì AI nhắc tới); `ends_on` "" = bỏ, `max_count` 0 = bỏ.
fn recurrence_patch(args: &Value) -> Result<Value, ToolError> {
    let mut patch = Map::new();
    if let Some(t) = text_arg(args, "title") {
        patch.insert("title".to_owned(), json!(t));
    }
    if let Some(c) = args.get("content").and_then(Value::as_str) {
        patch.insert("content".to_owned(), json!(c));
    }
    if args.get("account_ids").is_some_and(Value::is_array) {
        patch.insert("account_ids".to_owned(), json!(account_ids(args)));
    }
    if let Some(c) = args.get("captions").filter(|c| c.is_array()) {
        patch.insert("captions".to_owned(), c.clone());
    }
    if args.get("media_keys").is_some_and(Value::is_array) {
        patch.insert("media_keys".to_owned(), json!(media_keys(args)));
    }
    if let Some(u) = utm_arg(args)? {
        patch.insert("utm".to_owned(), u);
    }
    let rule = rule_from_args(args);
    if !rule.is_empty() {
        patch.insert("rule".to_owned(), Value::Object(rule));
    }
    if let Some(t) = text_arg(args, "starts_on") {
        patch.insert("starts_on".to_owned(), json!(t));
    }
    if let Some(e) = args.get("ends_on").and_then(Value::as_str) {
        patch.insert("ends_on".to_owned(), json!(Some(e.trim()).filter(|t| !t.is_empty())));
    }
    if args.get("max_count").is_some_and(Value::is_number) {
        patch.insert(
            "max_count".to_owned(),
            json!(opt_int(args.get("max_count")).filter(|n| *n != 0)),
        );
    }
    Ok(Value::Object(patch))
}

/// Phần sửa + lịch HIỆN TẠI (`RecurrencePort::get`) ⇒ đầu vào đầy đủ (trường không sửa giữ như đang có).
fn recurrence_input_from_patch(cur: &Value, patch: &Value) -> Result<Value, ToolError> {
    let tpl = cur.get("template").cloned().unwrap_or(Value::Null);
    let cur_targets: Vec<&Value> = tpl
        .get("targets")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let cur_id = |t: &Value| opt_int(t.get("account_id"));
    let ids: Vec<i32> = if patch.get("account_ids").is_some_and(Value::is_array) {
        account_ids(patch)
    } else {
        cur_targets.iter().filter_map(|t| cur_id(t)).collect()
    };
    let caps = parse_captions(patch);
    for (aid, _) in &caps {
        if !ids.contains(aid) {
            return Err(user(format!(
                "captions có account_id {aid} không nằm trong danh sách kênh của lịch."
            )));
        }
    }
    let targets: Vec<Value> = ids
        .iter()
        .map(|aid| {
            let old = cur_targets.iter().find(|t| cur_id(t) == Some(*aid));
            let c = caps.iter().find(|(i, _)| i == aid).map(|(_, c)| c);
            let caption = match c.and_then(|c| c.caption.clone()) {
                Some(v) => v,
                None => old
                    .and_then(|t| t.get("caption").and_then(Value::as_str))
                    .map(str::to_owned),
            };
            let stored = old
                .and_then(|t| t.get("options").and_then(Value::as_object))
                .cloned()
                .unwrap_or_default();
            json!({ "account_id": aid, "caption": caption, "options": merge_options(stored, c) })
        })
        .collect();
    let pick = |k: &str, fallback: &Value| patch.get(k).cloned().unwrap_or_else(|| fallback.clone());
    let mut template = json!({
        "content": patch.get("content").cloned().unwrap_or_else(|| tpl.get("content").cloned().unwrap_or(json!(""))),
        "media_keys": patch.get("media_keys").cloned().unwrap_or_else(|| tpl.get("media_keys").cloned().unwrap_or(json!([]))),
        "targets": targets,
    });
    // utm: vắng = giữ UTM đang có; `null` = bỏ; còn lại = cấu hình mới.
    let utm = match patch.get("utm") {
        Some(u) => Some(u.clone()),
        None => tpl.get("utm").cloned(),
    };
    if let Some(u) = utm.filter(|u| !u.is_null()) {
        template["utm"] = u;
    }
    let mut rule = cur.get("rule").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(r) = patch.get("rule").and_then(Value::as_object) {
        for (k, v) in r {
            rule.insert(k.clone(), v.clone());
        }
    }
    let null = Value::Null;
    Ok(json!({
        "title": pick("title", cur.get("title").unwrap_or(&null)),
        "template": template,
        "rule": Value::Object(rule),
        "starts_on": pick("starts_on", cur.get("starts_on").unwrap_or(&null)),
        "ends_on": pick("ends_on", cur.get("ends_on").unwrap_or(&null)),
        "max_count": pick("max_count", cur.get("max_count").unwrap_or(&null)),
    }))
}

/// Chi tiết cho người duyệt: tên, luật lặp, các lần đăng tới, rồi bài (không có dòng "Giờ đăng").
fn recurring_details(p: &Value) -> Vec<Value> {
    let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
    let ends = match (
        text("endsOn"),
        p.get("maxCount").and_then(Value::as_i64).filter(|n| *n != 0),
    ) {
        (Some(e), _) => format!("đến hết ngày {e}"),
        (None, Some(n)) => format!("sau {n} lần đăng"),
        (None, None) => "không kết thúc".to_owned(),
    };
    let times: Vec<String> = p
        .get("times")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|t| when_of(Some(t))).collect())
        .unwrap_or_default();
    let next = if times.is_empty() {
        "không còn lần nào".to_owned()
    } else {
        times.join(" | ")
    };
    let rule = describe_rule(p.get("rule").unwrap_or(&Value::Null));
    let mut out = lines(vec![
        line("Tên", text("title").as_deref(), 200),
        line("Lặp lại", Some(&rule), 300),
        line("Bắt đầu", text("startsOn").as_deref(), 40),
        line("Kết thúc", Some(&ends), 100),
        line("3 lần đăng tới", Some(&next), 600),
    ]);
    out.extend(post_lines(
        &src_from_preview(p.get("validated").unwrap_or(&Value::Null)),
        None,
    ));
    out
}

fn recur_id_arg(args: &Value) -> Result<i32, ToolError> {
    id_arg(args, "recurrence_id")
}

/// Kết quả gọn của một lịch lặp sau khi tạo/sửa/tiếp tục/dừng.
fn recurrence_result(r: &Value, with_upcoming: bool) -> Value {
    let active = r.get("active").and_then(Value::as_bool).unwrap_or(false);
    let next: Vec<Option<String>> = r
        .get("next_times")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|t| when_of(Some(t))).collect())
        .unwrap_or_default();
    let mut out = json!({
        "recurrence_id": r.get("id"),
        "title": r.get("title"),
        "status": if active { "active" } else { "paused" },
        "rule": describe_rule(r.get("rule").unwrap_or(&Value::Null)),
        "next_times": next,
    });
    if with_upcoming {
        let upcoming = r
            .get("posts")
            .and_then(Value::as_array)
            .and_then(|a| {
                a.iter()
                    .find(|p| p.get("status").and_then(Value::as_str) == Some("scheduled"))
            })
            .and_then(|p| p.get("id").cloned())
            .unwrap_or(Value::Null);
        out["upcoming_post_id"] = upcoming;
    }
    if let Some(e) = r.get("last_error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        out["error"] = json!(e);
    }
    out
}

fn recur_create_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let input = recurrence_input_from_args(args)?;
        let p = rec
            .preview(cx.principal.company, cx.principal.user_id, input.clone(), None)
            .await
            .map_err(svc)?;
        let details = recurring_details(&p);
        assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        let title = p.get("title").and_then(Value::as_str).unwrap_or_default();
        let rule = describe_rule(p.get("rule").unwrap_or(&Value::Null));
        let channels = p
            .get("validated")
            .and_then(|v| v.get("targets"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        Ok(Prepared {
            params: json!({ "input": input }),
            summary: shown(&format!("Đăng lặp lại \"{title}\": {rule}, {channels} kênh"), 300),
            details,
            impact: None,
        })
    })
}

fn recur_create_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let input = params.get("input").cloned().unwrap_or(Value::Null);
        let r = rec
            .create(cx.principal.company, cx.principal.user_id, input)
            .await
            .map_err(svc)?;
        Ok(recurrence_result(&r, true))
    })
}

fn recur_update_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let id = recur_id_arg(args)?;
        // Chỉ lưu PHẦN SỬA: chế độ duyệt có thể chờ tới 24 giờ, lịch sửa trên giao diện trong lúc đó không bị ghi đè.
        let patch = recurrence_patch(args)?;
        let cur = rec.get(cx.principal.company, id).await.map_err(svc)?;
        let input = recurrence_input_from_patch(&cur, &patch)?;
        let p = rec
            .preview(cx.principal.company, cx.principal.user_id, input, Some(id))
            .await
            .map_err(svc)?;
        let details = recurring_details(&p);
        assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        let title = p.get("title").and_then(Value::as_str).unwrap_or_default();
        Ok(Prepared {
            params: json!({ "recurrence_id": id, "patch": patch }),
            summary: shown(&format!("Sửa bài lặp lại #{id} \"{title}\""), 300),
            details,
            impact: None,
        })
    })
}

fn recur_update_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let id = recur_id_arg(params)?;
        let patch = params.get("patch").cloned().unwrap_or_else(|| json!({}));
        // Ghép phần sửa với lịch HIỆN TẠI (không phải lúc chuẩn bị) rồi ghi.
        let cur = rec.get(cx.principal.company, id).await.map_err(svc)?;
        let input = recurrence_input_from_patch(&cur, &patch)?;
        let r = rec
            .update(cx.principal.company, cx.principal.user_id, id, input)
            .await
            .map_err(svc)?;
        Ok(recurrence_result(&r, false))
    })
}

fn recur_active_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let id = recur_id_arg(args)?;
        let Some(active) = args.get("active").and_then(Value::as_bool) else {
            return Err(user("Thiếu active (true = tiếp tục, false = tạm dừng)."));
        };
        let cur = rec.get(cx.principal.company, id).await.map_err(svc)?;
        let title = cur.get("title").and_then(Value::as_str).unwrap_or_default();
        if !active {
            let pending = cur.get("posts").and_then(Value::as_array).is_some_and(|a| {
                a.iter()
                    .any(|p| p.get("status").and_then(Value::as_str) == Some("scheduled"))
            });
            let rule = describe_rule(cur.get("rule").unwrap_or(&Value::Null));
            let pending_text = if pending {
                "sẽ bị huỷ (không xoá)"
            } else {
                "không có"
            };
            return Ok(Prepared {
                params: json!({ "recurrence_id": id, "active": false }),
                summary: shown(&format!("Tạm dừng bài lặp lại #{id} \"{title}\""), 300),
                details: lines(vec![
                    line("Lặp lại", Some(&rule), 300),
                    line("Bài hẹn đang chờ", Some(pending_text), 100),
                ]),
                impact: None,
            });
        }
        let p = rec
            .preview(cx.principal.company, cx.principal.user_id, json!({}), Some(id))
            .await
            .map_err(svc)?;
        let details = recurring_details(&p);
        assert_post_confirmed(args.get("confirmed_by_user"), &details)?;
        Ok(Prepared {
            params: json!({ "recurrence_id": id, "active": true }),
            summary: shown(&format!("Tiếp tục bài lặp lại #{id} \"{title}\""), 300),
            details,
            impact: None,
        })
    })
}

fn recur_active_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let s = gate(cx).await?;
        let rec = port(&s.recurrences, "đăng bài lặp lại")?;
        let id = recur_id_arg(params)?;
        let active = params.get("active").and_then(Value::as_bool).unwrap_or(false);
        let r = rec.set_active(cx.principal.company, id, active).await.map_err(svc)?;
        let mut out = recurrence_result(&r, false);
        // Gọn như bản Node: chỉ id, trạng thái, lần tới và lỗi.
        if let Some(o) = out.as_object_mut() {
            o.remove("title");
            o.remove("rule");
        }
        debug_assert_eq!(
            out["status"],
            if recurrence_status(&r) == "paused" {
                "paused"
            } else {
                "active"
            }
        );
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chin_hanh_dong_khong_trung_ten_va_khong_xoa() {
        let names: Vec<&str> = all().iter().map(|a| a.name).collect();
        assert_eq!(names.len(), 9);
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 9, "{names:?}");
        for n in &names {
            for banned in ["delete", "remove", "cancel", "destroy"] {
                assert!(!n.contains(banned), "{n}");
            }
            assert!(find(n).is_some(), "{n}");
        }
        assert!(find("cancel_scheduled_post").is_none());
        assert!(all().iter().all(|a| a.permissions == ["social.post"]));
    }

    #[test]
    fn thieu_dong_y_tra_ban_xem_truoc() {
        let details = vec![
            json!({ "label": "Kênh", "value": "Trang A (facebook)" }),
            json!({ "label": "Giờ đăng", "value": "Đăng ngay" }),
        ];
        for words in [None, Some(json!("")), Some(json!("hmm")), Some(json!("không đăng"))] {
            let err = assert_post_confirmed(words.as_ref(), &details).unwrap_err();
            let ToolError::User(m) = err else {
                panic!("phải là lỗi người dùng")
            };
            assert!(m.starts_with("Chưa đăng gì"), "{m}");
            assert!(m.contains("Kênh: Trang A (facebook) | Giờ đăng: Đăng ngay"), "{m}");
        }
        let err = assert_post_confirmed(Some(&json!("hmm")), &details).unwrap_err();
        assert!(matches!(&err, ToolError::User(m) if m.contains("“hmm”")));
        assert!(assert_post_confirmed(Some(&json!("ok đăng đi")), &details).is_ok());
        assert!(assert_post_confirmed(Some(&json!("được, đăng vậy")), &details).is_ok());
    }

    #[test]
    fn tham_so_bai_di_ve_va_cung_dau_vao() {
        let args = json!({
            "content": "Chào",
            "account_ids": [3, 4],
            "captions": [{ "account_id": 4, "caption": "Riêng", "facebook_first_comment": "link" }],
            "media_keys": ["social/a.png"],
            "utm_campaign": "thu",
        });
        let ids = account_ids(&args);
        let input = PostInput {
            content: "Chào".to_owned(),
            media_keys: media_keys(&args),
            targets: targets_for(&args, &ids).unwrap(),
            scheduled_at: Some("2026-12-01T02:00:00.000Z".to_owned()),
            use_queue: false,
            utm: utm_arg(&args).unwrap(),
            source: None,
        };
        let params = post_params(&input, true);
        assert_eq!(params["queued"], true);
        assert_eq!(params["targets"][1]["caption"], "Riêng");
        assert_eq!(params["targets"][1]["options"]["first_comment"], "link");
        assert_eq!(params["utm"]["campaign"], "thu");
        let back = post_input_from_params(&params);
        assert_eq!(back, input);

        // UTM bỏ (null) vẫn đi về là `Some(null)`; vắng thì `None`.
        let mut cleared = input.clone();
        cleared.utm = Some(Value::Null);
        assert_eq!(
            post_input_from_params(&post_params(&cleared, false)).utm,
            Some(Value::Null)
        );
        let mut keep = input;
        keep.utm = None;
        let p = post_params(&keep, false);
        assert!(p.get("utm").is_none() && p.get("queued").is_none());
        assert_eq!(post_input_from_params(&p).utm, None);
    }

    #[test]
    fn dong_nhap_chuan_hoa_gio_viet_nam() {
        let raw = json!([
            { "content": "A", "account_ids": [1], "scheduled_at": "2026-12-01T09:00", "media_keys": ["k"], "first_comment": " bl ", "utm_campaign": "c" },
            { "use_queue": true },
        ]);
        let rows = normalize_rows(&raw).unwrap();
        assert_eq!(rows[0]["scheduled_at"], "2026-12-01T02:00:00.000Z");
        assert_eq!(rows[0]["first_comment"], "bl");
        assert_eq!(rows[0]["utm_campaign"], "c");
        assert_eq!(rows[1]["use_queue"], true);
        assert_eq!(rows[1]["scheduled_at"], Value::Null);
        assert_eq!(rows[1]["content"], "");
        let bad = json!([{ "scheduled_at": "mai" }]);
        assert!(matches!(normalize_rows(&bad), Err(ToolError::User(m)) if m.starts_with("Dòng 1:")));
    }

    #[test]
    fn xem_truoc_nhap_hang_loat() {
        let plan = json!({ "rows": [
            { "row": 1, "ok": true, "errors": [], "preview": {
                "channels": [{ "name": "Trang A" }, { "name": "Trang B" }],
                "scheduled_at": "2026-12-01T02:00:00Z", "use_queue": false, "content_excerpt": "Chào" } },
            { "row": 2, "ok": false, "errors": ["Thiếu kênh.", "Thiếu giờ."], "preview": {
                "channels": [], "scheduled_at": null, "use_queue": true, "content_excerpt": "" } },
        ]});
        let d = import_details(&plan);
        assert_eq!(d[0]["label"], "Dòng 1");
        assert_eq!(
            d[0]["value"],
            "Trang A, Trang B — 09:00 Thứ Ba 01/12/2026 (giờ Việt Nam) — Chào"
        );
        assert_eq!(
            d[1]["value"],
            "chưa chọn kênh — hàng đợi — (chỉ có tệp) — LỖI: Thiếu kênh. Thiếu giờ."
        );
    }

    #[test]
    fn dau_vao_lich_lap_tu_tham_so() {
        let args = json!({
            "content": "  Chào   cả   nhà ",
            "account_ids": [3],
            "freq": "weekly", "interval": 2, "weekdays": [1, 3], "time": " 09:00 ",
            "starts_on": "2026-12-01", "ends_on": "", "max_count": 10,
            "utm_campaign": "w",
        });
        let i = recurrence_input_from_args(&args).unwrap();
        assert_eq!(i["title"], "Chào cả nhà");
        assert_eq!(
            i["rule"],
            json!({ "freq": "weekly", "interval": 2, "weekdays": [1, 3], "time": "09:00" })
        );
        assert_eq!(i["starts_on"], "2026-12-01");
        assert_eq!(i["ends_on"], Value::Null);
        assert_eq!(i["max_count"], 10);
        assert_eq!(i["template"]["utm"]["campaign"], "w");
        assert_eq!(i["template"]["targets"][0]["account_id"], 3);
        let empty = recurrence_input_from_args(&json!({ "account_ids": [1] })).unwrap();
        assert_eq!(empty["title"], "Bài lặp lại");
    }

    #[test]
    fn sua_lich_lap_giu_phan_khong_nhac_toi() {
        let cur = json!({
            "title": "Cũ", "starts_on": "2026-12-01", "ends_on": "2027-01-31", "max_count": null,
            "rule": { "freq": "daily", "interval": 1, "time": "09:00" },
            "template": {
                "content": "Nội dung cũ", "media_keys": ["a"],
                "targets": [
                    { "account_id": 3, "caption": "Cũ 3", "options": { "first_comment": "bl" } },
                    { "account_id": 4, "caption": null, "options": {} },
                ],
                "utm": { "campaign": "x" },
            },
        });
        let patch = recurrence_patch(&json!({
            "time": "19:30", "ends_on": "", "max_count": 0,
            "captions": [{ "account_id": 3, "facebook_first_comment": "" }],
            "utm_campaign": "",
        }))
        .unwrap();
        let i = recurrence_input_from_patch(&cur, &patch).unwrap();
        assert_eq!(i["title"], "Cũ");
        assert_eq!(i["rule"], json!({ "freq": "daily", "interval": 1, "time": "19:30" }));
        assert_eq!(i["ends_on"], Value::Null);
        assert_eq!(i["max_count"], Value::Null);
        assert_eq!(i["template"]["content"], "Nội dung cũ");
        assert_eq!(i["template"]["targets"][0]["caption"], "Cũ 3");
        assert!(i["template"]["targets"][0]["options"].get("first_comment").is_none());
        assert!(i["template"].get("utm").is_none());
        assert_eq!(i["template"]["targets"].as_array().map(Vec::len), Some(2));

        let other = recurrence_patch(&json!({ "account_ids": [4], "captions": [{ "account_id": 9 }] })).unwrap();
        assert!(recurrence_input_from_patch(&cur, &other).is_err());
        let narrow = recurrence_patch(&json!({ "account_ids": [4] })).unwrap();
        let n = recurrence_input_from_patch(&cur, &narrow).unwrap();
        assert_eq!(n["template"]["targets"].as_array().map(Vec::len), Some(1));
        assert_eq!(n["template"]["utm"]["campaign"], "x");
    }

    #[test]
    fn chi_tiet_lich_lap_va_ket_qua() {
        let p = json!({
            "title": "Chào tuần", "startsOn": "2026-12-01", "endsOn": null, "maxCount": 5,
            "rule": { "freq": "daily", "interval": 1, "time": "09:00" },
            "times": ["2026-12-01T02:00:00Z", "2026-12-02T02:00:00Z"],
            "validated": {
                "content": "Hi",
                "targets": [{ "account_name": "Trang A", "network": "facebook", "caption": null, "options": { "first_comment": "bl", "utm": { "campaign": "w" } } }],
                "media": [{ "type": "image" }],
            },
        });
        let d = recurring_details(&p);
        let labels: Vec<&str> = d.iter().filter_map(|x| x["label"].as_str()).collect();
        assert_eq!(
            labels,
            [
                "Tên",
                "Lặp lại",
                "Bắt đầu",
                "Kết thúc",
                "3 lần đăng tới",
                "Kênh",
                "Nội dung",
                "Bình luận đầu tiên — Trang A",
                "UTM",
                "Tệp đính kèm"
            ]
        );
        assert_eq!(d[3]["value"], "sau 5 lần đăng");

        let r = json!({ "id": 7, "title": "T", "active": true, "rule": { "freq": "daily", "interval": 1, "time": "09:00" },
            "next_times": ["2026-12-01T02:00:00Z"], "last_error": "kênh lỗi",
            "posts": [{ "id": 11, "status": "published" }, { "id": 12, "status": "scheduled" }] });
        let out = recurrence_result(&r, true);
        assert_eq!(out["status"], "active");
        assert_eq!(out["upcoming_post_id"], 12);
        assert_eq!(out["error"], "kênh lỗi");
        assert_eq!(out["next_times"][0], "09:00 Thứ Ba 01/12/2026 (giờ Việt Nam)");
    }
}
