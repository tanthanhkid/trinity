//! `trinity serve` và `trinity healthcheck` (PLAN 4.1, K12/D01).
//!
//! `serve` dựng: cấu hình (K03) → pool DB → xác thực/phân quyền → router của từng module (mỗi module một trạng thái riêng)
//! → lớp biên (CORS, giới hạn body) → socket `/notif-ws` (K33) → bộ phân phối strangler (K17) với IP khách (K16) ngoài cùng.
//! Scheduler và worker hàng đợi chạy nền (tự tắt khi `TRINITY_TEST_HOOKS=1` với build `--features test-hooks`, K34).
//!
//! Các router module có trạng thái khác nhau nên không `merge` thẳng được (mỗi `ApiRouter` mang `fallback` 404 riêng mà axum
//! không cho gộp hai fallback). [`mount`] đăng ký từng route đã khai (`RouteSpec`) lên router chung, chuyển request nguyên vẹn
//! sang router con (đã gắn trạng thái, vẫn đi qua lớp thực thi quyền của chính nó).

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::Request;
use axum::http::Uri;
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::Response;
use axum::routing::{MethodFilter, on_service};
use clap::Args;
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::edge::body::{error_response, json_limit};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::edge::cors::{CorsConfig, cors_layer};
use trinity_http::router::{AccessDeps, ApiRouter, NamedGuard};
use trinity_http::strangler::{
    ListenerScheme, NodeProxy, OwnershipTable, ProxyTimeouts, dispatcher, initial_from_routes_env,
    spawn_sighup_reloader,
};
use trinity_kernel::config::{Config, TlsMode, process_env};
use trinity_kernel::error::HttpError;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};
use trinity_storage::{LocalDiskDriver, LocalUploadsStore};

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Địa chỉ nghe (mặc định: `LISTEN_HOST`, rồi `::` / `0.0.0.0`).
    #[arg(long)]
    host: Option<String>,
    /// Cổng nghe (mặc định: `TRINITY_HTTP_PORT`, rồi 3000).
    #[arg(long)]
    port: Option<u16>,
}

fn err(msg: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{msg}");
}

pub fn run(args: ServeArgs) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            err(&format!("không dựng được runtime: {e}"));
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(serve(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            err(&msg);
            ExitCode::FAILURE
        }
    }
}

/// `trinity healthcheck`: GET `/api/v1/health` trên loopback; 200 thì mã 0, ngược lại mã 1.
pub fn healthcheck() -> ExitCode {
    let (env, _) = process_env();
    let port = env
        .get("TRINITY_HTTP_PORT")
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(3000);
    match probe_health(port) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            err(&format!("healthcheck lỗi: {e}"));
            ExitCode::FAILURE
        }
    }
}

fn probe_health(port: u16) -> std::io::Result<bool> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    s.set_write_timeout(Some(Duration::from_secs(5)))?;
    s.write_all(b"GET /api/v1/health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf)?;
    let head = String::from_utf8_lossy(&buf);
    Ok(head
        .lines()
        .next()
        .is_some_and(|l| l.split_whitespace().nth(1) == Some("200")))
}

/// Đăng ký mọi route đã khai của `api` lên `outer`, chuyển tới router con đã gắn `state`.
fn mount<S: Clone + Send + Sync + 'static>(outer: Router, api: ApiRouter<S>, state: S) -> Router {
    let (router, table) = api.into_parts();
    let router: Router = router.with_state(state);
    let mut outer = outer;
    for spec in table {
        let Ok(filter) = MethodFilter::try_from(spec.method.clone()) else {
            continue;
        };
        outer = outer.route(&spec.axum_path(), on_service(filter, router.clone()));
    }
    outer
}

/// 404 dạng Nest cho đường dẫn không thuộc module nào.
async fn not_found(req: Request) -> Response {
    error_response(&HttpError::with_label(
        404,
        format!("Cannot {} {}", req.method(), req.uri().path()),
        "Not Found",
    ))
}

