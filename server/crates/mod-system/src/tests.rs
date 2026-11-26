use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache};

use super::*;

fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
    move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
}

fn deps() -> Arc<AccessDeps> {
    let db = Db::connect_lazy(&DbConfig::new("postgresql://u@127.0.0.1:1/none")).unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security.clone());
    Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(
            security,
            "jwt-secret-0123456789abcdef0123456789",
            &["svc"],
        )),
        permissions: PermissionService::new(db, cache),
        features: None,
        guards: Default::default(),
    })
}

async fn get_json(r: &Router, path: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
    let res = r
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (s, h) = (res.status(), res.headers().clone());
    let b = res.into_body().collect().await.unwrap().to_bytes();
    (s, h, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn full(cfg: SystemConfig) -> Router {
    let cfg = Arc::new(cfg);
    let (api, _) = api_router(deps(), cfg.clone()).into_parts();
    api.merge(extra_router(&cfg))
}

#[tokio::test]
async fn health_ready_live_giong_ban_ts() {
    let r = full(SystemConfig::from_lookup(env(&[])));
    let (s, _, b) = get_json(&r, "/api/v1/health").await;
    assert_eq!(
        (s, b["status"].as_str(), b["service"].as_str()),
        (StatusCode::OK, Some("ok"), Some("auth-service"))
    );
    let ts = b["timestamp"].as_str().unwrap();
    assert!(ts.len() == 24 && ts.ends_with('Z') && ts.as_bytes()[19] == b'.', "{ts}");
    assert_eq!(
        get_json(&r, "/api/v1/ready").await.2,
        json!({"status": "ready", "service": "auth-service"})
    );
    assert_eq!(get_json(&r, "/api/v1/live").await.2, json!({"status": "alive"}));
}

#[tokio::test]
async fn telemetry_config_null_khi_chua_bat_va_day_du_khi_bat() {
    let r = full(SystemConfig::from_lookup(env(&[])));
    assert_eq!(
        get_json(&r, "/api/v1/telemetry/config").await.2,
        json!({"sentry": null, "posthog": null})
    );
    let r = full(SystemConfig::from_lookup(env(&[
        ("SENTRY_DSN_WEB", " https://k@s.example/1 "),
        ("NODE_ENV", "staging"),
        ("TRINITY_RELEASE", "abc1234"),
        ("SENTRY_TRACES_SAMPLE_RATE", "1"),
        ("POSTHOG_KEY", "phc_x"),
        ("POSTHOG_REPLAY", "true"),
    ])));
    let b = get_json(&r, "/api/v1/telemetry/config").await.2;
    assert_eq!(
        b,
        json!({"sentry": {"dsn": "https://k@s.example/1", "environment": "staging", "release": "abc1234", "traces_sample_rate": 1},
               "posthog": {"key": "phc_x", "host": "https://us.i.posthog.com", "replay": true}})
    );
    // `1` in là `1` (không `1.0`) như JSON.stringify.
    let raw = serde_json::to_string(&b).unwrap();
    assert!(raw.contains("\"traces_sample_rate\":1}"), "{raw}");
    // Tỉ lệ ngoài [0,1] hoặc không phải số ⇒ 0.1; chuỗi rỗng ⇒ 0 (Number('') = 0, như Node).
    for (v, want) in [
        ("2", json!(0.1)),
        ("abc", json!(0.1)),
        ("", json!(0)),
        ("0.25", json!(0.25)),
    ] {
        let leak: &'static [(&'static str, &'static str)] = Box::leak(Box::new([
            ("SENTRY_DSN_WEB", "d"),
            (
                "SENTRY_TRACES_SAMPLE_RATE",
                Box::leak(v.to_owned().into_boxed_str()) as &'static str,
            ),
        ]));
        let r = full(SystemConfig::from_lookup(env(leak)));
        assert_eq!(
            get_json(&r, "/api/v1/telemetry/config").await.2["sentry"]["traces_sample_rate"],
            want,
            "{v:?}"
        );
    }
}

#[tokio::test]
async fn site_config_phap_ly_va_co_luc_chay() {
    let r = full(SystemConfig::from_lookup(env(&[])));
    assert_eq!(
        get_json(&r, "/api/v1/site-config").await.2,
        json!({"legal": {"contact_email": null, "company_name": null, "company_name_en": null, "company_tax_id": null,
                          "company_address": null, "company_phone": null}, "realtime_mode": "socket", "ds_v2": false})
    );
    let r = full(SystemConfig::from_lookup(env(&[
        ("LEGAL_COMPANY_NAME", "  Công ty A "),
        ("LEGAL_CONTACT_EMAIL", "a@example.com"),
        ("LEGAL_COMPANY_TAX_ID", "   "),
        ("REALTIME_MODE", "poll"),
        ("DS_V2_ENABLED", "true"),
    ])));
    let b = get_json(&r, "/api/v1/site-config").await.2;
    assert_eq!(b["legal"]["company_name"], "Công ty A");
    assert_eq!(b["legal"]["contact_email"], "a@example.com");
    assert!(
        b["legal"]["company_tax_id"].is_null(),
        "chuỗi toàn khoảng trắng như không đặt"
    );
    assert_eq!(
        (b["realtime_mode"].as_str(), b["ds_v2"].as_bool()),
        (Some("poll"), Some(true))
    );
    // Tên biến cũ lúc build vẫn được nhận khi chưa có biến mới.
    let r = full(SystemConfig::from_lookup(env(&[
        ("NEXT_PUBLIC_REALTIME_MODE", "poll"),
        ("NEXT_PUBLIC_DS_V2", "true"),
    ])));
    let b = get_json(&r, "/api/v1/site-config").await.2;
    assert_eq!(
        (b["realtime_mode"].as_str(), b["ds_v2"].as_bool()),
        (Some("poll"), Some(true))
    );
}

