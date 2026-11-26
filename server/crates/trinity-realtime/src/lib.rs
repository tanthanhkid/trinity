//! Socket.IO tương thích cho `/notif-ws` (K33, docs/rust/PLAN.md mục 4.10, quyết định R006).
//!
//! Giữ nguyên giao thức của `NotificationsGateway` (Node): path `/notif-ws`, namespace `/notifications/ws`, JWT ở
//! `handshake.auth.token` (không token / sai ⇒ máy chủ ngắt), room `user_<id>` (công ty 1) hoặc `c<cid>:user_<id>`, hai sự
//! kiện `notification:new` và `notification:count`. Web không phải sửa.
//!
//! Chuông giữa hai tiến trình đi qua `NOTIFY trinity_sync` kind `bell` (payload chỉ mang khoá `u` = người nhận,
//! `n` = id `notification_logs`): [`spawn_bell_listener`] đọc nội dung từ DB rồi đẩy tới socket của tiến trình này, giống
//! `SubscribersService.onRemoteBell` của Node. Chiều ngược lại: thông báo tạo ở Rust gọi `trinity_db::outbox::create_notification`
//! (phát `NOTIFY`) và [`NotifSocket::push_local`] cho socket cục bộ; Node giữ socket nhận qua kênh.

use std::sync::Arc;

use serde::Serialize;
use socketioxide::SocketIo;
use socketioxide::extract::{Data, SocketRef};
use socketioxide::layer::SocketIoLayer;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use trinity_db::sync::{Envelope, SyncEvent};
use trinity_db::{CompanyRef, Db};

pub const SOCKET_PATH: &str = "/notif-ws";
pub const NAMESPACE: &str = "/notifications/ws";
/// Nhóm `event_type` thuộc badge "tin nhắn & đề cập" (khớp `event-category.helper.ts` của Node và web).
pub const MESSAGE_EVENT_TYPES: [&str; 2] = ["chat.tag", "internal.message"];

/// Tên room của một user. User id trùng giữa các công ty nên room mang công ty; công ty 1 giữ tên cũ.
pub fn user_room(company: i64, user: i64) -> String {
    if company == 1 {
        format!("user_{user}")
    } else {
        format!("c{company}:user_{user}")
    }
}

/// Payload `notification:new` (bỏ khoá khi `None` như `JSON.stringify` bỏ `undefined`; `action_url` luôn có, `null` được).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotificationPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i32>,
    pub title: String,
    pub body: String,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    pub action_url: Option<String>,
    pub is_read: bool,
    pub created_at: String,
}

/// Payload `notification:count`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UnreadCounts {
    pub count: i64,
    pub bell_count: i64,
    pub message_count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RealtimeConfig<'a> {
    pub jwt_secret: &'a str,
    /// `MULTI_TENANT=true`; tắt ⇒ mọi phiên thuộc công ty 1 dù token mang `cid` (như Node).
    pub multi_tenant: bool,
}

/// Cổng phát tới socket của tiến trình này. Rẻ để `clone`.
#[derive(Clone)]
pub struct NotifSocket {
    io: SocketIo,
}

impl NotifSocket {
    /// Dựng layer (gắn vào router bằng `.layer(layer)`) và cổng phát.
    pub fn new(cfg: RealtimeConfig<'_>) -> (SocketIoLayer, Self) {
        let (layer, io) = SocketIo::builder().req_path(SOCKET_PATH).build_layer();
        let secret: Arc<str> = Arc::from(cfg.jwt_secret);
        let multi = cfg.multi_tenant;
        io.ns(NAMESPACE, move |s: SocketRef, Data(auth): Data<serde_json::Value>| {
            let secret = Arc::clone(&secret);
            async move {
                match authenticate(&auth, &secret, multi) {
                    Some((company, user)) => {
                        s.join(user_room(company, user));
                        tracing::info!(user, company, "WS connected");
                    }
                    None => {
                        // Như `client.disconnect()` của Nest: client nhận `io server disconnect`.
                        tracing::warn!("WS connection rejected");
                        s.disconnect().ok();
                    }
                }
            }
        });
        (layer, Self { io })
    }

    /// Phát `notification:new` tới mọi socket của user trong công ty (rõ ràng, không có ngữ cảnh ngầm).
    pub async fn send_to_user(&self, company: i64, user: i64, payload: &NotificationPayload) {
        if let Some(ns) = self.io.of(NAMESPACE) {
            ns.to(user_room(company, user))
                .emit("notification:new", payload)
                .await
                .ok();
        }
    }

