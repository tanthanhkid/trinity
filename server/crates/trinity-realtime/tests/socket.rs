//! K33: socket thông báo tương thích client hiện tại. Giao thức Engine.IO v4 / Socket.IO v5 qua WebSocket thô (đúng thứ
//! `socket.io-client` gửi với `transports: ['websocket']`), nên không cần client Node trong test.
//!
//! Ca không cần DB chạy mặc định. Ca có DB (chuông qua `NOTIFY trinity_sync`, Node <-> Rust) cần Postgres đã migrate bằng
//! Prisma, DB riêng: `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_k33 cargo test -p trinity-realtime --test socket -- --ignored --test-threads=1`

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use trinity_auth::jwt::{Claims, sign};
use trinity_realtime::{NAMESPACE, NotifSocket, NotificationPayload, RealtimeConfig, UnreadCounts};

const SECRET: &str = "k33-test-secret-k33-test-secret-0123";
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn serve(multi_tenant: bool) -> (String, NotifSocket) {
    let (layer, socket) = NotifSocket::new(RealtimeConfig {
        jwt_secret: SECRET,
        multi_tenant,
    });
    let app = axum::Router::new().layer(layer);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("ws://{addr}/notif-ws/?EIO=4&transport=websocket"), socket)
}

fn token(user: i64, cid: Option<i64>) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    sign(&Claims::access(user, "u@example.com", None, cid, now), SECRET).unwrap()
}

