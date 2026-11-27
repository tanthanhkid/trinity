//! Webhook Zalo OA (`zalo-oa-webhook.service.ts`). Luôn kiểm chữ ký TRƯỚC (sai/thiếu ⇒ 401, không phân biệt lý do). Sau đó trả
//! 200 cho mọi sự kiện (kể cả loại chưa hỗ trợ) để Zalo không gửi lại; lỗi hệ thống (DB) trả lỗi để Zalo gửi lại, vì tin được
//! khử trùng theo `msg_id`. Cờ tổ chức `zalo_oa` tắt ⇒ nhận 200 nhưng bỏ qua. Nhiều công ty: chạy dưới công ty đã nối OA này; OA
//! không thuộc công ty nào ⇒ bỏ qua (KHÔNG rơi về công ty 1).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use trinity_db::platform::RouteKind;
use trinity_kernel::error::{AppError, HttpError};

use crate::config::zalo_oa_config;
use crate::contacts::{self, LinkInput};
use crate::signature::verify_zalo_signature;
use crate::threads::{self, RecordMessage};
use crate::token::{Ctx, acquire, get_access_token, platform_db};

type Obj = Map<String, Value>;

fn obj(v: Option<&Value>) -> Obj {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

fn str_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn name_of(ev: &Obj) -> String {
    str_of(ev.get("event_name")).unwrap_or_default()
}

/// Sự kiện khách gửi (OA nhận): `user_send_text`, `_image`, `_link`, `_location`, `_sticker`, `_gif`, `_audio`, `_video`, `_file`.
fn is_inbound(name: &str) -> bool {
    name.starts_with("user_send_")
}

/// Tin do chính OA gửi đi từ app/web Zalo (đồng bộ vào hộp thư): `oa_send_text`, `oa_send_image`…
fn is_outbound(name: &str) -> bool {
    name.starts_with("oa_send_")
}

/// OA nhận sự kiện: tin khách gửi ⇒ `recipient`; tin OA gửi ⇒ `sender`; `follow`/khác ⇒ `oa.id` / `oa_id` / `recipient`.
pub fn zalo_event_oa_id(ev: &Obj) -> Option<String> {
    let name = name_of(ev);
    if is_inbound(&name) {
        return str_of(obj(ev.get("recipient")).get("id"));
    }
    if is_outbound(&name) {
        return str_of(obj(ev.get("sender")).get("id"));
    }
    str_of(obj(ev.get("oa")).get("id"))
        .or_else(|| str_of(ev.get("oa_id")))
        .or_else(|| str_of(obj(ev.get("recipient")).get("id")))
}

/// Kết quả xử lý: luôn `ok`; `handled` cho biết có ghi gì không.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    pub ok: bool,
    pub handled: bool,
}

const IGNORED: Outcome = Outcome {
    ok: true,
    handled: false,
};

/// `POST /zalo-oa/webhook`. `ctx.company` là công ty mặc định cho bản cài một công ty; nhiều công ty thì tìm theo OA.
pub async fn receive(
    ctx: &Ctx<'_>,
    raw: Option<&[u8]>,
    signature: Option<&str>,
    now_ms: i64,
) -> Result<Outcome, AppError> {
    let cfg = zalo_oa_config(ctx.env);
    if !verify_zalo_signature(cfg.app_id.as_deref(), cfg.webhook_secret.as_deref(), raw, signature) {
        return Err(HttpError::unauthorized("Chữ ký không hợp lệ").into());
    }
    // Chữ ký đã kiểm trên đúng chuỗi byte này nên đọc lại được; thân không phải object thì không có gì để xử lý.
    let ev = obj(serde_json::from_slice::<Value>(raw.unwrap_or_default()).ok().as_ref());
    if !ctx.platform.multi_tenant() {
        return handle(ctx, &ev, now_ms).await;
    }
    let Some(oa_id) = zalo_event_oa_id(&ev) else {
        return Ok(IGNORED);
    };
    let Some(cid) = ctx
        .platform
        .company_for_route(RouteKind::ZaloOa, &oa_id)
        .await
        .map_err(platform_db)?
    else {
        return Ok(IGNORED);
    };
    let Some(company) = ctx.platform.active_company(i64::from(cid)).await.map_err(platform_db)? else {
        return Ok(IGNORED);
    };
    handle(&Ctx { company, ..*ctx }, &ev, now_ms).await
}

/// Cờ/gói `zalo_oa` của công ty (đường không qua guard): lỗi đọc ⇒ coi như bật (fail-open như bản Node).
async fn feature_enabled(ctx: &Ctx<'_>) -> bool {
    let Ok(mut c) = acquire(ctx).await else { return true };
    match mod_settings::features::get(
        &mut c,
        mod_settings::Ctx {
            company_id: Some(ctx.company.id()),
        },
    )
    .await
    {
        Ok(f) => !f.0.iter().any(|(k, v)| *k == "zalo_oa" && *v == Some(false)),
        Err(_) => true,
    }
}

async fn handle(ctx: &Ctx<'_>, ev: &Obj, now_ms: i64) -> Result<Outcome, AppError> {
    if !feature_enabled(ctx).await {
        return Ok(IGNORED);
    }
    let name = name_of(ev);
    let handled = if is_inbound(&name) {
        on_message(ctx, ev, "in", now_ms).await?
    } else if is_outbound(&name) {
        on_message(ctx, ev, "out", now_ms).await?
    } else if name == "follow" {
        on_follow(ctx, ev, now_ms).await?
    } else {
        false
    };
    Ok(Outcome { ok: true, handled })
}

