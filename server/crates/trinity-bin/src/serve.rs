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
use clap::Args;
use mod_social::media::MediaStore;
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::edge::body::{error_response, json_limit};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::edge::cors::{CorsConfig, cors_layer};
use trinity_http::edge::security_headers::{SecurityHeadersConfig, security_headers_layer};
use trinity_http::router::{AccessDeps, ApiRouter, NamedGuard};
use trinity_http::strangler::{
    ListenerScheme, NodeProxy, OwnershipTable, ProxyTimeouts, dispatcher_full, initial_from_routes_env,
    spawn_sighup_reloader,
};
use trinity_http::web::{WebConfig, WebService};
use trinity_kernel::config::{Config, TlsMode, process_env};
use trinity_kernel::error::HttpError;
use trinity_kernel::ownership::Ownership;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};
use trinity_storage::{LocalDiskDriver, LocalUploadsStore, S3Config, S3Driver};

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

/// Gộp router của `api` (đã gắn `state`) vào `outer`.
///
/// Không dùng `route(.., on_service(router))`: router con khớp đường dẫn lần hai và axum nối tham số URL
/// vào lần khớp ngoài, làm `Path<..>` thấy gấp đôi tham số ("Expected 1 but got 2" → 500).
fn mount<S: Clone + Send + Sync + 'static>(outer: Router, api: ApiRouter<S>, state: S) -> Router {
    let (router, _table) = api.into_parts();
    outer.merge(router.with_state(state).reset_fallback())
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

