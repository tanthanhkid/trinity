//! Gửi tin tư vấn (≤ 48 giờ kể từ tin gần nhất của khách) và ZNS (`zalo-oa-messaging.service.ts`). Zalo không phải Meta nên
//! `ChannelGuard` chỉ áp khoá kênh (`OutboundScope::Other`); ZNS là tin chủ động nên còn tính vào hạn mức tin hàng loạt mỗi ngày
//! (giữ chỗ sau khi có token, hoàn lại nếu Zalo không nhận).
//!
//! Chưa có ở đây: trait `MessageChannel` dùng chung cho bot AI và bản tin (chưa có ở Rust).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use mod_channel_guard::{ChannelGuard, OutboundMode, OutboundScope, QuotaKind};
use serde_json::{Map, Value, json};
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::client::ZnsRequest;
use crate::config::{CONSULT_WINDOW_MS, to_zalo_phone, zalo_oa_config};
use crate::contacts::zalo_phone_variants;
use crate::errors::{Channel, ZaloApiError, describe_zalo_error};
use crate::len16;
use crate::threads::{self, RecordMessage};
use crate::token::{Ctx, acquire, get_access_token, get_connection, mark_needs_reauth};

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Trong cửa sổ 48 giờ kể từ tin gần nhất của khách?
pub fn in_consult_window(last_inbound_at: Option<DateTime<Utc>>, now_ms: i64) -> bool {
    last_inbound_at.is_some_and(|t| now_ms - t.timestamp_millis() <= CONSULT_WINDOW_MS)
}

/// Ghi tin lỗi (nếu có hội thoại), đánh dấu cần kết nối lại khi lỗi token, đổi sang 400 tiếng Việt. Nguyên văn lỗi Zalo chỉ vào log
/// (không chứa token); người dùng thấy câu đã dịch.
async fn fail(
    ctx: &Ctx<'_>,
    err: &ZaloApiError,
    channel: Channel,
    thread_id: Option<i32>,
    text: Option<&str>,
    sent_by: Option<i32>,
) -> AppError {
    tracing::warn!(
        "Zalo từ chối {} (mã {}{}): {}",
        if channel == Channel::Zns {
            "ZNS"
        } else {
            "tin tư vấn"
        },
        err.code,
        err.http_status.map_or_else(String::new, |s| format!(", HTTP {s}")),
        crate::utf16_prefix(&err.message, 300)
    );
    let msg = describe_zalo_error(err, channel);
    if err.is_auth_error()
        && let Ok(mut c) = acquire(ctx).await
        && let Ok(Some(conn)) = get_connection(&mut c).await
    {
        drop(c);
        let _ = mark_needs_reauth(ctx, &conn.oa_id, &format!("Zalo báo token lỗi (mã {})", err.code)).await;
    }
    if let Some(id) = thread_id
        && let Ok(mut c) = acquire(ctx).await
    {
        let kind = if channel == Channel::Zns { "zns" } else { "text" };
        let r = threads::record(
            &mut c,
            &RecordMessage {
                thread_id: id,
                direction: "out",
                kind,
                msg_id: None,
                text,
                payload: json!({}),
                status: "failed",
                error: Some(&msg),
                sent_by,
                at: None,
            },
        )
        .await;
        if let Err(e) = r {
            tracing::warn!("Không ghi được tin Zalo lỗi vào lịch sử: {e}");
        }
    }
    HttpError::bad_request(msg).into()
}

/// `POST /zalo-oa/threads/:id/messages`: tin tư vấn. Quá 48 giờ ⇒ 400 (dùng ZNS); Zalo đã nhận mà ghi lịch sử lỗi ⇒ vẫn thành công
/// (người dùng gửi lại sẽ làm khách nhận hai lần).
pub async fn send_text(
    ctx: &Ctx<'_>,
    guard: Option<&ChannelGuard>,
    thread_id: i32,
    text: &str,
    sent_by: Option<i32>,
    now_ms: i64,
) -> Result<Option<String>, AppError> {
    if let Some(g) = guard {
        g.assert_outbound(ctx.company, OutboundMode::Manual, OutboundScope::Other)
            .await?;
    }
    let body = text.trim();
    if body.is_empty() || len16(body) > 2000 {
        return Err(HttpError::bad_request("Nội dung tin phải từ 1 đến 2000 ký tự").into());
    }
    let thread = threads::get(&mut *acquire(ctx).await?, thread_id).await?;
    if !in_consult_window(thread.last_inbound_at.map(|t| t.0), now_ms) {
        return Err(HttpError::bad_request(
            "Đã quá 48 giờ kể từ tin gần nhất của khách — Zalo không cho gửi tin tư vấn. Hãy dùng ZNS.",
        )
        .into());
    }
    let tok = get_access_token(ctx, now_ms).await?;
    let msg_id = match ctx.client.send_text(&tok.token, &thread.zalo_user_id, body).await {
        Ok(id) => id,
        Err(e) => return Err(fail(ctx, &e, Channel::Consult, Some(thread_id), Some(body), sent_by).await),
    };
    let rec = async {
        let mut c = acquire(ctx).await?;
        threads::record(
            &mut c,
            &RecordMessage {
                thread_id,
                direction: "out",
                kind: "text",
                msg_id: msg_id.as_deref(),
                text: Some(body),
                payload: json!({}),
                status: "sent",
                error: None,
                sent_by,
                at: None,
            },
        )
        .await
    }
    .await;
    if let Err(e) = rec {
        tracing::error!("Tin Zalo OA đã gửi nhưng không ghi được lịch sử: {e}");
    }
    Ok(msg_id)
}