fn uri_of(raw: &str, what: &str) -> Result<Uri, String> {
    raw.trim()
        .parse::<Uri>()
        .map_err(|e| format!("{what}={raw} không phải URL hợp lệ: {e}"))
}

async fn serve(args: ServeArgs) -> Result<(), String> {
    let (env, dropped) = process_env();
    for name in &dropped {
        err(&format!(
            "cảnh báo: biến {name} có tên hoặc giá trị không phải UTF-8, bỏ qua"
        ));
    }
    let loaded = Config::from_env(&env).map_err(|e| e.to_string())?;
    let config = loaded.config;
    // Log JSON (K04). Lỗi cài lần hai (test) bỏ qua.
    let _ = trinity_obs::log::init_json();
    for w in &loaded.warnings {
        tracing::warn!("{w}");
    }
    let mut problems = trinity_http::edge::client_ip::startup_problems(&env);
    let listen_host = args.host.clone().or_else(|| {
        env.get("LISTEN_HOST")
            .map(|h| h.trim().to_owned())
            .filter(|h| !h.is_empty())
    });
    problems.extend(trinity_http::edge::client_ip::tunnel_listen_problem(
        Some(listen_host.as_deref().unwrap_or("::")),
        &env,
    ));
    if !problems.is_empty() {
        return Err(format!(
            "Không khởi động: cấu hình IP của khách sai:\n- {}",
            problems.join("\n- ")
        ));
    }
    crate::routes::boot_check()?;
    let port = args.port.unwrap_or(config.http_port);

    // ── DB, xác thực, phân quyền
    let lookup = |k: &str| -> Option<String> { env.get(k).cloned() };
    let mut db_cfg = DbConfig::from_lookup(lookup).map_err(|e| e.to_string())?;
    db_cfg.pool_size = config.db_pool_size;
    let db = Db::connect(&db_cfg)
        .await
        .map_err(|e| format!("không nối được DB: {e}"))?;
    let platform = Platform::new(&db, None);
    platform.ensure().await.map_err(|e| format!("platform: {e}"))?;
    let sync_on = trinity_db::sync::sync_enabled(lookup);
    let security = Security::new(db.clone(), platform.clone(), sync_on);
    // Nạp khối/phiên và (nếu bật đồng bộ) nghe `trinity_sync`; tác vụ chạy tới khi tiến trình thoát.
    let _security_listener = security.spawn_listener();
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let secrets: Vec<&str> = config.service_secret.iter().map(String::as_str).collect();
    let auth = Arc::new(Authenticator::new(security.clone(), &config.jwt_secret, &secrets));
    let mk_deps = |guards: BTreeMap<&'static str, Arc<dyn NamedGuard>>| {
        Arc::new(AccessDeps {
            auth: auth.clone(),
            permissions: perms.clone(),
            // Cổng tính năng tổ chức (`OrgFeatureGate`) chưa có bản dùng thật: các module đang mount không khai `org_feature`.
            features: None,
            guards,
        })
    };
    let deps = mk_deps(BTreeMap::new());

    let ip = Arc::new(ClientIpResolver::from_env(&env, NetProbe::System)?);
    if let Some(w) = ip.warning() {
        tracing::warn!("{w}");
    }

    // ── Thư mục tệp
    let uploads_root = std::path::PathBuf::from(env.get("UPLOADS_DIR").map_or("./uploads", |s| s.as_str()));
    if let Err(e) = LocalUploadsStore::new(uploads_root.clone()).init().await {
        tracing::warn!("thư mục uploads: {e}");
    }
    let contract_store = LocalDiskDriver::new(uploads_root.join("contracts"));
    contract_store
        .init()
        .await
        .map_err(|e| format!("thư mục hợp đồng: {e}"))?;
    let hr_ctx = || mod_hr::employees::Ctx {
        db: db.clone(),
        platform: platform.clone(),
        scopes: ScopeService::new(db.clone(), cache.clone()),
        perms: perms.clone(),
        cache: cache.clone(),
        uploads: LocalUploadsStore::new(uploads_root.clone()),
    };

    // ── Router các module
    let mut app = Router::new().fallback(not_found);

    let system_cfg = Arc::new(mod_system::SystemConfig::from_lookup(lookup));
    app = mount(app, mod_system::api_router(deps.clone(), system_cfg.clone()), ());
    app = app.merge(mod_system::extra_router(&system_cfg));

    app = mount(
        app,
        mod_users::api_router(deps.clone()),
        Arc::new(mod_users::Ctx {
            db: db.clone(),
            platform: platform.clone(),
            security: security.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            perms: perms.clone(),
            cache: cache.clone(),
        }),
    );
    app = mount(
        app,
        mod_custom::api_router(deps.clone()),
        Arc::new(mod_custom::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
        }),
    );
    app = mount(
        app,
        mod_reports::api_router(deps.clone()),
        Arc::new(mod_reports::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            cache: mod_reports::cache::ReadCache::new(false),
        }),
    );
    app = mount(
        app,
        mod_setup::api_router(deps.clone()),
        Arc::new(mod_setup::Ctx::new(db.clone())),
    );
    app = mount(app, mod_hr::routes::employee_router(deps.clone()), Arc::new(hr_ctx()));
    app = mount(
        app,
        mod_hr::routes::contract_router(deps.clone()),
        Arc::new(mod_hr::contracts::ContractsCtx {
            ctx: Arc::new(hr_ctx()),
            store: mod_hr::contracts::ContractStore::Local(contract_store),
        }),
    );
    app = mount(app, mod_attendance::routes::router(deps.clone()), Arc::new(hr_ctx()));
    app = mount(
        app,
        mod_channel_guard::api_router(deps.clone()),
        Arc::new(mod_channel_guard::ChannelGuard::with_config(
            db.clone(),
            platform.clone(),
            mod_channel_guard::GraphGuardConfig::from_lookup(lookup),
        )),
    );

    let public_ctx = Arc::new(mod_public_api::PublicCtx {
        db: db.clone(),
        platform: platform.clone(),
        perms: perms.clone(),
        scopes: ScopeService::new(db.clone(), cache.clone()),
        ip: ip.clone(),
        limiter: mod_public_api::PublicCtx::new_limiter(),
    });
    app = mount(
        app,
        mod_public_api::api_router(mk_deps(mod_public_api::named_guards(&public_ctx))),
        public_ctx,
    );

    // OAuth và MCP dùng chung bộ giới hạn.
    let oauth_config = mod_oauth::OauthConfig::from_lookup(lookup);
    let safe_get = trinity_http::outbound::safe_get::SafeGetOptions::new(
        oauth_config.policy,
        Arc::new(trinity_http::outbound::ssrf::SystemResolver),
        trinity_http::outbound::safe_get::SAFE_GET_TIMEOUT,
        trinity_http::outbound::safe_get::SAFE_GET_MAX_BYTES,
    )
    .ok();
    let oauth = Arc::new(mod_oauth::OauthCtx {
        db: db.clone(),
        platform: platform.clone(),
        perms: perms.clone(),
        config: oauth_config,
        ip: ip.clone(),
        safe_get,
        limits: mod_oauth::Limiters::new(),
    });
    app = mount(app, mod_oauth::api_router(deps.clone()), oauth.clone());

    let mcp_limits = Arc::new(mod_mcp::limits::McpLimits::with_untrusted_peer(
        oauth.limits.untrusted_peer.clone(),
    ));
    let mcp_audit = Arc::new(mod_mcp::exec::DbAudit { db: db.clone() });
    let mut registry = mod_mcp::ToolRegistry::new();
    mod_mcp::register_group1(&mut registry);
    let tool_scopes = ScopeService::new(db.clone(), cache.clone());
    let tool_deps = Arc::new(mod_mcp::deps::ToolDeps {
        db: db.clone(),
        scopes: tool_scopes.clone(),
        reports: Arc::new(mod_reports::Ctx {
            db: db.clone(),
            scopes: tool_scopes,
            cache: mod_reports::cache::ReadCache::new(false),
        }),
    });
    let public_base = lookup("INTEGRATIONS_PUBLIC_BASE_URL").unwrap_or_else(|| format!("http://localhost:{port}"));
    let mcp_endpoint = mod_mcp::McpEndpoint {
        config: mod_mcp::McpConfig::from_lookup(lookup),
        frozen: Arc::new(mod_mcp::frozen::Frozen::embedded()),
        identity: Arc::new(mod_mcp::auth::OauthIdentity { oauth: oauth.clone() }),
        limits: mcp_limits.clone(),
        exec: mod_mcp::exec::Executor {
            registry,
            limits: mcp_limits,
            audit: mcp_audit.clone(),
            deps: tool_deps,
            base_url: public_base,
        },
        audit: mcp_audit,
    };
    app = mount(
        app,
        mod_mcp::api_router(deps.clone()),
        Arc::new(mod_mcp::McpState {
            endpoint: mcp_endpoint,
            ip: ip.clone(),
        }),
    );
    // AI actions: bộ thực thi mặc định `NoTools` (M42/M43 cài tool thật); chỉ bật khi OAuth/MCP bật như `oauth_enabled`.
    let ai_enabled = lookup("INTEGRATIONS_MCP_ENABLED").is_some_and(|v| v.trim() == "true")
        && lookup("INTEGRATIONS_PUBLIC_BASE_URL").is_some_and(|v| !v.trim().is_empty());
    app = mount(
        app,
        mod_ai_actions::api_router(deps.clone()),
        Arc::new(mod_ai_actions::AiActionsCtx {
            db: db.clone(),
            enabled: ai_enabled,
            executor: Arc::new(mod_ai_actions::NoTools),
            exec_timeout: Duration::from_secs(240),
        }),
    );
    // CHƯA mount: mod-leads, mod-deals, mod-kanban,
    // mod-payroll, mod-pos, mod-facebook, mod-store (mới có bảng route, chưa có router axum). Route của chúng thuộc Node.

    // ── Scheduler và worker hàng đợi (nền). Chưa module nào đăng ký job ở đây; khi có, `scheduler.register(..)`.
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let node_id = format!("trinity-{}", std::process::id());
    let table = Arc::new(
        OwnershipTable::new(
            config.ownership_file.as_deref(),
            initial_from_routes_env(env.get("TRINITY_RUST_ROUTES").map(String::as_str)).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?,
    );
    let scheduler = trinity_jobs::Scheduler::new(&db, &platform, (*table.current()).clone(), &node_id);
    let queue = trinity_jobs::Queue::new(&db, &node_id);
    let worker = trinity_jobs::Worker::new(&queue, trinity_jobs::WorkerConfig::default());
    {
        let (s, rx) = (scheduler.clone(), stop_rx.clone());
        tokio::spawn(async move {
            if let Err(e) = s.run(rx).await {
                tracing::error!("scheduler dừng vì lỗi: {e}");
            }
        });
        let (w, rx) = (worker.clone(), stop_rx.clone());
        tokio::spawn(async move {
            if let Err(e) = w.run(rx).await {
                tracing::error!("worker hàng đợi dừng vì lỗi: {e}");
            }
        });
    }

    // K34: API điều khiển test, chỉ khi build với `--features test-hooks` VÀ TRINITY_TEST_HOOKS=1.
    #[cfg(feature = "test-hooks")]
    {
        let hooks = trinity_testhooks::TestHooks::new(auth.clone(), platform.clone(), config.multi_tenant)
            .scheduler(scheduler.clone())
            .worker(worker.clone());
        if let Some(r) = hooks.router(lookup) {
            app = app.merge(Router::new().nest("/api/v1", r));
        }
    }
    #[cfg(not(feature = "test-hooks"))]
    {
        let _ = (&scheduler, &worker);
    }

    // ── Realtime `/notif-ws` (K33)
    let (ws_layer, socket) = trinity_realtime::NotifSocket::new(trinity_realtime::RealtimeConfig {
        jwt_secret: &config.jwt_secret,
        multi_tenant: config.multi_tenant,
        security: Some(security.clone()),
    });
    if sync_on {
        match trinity_db::sync::listen_from_env() {
            Ok(Some(rx)) => {
                trinity_realtime::spawn_bell_listener(socket.clone(), db.clone(), rx, None);
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("chuông realtime không nghe được trinity_sync: {e}"),
        }
    }

    // ── Lớp biên rồi strangler
    let production = config.is_production();
    let rust = app
        .layer(from_fn(json_limit))
        .layer(from_fn_with_state(
            Arc::new(CorsConfig::new(&config.cors_origin, production)),
            cors_layer,
        ))
        .layer(ws_layer);
    let node_url = config
        .var("NODE_FALLBACK_URL")
        .map_or_else(|| format!("http://127.0.0.1:{}", config.compat_api_port), str::to_owned);
    let scheme = match config.tls {
        TlsMode::Off => ListenerScheme::Http,
        TlsMode::Files { .. } => ListenerScheme::Https,
    };
    let web_url = config
        .var("WEB_UPSTREAM_URL")
        .map(|raw| uri_of(raw, "WEB_UPSTREAM_URL"))
        .transpose()?;
    let proxy = NodeProxy::new(
        uri_of(&node_url, "NODE_FALLBACK_URL")?,
        web_url,
        config.service_secret.clone(),
        ProxyTimeouts::default(),
    )
    .with_scheme(scheme);
    // Không có tệp sở hữu và không đặt TRINITY_RUST_ROUTES: chạy localhost một mình, Rust nhận mọi route (không có Node để
    // chuyển tiếp). Đặt `NODE_FALLBACK_URL` hoặc tệp sở hữu để chạy chế độ lai.
    let table = if config.ownership_file.is_none()
        && env.get("TRINITY_RUST_ROUTES").is_none_or(|v| v.trim().is_empty())
        && config.var("NODE_FALLBACK_URL").is_none()
    {
        tracing::info!("không có tệp sở hữu và NODE_FALLBACK_URL: Rust nhận mọi route");
        Arc::new(OwnershipTable::fixed(
            initial_from_routes_env(Some("/")).map_err(|e| e.to_string())?,
        ))
    } else {
        table
    };
    let _reloader = spawn_sighup_reloader(table.clone()).map_err(|e| format!("SIGHUP: {e}"))?;
    let app = dispatcher(table, rust, proxy, ip.clone());

    // ── Mở cổng và chạy
    let tls = match &config.tls {
        TlsMode::Off => None,
        TlsMode::Files { cert, key } => {
            Some(trinity_http::serve::load_tls_acceptor(cert, key).map_err(|e| e.to_string())?)
        }
    };
    let host = listen_host.unwrap_or_else(|| "::".to_owned());
    let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        // Máy không có IPv6: lùi về mọi giao diện IPv4 khi người dùng không chỉ định địa chỉ.
        Err(_) if host == "::" => tokio::net::TcpListener::bind(("0.0.0.0", port))
            .await
            .map_err(|e| format!("không mở được cổng {port}: {e}"))?,
        Err(e) => return Err(format!("không mở được {host}:{port}: {e}")),
    };
    tracing::info!("trinity serve nghe tại {host}:{port} (Ctrl+C để dừng)");
    let shutdown = async move {
        trinity_http::serve::shutdown_signal().await;
        tracing::info!("nhận tín hiệu dừng, tắt máy êm");
        let _ = stop_tx.send(true);
    };
    trinity_http::serve::serve(listener, app, tls, shutdown, trinity_http::serve::DEFAULT_GRACE)
        .await
        .map_err(|e| format!("máy chủ dừng vì lỗi: {e}"))?;
    // Chờ scheduler/worker nhả lượt (chúng tự thoát khi `stop_tx` đã báo).
    tokio::time::sleep(Duration::from_millis(200)).await;
    db.close().await;
    Ok(())
}
