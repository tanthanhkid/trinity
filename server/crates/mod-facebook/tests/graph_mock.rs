//! Client Graph chạy với máy chủ giả (không lời gọi nào ra Internet): kịch bản và thân lỗi theo máy chủ giả C06b
//! (`tests/contract/mock/channels.ts`: thành công, lỗi Graph 368/551/17/32/4/613/190, `error_subcode`, `fbtrace_id`).
//! Kiểm: mã lỗi Graph phân loại đúng, kết quả báo cho `ChannelGuard` đúng loại (tính vào ngưỡng hay không), hình dạng từng lời
//! gọi (đường dẫn, header `Bearer`, query, thân), token không bao giờ nằm trong URL, lỗi cấu hình chưa gửi gì.

use std::sync::{Arc, Mutex};

use mod_channel_guard::GraphOutcome;
use mod_channel_guard::graph::{is_app_level_limit, is_block_outcome};
use mod_facebook::config::Env;
use mod_facebook::graph::{GraphApiError, GraphClient};
use serde_json::{Value, json};
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn env_for(base: &str) -> Env {
    let base = base.to_owned();
    Arc::new(move |k| match k {
        "FACEBOOK_APP_ID" => Some("123".into()),
        "FACEBOOK_APP_SECRET" => Some("shh".into()),
        "FACEBOOK_GRAPH_BASE_URL" => Some(base.clone()),
        _ => None,
    })
}

type Seen = Arc<Mutex<Vec<GraphOutcome>>>;

fn client(base: &str) -> (GraphClient, Seen) {
    // Provider TLS dùng chung (cài một lần ở `main` của binary; ở test phải tự cài).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let seen: Seen = Arc::default();
    let s = seen.clone();
    (
        GraphClient::new(env_for(base), Arc::new(move |o| s.lock().unwrap().push(o))),
        seen,
    )
}

/// Thân lỗi Graph như `graphError` của máy chủ giả.
fn graph_error(code: i64, subcode: Option<i64>) -> Value {
    let mut e = json!({ "message": format!("Lỗi Graph giả {code}"), "type": "OAuthException", "code": code, "fbtrace_id": "MOCKTRACE" });
    if let Some(s) = subcode {
        e["error_subcode"] = json!(s);
    }
    json!({ "error": e })
}

async fn mount(server: &MockServer, m: &str, p: &str, status: u16, body: Value) {
    Mock::given(method(m))
        .and(path(p))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(server)
        .await;
}

/// (http, mã Graph, subcode, cờ phân loại [token, quyền, tần suất, ngoài cửa sổ, chưa dùng], tính vào ngưỡng khi GỬI, cấp app).
type Row = (u16, i64, Option<i64>, [bool; 5], bool, bool);

