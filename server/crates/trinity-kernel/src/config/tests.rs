use super::vars::{ENV_VARS, VarKind, lookup};
use super::*;

const ENV_EXAMPLE: &str = include_str!("../../../../../.env.example");

fn env(pairs: &[(&str, &str)]) -> EnvMap {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

/// Cấu hình tối thiểu hợp lệ ở production.
fn good() -> EnvMap {
    env(&[
        ("NODE_ENV", "production"),
        ("JWT_SECRET", &"a".repeat(64)),
        ("SERVICE_SECRET", &"b".repeat(64)),
        ("DATABASE_URL", "postgresql://trinity:Xy9@db:5432/trinity"),
    ])
}

fn with(mut base: EnvMap, pairs: &[(&str, &str)]) -> EnvMap {
    for (k, v) in pairs {
        base.insert((*k).to_owned(), (*v).to_owned());
    }
    base
}

fn load(e: &EnvMap) -> Loaded {
    Config::from_env(e).unwrap_or_else(|err| panic!("cấu hình phải hợp lệ: {err}"))
}

fn err(e: &EnvMap) -> Vec<String> {
    Config::from_env(e).expect_err("cấu hình phải lỗi").problems
}

/// Mọi biến trong `.env.example`, kể cả dòng đang comment (`# KEY=...`), kèm giá trị mẫu.
fn example_vars() -> Vec<(String, String)> {
    ENV_EXAMPLE
        .lines()
        .filter_map(|line| {
            let l = line.trim_start().trim_start_matches('#').trim_start();
            let (k, v) = l.split_once('=')?;
            let ok = !k.is_empty()
                && k.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
                && k.bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
            // Giá trị mẫu: bỏ comment cuối dòng.
            let v = v.split("  #").next().unwrap_or("").trim();
            ok.then(|| (k.to_owned(), v.to_owned()))
        })
        .collect()
}

/// Giá trị hợp lệ để thử một biến (giá trị trong `.env.example` nếu có).
fn sample(name: &str, example: &str) -> String {
    match name {
        "FACEBOOK_GRAPH_BASE_URL" | "ZALO_OAUTH_BASE_URL" | "ZALO_OPENAPI_BASE_URL" | "ZALO_ZNS_BASE_URL" => {
            "https://fake.example.com".to_owned()
        }
        "SOCIAL_MAX_VIDEO_MB" | "DB_POOL_SIZE" | "PRISMA_CONNECTION_LIMIT" => "9".to_owned(),
        _ if example.is_empty() => "true".to_owned(),
        _ => example.to_owned(),
    }
}

#[test]
fn bang_moi_bien_trong_env_example_duoc_nhan_hoac_canh_bao() {
    let vars = example_vars();
    assert!(vars.len() > 80, "đọc được quá ít biến từ .env.example: {}", vars.len());
    let mut missing = Vec::new();
    for (name, example) in &vars {
        let Some(known) = lookup(name) else {
            missing.push(name.clone());
            continue;
        };
        let value = sample(name, example);
        // Ngoài production: giá trị mẫu change-me của .env.example không làm cấu hình lỗi.
        let base = with(good(), &[("NODE_ENV", "development")]);
        let loaded = load(&with(base, &[(name, &value)]));
        let warned = loaded
            .warnings
            .iter()
            .any(|w| w.starts_with(&format!("{name} không còn dùng")));
        match known.kind {
            VarKind::Retired(_) => assert!(warned, "{name} không còn dùng mà không có cảnh báo"),
            VarKind::Server => {
                assert!(!warned, "{name} bị cảnh báo nhầm");
                assert_eq!(loaded.config.var(name), Some(value.as_str()), "{name} không đọc được");
            }
            VarKind::Elsewhere(_) => assert!(!warned, "{name} bị cảnh báo nhầm"),
        }
    }
    assert!(
        missing.is_empty(),
        "biến trong .env.example chưa có trong config::vars::ENV_VARS: {missing:?}"
    );
}

#[test]
fn bang_bien_khong_trung_ten() {
    let mut names: Vec<&str> = ENV_VARS.iter().map(|v| v.name).collect();
    names.sort_unstable();
    let before = names.len();
    names.dedup();
    assert_eq!(before, names.len(), "tên biến trùng trong ENV_VARS");
}

#[test]
fn bien_khong_con_dung_bao_mot_dong_moi_bien() {
    let loaded = load(&with(
        good(),
        &[
            ("REDIS_URL", "redis://x"),
            ("PORT", "4000"),
            ("TENANT_MAX_CLIENTS", " "),
        ],
    ));
    assert_eq!(loaded.warnings.len(), 2, "{:?}", loaded.warnings);
    assert!(loaded.warnings[0].starts_with("PORT không còn dùng"));
    assert!(loaded.warnings[1].starts_with("REDIS_URL không còn dùng"));
    // PORT=4000 của bản Node không đổi cổng chính.
    assert_eq!(loaded.config.http_port, 3000);
    assert_eq!(
        loaded.config.compat_api_port, None,
        "không đặt COMPAT_API_PORT thì không mở cổng thứ hai"
    );
}

#[test]
fn change_me_o_production_la_loi() {
    let probs = err(&env(&[
        ("NODE_ENV", "production"),
        ("JWT_SECRET", "change-me-generate-with-openssl-rand-hex-32"),
        ("SERVICE_SECRET", "change-me-generate-with-openssl-rand-hex-32"),
        (
            "DATABASE_URL",
            "postgresql://trinity:change-me-db-password@localhost:5432/trinity",
        ),
    ]));
    assert_eq!(probs.len(), 3, "{probs:?}");
    assert!(!probs.join(" ").contains("generate-with"), "lộ giá trị secret");
    // Ngoài production bản Node không kiểm (để chạy thử bằng .env.example).
    let dev = with(good(), &[("NODE_ENV", "development"), ("JWT_SECRET", "change-me")]);
    assert!(Config::from_env(&dev).is_ok());
}

#[test]
fn insecure_secrets_giong_ban_node() {
    assert!(insecure_secrets(&good()).is_empty());
    assert_eq!(
        insecure_secrets(&with(good(), &[("JWT_SECRET", "secret123")]))[0],
        "JWT_SECRET ngắn hơn 32 ký tự — sinh mới bằng: openssl rand -hex 32"
    );
    assert!(insecure_secrets(&with(good(), &[("JWT_SECRET", "")])).contains(&"Thiếu JWT_SECRET".to_owned()));
    assert!(
        insecure_secrets(&with(good(), &[("INTEGRATIONS_SECRET_KEY", "change-me")]))[0]
            .starts_with("INTEGRATIONS_SECRET_KEY")
    );
    assert_eq!(
        insecure_secrets(&with(good(), &[("POSTGRES_PASSWORD", "CHANGE-ME-db")])),
        vec!["Mật khẩu Postgres vẫn là giá trị mẫu change-me-db-password".to_owned()]
    );
}

#[test]
fn thieu_database_url_o_production_la_loi() {
    let mut e = good();
    e.remove("DATABASE_URL");
    assert_eq!(err(&e), vec!["Thiếu DATABASE_URL".to_owned()]);
    let dev = with(e, &[("NODE_ENV", "development")]);
    assert!(Config::from_env(&dev).is_ok(), "ngoài production chưa bắt buộc");
}

#[test]
fn thieu_jwt_secret_ngoai_production_cung_loi() {
    assert_eq!(
        err(&env(&[("NODE_ENV", "development")])),
        vec!["Thiếu JWT_SECRET".to_owned()]
    );
}

#[test]
fn doc_bon_bien_dia_chi_goc_graph_zalo() {
    let d = load(&good()).config.external_apis;
    assert_eq!(d, ExternalApis::default());
    assert_eq!(d.graph, "https://graph.facebook.com");
    assert_eq!(d.graph_video, "https://graph-video.facebook.com");
    assert_eq!(d.zalo_oauth, "https://oauth.zaloapp.com");
    assert_eq!(d.zalo_openapi, "https://openapi.zalo.me");
    assert_eq!(d.zalo_zns, "https://business.openapi.zalo.me");

    let set = with(
        good(),
        &[
            ("FACEBOOK_GRAPH_BASE_URL", "http://127.0.0.1:9000/fb/"),
            ("ZALO_OAUTH_BASE_URL", "http://127.0.0.1:9000/zoauth"),
            ("ZALO_OPENAPI_BASE_URL", "http://localhost:9000/zapi"),
            ("ZALO_ZNS_BASE_URL", "http://[::1]:9000/zns"),
        ],
    );
    let a = load(&set).config.external_apis;
    assert_eq!(a.graph, "http://127.0.0.1:9000/fb");
    assert_eq!(
        a.graph_video, "http://127.0.0.1:9000/fb",
        "video đi cùng địa chỉ Graph khi đặt env"
    );
    assert_eq!(a.zalo_oauth, "http://127.0.0.1:9000/zoauth");
    assert_eq!(a.zalo_openapi, "http://localhost:9000/zapi");
    assert_eq!(a.zalo_zns, "http://[::1]:9000/zns");

    let probs = err(&with(
        good(),
        &[
            ("FACEBOOK_GRAPH_BASE_URL", "http://graph.example.com"),
            ("ZALO_ZNS_BASE_URL", "ftp://x"),
        ],
    ));
    assert_eq!(
        probs,
        vec![
            "FACEBOOK_GRAPH_BASE_URL: http:// chỉ dùng cho máy chủ cục bộ (localhost, 127.0.0.1, ::1) — dùng https://"
                .to_owned(),
            "ZALO_ZNS_BASE_URL chỉ nhận https:// (http:// cho máy chủ cục bộ)".to_owned(),
        ]
    );
}

#[test]
fn api_base_url_giong_ban_node() {
    let f =
        |v: &str, node_env: &str| api_base_url("X_BASE", "https://a", &env(&[("X_BASE", v), ("NODE_ENV", node_env)]));
    assert_eq!(
        api_base_url("X_BASE", "https://api.example.com", &env(&[])).unwrap(),
        "https://api.example.com"
    );
    assert_eq!(f("  ", "test").unwrap(), "https://a");
    assert_eq!(
        f("https://fake.test/graph/", "test").unwrap(),
        "https://fake.test/graph"
    );
    for node_env in ["production", "development", "test"] {
        assert_eq!(f("http://127.0.0.1:9000", node_env).unwrap(), "http://127.0.0.1:9000");
        assert_eq!(
            f("http://localhost:9000/fake", node_env).unwrap(),
            "http://localhost:9000/fake"
        );
        assert_eq!(f("http://[::1]:9000", node_env).unwrap(), "http://[::1]:9000");
        assert!(
            f("http://graph.example.com", node_env)
                .unwrap_err()
                .contains("http:// chỉ dùng cho máy chủ cục bộ")
        );
        assert!(
            f("http://10.0.0.5:9000", node_env)
                .unwrap_err()
                .contains("máy chủ cục bộ")
        );
    }
    assert_eq!(
        f("https://graph.example.com", "production").unwrap(),
        "https://graph.example.com"
    );
    assert!(f("graph.example.com", "test").unwrap_err().contains("không phải URL"));
    assert!(f("ftp://x", "test").unwrap_err().contains("chỉ nhận https"));
    assert!(f("https://x/?a=1", "test").unwrap_err().contains("query"));
    assert!(f("https://x/#a", "test").unwrap_err().contains("query"));
    // `?`/`#` trơ trọi cũng bị từ chối.
    assert!(f("https://x/?", "test").unwrap_err().contains("query"));
    assert!(f("https://x/#", "test").unwrap_err().contains("query"));
    assert!(is_loopback_host("127.1.2.3"));
    assert!(is_loopback_host("[::1]"));
    assert!(!is_loopback_host("localhost.example.com"));
    assert!(!is_loopback_host("127.0.0.1.example.com"));
}

#[test]
fn cong_pool_tls_video() {
    let c = load(&good()).config;
    assert_eq!(
        (c.http_port, c.compat_api_port, c.db_pool_size, c.social_max_video_mb),
        (3000, None, 8, 200)
    );
    assert_eq!(c.tls, TlsMode::Off);
    assert!(!c.swagger_enabled, "production mặc định tắt /docs");

    let c = load(&with(good(), &[("PRISMA_CONNECTION_LIMIT", "5")])).config;
    assert_eq!(c.db_pool_size, 5, "tên cũ vẫn nhận");
    let c = load(&with(
        good(),
        &[("PRISMA_CONNECTION_LIMIT", "5"), ("DB_POOL_SIZE", "12")],
    ))
    .config;
    assert_eq!(c.db_pool_size, 12, "DB_POOL_SIZE thắng");

    assert_eq!(
        load(&with(good(), &[("COMPAT_API_PORT", "4000")]))
            .config
            .compat_api_port,
        Some(4000)
    );
    // Trùng cổng chính chỉ lỗi khi COMPAT_API_PORT được đặt thật.
    let probs = err(&with(
        good(),
        &[("TRINITY_HTTP_PORT", "4000"), ("COMPAT_API_PORT", "4000")],
    ));
    assert!(probs[0].contains("trùng nhau"), "{probs:?}");
    assert_eq!(
        load(&with(good(), &[("TRINITY_HTTP_PORT", "4000")])).config.http_port,
        4000
    );
    // Cổng sai chỉ báo một lỗi, không kéo theo "trùng nhau".
    assert_eq!(
        err(&with(good(), &[("COMPAT_API_PORT", "0")])),
        vec!["COMPAT_API_PORT=0 không phải số cổng hợp lệ (1–65535)".to_owned()]
    );
    assert_eq!(
        err(&with(good(), &[("TRINITY_HTTP_PORT", "x"), ("COMPAT_API_PORT", "y")])).len(),
        2
    );
    assert_eq!(load(&with(good(), &[("TLS_MODE", "OFF")])).config.tls, TlsMode::Off);
    assert!(err(&with(good(), &[("DB_POOL_SIZE", "abc")]))[0].contains("DB_POOL_SIZE"));
    assert!(err(&with(good(), &[("TLS_MODE", "files")]))[0].contains("TLS_CERT_FILE"));
    assert!(err(&with(good(), &[("TLS_MODE", "auto")]))[0].contains("off | files"));
    let c = load(&with(
        good(),
        &[
            ("TLS_MODE", "Files"),
            ("TLS_CERT_FILE", "/c.pem"),
            ("TLS_KEY_FILE", "/k.pem"),
        ],
    ))
    .config;
    assert_eq!(
        c.tls,
        TlsMode::Files {
            cert: "/c.pem".into(),
            key: "/k.pem".into()
        }
    );

    // Như maxVideoBytes() của bản Node: giá trị lạ ⇒ 200.
    for (v, want) in [
        ("95", 95),
        ("1", 1),
        ("abc", 200),
        ("0", 200),
        ("95.5", 200),
        ("500", 200),
    ] {
        let l = load(&with(good(), &[("SOCIAL_MAX_VIDEO_MB", v)]));
        assert_eq!(l.config.social_max_video_mb, want, "SOCIAL_MAX_VIDEO_MB={v}");
        assert_eq!(
            l.warnings.is_empty(),
            want != 200,
            "SOCIAL_MAX_VIDEO_MB={v}: {:?}",
            l.warnings
        );
    }

    let c = load(&with(good(), &[("SWAGGER_ENABLED", "true"), ("MULTI_TENANT", "true")])).config;
    assert!(c.swagger_enabled && c.multi_tenant);
    let c = load(&with(good(), &[("NODE_ENV", "development")])).config;
    assert!(c.swagger_enabled && !c.is_production());
}

#[test]
fn service_secret_uu_tien_internal() {
    let c = load(&with(good(), &[("INTERNAL_SERVICE_SECRET", &"c".repeat(40))])).config;
    assert_eq!(c.service_secret.as_deref(), Some("c".repeat(40).as_str()));
    let c = load(&good()).config;
    assert_eq!(c.service_secret.as_deref(), Some("b".repeat(64).as_str()));
}

#[test]
fn debug_khong_in_secret() {
    let s = format!("{:?}", load(&good()).config);
    assert!(!s.contains("aaaa") && !s.contains("Xy9"), "{s}");
}

#[test]
#[should_panic(expected = "chưa khai")]
fn var_chi_nhan_bien_da_khai() {
    let _ = load(&good()).config.var("REDIS_URL");
}