    pub async fn emit_unread(&self, company: i64, user: i64, counts: &UnreadCounts) {
        if let Some(ns) = self.io.of(NAMESPACE) {
            ns.to(user_room(company, user))
                .emit("notification:count", counts)
                .await
                .ok();
        }
    }

    /// Đẩy một thông báo vừa tạo ở tiến trình này: `notification:new` rồi số chưa đọc đọc lại từ DB.
    pub async fn push_local(&self, db: &Db, company: i64, user: i64, payload: &NotificationPayload) {
        self.send_to_user(company, user, payload).await;
        self.refresh_unread(db, company, user).await;
    }

    pub async fn refresh_unread(&self, db: &Db, company: i64, user: i64) {
        match unread_counts(db, company, user).await {
            Ok(c) => self.emit_unread(company, user, &c).await,
            Err(e) => tracing::warn!(user, company, error = %e, "đọc số chưa đọc lỗi"),
        }
    }
}

/// Kiểm JWT ở handshake: trả `(công ty, user)`; `None` ⇒ ngắt. Cùng luật gateway Node: chỉ kiểm chữ ký + hạn.
fn authenticate(auth: &serde_json::Value, secret: &str, multi_tenant: bool) -> Option<(i64, i64)> {
    let token = auth.get("token")?.as_str().filter(|t| !t.is_empty())?;
    let claims = trinity_auth::jwt::verify(token, secret).ok()?;
    // Node: `cid` phải là số nguyên > 0, ngược lại công ty 1; một công ty ⇒ luôn công ty 1.
    let company = if multi_tenant && claims.company_id() > 0 {
        claims.company_id()
    } else {
        1
    };
    Some((company, claims.sub))
}

/// Số chưa đọc của user (cùng 3 con số `emitUnreadCounts` của Node). `event_type` NULL thuộc nhóm thông báo chung.
pub async fn unread_counts(db: &Db, company: i64, user: i64) -> Result<UnreadCounts, String> {
    let c = CompanyRef::new(company).map_err(|e| e.to_string())?;
    let mut conn = db
        .tenant(c)
        .await
        .map_err(|e| e.to_string())?
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let row: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE event_type IS NULL OR event_type <> ALL($2)), \
                count(*) FILTER (WHERE event_type = ANY($2)) \
         FROM notification_logs WHERE recipient_id = $1 AND is_read = false",
    )
    .bind(i32::try_from(user).map_err(|e| e.to_string())?)
    .bind(MESSAGE_EVENT_TYPES.map(String::from).to_vec())
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(UnreadCounts {
        count: row.0 + row.1,
        bell_count: row.0,
        message_count: row.1,
    })
}

#[derive(sqlx::FromRow)]
struct LogRow {
    id: i32,
    recipient_id: i32,
    title: Option<String>,
    body: Option<String>,
    channel: String,
    event_type: Option<String>,
    action_url: Option<String>,
    is_read: bool,
    created_at: String,
}

/// Xử lý một tin `bell` của tiến trình khác: đọc nội dung từ DB, phát `notification:new` cho từng dòng rồi số chưa đọc
/// của mọi người nhận (cả `u` lẫn người nhận của các dòng `n`).
pub async fn handle_bell(socket: &NotifSocket, db: &Db, env: &Envelope) {
    let ids = int_array(env.fields.get("n"));
    let mut users: Vec<i64> = int_array(env.fields.get("u"));
    let company = if env.company > 0 { env.company } else { 1 };
    if !ids.is_empty() {
        match load_logs(db, company, &ids).await {
            Ok(rows) => {
                for r in rows {
                    let user = i64::from(r.recipient_id);
                    if !users.contains(&user) {
                        users.push(user);
                    }
                    let p = NotificationPayload {
                        id: Some(r.id),
                        title: r.title.unwrap_or_default(),
                        body: r.body.unwrap_or_default(),
                        channel: r.channel,
                        event_type: r.event_type,
                        action_url: r.action_url,
                        is_read: r.is_read,
                        created_at: r.created_at,
                    };
                    socket.send_to_user(company, user, &p).await;
                }
            }
            Err(e) => tracing::warn!(company, error = %e, "sync bell: đọc notification_logs lỗi"),
        }
    }
    for u in users {
        socket.refresh_unread(db, company, u).await;
    }
}