#[tokio::test]
async fn ma_loi_graph_phan_loai_dung_va_bao_cho_cua_so_loi() {
    #[rustfmt::skip]
    let table: &[Row] = &[
        // (http, mã, subcode, [token, quyền, tần suất, ngoài cửa sổ, -], chặn khi gửi, giới hạn cấp app)
        (400, 368, None,            [false, false, false, false, false], true,  false),
        (400, 551, None,            [false, false, false, false, false], true,  false),
        (400, 17,  None,            [false, false, true,  false, false], true,  false),
        (400, 32,  None,            [false, false, true,  false, false], true,  false),
        (400, 4,   None,            [false, false, true,  false, false], false, true),
        (400, 613, None,            [false, false, true,  false, false], false, true),
        (400, 190, None,            [true,  false, false, false, false], false, false),
        (403, 10,  None,            [false, true,  false, false, false], false, false),
        (400, 10,  Some(2_018_278), [false, true,  false, true,  false], false, false),
        (400, 200, None,            [false, true,  false, false, false], false, false),
        (400, 299, None,            [false, true,  false, false, false], false, false),
        (400, 551, Some(1_545_041), [false, false, false, true,  false], false, false),
    ];
    for (http, code, sub, flags, blocks, app) in table.iter().copied() {
        for send in [true, false] {
            let server = MockServer::start().await;
            let (c, seen) = client(&server.uri());
            mount(&server, "POST", "/v25.0/me/messages", http, graph_error(code, sub)).await;
            mount(&server, "GET", "/v25.0/me/accounts", http, graph_error(code, sub)).await;
            let err: GraphApiError = if send {
                c.send_text("TOK", "PSID", "xin chào", false).await.unwrap_err()
            } else {
                c.list_pages("TOK").await.unwrap_err()
            };
            let ctx = format!("http {http} mã {code} subcode {sub:?} gửi={send}");
            assert_eq!(
                (err.http_status, err.code, err.subcode),
                (http, Some(code), sub),
                "{ctx}"
            );
            assert_eq!(err.message, format!("Lỗi Graph giả {code}"), "{ctx}");
            assert!(!err.is_config_error(), "{ctx}");
            assert_eq!(
                [
                    err.is_token_error(),
                    err.is_permission_error(),
                    err.is_rate_limit(),
                    err.is_outside_window(),
                    false
                ],
                flags,
                "{ctx}"
            );
            // Kết quả báo cho cửa sổ lỗi: đúng một lần, `ok = false`, cờ `send` đúng, và phân loại của M45 khớp.
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1, "{ctx}");
            let o = seen[0];
            assert_eq!(
                (o.ok, o.http_status, o.code, o.subcode, o.send),
                (false, i64::from(http), Some(code), sub, send),
                "{ctx}"
            );
            assert_eq!(is_block_outcome(&o), send && blocks, "{ctx}");
            assert_eq!(is_app_level_limit(&o), app, "{ctx}");
        }
    }
}

#[tokio::test]
async fn http_429_la_gioi_han_tan_suat_cap_app() {
    let server = MockServer::start().await;
    let (c, seen) = client(&server.uri());
    mount(&server, "POST", "/v25.0/me/messages", 429, json!({})).await;
    let e = c.send_text("T", "P", "x", false).await.unwrap_err();
    assert!(e.is_rate_limit() && e.code.is_none());
    assert_eq!(
        e.message, "Facebook trả lỗi HTTP 429",
        "không có thân lỗi thì dùng câu mặc định"
    );
    let o = seen.lock().unwrap()[0];
    assert!(is_app_level_limit(&o) && !is_block_outcome(&o));
}

#[tokio::test]
async fn thanh_cong_loi_than_la_va_mat_ket_noi() {
    let server = MockServer::start().await;
    let (c, seen) = client(&server.uri());
    mount(
        &server,
        "POST",
        "/v25.0/me/messages",
        200,
        json!({ "message_id": "m_1", "recipient_id": "P" }),
    )
    .await;
    let sent = c.send_text("T", "P", "x", false).await.unwrap();
    assert_eq!(
        (sent.message_id.as_str(), sent.recipient_id.as_deref()),
        ("m_1", Some("P"))
    );
    let o = seen.lock().unwrap()[0];
    assert_eq!((o.ok, o.http_status, o.code, o.send), (true, 200, None, true));

    // HTTP 200 nhưng thân có `error` vẫn là lỗi (Graph đôi khi trả vậy).
    mount(&server, "GET", "/v25.0/me/permissions", 200, graph_error(190, None)).await;
    let e = c.granted_permissions("T").await.unwrap_err();
    assert!(e.is_token_error());
    assert!(!seen.lock().unwrap()[1].ok);

    // Thân không phải JSON ở HTTP lỗi: giữ mã HTTP, không mã Graph.
    Mock::given(method("GET"))
        .and(path("/v25.0/me/accounts"))
        .respond_with(ResponseTemplate::new(502).set_body_string("<html>bad gateway</html>"))
        .mount(&server)
        .await;
    let e = c.list_pages("T").await.unwrap_err();
    assert_eq!(
        (e.http_status, e.code, e.message.as_str()),
        (502, None, "Facebook trả lỗi HTTP 502")
    );

    // Không kết nối được: câu cố định, không lộ địa chỉ, KHÔNG báo cho cửa sổ lỗi.
    let before = seen.lock().unwrap().len();
    let (dead, seen2) = client("http://127.0.0.1:1");
    let e = dead.send_text("T", "P", "x", false).await.unwrap_err();
    assert_eq!(
        (e.http_status, e.message.as_str()),
        (0, "Không kết nối được tới Facebook")
    );
    assert!(seen2.lock().unwrap().is_empty());
    assert_eq!(before, 3);
}