async fn next_text(ws: &mut Ws, within: Duration) -> Option<String> {
    loop {
        match tokio::time::timeout(within, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let t = t.to_string();
                if t == "2" {
                    ws.send(Message::text("3")).await.unwrap(); // pong cho ping của Engine.IO
                    continue;
                }
                return Some(t);
            }
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

/// Nối, vào namespace với `auth`; trả `(ws, gói phản hồi namespace)`.
async fn connect(url: &str, auth: Value) -> (Ws, String) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let open = next_text(&mut ws, Duration::from_secs(2)).await.unwrap();
    assert!(open.starts_with('0'), "gói mở Engine.IO: {open}");
    ws.send(Message::text(format!("40{NAMESPACE},{auth}"))).await.unwrap();
    let ack = next_text(&mut ws, Duration::from_secs(2)).await.unwrap();
    (ws, ack)
}

fn event(packet: &str) -> (String, Value) {
    let body = packet
        .strip_prefix(&format!("42{NAMESPACE},"))
        .unwrap_or_else(|| panic!("không phải sự kiện: {packet}"));
    let v: Value = serde_json::from_str(body).unwrap();
    (v[0].as_str().unwrap().to_owned(), v[1].clone())
}

fn payload(id: i32) -> NotificationPayload {
    NotificationPayload {
        id: Some(id),
        title: "Việc mới".into(),
        body: "Bạn được giao một thương vụ".into(),
        channel: "in_app".into(),
        event_type: Some("deal.assigned".into()),
        action_url: Some("/deals/1".into()),
        is_read: false,
        created_at: "2026-11-27T00:00:00.000Z".into(),
    }
}

#[tokio::test]
async fn nhan_thong_bao_trong_mot_giay_dung_payload() {
    let (url, socket) = serve(true).await;
    let (mut ws, ack) = connect(&url, json!({"token": token(7, Some(1))})).await;
    assert!(ack.starts_with(&format!("40{NAMESPACE},{{\"sid\"")), "{ack}");

    let t = std::time::Instant::now();
    socket.send_to_user(1, 7, &payload(11)).await;
    socket
        .emit_unread(
            1,
            7,
            &UnreadCounts {
                count: 3,
                bell_count: 2,
                message_count: 1,
            },
        )
        .await;
    let (name, body) = event(
        &next_text(&mut ws, Duration::from_secs(1))
            .await
            .expect("notification:new trong 1 giây"),
    );
    assert!(t.elapsed() < Duration::from_secs(1));
    assert_eq!(name, "notification:new");
    assert_eq!(
        body,
        json!({"id": 11, "title": "Việc mới", "body": "Bạn được giao một thương vụ", "channel": "in_app",
               "event_type": "deal.assigned", "action_url": "/deals/1", "is_read": false, "created_at": "2026-11-27T00:00:00.000Z"})
    );
    let (name, body) = event(
        &next_text(&mut ws, Duration::from_secs(1))
            .await
            .expect("notification:count"),
    );
    assert_eq!(name, "notification:count");
    assert_eq!(body, json!({"count": 3, "bell_count": 2, "message_count": 1}));
}

#[tokio::test]
async fn cong_ty_a_khong_nhan_su_kien_cua_b() {
    let (url, socket) = serve(true).await;
    // Cùng user id 7 ở hai công ty; token không có `cid` = công ty 1.
    let (mut a, _) = connect(&url, json!({"token": token(7, None)})).await;
    let (mut b, _) = connect(&url, json!({"token": token(7, Some(2))})).await;
    let (mut other, _) = connect(&url, json!({"token": token(8, Some(1))})).await;

    socket.send_to_user(2, 7, &payload(1)).await;
    let (name, _) = event(&next_text(&mut b, Duration::from_secs(1)).await.expect("B nhận"));
    assert_eq!(name, "notification:new");
    assert!(
        next_text(&mut a, Duration::from_millis(400)).await.is_none(),
        "công ty A không được nhận tin của B"
    );
    assert!(
        next_text(&mut other, Duration::from_millis(400)).await.is_none(),
        "user khác không nhận"
    );

    socket.send_to_user(1, 7, &payload(2)).await;
    assert!(next_text(&mut a, Duration::from_secs(1)).await.is_some());
    assert!(
        next_text(&mut b, Duration::from_millis(400)).await.is_none(),
        "công ty B không được nhận tin của A"
    );
}

#[tokio::test]
async fn mot_cong_ty_thi_moi_phien_vao_cong_ty_1() {
    let (url, socket) = serve(false).await;
    let (mut ws, _) = connect(&url, json!({"token": token(7, Some(5))})).await;
    socket.send_to_user(1, 7, &payload(1)).await;
    assert!(next_text(&mut ws, Duration::from_secs(1)).await.is_some());
}

#[tokio::test]
async fn khong_token_hoac_token_sai_bi_ngat() {
    let (url, _s) = serve(true).await;
    for auth in [
        json!({}),
        json!({"token": ""}),
        json!({"token": "khong.phai.jwt"}),
        json!({"token": token(7, None).replace('.', "x")}),
    ] {
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        next_text(&mut ws, Duration::from_secs(2)).await.unwrap();
        ws.send(Message::text(format!("40{NAMESPACE},{auth}"))).await.unwrap();
        // Máy chủ nhận kết nối rồi ngắt namespace: client thấy `41/notifications/ws,` (`io server disconnect`).
        let mut seen = Vec::new();
        while let Some(p) = next_text(&mut ws, Duration::from_secs(2)).await {
            seen.push(p);
            if seen.last().is_some_and(|p| p.starts_with("41")) {
                break;
            }
        }
        assert!(
            seen.iter().any(|p| p == &format!("41{NAMESPACE},")),
            "auth {auth}: {seen:?}"
        );
    }
}

#[tokio::test]
async fn token_het_han_bi_ngat() {
    let (url, _s) = serve(true).await;
    let old = Claims {
        exp: Some(1_000),
        iat: Some(0),
        ..Claims::access(7, "u@example.com", None, None, 0)
    };
    let tok = sign(&old, SECRET).unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    next_text(&mut ws, Duration::from_secs(2)).await.unwrap();
    ws.send(Message::text(format!("40{NAMESPACE},{}", json!({"token": tok}))))
        .await
        .unwrap();
    let mut got_disconnect = false;
    while let Some(p) = next_text(&mut ws, Duration::from_secs(2)).await {
        if p == format!("41{NAMESPACE},") {
            got_disconnect = true;
            break;
        }
    }
    assert!(got_disconnect);
}

mod pg {
    use super::*;
    use sqlx::postgres::PgListener;
    use sqlx::{Connection, PgConnection};
    use trinity_db::outbox::{NewNotification, create_notification};
    use trinity_db::sync::{self, SyncEvent};
    use trinity_db::{CompanyRef, Db, DbConfig};
    use trinity_realtime::spawn_bell_listener;

    fn url() -> String {
        std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
    }

    async fn db() -> Db {
        let mut c = DbConfig::new(url());
        c.pool_size = 4;
        c.acquire_timeout = Duration::from_secs(5);
        Db::connect(&c).await.expect("kết nối DB")
    }

    async fn reset(c: &mut PgConnection) {
        sqlx::query("TRUNCATE notification_logs RESTART IDENTITY CASCADE")
            .execute(&mut *c)
            .await
            .unwrap();
        for id in [4, 6] {
            sqlx::query("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ($1, $2, 'x', 'Test', now()) ON CONFLICT (id) DO NOTHING")
                .bind(id)
                .bind(format!("k33-{id}@example.com"))
                .execute(&mut *c)
                .await
                .unwrap();
        }
    }

    /// Node tạo thông báo -> client nối ở Rust nhận trong 1 giây (đúng định dạng `publishBell` của Node, origin lạ).
    #[tokio::test]
    #[ignore = "cần Postgres (TEST_DATABASE_URL)"]
    async fn node_tao_thong_bao_client_noi_o_rust_nhan() {
        let mut admin = PgConnection::connect(&url()).await.unwrap();
        reset(&mut admin).await;
        let db = db().await;
        let (wsurl, socket) = serve(false).await;
        let rx = sync::listen(DbConfig::new(url()).connect_options().unwrap());
        let _task = spawn_bell_listener(socket.clone(), db.clone(), rx);
        tokio::time::sleep(Duration::from_millis(500)).await; // chờ LISTEN

        let (mut ws, _) = connect(&wsurl, json!({"token": token(4, None)})).await;
        let (mut other, _) = connect(&wsurl, json!({"token": token(6, None)})).await;

        // Node: INSERT dòng rồi `NOTIFY bell` {u:[4], n:[id]} (đây là phần Node làm trong giao dịch bằng `pg_notify`).
        let id: i32 = sqlx::query_scalar("INSERT INTO notification_logs (recipient_id, event_type, channel, title, body, status, is_read, action_url, retry_count) VALUES (4, 'deal.assigned', 'in_app', 'Việc mới', 'Nội dung', 'sent', false, '/deals/1', 0) RETURNING id")
            .fetch_one(&mut admin)
            .await
            .unwrap();
        let t = std::time::Instant::now();
        let msg = json!({"v": 1, "o": "node-test-1", "k": "bell", "c": 1, "u": [4], "n": [id]}).to_string();
        sqlx::query("SELECT pg_notify('trinity_sync', $1)")
            .bind(msg)
            .execute(&mut admin)
            .await
            .unwrap();

        let (name, body) = event(
            &next_text(&mut ws, Duration::from_secs(1))
                .await
                .expect("notification:new"),
        );
        assert!(t.elapsed() < Duration::from_secs(1));
        assert_eq!(
            (
                name.as_str(),
                body["id"].as_i64(),
                body["title"].as_str(),
                body["action_url"].as_str()
            ),
            (
                "notification:new",
                Some(i64::from(id)),
                Some("Việc mới"),
                Some("/deals/1")
            )
        );
        assert!(body["created_at"].as_str().unwrap().ends_with('Z'));
        let (name, body) = event(
            &next_text(&mut ws, Duration::from_secs(1))
                .await
                .expect("notification:count"),
        );
        assert_eq!(name, "notification:count");
        assert_eq!(body, json!({"count": 1, "bell_count": 1, "message_count": 0}));
        assert!(
            next_text(&mut other, Duration::from_millis(400)).await.is_none(),
            "user 6 không nhận"
        );
    }

    /// Rust tạo thông báo -> socket Rust cục bộ nhận ngay; tin `NOTIFY bell` kèm id tới tiến trình khác (Node đọc DB theo id).
    #[tokio::test]
    #[ignore = "cần Postgres (TEST_DATABASE_URL)"]
    async fn rust_tao_thong_bao_client_rust_va_kenh_cho_node() {
        let mut admin = PgConnection::connect(&url()).await.unwrap();
        reset(&mut admin).await;
        let db = db().await;
        let (wsurl, socket) = serve(false).await;
        let (mut ws, _) = connect(&wsurl, json!({"token": token(4, None)})).await;

        let mut node_side = PgListener::connect(&url()).await.unwrap(); // đóng vai Node nghe kênh
        node_side.listen(sync::SYNC_CHANNEL).await.unwrap();

        let mut tx = db.tenant(CompanyRef::DEFAULT).await.unwrap().begin().await.unwrap();
        let made = create_notification(
            &mut tx,
            &[NewNotification {
                recipient_id: 4,
                event_type: "deal.assigned".into(),
                title: "Việc mới".into(),
                body: "Nội dung".into(),
                action_url: Some("/deals/1".into()),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let c = &made[0];
        socket
            .push_local(
                &db,
                1,
                i64::from(c.recipient_id),
                &NotificationPayload {
                    id: Some(c.id),
                    title: c.title.clone(),
                    body: c.body.clone(),
                    channel: "in_app".into(),
                    event_type: Some(c.event_type.clone()),
                    action_url: c.action_url.clone(),
                    is_read: false,
                    created_at: "2026-11-27T00:00:00.000Z".into(),
                },
            )
            .await;
        let (name, body) = event(
            &next_text(&mut ws, Duration::from_secs(1))
                .await
                .expect("notification:new"),
        );
        assert_eq!(
            (name.as_str(), body["id"].as_i64()),
            ("notification:new", Some(i64::from(c.id)))
        );
        let (name, body) = event(
            &next_text(&mut ws, Duration::from_secs(1))
                .await
                .expect("notification:count"),
        );
        assert_eq!(name, "notification:count");
        assert_eq!(body["bell_count"], 1);

        let n = tokio::time::timeout(Duration::from_secs(2), node_side.recv())
            .await
            .expect("NOTIFY bell")
            .unwrap();
        let env = sync::parse_payload(n.payload()).unwrap();
        assert_eq!(env.kind, "bell");
        assert_eq!(env.fields["n"], json!([c.id]));
        assert!(env.origin.starts_with("rust-"));
        let _ = SyncEvent::Resync; // kiểu dùng chung
    }
}
