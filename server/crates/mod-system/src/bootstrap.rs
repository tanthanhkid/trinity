//! `GET /api/v1/bootstrap`: gộp các lời gọi layout/app-shell mà web phát riêng lẻ mỗi lần nạp trang thành MỘT lượt.
//!
//! Không viết lại logic: mỗi phần là một yêu cầu nội bộ `GET` đi qua CHÍNH router đã mount (cùng xác thực, cùng kiểm quyền,
//! cùng handler), chạy song song bằng `JoinSet`. Phần nào không 2xx hoặc không phải JSON ⇒ `null` cho phần đó, không làm hỏng
//! cả phản hồi (người dùng thiếu quyền một phần cũng nhận phần còn lại). Router được nạp vào [`BootstrapSlot`] SAU khi
//! `trinity-bin` dựng xong, nên route này chỉ chạy đúng khi binary đã gắn slot.
//!
//! Hai nhóm: luôn có [`LAYOUT_PARTS`]; thêm [`DASHBOARD_PARTS`] khi có `?include=dashboard`
//! (kèm `cc_from`/`cc_to` dạng `YYYY-MM-DD` thì thêm Trung tâm điều hành cho đúng khoảng đó).

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use tower::ServiceExt;
use trinity_http::edge::client_ip::ClientIp;

/// Trần thân phản hồi của một phần (tránh một phần phình làm nghẽn bộ nhớ).
const PART_LIMIT: usize = 4 * 1024 * 1024;

/// Phần của layout/app-shell: khoá trong phản hồi → đường nội bộ.
pub const LAYOUT_PARTS: &[(&str, &str)] = &[
    ("me", "/api/v1/auth/me"),
    ("pinned_menu", "/api/v1/users/me/pinned-menu"),
    ("client_ip_alerts", "/api/v1/settings/client-ip/alerts"),
    ("channel_guard_alerts", "/api/v1/settings/channel-guard/alerts"),
    ("telemetry_identity", "/api/v1/telemetry/identity"),
    ("unread_profile", "/api/v1/notifications/unread-count?category=profile"),
    ("unread_message", "/api/v1/notifications/unread-count?category=message"),
    // Đã áp gói dịch vụ: đây cũng là nguồn "gói" của layout.
    ("org_features", "/api/v1/settings/org-features"),
    ("setup_status", "/api/v1/setup/status"),
    ("site_config", "/api/v1/site-config"),
];

/// Phần của trang Tổng quan (bộ lọc rỗng, đúng lời gọi mặc định của web).
pub const DASHBOARD_PARTS: &[(&str, &str)] = &[
    ("dashboard_overview", "/api/v1/reports/dashboard-overview"),
    ("dashboard_tasks", "/api/v1/reports/dashboard-tasks"),
    ("dashboard_channels", "/api/v1/reports/dashboard-channels"),
    ("dashboard_filter_roster", "/api/v1/reports/dashboard-filter-roster"),
    ("ai_actions_home", "/api/v1/integrations/ai-actions?limit=50"),
    (
        "ai_actions_pending",
        "/api/v1/integrations/ai-actions?limit=5&status=pending",
    ),
    ("notifications_home_unread", "/api/v1/notifications?read=false&limit=20"),
];

/// Ô chứa router đã dựng xong; `serve` gắn vào một lần.
pub type BootstrapSlot = Arc<OnceLock<Router>>;

