//! M33: phần thuần (không DB) — lọc nhật ký đối chiếu với bản Node, cờ trạng thái, cursor.

use std::collections::HashMap;

use serde_json::{Value, json};
use trinity_integrations::audit::{
    MAX_ERROR, MAX_STRING, decode_cursor, encode_cursor, sanitize_metadata, sanitize_text,
};
use trinity_integrations::status;

#[test]
fn loc_nhat_ky_khop_ban_node() {
    let g: Value = serde_json::from_str(include_str!("fixtures/sanitize.json")).unwrap();
    for t in g["texts"].as_array().unwrap() {
        let (i, o) = (t["in"].as_str().unwrap(), t["out"].as_str().unwrap());
        assert_eq!(sanitize_text(i, MAX_STRING), o, "text {i:?}");
    }
    for m in g["metas"].as_array().unwrap() {
        assert_eq!(sanitize_metadata(Some(&m["in"])), m["out"], "meta {}", m["in"]);
    }
    for t in g["errors"].as_array().unwrap() {
        let out = sanitize_text(t["in"].as_str().unwrap(), MAX_ERROR);
        assert_eq!(out, t["out"].as_str().unwrap());
        assert!(out.encode_utf16().count() <= MAX_ERROR, "vượt varchar(500)");
    }
    assert_eq!(sanitize_metadata(None), json!({}));
    assert_eq!(sanitize_metadata(Some(&json!("chuoi"))), json!({}));
}

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let m: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    move |k| m.get(k).cloned()
}

#[test]
fn status_mac_dinh_tat_het() {
    let e = env(&[]);
    assert_eq!(
        status::status(&e),
        json!({"webhooks_enabled": false, "mcp_enabled": false, "secret_key_configured": false,
               "mcp_base_url_configured": false, "mcp_url": null})
    );
    assert!(!status::any_enabled(&e));
}

#[test]
fn status_co_va_url_mcp() {
    let key = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU="; // 32 byte
    let e = env(&[
        ("INTEGRATIONS_WEBHOOKS_ENABLED", " TRUE "),
        ("INTEGRATIONS_MCP_ENABLED", "1"),
        ("INTEGRATIONS_SECRET_KEY", key),
        ("INTEGRATIONS_PUBLIC_BASE_URL", "https://crm.example.com/"),
    ]);
    assert_eq!(
        status::status(&e),
        json!({"webhooks_enabled": true, "mcp_enabled": true, "secret_key_configured": true,
               "mcp_base_url_configured": true, "mcp_url": "https://crm.example.com/api/v1/mcp"})
    );
}

#[test]
fn khoa_bi_mat_sai_thi_khong_cau_hinh() {
    for bad in [
        "",
        "   ",
        "abc",
        "QUJD!",
        "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=QUJD",
    ] {
        assert!(
            !status::secret_key_configured(&env(&[("INTEGRATIONS_SECRET_KEY", bad)])),
            "{bad:?}"
        );
    }
    // base64url không đệm vẫn nhận (Node `Buffer.from(raw, 'base64')` nhận cả hai bảng chữ)
    assert!(status::secret_key_configured(&env(&[(
        "INTEGRATIONS_SECRET_KEY",
        "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU"
    )])));
}

#[test]
fn url_goc_cong_khai_chi_nhan_dang_hop_le() {
    let u =
        |v: &str, node: &str| status::public_base_url(&env(&[("INTEGRATIONS_PUBLIC_BASE_URL", v), ("NODE_ENV", node)]));
    assert_eq!(
        u("https://a.example.com", "production").as_deref(),
        Some("https://a.example.com")
    );
    assert_eq!(
        u("http://localhost:3000", "development").as_deref(),
        Some("http://localhost:3000")
    );
    for bad in [
        ("http://localhost:3000", "production"),
        ("http://a.example.com", "development"),
        ("https://a.example.com/x", "production"),
        ("https://a.example.com/?q=1", "production"),
        ("https://u:p@a.example.com", "production"),
        ("https://a.example.com/#f", "production"),
        ("https://a.example.com/?q", "production"),
        ("không phải url", "production"),
        ("", "production"),
    ] {
        assert_eq!(u(bad.0, bad.1), None, "{bad:?}");
    }
    // cờ MCP bật nhưng thiếu URL gốc ⇒ OAuth/MCP không chạy, mcp_url là null
    let e = env(&[("INTEGRATIONS_MCP_ENABLED", "true")]);
    assert!(!status::oauth_enabled(&e));
    assert_eq!(status::status(&e)["mcp_url"], Value::Null);
}

#[test]
fn cursor_cung_dinh_dang_node() {
    // Node: `${createdAt.getTime()}.${id}`
    let (at, id) = decode_cursor("1700000000123.42").unwrap();
    assert_eq!(at.timestamp_millis(), 1_700_000_000_123);
    assert_eq!(id, 42);
    assert_eq!(encode_cursor(at, id), "1700000000123.42");
    for bad in [
        "",
        "1",
        "1.",
        ".1",
        "a.1",
        "1.b",
        "1234567890123456.1",
        "1.12345678901234567890",
        "1.2.3",
    ] {
        assert!(decode_cursor(bad).is_none(), "{bad:?}");
    }
}