#[tokio::test]
async fn build_id_no_store_va_nguon() {
    let r = full(SystemConfig::from_lookup(env(&[("TRINITY_BUILD_ID", " b-123 ")])));
    let (s, h, b) = get_json(&r, "/api/build-id").await;
    assert_eq!((s, b), (StatusCode::OK, json!({"buildId": "b-123"})));
    assert_eq!(h.get("cache-control").unwrap(), "no-store, must-revalidate");
    let r = full(SystemConfig::from_lookup(env(&[])));
    let id = get_json(&r, "/api/build-id").await.2["buildId"]
        .as_str()
        .map(str::to_owned)
        .unwrap();
    assert!(
        id == "unknown" || BUILD_ID_COMPILED.is_some_and(|c| c.trim() == id),
        "{id}"
    );
}

#[tokio::test]
async fn docs_chi_khi_ngoai_production_hoac_bat_co() {
    for (pairs, on) in [
        (&[("NODE_ENV", "production")][..], false),
        (&[("NODE_ENV", "production"), ("SWAGGER_ENABLED", "false")][..], false),
        (&[("NODE_ENV", "production"), ("SWAGGER_ENABLED", "true")][..], true),
        (&[("NODE_ENV", "development")][..], true),
        (&[][..], true),
    ] {
        let pairs: &'static [(&'static str, &'static str)] = Box::leak(pairs.to_vec().into_boxed_slice());
        let r = full(SystemConfig::from_lookup(env(pairs)));
        let want = if on { StatusCode::OK } else { StatusCode::NOT_FOUND };
        assert_eq!(get_json(&r, "/docs").await.0, want, "{pairs:?}");
        assert_eq!(get_json(&r, "/docs-json").await.0, want, "{pairs:?}");
    }
}

#[tokio::test]
async fn docs_json_la_openapi_do_utoipa_sinh() {
    let r = full(SystemConfig::from_lookup(env(&[])));
    let (s, _, b) = get_json(&r, "/docs-json").await;
    assert_eq!(s, StatusCode::OK);
    assert!(b["openapi"].as_str().is_some_and(|v| v.starts_with("3.")), "{b}");
    for p in [
        "/api/v1/health",
        "/api/v1/site-config",
        "/api/build-id",
        "/api/v1/telemetry/identity",
    ] {
        assert!(b["paths"][p]["get"].is_object(), "thiếu {p}");
    }
}

#[tokio::test]
async fn identity_can_dang_nhap() {
    let r = full(SystemConfig::from_lookup(env(&[("JWT_SECRET", "j")])));
    let (s, _, _) = get_json(&r, "/api/v1/telemetry/identity").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[test]
fn bang_route_khop_hop_dong() {
    // Mọi route của module khớp `routes.json` (route chỉ có ở Rust nằm ở RUST_ONLY_ROUTES).
    let rep = trinity_http::router::check::check_embedded(&routes(), false);
    assert!(rep.ok(), "{:#?}", rep.problems);
}

/// Đợt a trong tệp sở hữu (K27): `site-config` chỉ có ở Rust nên PHẢI thuộc `rust`, nếu không chiến lược proxy gửi nó sang Node và
/// nhận 404. Mẫu ở `contracts/ownership-wave-a.json`.
#[test]
fn tep_so_huu_dot_a_giao_route_cua_module_cho_rust() {
    use trinity_kernel::ownership::{Owner, Ownership};
    let own = Ownership::parse(
        include_str!("../../../contracts/ownership-wave-a.json"),
        "ownership-wave-a.json",
    )
    .unwrap();
    for r in routes() {
        assert_eq!(own.route("GET", r.path).owner, Owner::Rust, "{}", r.path);
    }
    for p in ["/api/build-id", "/docs", "/docs-json", "/api/v1/site-config"] {
        assert_eq!(own.route("GET", p).owner, Owner::Rust, "{p}");
    }
    // Chỉ các route của đợt này; phần còn lại thuộc Node.
    assert_eq!(own.route("GET", "/api/v1/settings").owner, Owner::Node);
    assert_eq!(own.route("POST", "/api/v1/site-config").owner, Owner::Node);
}
