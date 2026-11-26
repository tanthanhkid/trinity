//! M34 phần thuần: chữ ký, secret, lịch thử lại và che/lọc payload, đối chiếu với golden sinh từ bản Node
//! (`tests/fixtures/gen-webhook.mjs`).

use serde_json::Value;
use trinity_integrations::webhooks::payload::{ActorScopes, Scope, evaluate_event};
use trinity_integrations::webhooks::retry::next_retry_delay_sec;
use trinity_integrations::webhooks::secret::{
    decrypt_secret, encrypt_secret, generate_webhook_secret, load_secret_key,
};
use trinity_integrations::webhooks::signature::{build_signature_header, compute_signature, verify_signature_header};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/webhook.json")).unwrap()
}

#[test]
fn chu_ky_khop_node() {
    let g = golden();
    for c in g["sig"].as_array().unwrap() {
        let (secret, t, body) = (
            c["secret"].as_str().unwrap(),
            c["t"].as_i64().unwrap(),
            c["body"].as_str().unwrap(),
        );
        assert_eq!(
            compute_signature(secret, t, body.as_bytes()),
            c["sig"].as_str().unwrap()
        );
        assert_eq!(
            build_signature_header(secret, body.as_bytes(), t * 1000 + 999),
            c["header"].as_str().unwrap()
        );
    }
}

#[test]
fn kiem_chu_ky_khop_node() {
    let g = golden();
    let now = g["now_ms"].as_i64().unwrap();
    for c in g["verify"].as_array().unwrap() {
        let h = c["header"].as_str().unwrap();
        assert_eq!(
            verify_signature_header("s", b"b", Some(h), 300, now),
            c["ok"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
    }
    assert!(!verify_signature_header("s", b"b", None, 300, now));
    // Thân khác ⇒ sai.
    let h = build_signature_header("s", b"b", now);
    assert!(verify_signature_header("s", b"b", Some(&h), 300, now));
    assert!(!verify_signature_header("s", b"c", Some(&h), 300, now));
    assert!(!verify_signature_header("khac", b"b", Some(&h), 300, now));
}

#[test]
fn giai_ma_secret_node_va_vong_tron() {
    let g = golden();
    let get = |v: String| move |k: &str| (k == "INTEGRATIONS_SECRET_KEY").then(|| v.clone());
    let key = load_secret_key(&get(g["key_b64"].as_str().unwrap().to_owned())).unwrap();
    assert_eq!(key, [7u8; 32]);
    for c in g["enc"].as_array().unwrap() {
        assert_eq!(
            decrypt_secret(c["enc"].as_str().unwrap(), &key).unwrap(),
            c["plain"].as_str().unwrap()
        );
    }
    let e = encrypt_secret("tiếng Việt 😀", &key);
    assert!(e.starts_with("v1.") && e.split('.').count() == 4);
    assert_eq!(decrypt_secret(&e, &key).unwrap(), "tiếng Việt 😀");
    assert_ne!(e, encrypt_secret("tiếng Việt 😀", &key), "iv ngẫu nhiên");
    // Sai khoá, dữ liệu hỏng, sai định dạng.
    assert!(decrypt_secret(&e, &[8u8; 32]).is_err());
    let mut parts: Vec<String> = e.split('.').map(str::to_owned).collect();
    parts[3].push('A');
    assert!(decrypt_secret(&parts.join("."), &key).is_err());
    assert!(decrypt_secret("v2.a.b.c", &key).is_err());
    assert!(decrypt_secret("rac", &key).is_err());
    let s = generate_webhook_secret();
    assert!(s.starts_with("whsec_") && s.len() == 6 + 43);
}

#[test]
fn nap_khoa_khop_node() {
    for c in golden()["keys"].as_array().unwrap() {
        let raw = c["raw"].as_str().unwrap().to_owned();
        let ok = load_secret_key(&move |_: &str| Some(raw.clone())).is_ok();
        assert_eq!(ok, c["ok"].as_bool().unwrap(), "{}", c["raw"]);
    }
}

#[test]
fn lich_thu_lai_khop_node() {
    for c in golden()["retry"].as_array().unwrap() {
        let n = i32::try_from(c["attempts"].as_i64().unwrap()).unwrap();
        let want = c["ms"].as_u64().map(|ms| ms / 1000);
        assert_eq!(next_retry_delay_sec(n), want, "attempts {n}");
    }
}

fn scope(v: &Value) -> Scope {
    match v {
        Value::String(s) if s == "all" => Scope::All,
        Value::Array(a) => Scope::Owners(a.iter().map(|x| i32::try_from(x.as_i64().unwrap()).unwrap()).collect()),
        _ => Scope::None,
    }
}

fn scopes(v: &Value) -> ActorScopes {
    ActorScopes {
        contacts_view: scope(&v["contactsView"]),
        deals_view: scope(&v["dealsView"]),
        pos_sell: scope(&v["posSell"]),
        phone_full: scope(&v["phoneFull"]),
        custom_view: scope(&v["customView"]),
        custom_phone_full: scope(&v["customPhoneFull"]),
        role_ids: v["roleIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| i32::try_from(x.as_i64().unwrap()).unwrap())
            .collect(),
        can_manage_custom_objects: v["canManageCustomObjects"].as_bool().unwrap(),
        can_social_post: v["canSocialPost"].as_bool().unwrap(),
    }
}

#[test]
fn che_va_loc_payload_khop_node() {
    let g = golden();
    let cases = g["payload"].as_array().unwrap();
    assert!(cases.len() > 100);
    for c in cases {
        let out = evaluate_event(c["type"].as_str().unwrap(), &c["payload"], &scopes(&c["scopes"]));
        let label = format!("{} / {} / {}", c["type"], c["scopes_name"], c["payload"]);
        assert_eq!(out.is_some(), c["deliver"].as_bool().unwrap(), "deliver: {label}");
        if let Some(d) = out {
            assert_eq!(d, c["data"], "data: {label}");
        }
    }
}
