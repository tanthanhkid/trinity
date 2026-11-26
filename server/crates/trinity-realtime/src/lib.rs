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
use socketioxide::extract::{SocketRef, TryData};
use socketioxide::handler::ConnectHandler;
use socketioxide::layer::SocketIoLayer;
use tokio::sync::mpsc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use trinity_auth::Security;
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

#[derive(Clone)]
pub struct RealtimeConfig<'a> {
    pub jwt_secret: &'a str,
    /// `MULTI_TENANT=true`; tắt ⇒ mọi phiên thuộc công ty 1 dù token mang `cid` (như Node).
    pub multi_tenant: bool,
    /// Có ⇒ handshake từ chối `sid` đã bị phiên đăng nhập khác thay (cùng `isCurrentSession` của guard HTTP).
    pub security: Option<Arc<Security>>,
}

/// Cổng phát tới socket của tiến trình này. Rẻ để `clone`.
#[derive(Clone)]
pub struct NotifSocket {
    io: SocketIo,
    multi_tenant: bool,
}

impl NotifSocket {
    /// Dựng layer (gắn vào router bằng `.layer(layer)`) và cổng phát.
    pub fn new(cfg: RealtimeConfig<'_>) -> (SocketIoLayer, Self) {
        let (layer, io) = SocketIo::builder().req_path(SOCKET_PATH).build_layer();
        let secret: Arc<str> = Arc::from(cfg.jwt_secret);
        let multi = cfg.multi_tenant;
        let security = cfg.security.clone();
        // Socketioxide gửi gói xác nhận kết nối TRƯỚC khi chạy handler (handler được spawn), nên `join` trong handler để hở một khoảng
        // mà sự kiện phát ngay sau xác nhận bị mất. Vì vậy `join` nằm ở MIDDLEWARE (chạy xong mới gửi xác nhận). Middleware không từ
        // chối (từ chối ⇒ client nhận `connect_error`, khác `io server disconnect` của Nest); handler chạy sau xác nhận và
        // `disconnect()` khi xác thực hỏng, đúng hành vi cũ.
        let v = Verifier {
            secret,
            multi,
            security,
        };
        let (check_mw, check_h) = (v.clone(), v);
        let join = move |s: SocketRef, TryData(auth): TryData<serde_json::Value>| {
            let verdict = check_mw.verdict(&auth);
            async move {
                if let Some((company, user)) = verdict {
                    s.join(user_room(company, user));
                }
                Ok::<(), std::convert::Infallible>(())
            }
        };
        let on_connect = move |s: SocketRef, TryData(auth): TryData<serde_json::Value>| {
            let verdict = check_h.verdict(&auth);
            async move {
                match verdict {
                    Some((company, user)) => tracing::info!(user, company, "WS connected"),
                    None => {
                        tracing::warn!("WS connection rejected");
                        s.disconnect().ok();
                    }
                }
            }
        };
        io.ns(NAMESPACE, on_connect.with(join));
        (
            layer,
            Self {
                io,
                multi_tenant: multi,
            },
        )
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

    /// Mọi `(công ty, user)` đang có socket nối (suy ra từ tên room); dùng khi cần làm mới số đếm hàng loạt.
    pub fn connected_users(&self) -> Vec<(i64, i64)> {
        let Some(ns) = self.io.of(NAMESPACE) else {
            return Vec::new();
        };
        let mut out: Vec<(i64, i64)> = ns
            .sockets()
            .iter()
            .flat_map(|s| s.rooms())
            .filter_map(|r| parse_room(&r))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    pub async fn refresh_unread(&self, db: &Db, company: i64, user: i64) {
        match unread_counts(db, company, user).await {
            Ok(c) => self.emit_unread(company, user, &c).await,
            Err(e) => tracing::warn!(user, company, error = %e, "đọc số chưa đọc lỗi"),
        }
    }
}

#[derive(Clone)]
struct Verifier {
    secret: Arc<str>,
    multi: bool,
    security: Option<Arc<Security>>,
}

impl Verifier {
    /// Gói `auth` không đọc được (lỗi giải mã) ⇒ coi như không có token.
    fn verdict<E>(&self, auth: &Result<serde_json::Value, E>) -> Option<(i64, i64)> {
        authenticate(auth.as_ref().ok()?, &self.secret, self.multi, self.security.as_deref())
    }
}

/// Kiểm JWT ở handshake: trả `(công ty, user)`; `None` ⇒ ngắt. Chữ ký + hạn như gateway Node, cộng hai luật của guard HTTP:
/// từ chối refresh token và `sid` đã bị phiên khác thay.
fn authenticate(
    auth: &serde_json::Value,
    secret: &str,
    multi_tenant: bool,
    security: Option<&Security>,
) -> Option<(i64, i64)> {
    let token = auth.get("token")?.as_str().filter(|t| !t.is_empty())?;
    let claims = trinity_auth::jwt::verify(token, secret).ok()?;
    if claims.is_refresh() {
        return None;
    }
    // Node: `cid` phải là số nguyên > 0, ngược lại công ty 1; một công ty ⇒ luôn công ty 1.
    let company = if multi_tenant && claims.company_id() > 0 {
        claims.company_id()
    } else {
        1
    };
    if let Some(sec) = security
        && let (Ok(c), Ok(u)) = (i32::try_from(company), i32::try_from(claims.sub))
        && !sec.is_current_session(c, u, claims.sid.as_deref())
    {
        return None;
    }
    Some((company, claims.sub))
}

/// Ngược của [`user_room`]; room không phải của user (vd room mặc định theo sid) ⇒ `None`.
fn parse_room(room: &str) -> Option<(i64, i64)> {
    if let Some(u) = room.strip_prefix("user_") {
        return Some((1, u.parse().ok()?));
    }
    let rest = room.strip_prefix('c')?;
    let (c, u) = rest.split_once(":user_")?;
    Some((c.parse().ok()?, u.parse().ok()?))
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
    // Đa công ty: tin không có công ty (`c` ≤ 0) không biết phát vào room nào ⇒ bỏ, không quy về công ty 1 (sẽ gửi nhầm).
    // Một công ty: luôn công ty 1 (room không mang `cid`).
    let company = if !socket.multi_tenant {
        1
    } else if env.company > 0 {
        env.company
    } else {
        tracing::warn!(
            company = env.company,
            "sync bell: thiếu công ty ở chế độ đa công ty, bỏ tin"
        );
        return;
    };
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

/// Xử lý luồng `trinity_sync` cho chuông. Chỉ MỘT bên được nghe kênh (`trinity_db::sync::listen_from_env`): server mở một luồng
/// rồi chuyển tiếp cho mọi bên dùng. Hàm này nhận luồng ĐẦY ĐỦ, tự xử lý `bell`, và đẩy mọi tin/sự kiện khác (kể cả `Resync`)
/// sang `forward` nếu có để bên khác (security, cache) vẫn nhận — không nuốt tin. `Resync` (vừa nối lại sau lúc đứt, tin đã
/// mất) ⇒ phát lại số chưa đọc cho mọi user đang nối. Dừng khi kênh đóng.
pub fn spawn_bell_listener(
    socket: NotifSocket,
    db: Db,
    mut rx: mpsc::Receiver<SyncEvent>,
    forward: Option<mpsc::Sender<SyncEvent>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match &ev {
                SyncEvent::Message(env) if env.kind == "bell" => handle_bell(&socket, &db, env).await,
                SyncEvent::Message(_) => {}
                SyncEvent::Resync => {
                    for (company, user) in socket.connected_users() {
                        socket.refresh_unread(&db, company, user).await;
                    }
                }
            }
            let is_bell = matches!(&ev, SyncEvent::Message(env) if env.kind == "bell");
            if !is_bell && let Some(f) = &forward {
                f.send(ev).await.ok();
            }
        }
    })
}

