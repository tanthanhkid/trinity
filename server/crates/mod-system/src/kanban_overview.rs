//! `GET /api/v1/kanban/overview`: màn Kanban cần `boards` → `boards/{id}` + `users` → `cards` từng cột (ba đợt nối tiếp qua
//! mạng). Endpoint này chạy chuỗi đó NỘI BỘ (qua chính router đã mount: cùng xác thực, quyền, phạm vi) rồi trả một lượt:
//!
//! ```json
//! { "boards": [...], "board": {...chi tiết board đầu...}|null,
//!   "cards": { "<id cột>": { "cards": [...], "has_more": bool, "next_cursor": n|null } },
//!   "users": [{ "id", "full_name", "email" }]|null }
//! ```
//!
//! Board mặc định = phần tử đầu của `boards` (đúng cách web chọn). Mỗi cột chỉ trang đầu (`?limit=`, 1..=100, mặc định 30);
//! trang tiếp web vẫn gọi `GET /kanban/cards?...&cursor=` như cũ (`next_cursor` của mỗi cột). Phần nào lỗi/thiếu quyền ⇒ `null`
//! (thiếu `users.view` thì `users` null, web không dùng roster đó). Không ghi gì.

use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use trinity_http::edge::client_ip::ClientIp;

use crate::bootstrap::{BootstrapSlot, fetch_part};

const DEFAULT_LIMIT: i64 = 30;
const MAX_LIMIT: i64 = 100;

fn limit_of(query: Option<&str>) -> i64 {
    query
        .unwrap_or("")
        .split('&')
        .find_map(|p| p.strip_prefix("limit="))
        .and_then(|v| v.parse::<i64>().ok())
        .map_or(DEFAULT_LIMIT, |n| n.clamp(1, MAX_LIMIT))
}

/// Chỉ id, tên, email: roster cho picker không cần cả hồ sơ.
fn slim_users(raw: &Value) -> Value {
    let list = raw.get("data").and_then(Value::as_array).or_else(|| raw.as_array());
    let Some(list) = list else { return Value::Null };
    Value::Array(
        list.iter()
            .filter_map(|u| {
                let id = u.get("id")?.as_i64()?;
                let mut m = Map::new();
                m.insert("id".into(), json!(id));
                m.insert("full_name".into(), u.get("full_name").cloned().unwrap_or(Value::Null));
                if let Some(e) = u.get("email").filter(|e| e.is_string()) {
                    m.insert("email".into(), e.clone());
                }
                Some(Value::Object(m))
            })
            .collect(),
    )
}

fn column_ids(board: &Value) -> Vec<i64> {
    board
        .get("columns")
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(|x| x.get("id").and_then(Value::as_i64)).collect())
        .unwrap_or_default()
}