/// Tham số `POST /zalo-oa/zns` đã kiểm.
#[derive(Debug, Clone)]
pub struct ZnsInput<'a> {
    pub phone: &'a str,
    pub template_id: &'a str,
    pub template_data: &'a Map<String, Value>,
    pub tracking_id: Option<&'a str>,
    pub sent_by: Option<i32>,
}

/// `POST /zalo-oa/zns` ⇒ `{ message_id, quota }`. SĐT không phải SĐT Việt Nam ⇒ 400; hết hạn mức ngày hoặc khoá kênh ⇒ lỗi của
/// `ChannelGuard`; Zalo không nhận ⇒ hoàn hạn mức đã giữ.
pub async fn send_zns(
    ctx: &Ctx<'_>,
    guard: Option<&ChannelGuard>,
    p: &ZnsInput<'_>,
    now_ms: i64,
) -> Result<Value, AppError> {
    let Some(phone) = to_zalo_phone(p.phone) else {
        return Err(HttpError::bad_request("Số điện thoại không hợp lệ (cần SĐT Việt Nam)").into());
    };
    let tok = get_access_token(ctx, now_ms).await?;
    let thread_id: Option<i32> =
        sqlx::query_scalar("SELECT id FROM zalo_oa_threads WHERE phone = ANY($1) ORDER BY id LIMIT 1")
            .bind(zalo_phone_variants(&phone))
            .fetch_optional(&mut *acquire(ctx).await?)
            .await
            .map_err(db)?;
    // ZNS là tin gửi chủ động: tính vào hạn mức tin hàng loạt mỗi ngày (khoá kênh chặn; tạm dừng do Graph KHÔNG áp cho Zalo).
    let bucket = match guard {
        Some(g) => {
            g.reserve(ctx.company, QuotaKind::BulkMessage, 1, OutboundScope::Other)
                .await?
        }
        None => None,
    };
    let req = ZnsRequest {
        phone: &phone,
        template_id: p.template_id,
        template_data: p.template_data,
        tracking_id: p.tracking_id,
        mode: zalo_oa_config(ctx.env).zns_mode,
    };
    let r = match ctx.client.send_zns(&tok.token, &req).await {
        Ok(r) => r,
        Err(e) => {
            if let Some(g) = guard {
                g.refund(ctx.company, QuotaKind::BulkMessage, 1, bucket).await;
            }
            return Err(fail(ctx, &e, Channel::Zns, thread_id, None, p.sent_by).await);
        }
    };
    if let Some(id) = thread_id {
        let rec = async {
            let mut c = acquire(ctx).await?;
            threads::record(
                &mut c,
                &RecordMessage {
                    thread_id: id,
                    direction: "out",
                    kind: "zns",
                    msg_id: r.msg_id.as_deref(),
                    text: None,
                    payload: json!({ "template_id": p.template_id }),
                    status: "sent",
                    error: None,
                    sent_by: p.sent_by,
                    at: None,
                },
            )
            .await
        }
        .await;
        if let Err(e) = rec {
            tracing::error!("ZNS đã gửi nhưng không ghi được lịch sử: {e}");
        }
    }
    Ok(json!({ "message_id": r.msg_id, "quota": r.quota }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cua_so_tu_van_48_gio() {
        let now = 1_800_000_000_000_i64;
        let at = |ms: i64| DateTime::from_timestamp_millis(ms);
        assert!(in_consult_window(at(now - 47 * 3_600_000), now));
        assert!(
            in_consult_window(at(now - CONSULT_WINDOW_MS), now),
            "đúng 48 giờ vẫn được"
        );
        assert!(!in_consult_window(at(now - CONSULT_WINDOW_MS - 1), now));
        assert!(!in_consult_window(None, now));
    }
}
