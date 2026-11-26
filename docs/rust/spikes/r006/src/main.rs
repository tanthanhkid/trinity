//! Máy chủ thử: giữ đúng giao thức của NotificationsGateway (path /notif-ws, namespace /notifications/ws,
//! JWT ở handshake `auth.token`, room `user_<id>` / `c<cid>:user_<id>`, sự kiện notification:new + notification:count).
use axum::{Router, extract::State, routing::post};
use jsonwebtoken::{DecodingKey, Validation, decode};
use serde::Deserialize;
use socketioxide::{
    SocketIo,
    extract::{Data, SocketRef},
};
use tower_http::cors::{Any, CorsLayer};

#[derive(Deserialize)]
struct Claims {
    sub: i64,
    cid: Option<i64>,
}
#[derive(Deserialize)]
struct Auth {
    token: Option<String>,
}

fn room(cid: i64, uid: i64) -> String {
    if cid == 1 {
        format!("user_{uid}")
    } else {
        format!("c{cid}:user_{uid}")
    }
}

#[derive(Clone)]
struct App {
    io: SocketIo,
}

#[derive(Deserialize)]
struct Push {
    user: i64,
    cid: Option<i64>,
}

/// Đóng vai ca dùng dịch vụ thông báo: POST /push -> phát notification:new rồi notification:count vào room.
async fn push(State(a): State<App>, axum::Json(p): axum::Json<Push>) -> &'static str {
    let ns = a.io.of("/notifications/ws").expect("ns");
    let r = room(p.cid.unwrap_or(1), p.user);
    ns.clone().to(r.clone()).emit("notification:new", &serde_json::json!({
        "id": 1, "title": "Việc mới", "body": "Bạn được giao một thương vụ", "channel": "in_app",
        "event_type": "deal.assigned", "action_url": "/deals/1", "is_read": false, "created_at": "2026-11-27T00:00:00Z"
    })).await.ok();
    ns.to(r)
        .emit(
            "notification:count",
            &serde_json::json!({"count": 1, "bell_count": 1, "message_count": 0}),
        )
        .await
        .ok();
    "ok"
}

#[tokio::main]
async fn main() {
    let secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "spike-secret".into());
    let (layer, io) = SocketIo::builder().req_path("/notif-ws").build_layer();
    let key = DecodingKey::from_secret(secret.as_bytes()).expect("khoá");
    io.ns(
        "/notifications/ws",
        move |s: SocketRef, Data(auth): Data<Auth>| {
            let key = key.clone();
            async move {
                // NestJS: không token / token sai -> client.disconnect() (client nhận "io server disconnect").
                let Some(tok) = auth.token.filter(|t| !t.is_empty()) else {
                    s.disconnect().ok();
                    return;
                };
                match decode::<Claims>(&tok, &key, &Validation::default()) {
                    Ok(c) => {
                        s.join(room(c.claims.cid.unwrap_or(1), c.claims.sub));
                    }
                    Err(_) => {
                        s.disconnect().ok();
                    }
                }
            }
        },
    );
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let app = Router::new()
        .route("/push", post(push))
        .with_state(App { io })
        .layer(layer)
        .layer(cors);
    let port = std::env::var("PORT").unwrap_or_else(|_| "5066".into());
    let l = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    axum::serve(l, app).await.unwrap();
}