/// `CORS_ORIGIN` như `buildWsCorsOrigin` của Node: danh sách phân tách bằng dấu phẩy, `*.example.com` cho mọi subdomain
/// một cấp, `localhost` luôn được phép. Chưa đặt (hoặc rỗng) ⇒ `None` (không thêm header CORS; dùng same-origin).
pub fn cors_layer(configured: Option<&str>) -> Option<CorsLayer> {
    // Như Node: chuỗi rỗng ⇒ không CORS; chỉ toàn khoảng trắng/dấu phẩy ⇒ danh sách rỗng nhưng localhost vẫn được phép.
    let configured = configured.filter(|c| !c.is_empty())?;
    let entries: Vec<String> = configured
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    Some(
        CorsLayer::new()
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
            .allow_origin(AllowOrigin::predicate(move |origin, _| {
                origin.to_str().is_ok_and(|o| origin_allowed(o, &entries))
            })),
    )
}

/// Như `buildWsCorsOrigin` của Node: khớp đúng từng ký tự với một mục; hoặc mục dạng `[scheme://]*.host` ⇒ origin
/// `http(s)://<một nhãn [a-z0-9-]>.host` (không phân biệt hoa thường; scheme của mục không ràng buộc, nhận cả http lẫn https).
pub fn origin_allowed(origin: &str, entries: &[String]) -> bool {
    if is_localhost(origin) {
        return true;
    }
    let lower = origin.to_ascii_lowercase();
    entries.iter().any(|e| {
        if e == origin {
            return true;
        }
        let rest = e
            .strip_prefix("https://")
            .or_else(|| e.strip_prefix("http://"))
            .unwrap_or(e);
        let Some(host) = rest.strip_prefix("*.").filter(|h| !h.is_empty()) else {
            return false;
        };
        let suffix = format!(".{}", host.to_ascii_lowercase());
        lower
            .strip_prefix("https://")
            .or_else(|| lower.strip_prefix("http://"))
            .and_then(|o| o.strip_suffix(suffix.as_str()))
            .is_some_and(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
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
    fn parse_room_is_inverse_of_user_room() {
        for (c, u) in [(1, 7), (2, 7), (30, 4)] {
            assert_eq!(parse_room(&user_room(c, u)), Some((c, u)));
        }
        assert_eq!(parse_room("abcdef"), None);
    }

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
        // Wildcard nhận cả http lẫn https, không phân biệt hoa thường (như regex `i` của Node).
        assert!(origin_allowed("http://a.corp.vn", &e) && origin_allowed("HTTPS://A.CORP.VN", &e));
        let e2 = vec!["https://*.Corp.vn".to_owned()];
        assert!(origin_allowed("http://x.corp.vn", &e2));
        // CORS_ORIGIN rỗng ⇒ không có lớp CORS; toàn khoảng trắng ⇒ có lớp (localhost vẫn được phép).
        assert!(cors_layer(None).is_none() && cors_layer(Some("")).is_none());
        assert!(cors_layer(Some("  ")).is_some() && cors_layer(Some(" , ")).is_some());
        assert!(origin_allowed("http://localhost:3000", &[]) && !origin_allowed("https://x.com", &[]));
    }

    #[test]
    fn auth_needs_valid_token() {
        assert!(authenticate(&serde_json::json!({}), "s", true, None).is_none());
        assert!(authenticate(&serde_json::json!({"token": ""}), "s", true, None).is_none());
        assert!(authenticate(&serde_json::json!({"token": "bad"}), "s", true, None).is_none());
    }
}