pub async fn handle(slot: BootstrapSlot, req: Request) -> Response {
    let Some(router) = slot.get().cloned() else {
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "overview chưa sẵn sàng").into_response();
    };
    let limit = limit_of(req.uri().query());
    let headers = req.headers().clone();
    let client = req.extensions().get::<ClientIp>().cloned();
    let get = |path: String| fetch_part(router.clone(), path, headers.clone(), client.clone());

    // Đợt 1: danh sách board và roster song song.
    let (boards, users) = tokio::join!(
        get("/api/v1/kanban/boards".into()),
        get("/api/v1/users?limit=500".into())
    );
    let first_id = boards
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|b| b.first())
        .and_then(|b| b.get("id"))
        .and_then(Value::as_i64);

    // Đợt 2: chi tiết board đầu; đợt 3: thẻ từng cột song song.
    let board = match first_id {
        Some(id) => get(format!("/api/v1/kanban/boards/{id}")).await,
        None => None,
    };
    let mut cards = Map::new();
    if let (Some(b), Some(id)) = (&board, first_id) {
        let cols = column_ids(b);
        let mut set = tokio::task::JoinSet::new();
        for c in &cols {
            let path = format!("/api/v1/kanban/cards?board_id={id}&column_id={c}&limit={limit}");
            let (r, h, cl, c) = (router.clone(), headers.clone(), client.clone(), *c);
            set.spawn(async move { (c, fetch_part(r, path, h, cl).await) });
        }
        let mut pages = Vec::new();
        while let Some(Ok(done)) = set.join_next().await {
            pages.push(done);
        }
        for (c, p) in pages {
            cards.insert(c.to_string(), p.unwrap_or(Value::Null));
        }
    }
    let out = json!({
        "boards": boards.unwrap_or(Value::Null),
        "board": board.unwrap_or(Value::Null),
        "cards": cards,
        "users": users.as_ref().map_or(Value::Null, slim_users),
    });
    let mut res = axum::Json(out).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bootstrap::new_slot;
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;

    #[test]
    fn gioi_han_limit() {
        assert_eq!(limit_of(None), 30);
        assert_eq!(limit_of(Some("limit=5")), 5);
        assert_eq!(limit_of(Some("limit=0")), 1);
        assert_eq!(limit_of(Some("limit=9999")), 100);
        assert_eq!(limit_of(Some("limit=abc")), 30);
    }

    #[test]
    fn roster_toi_gian() {
        let raw =
            json!({"data": [{"id": 1, "full_name": "A", "email": "a@x", "phone": "1", "role": "r"}, {"id": "x"}]});
        assert_eq!(slim_users(&raw), json!([{"id": 1, "full_name": "A", "email": "a@x"}]));
        assert_eq!(slim_users(&json!([{"id": 2}])), json!([{"id": 2, "full_name": null}]));
        assert!(slim_users(&json!({"x": 1})).is_null());
    }

    #[tokio::test]
    async fn gom_board_dau_cot_va_the() {
        let r = Router::new()
            .route(
                "/api/v1/kanban/boards",
                get(|| async { axum::Json(json!([{"id": 7, "name": "b"}, {"id": 8}])) }),
            )
            .route(
                "/api/v1/kanban/boards/7",
                get(|| async { axum::Json(json!({"id": 7, "columns": [{"id": 1}, {"id": 2}]})) }),
            )
            .route(
                "/api/v1/kanban/cards",
                get(|req: Request| async move {
                    let q = req.uri().query().unwrap_or("").to_owned();
                    assert!(q.contains("board_id=7") && q.contains("limit=30"), "{q}");
                    axum::Json(json!({"cards": [], "has_more": q.contains("column_id=2"), "next_cursor": null}))
                }),
            )
            .route(
                "/api/v1/users",
                get(|| async { axum::Json(json!({"data": [{"id": 3, "full_name": "C", "extra": 1}]})) }),
            );
        let slot = new_slot();
        slot.set(r).unwrap();
        let res = handle(
            slot,
            Request::get("/api/v1/kanban/overview").body(Body::empty()).unwrap(),
        )
        .await;
        let b: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap();
        assert_eq!(b["boards"].as_array().unwrap().len(), 2);
        assert_eq!(b["board"]["id"], 7);
        assert_eq!(b["cards"]["1"]["has_more"], false);
        assert_eq!(b["cards"]["2"]["has_more"], true);
        assert_eq!(b["users"], json!([{"id": 3, "full_name": "C"}]));
    }

    #[tokio::test]
    async fn khong_co_board_thi_phan_con_lai_null() {
        let r = Router::new().route("/api/v1/kanban/boards", get(|| async { axum::Json(json!([])) }));
        let slot = new_slot();
        slot.set(r).unwrap();
        let res = handle(
            slot,
            Request::get("/api/v1/kanban/overview").body(Body::empty()).unwrap(),
        )
        .await;
        let b: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap();
        assert!(b["board"].is_null() && b["users"].is_null());
        assert_eq!(b["cards"], json!({}));
    }
}