async fn load_logs(db: &Db, company: i64, ids: &[i64]) -> Result<Vec<LogRow>, String> {
    let c = CompanyRef::new(company).map_err(|e| e.to_string())?;
    let mut conn = db
        .tenant(c)
        .await
        .map_err(|e| e.to_string())?
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let ids: Vec<i32> = ids.iter().filter_map(|i| i32::try_from(*i).ok()).collect();
    sqlx::query_as::<_, LogRow>(
        "SELECT id, recipient_id, title, body, channel, event_type, action_url, is_read, \
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at \
         FROM notification_logs WHERE id = ANY($1) ORDER BY id",
    )
    .bind(ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())
}

fn int_array(v: Option<&serde_json::Value>) -> Vec<i64> {
    v.and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
        .unwrap_or_default()
}

/// Nghe `trinity_sync` (kênh từ `trinity_db::sync::listen_from_env`) và đẩy chuông tới socket. Dừng khi kênh đóng.
pub fn spawn_bell_listener(
    socket: NotifSocket,
    db: Db,
    mut rx: mpsc::Receiver<SyncEvent>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            // `Resync` (mất kết nối): không giữ cache nào ở đây; số chưa đọc đọc lại từ DB ở lần phát kế tiếp.
            if let SyncEvent::Message(env) = ev
                && env.kind == "bell"
            {
                handle_bell(&socket, &db, &env).await;
            }
        }
    })
}

/// `CORS_ORIGIN` như `buildWsCorsOrigin` của Node: danh sách phân tách bằng dấu phẩy, `*.example.com` cho mọi subdomain
/// một cấp, `localhost` luôn được phép. Chưa đặt (hoặc rỗng) ⇒ `None` (không thêm header CORS; dùng same-origin).
pub fn cors_layer(configured: Option<&str>) -> Option<CorsLayer> {
    let entries: Vec<String> = configured?
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    Some(
        CorsLayer::new()
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
            .allow_origin(AllowOrigin::predicate(move |origin, _| {
                origin.to_str().is_ok_and(|o| origin_allowed(o, &entries))
            })),
    )
}

pub fn origin_allowed(origin: &str, entries: &[String]) -> bool {
    if is_localhost(origin) {
        return true;
    }
    entries.iter().any(|e| {
        if e == origin {
            return true;
        }
        // `(https?://)?*.host`: scheme tuỳ chọn, đúng một nhãn `[a-z0-9-]+` trước host.
        let (scheme, rest) = match e.strip_prefix("https://") {
            Some(r) => (Some("https://"), r),
            None => match e.strip_prefix("http://") {
                Some(r) => (Some("http://"), r),
                None => (None, e.as_str()),
            },
        };
        let Some(host) = rest.strip_prefix("*.") else {
            return false;
        };
        let candidates: &[&str] = match scheme {
            Some(s) => &[s][..],
            None => &["https://", "http://"][..],
        };
        candidates.iter().any(|s| {
            origin
                .strip_prefix(s)
                .and_then(|o| o.strip_suffix(host))
                .and_then(|l| l.strip_suffix('.'))
                .is_some_and(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        })
    })
}

fn is_localhost(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    match rest.strip_prefix("localhost") {
        Some("") => true,
        Some(p) => p
            .strip_prefix(':')
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_names_match_node() {
        assert_eq!(user_room(1, 7), "user_7");
        assert_eq!(user_room(2, 7), "c2:user_7");
    }

    #[test]
    fn payload_omits_undefined_like_json_stringify() {
        let p = NotificationPayload {
            id: None,
            title: "t".into(),
            body: "b".into(),
            channel: "in_app".into(),
            event_type: None,
            action_url: None,
            is_read: false,
            created_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(!s.contains("\"id\"") && !s.contains("event_type"));
        assert!(s.contains("\"action_url\":null"));
    }

    #[test]
    fn origin_rules() {
        let e = vec!["https://crm.example.com".to_owned(), "*.corp.vn".to_owned()];
        assert!(origin_allowed("http://localhost:3000", &e));
        assert!(origin_allowed("https://crm.example.com", &e));
        assert!(origin_allowed("https://a-b.corp.vn", &e));
        assert!(!origin_allowed("https://a.b.corp.vn", &e));
        assert!(!origin_allowed("https://evilcorp.vn", &e));
        assert!(!origin_allowed("http://localhost.evil.com", &e));
        assert!(cors_layer(None).is_none() && cors_layer(Some(" , ")).is_none());
    }

    #[test]
    fn auth_needs_valid_token() {
        assert!(authenticate(&serde_json::json!({}), "s", true).is_none());
        assert!(authenticate(&serde_json::json!({"token": ""}), "s", true).is_none());
        assert!(authenticate(&serde_json::json!({"token": "bad"}), "s", true).is_none());
    }
}
