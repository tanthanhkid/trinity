//! Client Zalo với máy chủ giả (wiremock; kịch bản như C06b: thành công, mã lỗi Zalo, token hết hạn `-216`/`-124`/`-118`). Không lời
//! gọi nào ra Internet. Kiểm: hình dạng từng lời gọi (URL, header `secret_key`/`access_token`, thân), gộp hai dạng lỗi của Zalo,
//! lỗi mạng/JSON/cấu hình, và câu tiếng Việt cho người dùng.

use std::sync::Arc;

use mod_zalo::client::{ZaloClient, ZnsRequest};
use mod_zalo::config::Env;
use mod_zalo::errors::{Channel, ZALO_BAD_TOKEN_BODY, ZALO_CONFIG_ERROR, describe_zalo_error};
use serde_json::{Value, json};
use wiremock::matchers::{body_json, body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn env_for(base: &str) -> Env {
    let base = base.to_owned();
    Arc::new(move |k| match k {
        "ZALO_OAUTH_BASE_URL" | "ZALO_OPENAPI_BASE_URL" | "ZALO_ZNS_BASE_URL" => Some(base.clone()),
        _ => None,
    })
}

fn client(base: &str) -> ZaloClient {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ZaloClient::new(env_for(base))
}

fn ok(b: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(b)
}

#[tokio::test]
async fn doi_code_va_lam_moi_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .and(header("secret_key", "shh"))
        .and(header("content-type", "application/x-www-form-urlencoded"))
        .and(body_string_contains("app_id=app1"))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains("code=CODE"))
        .and(body_string_contains("code_verifier=VER"))
        .respond_with(ok(
            json!({ "access_token": "AT1", "refresh_token": "RT1", "expires_in": "3600" }),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=RT1"))
        .respond_with(ok(
            json!({ "access_token": "AT2", "refresh_token": "RT2", "expires_in": 7200 }),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let c = client(&server.uri());
    let t = c.exchange_code("app1", "shh", "CODE", "VER").await.unwrap();
    assert_eq!(
        (t.access_token.as_str(), t.refresh_token.as_str(), t.expires_in),
        ("AT1", "RT1", 3600)
    );
    let t = c.refresh("app1", "shh", "RT1").await.unwrap();
    assert_eq!((t.access_token.as_str(), t.expires_in), ("AT2", 7200));
}

#[tokio::test]
async fn gui_tin_zns_va_ho_so() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v3.0/oa/message/cs"))
        .and(header("access_token", "AT"))
        .and(body_json(
            json!({ "recipient": { "user_id": "U1" }, "message": { "text": "chào" } }),
        ))
        .respond_with(ok(
            json!({ "error": 0, "message": "Success", "data": { "message_id": "m1", "user_id": "U1" } }),
        ))
        .expect(1)
        .mount(&server)
        .await;
    let data = json!({ "customer_name": "Lan" });
    Mock::given(method("POST"))
        .and(path("/message/template"))
        .and(header("access_token", "AT"))
        .and(body_json(json!({ "phone": "84912345678", "template_id": "555", "template_data": data, "tracking_id": "trk", "mode": "development" })))
        .respond_with(ok(json!({ "error": 0, "data": { "msg_id": "z1", "quota": { "dailyQuota": "500", "remainingQuota": "499" } } })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v3.0/oa/user/detail"))
        .and(header("access_token", "AT"))
        .and(query_param("data", r#"{"user_id":"U 1"}"#))
        .respond_with(ok(json!({ "error": 0, "data": { "display_name": "Nguyễn Lan", "avatar": "https://img/a.png", "shared_info": { "phone": 84_912_345_678_u64 } } })))
        .expect(1)
        .mount(&server)
        .await;
    let c = client(&server.uri());
    assert_eq!(c.send_text("AT", "U1", "chào").await.unwrap().as_deref(), Some("m1"));
    let map = data.as_object().unwrap();
    let r = c
        .send_zns(
            "AT",
            &ZnsRequest {
                phone: "84912345678",
                template_id: "555",
                template_data: map,
                tracking_id: Some("trk"),
                mode: Some("development"),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (r.msg_id.as_deref(), r.quota["remainingQuota"].as_str()),
        (Some("z1"), Some("499"))
    );
    let p = c.get_profile("AT", "U 1").await.unwrap();
    assert_eq!(
        (p.display_name.as_deref(), p.avatar.as_deref(), p.phone.as_deref()),
        (Some("Nguyễn Lan"), Some("https://img/a.png"), Some("84912345678"))
    );
}

#[tokio::test]
async fn gop_hai_dang_loi_cua_zalo_va_cau_nguoi_dung() {
    let server = MockServer::start().await;
    let c = client(&server.uri());
    // Dạng API: `{ error, message }`, kể cả HTTP 200.
    for (code, expect_auth) in [
        (-216, true),
        (-124, true),
        (-118, true),
        (-233, false),
        (-230, false),
        (-223, false),
    ] {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3.0/oa/message/cs"))
            .respond_with(ok(json!({ "error": code, "message": format!("err {code}") })))
            .mount(&s)
            .await;
        let e = client(&s.uri()).send_text("AT", "U", "x").await.unwrap_err();
        assert_eq!(
            (e.code, e.message.as_str(), e.is_auth_error(), e.is_config_error()),
            (code, format!("err {code}").as_str(), expect_auth, false)
        );
        assert!(!e.is_transient());
        let msg = describe_zalo_error(&e, Channel::Consult);
        assert!(
            !msg.contains(&format!("err {code}")),
            "không lộ nguyên văn lỗi Zalo: {msg}"
        );
    }
    // Dạng OAuth: `{ error, error_name, error_reason }` ở HTTP 400.
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(
            json!({ "error": -118, "error_name": "invalid_grant", "error_reason": "Refresh token is invalid" }),
        ))
        .mount(&server)
        .await;
    let e = c.refresh("a", "s", "RT").await.unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str(), e.http_status),
        (-118, "Refresh token is invalid", Some(400))
    );
    // Lỗi HTTP không có thân JSON ⇒ -2 (tạm thời); HTTP 5xx có JSON không mã ⇒ -status (tạm thời).
    Mock::given(method("POST"))
        .and(path("/message/template"))
        .respond_with(ResponseTemplate::new(502).set_body_string("<html>"))
        .mount(&server)
        .await;
    let e = c
        .send_zns(
            "AT",
            &ZnsRequest {
                phone: "84912345678",
                template_id: "1",
                template_data: &serde_json::Map::new(),
                tracking_id: None,
                mode: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!((e.code, e.http_status, e.is_transient()), (-2, Some(502), true));
    Mock::given(method("GET"))
        .and(path("/v3.0/oa/user/detail"))
        .respond_with(ResponseTemplate::new(503).set_body_json(json!({})))
        .mount(&server)
        .await;
    let e = c.get_profile("AT", "U").await.unwrap_err();
    assert_eq!((e.code, e.message.as_str(), e.is_transient()), (-503, "HTTP 503", true));
    // Phản hồi token thiếu trường ⇒ mã riêng, KHÔNG bị coi là lỗi cấu hình (bản Node nhầm).
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .respond_with(ok(json!({ "access_token": "x" })))
        .mount(&s)
        .await;
    let e = client(&s.uri()).refresh("a", "s", "RT").await.unwrap_err();
    assert_eq!(e.code, ZALO_BAD_TOKEN_BODY);
    assert!(!e.is_config_error());
}

#[tokio::test]
async fn mang_va_cau_hinh() {
    // Không kết nối được ⇒ -1, câu cố định, không lộ địa chỉ.
    let e = client("http://127.0.0.1:1")
        .send_text("AT", "U", "x")
        .await
        .unwrap_err();
    assert!(
        e.code == -1 && e.is_transient() && !e.message.contains("127.0.0.1"),
        "{e}"
    );
    // Địa chỉ gốc http ngoài loopback ⇒ lỗi cấu hình, chưa gửi gì.
    let e = client("http://openapi.example.test")
        .send_text("AT", "U", "x")
        .await
        .unwrap_err();
    assert_eq!(e.code, ZALO_CONFIG_ERROR);
    assert!(e.is_config_error() && !e.is_transient());
    assert!(describe_zalo_error(&e, Channel::Zns).starts_with("Cấu hình kết nối Zalo của máy chủ sai: "));
    // Chỉ điểm cuối được gọi mới bị kiểm biến: ZNS sai không làm hỏng điểm cuối token.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .respond_with(ok(
            json!({ "access_token": "a", "refresh_token": "r", "expires_in": 1 }),
        ))
        .mount(&server)
        .await;
    let base = server.uri();
    let env: Env = Arc::new(move |k| match k {
        "ZALO_OAUTH_BASE_URL" => Some(base.clone()),
        "ZALO_ZNS_BASE_URL" => Some("http://zns.example.test".into()),
        _ => None,
    });
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = ZaloClient::new(env);
    assert!(c.refresh("a", "s", "r").await.is_ok());
    assert!(
        c.send_zns(
            "AT",
            &ZnsRequest {
                phone: "84912345678",
                template_id: "1",
                template_data: &serde_json::Map::new(),
                tracking_id: None,
                mode: None
            }
        )
        .await
        .unwrap_err()
        .is_config_error()
    );
}