#[tokio::test]
async fn loi_cau_hinh_chua_gui_gi_toi_facebook() {
    let server = MockServer::start().await;
    mount(&server, "GET", "/v25.0/x", 200, json!({})).await;
    // Địa chỉ gốc http ngoài loopback.
    let (c, seen) = client("http://graph.example.test");
    let e = c.list_pages("T").await.unwrap_err();
    assert!(
        e.is_config_error() && e.message.contains("http:// chỉ dùng cho máy chủ cục bộ"),
        "{e}"
    );
    assert!(seen.lock().unwrap().is_empty(), "lỗi cấu hình không phải kết quả Graph");
    // Id lạ từ webhook không thoát khỏi `/{version}/`.
    let (c, seen) = client(&server.uri());
    for bad in ["a/../b", "x?y=1", "x#f", "x y", "x\\y"] {
        let e = c.get_lead(bad, "T").await.unwrap_err();
        assert!(e.is_config_error(), "{bad}");
        assert_eq!(e.message, "Đường dẫn Graph API không hợp lệ");
    }
    assert!(seen.lock().unwrap().is_empty());
    assert!(
        server.received_requests().await.unwrap().is_empty(),
        "không có yêu cầu nào tới máy chủ"
    );
}

#[tokio::test]
async fn hinh_dang_dang_nhap_danh_sach_page_va_webhook() {
    let server = MockServer::start().await;
    let (c, _) = client(&server.uri());
    Mock::given(method("GET"))
        .and(path("/v25.0/oauth/access_token"))
        .and(query_param("client_id", "123"))
        .and(query_param("client_secret", "shh"))
        .and(query_param("redirect_uri", "https://crm.example/cb"))
        .and(query_param("code", "CODE"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": "SHORT" })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/oauth/access_token"))
        .and(query_param("grant_type", "fb_exchange_token"))
        .and(query_param("fb_exchange_token", "SHORT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": "LONG" })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/me/accounts"))
        .and(header("authorization", "Bearer LONG"))
        .and(query_param("fields", "id,name,access_token,tasks,picture{url}"))
        .and(query_param("limit", "100"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [
            { "id": "P1", "name": "Quán A", "access_token": "PT1", "tasks": ["MANAGE"], "picture": { "data": { "url": "https://img/a.png" } } },
            { "id": "P2", "name": "Quán B", "access_token": "PT2" }
        ] })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/me/permissions"))
        .and(header("authorization", "Bearer LONG"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [
            { "permission": "pages_show_list", "status": "granted" }, { "permission": "pages_manage_posts", "status": "declined" },
            { "permission": "pages_messaging", "status": "granted" }
        ] })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/P1/subscribed_apps"))
        .and(header("authorization", "Bearer PT1"))
        .and(query_param("subscribed_fields", "messages,messaging_postbacks"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/P1/subscribed_apps"))
        .and(query_param("subscribed_fields", ""))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/debug_token"))
        .and(header("authorization", "Bearer 123|shh"))
        .and(query_param("input_token", "PT1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({ "data": { "is_valid": true, "expires_at": 0, "data_access_expires_at": 1_900_000_000 } }),
        ))
        .expect(1)
        .mount(&server)
        .await;

    let short = c.exchange_code("CODE", "https://crm.example/cb").await.unwrap();
    assert_eq!(short, "SHORT");
    let long = c.to_long_lived(&short).await.unwrap();
    assert_eq!(long, "LONG");
    let pages = c.list_pages(&long).await.unwrap();
    assert_eq!(pages.len(), 2);
    assert_eq!(
        (
            pages[0].id.as_str(),
            pages[0].tasks.as_deref().map(<[String]>::len),
            pages[0].picture_url()
        ),
        ("P1", Some(1), Some("https://img/a.png"))
    );
    assert!(pages[1].tasks.is_none() && pages[1].picture_url().is_none());
    assert_eq!(
        c.granted_permissions(&long).await.unwrap(),
        ["pages_show_list", "pages_messaging"],
        "chỉ quyền đã cấp thật"
    );
    c.subscribe_page("P1", "PT1", &["messages".to_owned(), "messaging_postbacks".to_owned()])
        .await
        .unwrap();
    c.unsubscribe_page("P1", "PT1").await.unwrap();
    let d = c.debug_token("PT1").await.unwrap();
    assert!(d.is_valid && d.expires_at == Some(0) && d.data_access_expires_at == Some(1_900_000_000));

    // Token không nằm trong URL (chỉ ở header Authorization); `client_secret` chỉ ở query của oauth/access_token (Graph quy định).
    for r in server.received_requests().await.unwrap() {
        let url = r.url.to_string();
        // Ngoại lệ duy nhất: `debug_token` bắt buộc nhận `input_token` ở query (Graph API quy định); app token vẫn ở header.
        let secrets: &[&str] = if r.url.path().ends_with("/debug_token") {
            &["LONG", "PT2", "123|shh"]
        } else {
            &["LONG", "PT1", "PT2", "123|shh"]
        };
        for secret in secrets {
            assert!(!url.contains(secret), "{url} lộ {secret}");
        }
    }
}

#[tokio::test]
async fn hinh_dang_gui_tin_binh_luan_va_hoi_thoai() {
    let server = MockServer::start().await;
    let (c, seen) = client(&server.uri());
    let ok = |b: Value| ResponseTemplate::new(200).set_body_json(b);
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(header("authorization", "Bearer PT"))
        .and(body_json(
            json!({ "recipient": { "id": "PS" }, "messaging_type": "RESPONSE", "message": { "text": "chào" } }),
        ))
        .respond_with(ok(json!({ "message_id": "m1" })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_json(json!({ "recipient": { "id": "PS" }, "messaging_type": "MESSAGE_TAG", "tag": "HUMAN_AGENT", "message": { "text": "chào lại" } })))
        .respond_with(ok(json!({ "message_id": "m2" })))
        .expect(1)
        .mount(&server)
        .await;
    let long_title = "Tiêu đề rất dài vượt hai mươi ký tự";
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_json(json!({ "recipient": { "id": "PS" }, "messaging_type": "RESPONSE", "message": { "text": "chọn", "quick_replies": [
            { "content_type": "text", "title": "Tiêu đề rất dài vượt", "payload": "A" }
        ] } })))
        .respond_with(ok(json!({ "message_id": "m3" })))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(c.send_text("PT", "PS", "chào", false).await.unwrap().message_id, "m1");
    assert_eq!(
        c.send_text("PT", "PS", "chào lại", true).await.unwrap().message_id,
        "m2"
    );
    assert_eq!(
        c.send_quick_replies("PT", "PS", "chọn", &[(long_title.to_owned(), "A".to_owned())])
            .await
            .unwrap()
            .message_id,
        "m3"
    );

    // Nút "Bắt đầu": đã có thì không đè; chưa có thì bật.
    let has = MockServer::start().await;
    let (c2, _) = client(&has.uri());
    mount(
        &has,
        "GET",
        "/v25.0/me/messenger_profile",
        200,
        json!({ "data": [{ "get_started": { "payload": "X" } }] }),
    )
    .await;
    assert!(!c2.ensure_get_started("PT").await.unwrap());
    assert!(
        has.received_requests()
            .await
            .unwrap()
            .iter()
            .all(|r| r.method.as_str() == "GET"),
        "không POST khi đã có nút"
    );
    let none = MockServer::start().await;
    let (c3, _) = client(&none.uri());
    mount(
        &none,
        "GET",
        "/v25.0/me/messenger_profile",
        200,
        json!({ "data": [{}] }),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messenger_profile"))
        .and(body_json(json!({ "get_started": { "payload": "GET_STARTED" } })))
        .respond_with(ok(json!({ "result": "success" })))
        .expect(1)
        .mount(&none)
        .await;
    assert!(c3.ensure_get_started("PT").await.unwrap());

    // Bình luận.
    Mock::given(method("POST"))
        .and(path("/v25.0/C1/comments"))
        .and(body_json(json!({ "message": "cảm ơn" })))
        .respond_with(ok(json!({ "id": "C1_2" })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/P1/messages"))
        .and(body_json(
            json!({ "recipient": { "comment_id": "C1" }, "message": { "text": "nhắn riêng" } }),
        ))
        .respond_with(ok(json!({ "message_id": "m4", "recipient_id": "U" })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/C1"))
        .and(body_json(json!({ "is_hidden": true })))
        .respond_with(ok(json!({ "success": true })))
        .expect(1)
        .mount(&server)
        .await;
    assert_eq!(c.reply_to_comment("PT", "C1", "cảm ơn").await.unwrap(), "C1_2");
    assert_eq!(
        c.private_reply("PT", "P1", "C1", "nhắn riêng")
            .await
            .unwrap()
            .recipient_id
            .as_deref(),
        Some("U")
    );
    c.hide_comment("PT", "C1").await.unwrap();
    // Mọi lời gọi gửi ra mang `send = true` (tính vào ngưỡng); lời gọi đọc thì không.
    assert!(seen.lock().unwrap().iter().all(|o| o.send));

    // Tên khách: `name`, hoặc ghép họ tên, hoặc `None` khi lỗi; tên từ hội thoại; tin gần nhất.
    let r = MockServer::start().await;
    let (c4, seen4) = client(&r.uri());
    Mock::given(method("GET"))
        .and(path("/v25.0/U1"))
        .respond_with(ok(json!({ "name": "Nguyễn A" })))
        .mount(&r)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/U2"))
        .respond_with(ok(json!({ "first_name": "Trần", "last_name": "B" })))
        .mount(&r)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/U3"))
        .respond_with(ResponseTemplate::new(403).set_body_json(graph_error(10, None)))
        .mount(&r)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/U4"))
        .respond_with(ok(json!({})))
        .mount(&r)
        .await;
    assert_eq!(c4.get_user_name("U1", "PT").await.as_deref(), Some("Nguyễn A"));
    assert_eq!(c4.get_user_name("U2", "PT").await.as_deref(), Some("Trần B"));
    assert_eq!(c4.get_user_name("U3", "PT").await, None);
    assert_eq!(c4.get_user_name("U4", "PT").await, None);
    assert!(seen4.lock().unwrap().iter().all(|o| !o.send));
    Mock::given(method("GET"))
        .and(path("/v25.0/P1/conversations"))
        .and(query_param("platform", "messenger"))
        .and(query_param("user_id", "U1"))
        .and(query_param("fields", "participants"))
        .respond_with(ok(json!({ "data": [{ "participants": { "data": [{ "id": "P1", "name": "Quán" }, { "id": "U1", "name": " Lê C " }] } }] })))
        .mount(&r)
        .await;
    assert_eq!(
        c4.get_conversation_name("P1", "U1", "PT").await.as_deref(),
        Some("Lê C")
    );
    Mock::given(method("GET"))
        .and(path("/v25.0/P1/conversations"))
        .and(query_param("fields", "messages.limit(2){id,created_time,from,message}"))
        .respond_with(ok(json!({ "data": [{ "messages": { "data": [
            { "id": "m9", "created_time": "2026-01-01T00:00:00+0000", "from": { "id": "U1", "name": "C" }, "message": "hi" },
            { "id": "m8", "created_time": "2025-12-31T00:00:00+0000" }
        ] } }] })))
        .mount(&r)
        .await;
    let msgs = c4.get_recent_messages("P1", "U1", "PT", 2).await.unwrap();
    assert_eq!(
        (msgs.len(), msgs[0].message.as_deref(), msgs[1].message.as_deref()),
        (2, Some("hi"), None)
    );
    // Lead.
    Mock::given(method("GET"))
        .and(path("/v25.0/L1"))
        .and(query_param("fields", "id,created_time,form_id,ad_id,field_data"))
        .respond_with(ok(
            json!({ "id": "L1", "field_data": [{ "name": "phone", "values": ["0901"] }] }),
        ))
        .mount(&r)
        .await;
    let lead = c4.get_lead("L1", "PT").await.unwrap();
    assert_eq!(lead.field_data.as_ref().unwrap()[0].values, ["0901"]);
}