/// Kho tệp của đăng đa kênh theo `STORAGE_DRIVER` (như `StorageService` của Node): `s3` dùng MinIO/S3 (`MINIO_*`; endpoint và
/// vùng có mặc định như Node), còn lại là thư mục uploads. Lấy tên khoá `social/...` ở cả hai nơi.
async fn social_store(env: &BTreeMap<String, String>, uploads_root: &std::path::Path) -> Result<MediaStore, String> {
    let s3 = env
        .get("STORAGE_DRIVER")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("s3"));
    if !s3 {
        return Ok(MediaStore::Local(LocalDiskDriver::new(uploads_root.to_path_buf())));
    }
    let get = |k: &str| {
        env.get(k).cloned().or_else(|| match k {
            "MINIO_ENDPOINT" => Some("http://127.0.0.1:9000".to_owned()),
            "MINIO_REGION" => Some("ap-southeast-1".to_owned()),
            _ => None,
        })
    };
    let cfg = S3Config::from_env(get).map_err(|e| e.to_string())?;
    let driver = S3Driver::new(&cfg).map_err(|e| format!("kho tệp S3 của đăng đa kênh: {e}"))?;
    // Như Node: kho S3 chưa sẵn sàng chỉ cảnh báo, không chặn khởi động.
    if let Err(e) = driver.init().await {
        tracing::warn!("kho tệp S3 của đăng đa kênh chưa sẵn sàng: {e}");
    }
    Ok(MediaStore::S3(driver))
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
    // Sự kiện sản phẩm (PostHog): tắt khi thiếu `POSTHOG_KEY`/khoá băm. reqwest cần provider TLS `ring` cài trước (một lần).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let product_events = trinity_obs::ProductEvents::from_config(&trinity_obs::MonitoringConfig::from_env(lookup));
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
    let gate: Arc<dyn trinity_http::router::OrgFeatureGate> = Arc::new(crate::feature_gate::OrgGate {
        db: db.clone(),
        multi_tenant: platform.multi_tenant(),
    });
    let mk_deps = |guards: BTreeMap<&'static str, Arc<dyn NamedGuard>>| {
        Arc::new(AccessDeps {
            auth: auth.clone(),
            permissions: perms.clone(),
            // Cổng tính năng tổ chức: route khai `org_feature` (mod-leads) bị chặn 403 khi tổ chức tắt cờ.
            features: Some(gate.clone()),
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
    app = mount(app, mod_system::retired::api_router(deps.clone()), ());

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
    // Một bộ nhớ đệm số liệu Tổng quan dùng chung cho router báo cáo, tool MCP và việc xoá cache sau khi ghi khách.
    let reports_ctx = Arc::new(mod_reports::Ctx {
        db: db.clone(),
        scopes: ScopeService::new(db.clone(), cache.clone()),
        cache: mod_reports::cache::ReadCache::new(false),
    });
    app = mount(app, mod_reports::api_router(deps.clone()), reports_ctx.clone());
    // Socket `/notif-ws` dựng sau cùng: các router cần đẩy thông báo nội bộ (payroll, khách hàng) giữ ô này và điền ở bước realtime.
    let socket_slot: Arc<std::sync::OnceLock<trinity_realtime::NotifSocket>> = Arc::new(std::sync::OnceLock::new());
    // Router khách hàng dựng sau; dọn mẫu hàng loạt (wizard) cần xoá cache đếm của nó và cache Tổng quan.
    let contacts_slot: Arc<std::sync::OnceLock<Arc<mod_contacts::routes::Ctx>>> = Arc::new(std::sync::OnceLock::new());
    let mut setup_inner = mod_setup::Ctx::new(db.clone());
    setup_inner.events = product_events.clone();
    {
        let (slot, reports, db) = (contacts_slot.clone(), reports_ctx.clone(), db.clone());
        let changed: mod_setup::ContactsChanged = Arc::new(move |company: trinity_db::CompanyRef| {
            let slot = slot.clone();
            let (reports, db) = (reports.clone(), db.clone());
            tokio::spawn(async move {
                if let Some(c) = slot.get() {
                    c.cache.invalidate_with(&db, company).await;
                }
                crate::contacts_hooks::invalidate_dashboard(&db, &reports, company).await;
            });
        });
        setup_inner.contacts_changed = Some(changed);
    }
    let setup_ctx = Arc::new(setup_inner);
    app = mount(app, mod_setup::api_router(deps.clone()), setup_ctx.clone());
    app = mount(app, mod_hr::routes::employee_router(deps.clone()), Arc::new(hr_ctx()));
    app = mount(
        app,
        mod_hr::routes::contract_router(deps.clone()),
        Arc::new(mod_hr::contracts::ContractsCtx {
            ctx: Arc::new(hr_ctx()),
            store: mod_hr::contracts::ContractStore::Local(contract_store),
        }),
    );
    // Team, chức danh (M09) và tuyển dụng (M12): chung `Ctx` của nhân sự.
    app = mount(app, mod_hr::org_routes::team_router(deps.clone()), Arc::new(hr_ctx()));
    app = mount(
        app,
        mod_hr::org_routes::job_title_router(deps.clone()),
        Arc::new(hr_ctx()),
    );
    app = mount(
        app,
        mod_hr::org_routes::recruitment_router(deps.clone()),
        Arc::new(hr_ctx()),
    );
    app = mount(app, mod_attendance::routes::router(deps.clone()), Arc::new(hr_ctx()));
    // Chấm công vào/ra (M13b) và ảnh selfie của sổ chấm công (M14a) dùng chung `CheckCtx`: kho tệp là thư mục `contracts` như
    // hợp đồng (bộ ghi `LocalDiskDriver` không giữ trạng thái, thư mục đã `init` ở trên), IP khách qua `ClientIpResolver` chung.
    let attendance_check = Arc::new(mod_attendance::check::CheckCtx {
        ctx: Arc::new(hr_ctx()),
        store: mod_hr::contracts::ContractStore::Local(LocalDiskDriver::new(uploads_root.join("contracts"))),
        ip: ip.clone(),
    });
    app = mount(
        app,
        mod_attendance::routes::check_router(deps.clone()),
        attendance_check.clone(),
    );
    app = mount(
        app,
        mod_attendance::routes::proof_router(deps.clone()),
        attendance_check,
    );
    // Facebook (M46, webhook M47a, tin nhắn/Lead Ads M47b) và Zalo OA (M52) dùng chung `ChannelGuard` với router kênh; URL Graph/Zalo
    // và khoá đọc từ env (G15). Chưa có `refreshMissingNames` (M48) sau `check`.
    let guard = mod_channel_guard::ChannelGuard::with_config(
        db.clone(),
        platform.clone(),
        mod_channel_guard::GraphGuardConfig::from_lookup(lookup),
    );
    app = mount(
        app,
        mod_channel_guard::api_router(deps.clone()),
        Arc::new(guard.clone()),
    );
    // Route facebook/zalo-oa khai `org_feature`: cần `AccessDeps.features` (OrgGate của feat/x-router-contacts-leads); thiếu thì dừng.
    let Some(features) = deps.features.clone() else {
        return Err("thiếu cổng tính năng tổ chức (OrgGate) cho route facebook/zalo-oa".to_owned());
    };
    let channel_vars = env.clone();
    let channel_env: mod_facebook::config::Env = Arc::new(move |k: &str| channel_vars.get(k).cloned());
    let fb_state = Arc::new(mod_facebook::routes::FacebookState::new(
        db.clone(),
        platform.clone(),
        channel_env.clone(),
        ScopeService::new(db.clone(), cache.clone()),
        guard.clone(),
        features.clone(),
    ));
    app = mount(app, mod_facebook::routes::api_router(deps.clone()), fb_state.clone());
    // M50b: kịch bản nhắn tin, link/QR mở chat, `tick` (một khối liền, cùng `FacebookState` và OrgGate với router kết nối).
    app = mount(
        app,
        mod_facebook::flows_routes::api_router(deps.clone()),
        fb_state.clone(),
    );
    app = mount(
        app,
        mod_zalo::routes::api_router(deps.clone()),
        Arc::new(mod_zalo::routes::ZaloState::new(
            db.clone(),
            platform.clone(),
            channel_env.clone(),
            guard.clone(),
        )),
    );

    // Đăng đa kênh (M53a/b, M54a, M55a, X15a): kho tệp theo `STORAGE_DRIVER` (mặc định thư mục uploads, khoá `social/...`; `s3` dùng
    // MinIO/S3), Graph theo công ty dùng chung bộ dựng của Facebook. Route M55b (import CSV, bài lặp) đi qua `PostsAdapter` của
    // M54b. `Runner` của M54b dùng chung cho `tick`, `posts/sync` và (đăng ký ở khối scheduler bên dưới) hai job `social.*`.
    let social_runner = mod_social::jobs::Runner::new(mod_social::jobs::JobDeps {
        db: db.clone(),
        platform: platform.clone(),
        env: channel_env.clone(),
        store: Arc::new(social_store(&env, &uploads_root).await?),
        guard: guard.clone(),
        graph_for: fb_state.graph_for.clone(),
        before_publish: None,
        owns_publish: None,
    });
    let social_state = Arc::new(mod_social::router::SocialState {
        db: db.clone(),
        platform: platform.clone(),
        env: channel_env.clone(),
        graph_for: fb_state.graph_for.clone(),
        guard: guard.clone(),
        store: social_store(&env, &uploads_root).await?,
        runner: social_runner.clone(),
    });
    app = mount(app, mod_social::router::api_router(deps.clone()), social_state);

    let public_ctx = Arc::new(mod_public_api::PublicCtx {
        db: db.clone(),
        platform: platform.clone(),
        perms: perms.clone(),
        scopes: ScopeService::new(db.clone(), cache.clone()),
        ip: ip.clone(),
        limiter: mod_public_api::PublicCtx::new_limiter(),
        // Tạo khách qua API công khai cũng như `ContactsService.create`: xoá cache, dọn bản ghi mẫu.
        contact_created: Some({
            let (slot, reports, setup, db) = (
                contacts_slot.clone(),
                reports_ctx.clone(),
                setup_ctx.clone(),
                db.clone(),
            );
            Arc::new(move |company: trinity_db::CompanyRef| {
                if let Some(c) = slot.get() {
                    c.cache.clear();
                }
                let (reports, setup, db) = (reports.clone(), setup.clone(), db.clone());
                tokio::spawn(async move {
                    crate::contacts_hooks::invalidate_dashboard(&db, &reports, company).await;
                    mod_setup::samples::purge_if_real(&setup, company).await;
                });
            }) as Arc<dyn Fn(trinity_db::CompanyRef) + Send + Sync>
        }),
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

    // Đăng nhập (M01) và API key (M05): chung một AuthService (chung bộ giới hạn tốc độ đăng nhập).
    let auth_cfg = mod_auth::AuthConfig::from_lookup(lookup).ok_or_else(|| "thiếu JWT_SECRET".to_owned())?;
    let auth_svc = Arc::new(mod_auth::AuthService::new(
        db.clone(),
        platform.clone(),
        security.clone(),
        mod_auth::PermGrants(perms.clone()),
        LocalUploadsStore::new(uploads_root.clone()),
        auth_cfg,
    ));
    let mcp_limits = Arc::new(mod_mcp::limits::McpLimits::with_untrusted_peer(
        oauth.limits.untrusted_peer.clone(),
    ));
    let mcp_audit = Arc::new(mod_mcp::exec::DbAudit { db: db.clone() });
    let mut registry = mod_mcp::ToolRegistry::new();
    mod_mcp::register_group1(&mut registry);
    mod_mcp::register_group2(&mut registry);
    mod_mcp::register_group3(&mut registry);
    mod_mcp::register_structure(&mut registry);
    // M44c: hộp thư và lời mời. Facebook dùng bản `FacebookIngest` riêng (cùng `GraphClient`, chỉ khác bộ nhớ chống đồng bộ dồn).
    mod_mcp::register_inbox_invitations(
        &mut registry,
        Arc::new(mod_mcp::InboxDeps {
            features: features.clone(),
            facebook: Arc::new(mod_facebook::ingest::FacebookIngest::new(
                db.clone(),
                channel_env.clone(),
                fb_state.graph_for.clone(),
            )),
            guard: guard.clone(),
            zalo_client: mod_zalo::client::ZaloClient::new(channel_env.clone()),
            zalo_env: channel_env.clone(),
            platform: platform.clone(),
        }),
        Arc::new(mod_mcp::AuthInvitations(auth_svc.clone())),
    );
    // M44a (một phần): 4 tool đăng bài. Kho tệp là thư mục `uploads` (khoá `social/u<id>_…`); `LocalDiskDriver` không giữ trạng
    // thái nên router `/social` dựng bản `MediaStore::Local` cùng thư mục là dùng chung dữ liệu.
    // M44a: tool đăng bài. MỘT `Arc<SocialDeps>` dùng cho cả `register_social` lẫn `ToolDeps.social` (khung duyệt M42 lấy dịch vụ từ
    // đó). Kho tệp là thư mục `uploads` như router `/social`. Bài lặp và nhập hàng loạt đi qua `SocialAdapter` bọc `mod_social`
    // (M55b), cùng bản này bọc số liệu (M54b) và đăng nháp.
    let post_infra = mod_mcp::PostInfra {
        guard: guard.clone(),
        graph_for: fb_state.graph_for.clone(),
    };
    let social_adapter = mod_mcp::SocialAdapter::new(
        db.clone(),
        channel_env.clone(),
        mod_social::media::MediaStore::Local(LocalDiskDriver::new(uploads_root.clone())),
        post_infra.clone(),
        social_runner.clone(),
    );
    let social_deps = {
        let mut d = mod_mcp::SocialDeps::new(
            mod_social::media::MediaStore::Local(LocalDiskDriver::new(uploads_root.clone())),
            channel_env.clone(),
        );
        d.infra = Some(post_infra);
        d.recurrences = Some(social_adapter.clone());
        d.importer = Some(social_adapter.clone());
        d.metrics = Some(social_adapter.clone());
        d.draft_publisher = Some(social_adapter);
        Arc::new(d)
    };
    mod_mcp::register_social(&mut registry, social_deps.clone());
    // Tool Fanpage (M44b): port bằng dịch vụ thật (`FacebookIngest` dùng chung với router; kho tệp là thư mục `uploads` như router
    // `/social`). Không có `kick` riêng: job `facebook.broadcasts` (60 giây) nhặt lượt gửi mới.
    mod_mcp::register_fanpage(
        &mut registry,
        Arc::new(mod_mcp::fanpage_deps(
            fb_state.ingest.clone(),
            platform.multi_tenant(),
            None,
            Some(mod_mcp::PostsDeps {
                store: Arc::new(mod_social::media::MediaStore::Local(LocalDiskDriver::new(
                    uploads_root.clone(),
                ))),
                graph_for: fb_state.graph_for.clone(),
                guard: guard.clone(),
            }),
        )),
    );
    mod_mcp::register_payroll(&mut registry);
    mod_mcp::register_channels(
        &mut registry,
        Arc::new(mod_mcp::ChannelsDeps {
            guard: guard.clone(),
            client_ip: ip.clone(),
        }),
    );
    let tool_scopes = ScopeService::new(db.clone(), cache.clone());
    let tool_deps = Arc::new(mod_mcp::deps::ToolDeps {
        db: db.clone(),
        scopes: tool_scopes,
        reports: reports_ctx.clone(),
        social: Some(social_deps),
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
            deps: tool_deps.clone(),
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
    // AI actions: bộ thực thi `McpExecutor` (M42: tool ghi của mod-mcp; M43 thêm tool cấu trúc); chỉ bật khi OAuth/MCP bật như `oauth_enabled`.
    let ai_enabled = lookup("INTEGRATIONS_MCP_ENABLED").is_some_and(|v| v.trim() == "true")
        && lookup("INTEGRATIONS_PUBLIC_BASE_URL").is_some_and(|v| !v.trim().is_empty());
    app = mount(
        app,
        mod_ai_actions::api_router(deps.clone()),
        Arc::new(mod_ai_actions::AiActionsCtx {
            db: db.clone(),
            enabled: ai_enabled,
            executor: Arc::new(mod_ai_actions::McpExecutor { deps: tool_deps }),
            exec_timeout: Duration::from_secs(240),
        }),
    );
    app = mount(
        app,
        mod_pos::api_router(deps.clone()),
        Arc::new(mod_pos::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
        }),
    );
    let contacts_ctx = Arc::new(mod_contacts::routes::Ctx {
        db: db.clone(),
        scopes: ScopeService::new(db.clone(), cache.clone()),
        cache: mod_contacts::list::CountCache::new(),
        hooks: Arc::new(crate::contacts_hooks::ContactsHooks {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            reports: reports_ctx.clone(),
            setup: setup_ctx.clone(),
            socket: socket_slot.clone(),
        }),
    });
    let _ = contacts_slot.set(contacts_ctx.clone());
    app = mount(app, mod_contacts::routes::api_router(deps.clone()), contacts_ctx);
    app = mount(
        app,
        mod_leads::routes::api_router(deps.clone()),
        Arc::new(mod_leads::routes::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            lead_job_enabled: mod_leads::jobs::lead_enabled(lookup),
            stale_job_enabled: mod_leads::jobs::stale_enabled(lookup),
        }),
    );
    app = mount(
        app,
        mod_deals::routes::api_router(deps.clone()),
        Arc::new(mod_deals::routes::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            multi_tenant: platform.multi_tenant(),
        }),
    );
    // Bản tin sáng/chiều (M23): route `preview`/`run-now` khai `org_feature = ai_briefing` (OrgGate trong `deps`).
    app = mount(
        app,
        mod_briefings::routes::api_router(deps.clone()),
        Arc::new(mod_briefings::routes::Ctx { db: db.clone() }),
    );
    // Payroll: socket `/notif-ws` dựng sau cùng nên điền vào `payroll_socket` ở bước realtime bên dưới.
    let payroll_socket = socket_slot.clone();
    app = mount(
        app,
        mod_payroll::api_router(deps.clone()),
        Arc::new(mod_payroll::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            socket: payroll_socket.clone(),
        }),
    );
    app = mount(
        app,
        mod_auth::api_router(deps.clone()),
        Arc::new(mod_auth::AuthCtx {
            auth: auth_svc.clone(),
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            ip: ip.clone(),
        }),
    );
    let keys_ctx = Arc::new(mod_apikeys::ApiKeysCtx {
        db: db.clone(),
        platform: platform.clone(),
        perms: perms.clone(),
        auth: auth_svc,
        ip: ip.clone(),
    });
    app = mount(
        app,
        mod_apikeys::api_router(mk_deps(mod_apikeys::named_guards(&keys_ctx))),
        keys_ctx,
    );
    // Trang bán hàng (route công khai tự chọn công ty theo `?cid=`/slug; IP khách qua `ClientIpResolver`) và commerce.
    app = mount(
        app,
        mod_store::api_router(deps.clone()),
        Arc::new(mod_store::Ctx {
            db: db.clone(),
            platform: platform.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            ip: ip.clone(),
            limits: mod_store::shop::OrderLimits::default(),
        }),
    );
    app = mount(
        app,
        mod_commerce::api_router(deps.clone()),
        Arc::new(mod_commerce::Ctx {
            db: db.clone(),
            uploads: LocalUploadsStore::new(uploads_root.clone()),
        }),
    );
    app = mount(
        app,
        mod_kanban::http::api_router(deps.clone()),
        Arc::new(mod_kanban::http::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            mentions: Some(Arc::new(crate::kanban_mentions::Sink {
                ctx: mod_custom::Ctx {
                    db: db.clone(),
                    scopes: ScopeService::new(db.clone(), cache.clone()),
                },
            })),
        }),
    );
    // ── Scheduler và worker hàng đợi (nền). Mọi `scheduler.register(..)` phải xong TRƯỚC `scheduler.run` (chụp danh sách job lúc
    // chạy); các job cần socket/chính sách SSRF nên khối đăng ký nằm sau khối integrations, rồi mới tới khối khởi chạy.
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
    // Facebook (M51): job gửi hàng loạt Messenger, 60 giây một lượt cho từng công ty (`send`/`tick` còn kích chạy nền ngay).
    scheduler.register(
        mod_facebook::broadcast::broadcast_job(fb_state.ingest.clone(), Some(Arc::new(guard.clone())))
            .map_err(|e| format!("job facebook.broadcasts: {e}"))?,
    );
    // M50b: job `facebook.flows` (60 giây): gửi tiếp bước kịch bản đã tới giờ, kể cả lượt hẹn lại khi kênh tạm dừng.
    scheduler.register(mod_facebook::flows::flows_job(fb_state.ingest.clone()).map_err(|e| e.to_string())?);
    // M54b: job `social.publish` (60 giây) và `social.metrics` (15 phút); chủ job do bảng sở hữu quyết định, API điều khiển test
    // bật thì không đăng ký.
    match mod_social::jobs::register(&scheduler, &social_runner, lookup) {
        Ok(names) => tracing::info!("đã đăng ký job {names:?}"),
        Err(e) => tracing::warn!("không đăng ký được job đăng đa kênh: {e}"),
    }
    let queue = trinity_jobs::Queue::new(&db, &node_id);
    let mut worker = trinity_jobs::Worker::new(&queue, trinity_jobs::WorkerConfig::default());
    // X15b: xuất tệp dài chạy nền (`/api/v1/exports`, loại việc `export.run`). Bảng sở hữu cần tiền tố này thuộc Rust.
    mod_exports::worker::register(&mut worker, &db);
    // M23: job `briefings.run-due` (mỗi phút), chỉ đăng ký khi `BRIEFING_CRON_ENABLED=true`; `Ports` dựng theo từng công ty.
    {
        let multi_tenant = db.multi_tenant();
        match mod_briefings::job::register_if_enabled(
            &scheduler,
            &db,
            move |company| mod_briefings::ports::RbacPorts::new(company, multi_tenant),
            lookup,
        ) {
            Ok(true) => tracing::info!("đã đăng ký job {}", mod_briefings::job::JOB_NAME),
            Ok(false) => {}
            Err(e) => tracing::warn!("không đăng ký được job {}: {e}", mod_briefings::job::JOB_NAME),
        }
    }
    app = mount(
        app,
        mod_exports::routes::api_router(deps.clone()),
        Arc::new(mod_exports::routes::Ctx {
            db: db.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            queue: queue.clone(),
            store: mod_exports::store::Store::new(&db),
        }),
    );
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
    let _ = payroll_socket.set(socket.clone());
    if sync_on {
        match trinity_db::sync::listen_from_env() {
            Ok(Some(rx)) => {
                // Chỉ MỘT bên được nghe `trinity_sync`: chuông tự xử lý tin `bell`, mọi tin khác (kể cả `Resync`) chuyển tiếp
                // cho cache số liệu Tổng quan (tin `cache`) và ChannelGuard (tin `graph`).
                let (fwd_tx, mut fwd_rx) = tokio::sync::mpsc::channel::<trinity_db::sync::SyncEvent>(1024);
                trinity_realtime::spawn_bell_listener(socket.clone(), db.clone(), rx, Some(fwd_tx));
                let (reports, guard, contacts) = (reports_ctx.clone(), guard.clone(), contacts_slot.clone());
                tokio::spawn(async move {
                    while let Some(ev) = fwd_rx.recv().await {
                        reports.cache.on_sync_event(&ev);
                        if let Some(c) = contacts.get() {
                            c.cache.on_sync_event(&ev);
                        }
                        guard.on_sync_event(&ev);
                    }
                });
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("chuông realtime không nghe được trinity_sync: {e}"),
        }
    }

    // ── settings, rbac-admin, notify (notify cần cổng socket nên mount sau khi dựng `socket`).
    let plan_guards = mod_settings::named_guards(lookup(mod_settings::features::PLAN_TOKEN_ENV));
    app = mount(
        app,
        mod_settings::api_router(mk_deps(plan_guards)),
        Arc::new(mod_settings::SettingsState {
            db: db.clone(),
            client_ip: ip.clone(),
            events: product_events.clone(),
        }),
    );
    app = mount(
        app,
        mod_rbac_admin::api_router(deps.clone()),
        Arc::new(mod_rbac_admin::RbacState {
            db: db.clone(),
            permissions: perms.clone(),
            scope: ScopeService::new(db.clone(), cache.clone()),
            cache: cache.clone(),
        }),
    );
    let ssrf_policy = trinity_http::outbound::ssrf::SsrfPolicy::from_env(lookup);
    let webhook: Arc<dyn mod_notify::delivery::WebhookPoster> =
        Arc::new(mod_notify::delivery::SafeWebhookPoster::new(ssrf_policy).map_err(|e| format!("webhook: {e}"))?);
    let notify_sink: Arc<dyn mod_notify::delivery::InAppSink> = Arc::new(mod_notify::delivery::RealtimeSink {
        socket: socket.clone(),
        db: db.clone(),
    });
    app = mount(
        app,
        mod_notify::api_router(deps.clone()),
        Arc::new(mod_notify::NotifyState {
            db: db.clone(),
            deliverer: mod_notify::delivery::Deliverer::new(notify_sink.clone(), webhook.clone(), ssrf_policy),
        }),
    );
    // Integrations (M33/M34): status, nhật ký, webhook ra, nguồn webhook vào và `POST /hooks/in/:token` (công khai theo token).
    // Chống SSRF dùng chung chính sách với kênh webhook của notify; khoá mã hoá secret là INTEGRATIONS_SECRET_KEY.
    // Dispatcher gửi webhook ra chạy ở job `webhook.dispatch`, đăng ký ở khối job nền bên dưới.
    let integ_vars = env.clone();
    let integ_env: trinity_integrations::routes::EnvFn = Arc::new(move |k: &str| integ_vars.get(k).cloned());
    let key_vars = env.clone();
    let secret_key: trinity_integrations::webhooks::secret::KeySource =
        Arc::new(move || trinity_integrations::webhooks::secret::load_secret_key(&|k: &str| key_vars.get(k).cloned()));
    let inbound_vars = env.clone();
    let inbound_enabled: Arc<dyn Fn() -> bool + Send + Sync> =
        Arc::new(move || trinity_integrations::status::webhooks_enabled(&|k: &str| inbound_vars.get(k).cloned()));
    let integ_sender = trinity_integrations::webhooks::sender::Sender::new(
        ssrf_policy,
        Arc::new(trinity_http::outbound::ssrf::SystemResolver),
        secret_key.clone(),
    )
    .map_err(|e| format!("webhook ra: {e}"))?;
    app = mount(
        app,
        trinity_integrations::routes::api_router(deps.clone()),
        Arc::new(trinity_integrations::routes::IntegrationsState {
            db: db.clone(),
            platform: platform.clone(),
            scopes: ScopeService::new(db.clone(), cache.clone()),
            env: integ_env,
            sender: integ_sender.clone(),
            inbound: trinity_integrations::webhooks::inbound::receive::InboundService::new(secret_key, inbound_enabled),
        }),
    );

    // Job nền còn lại (mỗi job tự tắt theo cờ env của module): lead-scoring + stale-work (mod-leads), notification.scheduled,
    // integrations.ai-action-expiry, outbox/oauth purge, webhook dispatch.
    {
        let job_vars = env.clone();
        let job_env = move |k: &str| job_vars.get(k).cloned();
        let multi_tenant = db.multi_tenant();
        match mod_leads::jobs::register_if_enabled_with(
            &scheduler,
            &db,
            move |company| crate::job_ports::CompanyFeatures { company, multi_tenant },
            lookup,
        ) {
            Ok(names) => tracing::info!("đã đăng ký job leads {names:?}"),
            Err(e) => tracing::warn!("không đăng ký được job leads: {e}"),
        }
        let notify_deliverer = Arc::new(mod_notify::delivery::Deliverer::new(
            notify_sink.clone(),
            webhook.clone(),
            ssrf_policy,
        ));
        let webhook_dispatcher = Arc::new(trinity_integrations::webhooks::dispatcher::Dispatcher::new(
            integ_sender,
            Box::new(crate::job_ports::RbacActors {
                permissions: perms.clone(),
                scopes: ScopeService::new(db.clone(), cache.clone()),
            }),
        ));
        let (any_on, oauth_on, webhooks_on) = (
            trinity_integrations::status::any_enabled(&job_env),
            trinity_integrations::status::oauth_enabled(&job_env),
            trinity_integrations::status::webhooks_enabled(&job_env),
        );
        let specs = [
            mod_notify::jobs::scheduled_job(&db, notify_deliverer).map(Some),
            mod_ai_actions::job::expiry_job(&db, oauth_on),
            trinity_integrations::purge::outbox_purge_job(&db, any_on),
            trinity_integrations::purge::oauth_purge_job(&db, oauth_on),
            trinity_integrations::webhooks::dispatcher::webhook_tick_job(&db, webhook_dispatcher, webhooks_on),
        ];
        for spec in specs {
            match spec {
                Ok(Some(spec)) => {
                    tracing::info!("đã đăng ký job {}", spec.name);
                    scheduler.register(spec);
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("không đăng ký được job nền: {e}"),
            }
        }
    }
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

    // Newsfeed: kho tệp theo `STORAGE_DRIVER` (local|s3, mặc định local) như `packages/storage`; ảnh/video khoá `newsfeed/...`.
    let newsfeed_store = match lookup("STORAGE_DRIVER")
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("") | Some("local") => {
            let root = lookup("STORAGE_LOCAL_ROOT")
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "/var/lib/trinity/storage".to_owned());
            let driver = LocalDiskDriver::new(root);
            // Như thư mục uploads: không ghi được thì cảnh báo (chạy localhost không đặt STORAGE_LOCAL_ROOT), không dừng serve.
            if let Err(e) = driver.init().await {
                tracing::warn!("thư mục newsfeed: {e}");
            }
            mod_newsfeed::routes::Store::Local(driver)
        }
        Some("s3") => {
            let cfg = trinity_storage::S3Config::from_env(lookup).map_err(|e| e.to_string())?;
            mod_newsfeed::routes::Store::S3(trinity_storage::S3Driver::new(&cfg).map_err(|e| format!("s3: {e}"))?)
        }
        Some(other) => return Err(format!("STORAGE_DRIVER '{other}' không hợp lệ (local|s3)")),
    };
    app = mount(
        app,
        mod_newsfeed::routes::api_router(deps.clone()),
        Arc::new(mod_newsfeed::routes::Ctx {
            db: db.clone(),
            store: newsfeed_store,
            push: mod_newsfeed::routes::socket_push(socket.clone(), db.clone()),
        }),
    );

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
    // Web tĩnh (K18): `WEB_DIR` trỏ tới `out/` của `next build` (output: export). Bật bằng `"web": "rust"` trong tệp sở hữu.
    let web = config.var("WEB_DIR").map(|dir| {
        Arc::new(WebService::new(WebConfig {
            dir: dir.into(),
            store_domain: env.get("STORE_DOMAIN").cloned(),
            site_config: system_cfg.site_config().clone(),
            build_id: system_cfg.build_id().to_owned(),
        }))
    });
    let standalone = config.ownership_file.is_none()
        && env.get("TRINITY_RUST_ROUTES").is_none_or(|v| v.trim().is_empty())
        && config.var("NODE_FALLBACK_URL").is_none();
    let table = if standalone {
        tracing::info!("không có tệp sở hữu và NODE_FALLBACK_URL: Rust nhận mọi route");
        // Chạy một mình: có WEB_DIR thì Rust phục vụ luôn trang web (không còn Next để chuyển tiếp).
        let web_owner = if web.is_some() { "rust" } else { "node" };
        let fixed = Ownership::parse(
            &format!(r#"{{"routes": [{{"prefix": "/", "owner": "rust"}}], "web": "{web_owner}"}}"#),
            "standalone",
        )
        .map_err(|e| e.to_string())?;
        Arc::new(OwnershipTable::fixed(fixed))
    } else {
        table
    };
    match (&web, table.current().web()) {
        (Some(w), trinity_kernel::ownership::Owner::Rust) => {
            tracing::info!("web tĩnh do Rust phục vụ từ {}", w.dir().display());
        }
        (None, trinity_kernel::ownership::Owner::Rust) => {
            tracing::warn!("tệp sở hữu ghi web: rust nhưng chưa đặt WEB_DIR: trang vẫn chuyển tiếp sang Next/Node");
        }
        _ => {}
    }
    let _reloader = spawn_sighup_reloader(table.clone()).map_err(|e| format!("SIGHUP: {e}"))?;
    let shadow = crate::shadow_report::init(lookup)?;
    let app = dispatcher_full(table, rust, proxy, ip.clone(), shadow, web);
    // Header bảo mật chung ở lớp ngoài cùng (header đã có sẵn trong phản hồi được giữ nguyên).
    let app = app.layer(from_fn_with_state(
        Arc::new(SecurityHeadersConfig::from_lookup(
            lookup,
            production,
            matches!(config.tls, TlsMode::Files { .. }),
        )),
        security_headers_layer,
    ));

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