pub fn new_slot() -> BootstrapSlot {
    Arc::new(OnceLock::new())
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Danh sách (khoá, đường) cần gọi theo query của yêu cầu.
fn plan(query: Option<&str>) -> Vec<(String, String)> {
    let mut include_dashboard = false;
    let (mut from, mut to) = (None, None);
    for pair in query.unwrap_or("").split('&') {
        match pair.split_once('=') {
            Some(("include", v)) => include_dashboard = v.split(',').any(|x| x == "dashboard"),
            Some(("cc_from", v)) if is_date(v) => from = Some(v.to_owned()),
            Some(("cc_to", v)) if is_date(v) => to = Some(v.to_owned()),
            _ => {}
        }
    }
    let mut v: Vec<(String, String)> = LAYOUT_PARTS.iter().map(|(k, p)| ((*k).into(), (*p).into())).collect();
    if include_dashboard {
        v.extend(DASHBOARD_PARTS.iter().map(|(k, p)| ((*k).into(), (*p).into())));
        if let (Some(f), Some(t)) = (from, to) {
            v.push((
                "dashboard_command_center".into(),
                format!("/api/v1/reports/dashboard-command-center?date_from={f}&date_to={t}"),
            ));
        }
    }
    v
}

/// Gọi một phần qua router; mọi lỗi ⇒ `None`.
async fn fetch_part(
    router: Router,
    path: String,
    headers: header::HeaderMap,
    client: Option<ClientIp>,
) -> Option<Value> {
    let mut req = Request::builder()
        .method(Method::GET)
        .uri(&path)
        .body(Body::empty())
        .ok()?;
    for (name, value) in &headers {
        if matches!(
            name,
            &header::CONTENT_LENGTH | &header::CONTENT_TYPE | &header::TRANSFER_ENCODING | &header::CONNECTION
        ) {
            continue;
        }
        req.headers_mut().append(name.clone(), value.clone());
    }
    if let Some(c) = client {
        req.extensions_mut().insert(c);
    }
    let res = router.oneshot(req).await.ok()?;
    if !res.status().is_success() {
        tracing::debug!(path = %path, status = %res.status(), "bootstrap: phần lỗi, trả null");
        return None;
    }
    let bytes = axum::body::to_bytes(res.into_body(), PART_LIMIT).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Xử lý `GET /api/v1/bootstrap` (đã qua lớp xác thực của `ApiRouter`).
pub async fn handle(slot: BootstrapSlot, req: Request) -> Response {
    let Some(router) = slot.get().cloned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "bootstrap chưa sẵn sàng").into_response();
    };
    let parts = plan(req.uri().query());
    let headers = req.headers().clone();
    let client = req.extensions().get::<ClientIp>().cloned();
    let mut set = tokio::task::JoinSet::new();
    for (key, path) in parts {
        let (r, h, c) = (router.clone(), headers.clone(), client.clone());
        set.spawn(async move { (key, fetch_part(r, path, h, c).await) });
    }
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    while let Some(done) = set.join_next().await {
        if let Ok((k, v)) = done {
            out.insert(k, v.unwrap_or(Value::Null));
        }
    }
    let body: Map<String, Value> = out.into_iter().collect();
    let mut res = axum::Json(Value::Object(body)).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ke_hoach_mac_dinh_chi_co_layout() {
        let p = plan(None);
        assert_eq!(p.len(), LAYOUT_PARTS.len());
        assert!(p.iter().all(|(k, _)| !k.starts_with("dashboard")));
    }

    #[test]
    fn ke_hoach_dashboard_va_command_center() {
        let p = plan(Some("include=dashboard&cc_from=2026-11-21&cc_to=2026-11-27"));
        assert_eq!(p.len(), LAYOUT_PARTS.len() + DASHBOARD_PARTS.len() + 1);
        assert!(
            p.iter().any(|(k, path)| k == "dashboard_command_center"
                && path.ends_with("date_from=2026-11-21&date_to=2026-11-27"))
        );
        // Ngày sai dạng: bỏ command-center, không chèn chuỗi lạ vào đường nội bộ.
        let bad = plan(Some("include=dashboard&cc_from=x/../y&cc_to=2026-11-27"));
        assert!(bad.iter().all(|(k, _)| k != "dashboard_command_center"));
    }

    #[test]
    fn moi_duong_la_get_noi_bo_duoi_api_v1() {
        for (_, p) in LAYOUT_PARTS.iter().chain(DASHBOARD_PARTS) {
            assert!(p.starts_with("/api/v1/"), "{p}");
        }
    }

    #[tokio::test]
    async fn phan_loi_thanh_null_va_phan_con_lai_van_tra() {
        use axum::routing::get;
        let r = Router::new()
            .route(
                "/api/v1/site-config",
                get(|| async { axum::Json(serde_json::json!({"ds_v2": true})) }),
            )
            .route("/api/v1/auth/me", get(|| async { StatusCode::FORBIDDEN }));
        let slot = new_slot();
        slot.set(r).unwrap();
        let res = handle(slot, Request::get("/api/v1/bootstrap").body(Body::empty()).unwrap()).await;
        assert_eq!(res.status(), StatusCode::OK);
        let b: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap();
        assert_eq!(b["site_config"], serde_json::json!({"ds_v2": true}));
        assert!(b["me"].is_null());
        assert!(b["org_features"].is_null());
        assert_eq!(b.as_object().unwrap().len(), LAYOUT_PARTS.len());
    }

    #[tokio::test]
    async fn chua_gan_router_thi_503() {
        let res = handle(
            new_slot(),
            Request::get("/api/v1/bootstrap").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