async fn on_follow(ctx: &Ctx<'_>, ev: &Obj, now_ms: i64) -> Result<bool, AppError> {
    let user_id = str_of(obj(ev.get("follower")).get("id")).or_else(|| str_of(obj(ev.get("sender")).get("id")));
    let oa_id = str_of(obj(ev.get("oa")).get("id")).or_else(|| str_of(obj(ev.get("recipient")).get("id")));
    let (Some(user_id), Some(oa_id)) = (user_id, oa_id) else {
        return Ok(false);
    };
    let t = threads::upsert_thread(&mut *acquire(ctx).await?, &oa_id, &user_id).await?;
    enrich(ctx, t.id, &user_id, &oa_id, now_ms).await;
    Ok(true)
}

/// `new Date(Number(ev.timestamp))`: mili giây (số hoặc chuỗi số); không đọc được ⇒ `None` (dùng giờ hiện tại).
fn event_time(ev: &Obj) -> Option<DateTime<Utc>> {
    let ms = match ev.get("timestamp")? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !ms.is_finite() {
        return None;
    }
    DateTime::from_timestamp_millis(ms as i64)
}

async fn on_message(ctx: &Ctx<'_>, ev: &Obj, dir: &'static str, now_ms: i64) -> Result<bool, AppError> {
    let sender = str_of(obj(ev.get("sender")).get("id"));
    let recipient = str_of(obj(ev.get("recipient")).get("id"));
    let (user_id, oa_id) = if dir == "in" {
        (sender, recipient)
    } else {
        (recipient, sender)
    };
    let (Some(user_id), Some(oa_id)) = (user_id, oa_id) else {
        return Ok(false);
    };
    let msg = obj(ev.get("message"));
    let existed = threads::upsert_thread(&mut *acquire(ctx).await?, &oa_id, &user_id).await?;
    let is_new = existed.last_message_at.is_none() && existed.contact_id.is_none() && existed.display_name.is_none();
    let attachments = msg
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = str_of(msg.get("text"));
    let msg_id = str_of(msg.get("msg_id"));
    let row = threads::record(
        &mut *acquire(ctx).await?,
        &RecordMessage {
            thread_id: existed.id,
            direction: dir,
            kind: if text.is_some() { "text" } else { "attachment" },
            msg_id: msg_id.as_deref(),
            text: text.as_deref(),
            payload: if attachments.is_empty() {
                json!({})
            } else {
                json!({ "attachments": attachments })
            },
            status: if dir == "in" { "received" } else { "sent" },
            error: None,
            sent_by: None,
            at: event_time(ev),
        },
    )
    .await?;
    if row.is_some() && is_new {
        enrich(ctx, existed.id, &user_id, &oa_id, now_ms).await;
    }
    Ok(row.is_some())
}

/// Lấy hồ sơ (tên, ảnh, SĐT nếu khách chia sẻ) và ghép/tạo khách. Best-effort: lỗi chỉ ghi log, không làm hỏng việc nhận tin.
/// Gọi Zalo (HTTP) xảy ra khi KHÔNG giữ kết nối (trừ bước làm mới token, xem `token.rs`).
async fn enrich(ctx: &Ctx<'_>, thread_id: i32, user_id: &str, oa_id: &str, now_ms: i64) {
    let r: Result<(), AppError> = async {
        let tok = get_access_token(ctx, now_ms).await?;
        let p = ctx
            .client
            .get_profile(&tok.token, user_id)
            .await
            .map_err(|e| HttpError::new(502, e.message))?;
        let mut c = acquire(ctx).await?;
        let contact_id = contacts::find_or_create(
            &mut c,
            &LinkInput {
                zalo_user_id: user_id,
                phone: p.phone.as_deref(),
                name: p.display_name.as_deref(),
                owner_user_id: tok.connected_by,
            },
        )
        .await?;
        threads::update_profile(
            &mut c,
            thread_id,
            p.display_name.as_deref(),
            p.avatar.as_deref(),
            p.phone.as_deref(),
            contact_id,
        )
        .await
    }
    .await;
    if let Err(e) = r {
        tracing::warn!("Không lấy được hồ sơ Zalo user (oa={oa_id}): {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn oa_cua_su_kien() {
        assert_eq!(
            zalo_event_oa_id(&ev(
                json!({ "event_name": "user_send_text", "sender": { "id": "u" }, "recipient": { "id": "oa1" } })
            ))
            .as_deref(),
            Some("oa1")
        );
        assert_eq!(
            zalo_event_oa_id(&ev(
                json!({ "event_name": "oa_send_image", "sender": { "id": "oa2" }, "recipient": { "id": "u" } })
            ))
            .as_deref(),
            Some("oa2")
        );
        assert_eq!(
            zalo_event_oa_id(&ev(json!({ "event_name": "follow", "oa": { "id": "oa3" } }))).as_deref(),
            Some("oa3")
        );
        assert_eq!(
            zalo_event_oa_id(&ev(json!({ "event_name": "x", "oa_id": 4 }))).as_deref(),
            Some("4")
        );
        assert_eq!(
            zalo_event_oa_id(&ev(json!({ "event_name": "x", "recipient": { "id": "oa5" } }))).as_deref(),
            Some("oa5")
        );
        assert_eq!(zalo_event_oa_id(&ev(json!({}))), None);
    }

    #[test]
    fn thoi_gian_su_kien() {
        assert_eq!(
            event_time(&ev(json!({ "timestamp": 1_700_000_000_000_i64 }))).map(|t| t.timestamp()),
            Some(1_700_000_000)
        );
        assert_eq!(
            event_time(&ev(json!({ "timestamp": "1700000000000" }))).map(|t| t.timestamp()),
            Some(1_700_000_000)
        );
        assert!(event_time(&ev(json!({ "timestamp": "abc" }))).is_none() && event_time(&ev(json!({}))).is_none());
    }
}
