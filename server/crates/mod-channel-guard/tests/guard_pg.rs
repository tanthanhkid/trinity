//! M45 trên Postgres thật, đa công ty (`MULTI_TENANT`): hạn mức đếm nguyên tử theo công ty, khoá kênh, tự tạm dừng theo lỗi
//! Graph (kể cả kết quả do tiến trình khác phát qua `NOTIFY`), giữ chỗ trong giao dịch, và hai đường HTTP. Chuyển từ phần kênh của
//! `saas-abuse.pg.spec.ts` (phần slug/VietQR/route của spec đó thuộc G05–G07b, không nằm ở M45).
//!
//! Test tự tạo một DB trống (`<DB của TEST_DATABASE_URL>_m45_<pid>`), tạo hai công ty rồi xoá DB:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-channel-guard --test guard_pg -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request};
use mod_channel_guard::{
    BlockCode, ChannelGuard, GraphGuardConfig, GraphOutcome, GuardError, OutboundMode, OutboundScope, QuotaKind,
    api_router,
};
use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::provision::{ProvisionInput, provision_company};
use trinity_db::sync::{self, SyncEvent};
use trinity_db::{CompanyRef, Db, DbConfig, migrate};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache};

const SETUP: &str = "
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
";

const JWT: &str = "m45-jwt-secret-0123456789abcdef0123456789abcdef";

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn url_for(db: &str) -> String {
    let base = base_url();
    let (head, query) = base
        .split_once('?')
        .map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
    let (server, _) = head.rsplit_once('/').expect("URL có tên DB");
    match query {
        Some(q) => format!("{server}/{db}?{q}"),
        None => format!("{server}/{db}"),
    }
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

struct TestDb {
    name: String,
    url: String,
}

impl TestDb {
    async fn new() -> Self {
        let base = base_url();
        let dbname = base
            .split_once('?')
            .map_or(base.as_str(), |(h, _)| h)
            .rsplit_once('/')
            .map(|(_, d)| d.to_owned())
            .unwrap();
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let name = format!(
            "{dbname}_m45_{}_{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        let mut c = PgConnection::connect(&url).await.unwrap();
        exec(&mut c, SETUP).await;
        Self { name, url }
    }

    fn cfg(&self, multi_tenant: bool) -> DbConfig {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.multi_tenant = multi_tenant;
        cfg.pool_size = 16;
        cfg.acquire_timeout = Duration::from_secs(30);
        cfg.statement_timeout = Duration::ZERO;
        cfg
    }

    async fn conn(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let name = self.name.clone();
        let base = base_url();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(mut admin) = PgConnection::connect(&base).await {
                    let _ = sqlx::raw_sql(AssertSqlSafe(format!(
                        "DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"
                    )))
                    .execute(&mut admin)
                    .await;
                }
            });
        })
        .join();
    }
}

fn send(code: Option<i64>, http: i64) -> GraphOutcome {
    GraphOutcome {
        ok: false,
        http_status: http,
        code,
        subcode: None,
        send: true,
    }
}

fn read_fail(code: i64) -> GraphOutcome {
    GraphOutcome {
        send: false,
        ..send(Some(code), 403)
    }
}

const OK: GraphOutcome = GraphOutcome {
    ok: true,
    http_status: 200,
    code: None,
    subcode: None,
    send: true,
};

struct Env {
    t: TestDb,
    db: Db,
    platform: Platform,
    a: CompanyRef,
    b: CompanyRef,
}

impl Env {
    /// Bản guard mới (cache gói/tạm dừng/backoff riêng) trên cùng DB.
    fn guard(&self) -> ChannelGuard {
        ChannelGuard::with_config(
            self.db.clone(),
            self.platform.clone(),
            GraphGuardConfig::from_lookup(|_| None),
        )
    }

    async fn set_plan(&self, c: CompanyRef, plan: &str) {
        let mut conn = self.t.conn().await;
        exec(
            &mut conn,
            &format!(
                "INSERT INTO c_{id}.settings (key, value, updated_at) VALUES ('org_plan', '{plan}', now())
                 ON CONFLICT (key) DO UPDATE SET value = '{plan}'",
                id = c.id()
            ),
        )
        .await;
    }

    async fn events(&self, c: CompanyRef, kind: &str) -> i64 {
        let mut conn = self.t.conn().await;
        sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT count(*) FROM c_{}.channel_events WHERE kind = '{kind}'",
            c.id()
        )))
        .fetch_one(&mut conn)
        .await
        .unwrap()
    }
}

async fn env() -> Env {
    let t = TestDb::new().await;
    let db = Db::connect_lazy(&t.cfg(true)).unwrap();
    let platform = Platform::new(&db, None);
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();
    let mk = |email: &str, name: &str| ProvisionInput {
        company_name: name.to_owned(),
        admin_email: email.to_owned(),
        admin_password: "mat-khau-thu-123".to_owned(),
        admin_name: format!("Chủ {name}"),
    };
    let a = provision_company(&db, &platform, &migrations, latest, &mk("a@m45.test", "Công ty A"))
        .await
        .unwrap()
        .company;
    let b = provision_company(&db, &platform, &migrations, latest, &mk("b@m45.test", "Công ty B"))
        .await
        .unwrap()
        .company;
    Env { t, db, platform, a, b }
}

fn blocked(r: Result<impl std::fmt::Debug, GuardError>) -> (BlockCode, String) {
    match r {
        Err(GuardError::Blocked(b)) => (b.code, b.message),
        other => panic!("đáng lẽ bị chặn: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn hanmuc_khoa_tamdung_va_http() {
    let e = env().await;
    let (a, b) = (e.a, e.b);
    let g = e.guard();
    let auto = OutboundMode::Auto;
    let meta = OutboundScope::Meta;

    // ───── hạn mức theo gói: đếm theo từng công ty
    e.set_plan(a, "ket_noi").await; // 200 tin/ngày
    e.set_plan(b, "ket_noi").await;
    let g1 = e.guard();
    g1.reserve(a, QuotaKind::BulkMessage, 200, meta).await.unwrap();
    let (code, msg) = blocked(g1.reserve(a, QuotaKind::BulkMessage, 1, meta).await);
    assert_eq!(code, BlockCode::ChannelQuota);
    assert!(msg.contains("hết hạn mức tin gửi hàng loạt"), "{msg}");
    assert!(
        g1.reserve(b, QuotaKind::BulkMessage, 150, meta)
            .await
            .unwrap()
            .is_some()
    );
    let (sa, sb) = (g1.status(a).await.unwrap(), g1.status(b).await.unwrap());
    assert_eq!((sa.usage.bulk_messages_today, sb.usage.bulk_messages_today), (200, 150));
    assert_eq!(sa.plan, "ket_noi");
    assert!(sa.warnings.join(" ").contains("hết hạn mức tin gửi hàng loạt"));
    // Lần vượt thành sự kiện của A, không lộ sang B.
    assert!(sa.recent_events.iter().any(|ev| ev.kind == "limit_exceeded"));
    assert!(!sb.recent_events.iter().any(|ev| ev.kind == "limit_exceeded"));
    let v = serde_json::to_value(&sa).unwrap();
    assert_eq!(v["limits"]["bulkMessagesPerDay"], 200);
    assert_eq!(v["limits"]["autoCommentRepliesPerHour"], 60);

    // Nguyên tử: 40 lời giữ chỗ song song, B còn 50 ⇒ đúng 25 lượt (mỗi lượt 2) qua.
    let mut set = Vec::new();
    for _ in 0..40 {
        let g = g1.clone();
        set.push(tokio::spawn(async move {
            g.reserve(b, QuotaKind::BulkMessage, 2, meta).await
        }));
    }
    let mut passed = 0;
    for h in set {
        if h.await.unwrap().is_ok() {
            passed += 1;
        }
    }
    assert_eq!(passed, 25);
    assert_eq!(g1.status(b).await.unwrap().usage.bulk_messages_today, 200);

    // Người nhận/chiến dịch; bài đăng/ngày; trả lời bình luận/giờ.
    assert!(
        blocked(g1.assert_recipients(b, 201).await)
            .1
            .contains("tối đa 200 người")
    );
    g1.assert_recipients(b, 200).await.unwrap();
    g1.reserve(b, QuotaKind::Post, 10, meta).await.unwrap();
    assert!(
        blocked(g1.reserve(b, QuotaKind::Post, 1, meta).await)
            .1
            .contains("bài đăng")
    );
    g1.reserve(b, QuotaKind::CommentReply, 60, meta).await.unwrap();
    assert_eq!(
        blocked(g1.reserve(b, QuotaKind::CommentReply, 1, meta).await).0,
        BlockCode::ChannelQuota
    );
    // Xin một lần vượt cả trần: câu riêng, không ghi limit_exceeded mới.
    let before = e.events(a, "limit_exceeded").await;
    assert!(
        blocked(g1.reserve(a, QuotaKind::Post, 11, meta).await)
            .1
            .contains("Một lần chỉ được")
    );
    assert_eq!(e.events(a, "limit_exceeded").await, before);

    // Gói custom rộng nhưng có trần an toàn.
    e.set_plan(a, "custom").await;
    let g2 = e.guard();
    assert_eq!(g2.limits(a).await.bulk_messages_per_day, 5000);
    assert!(g2.assert_recipients(a, 2001).await.is_err());
    // Công ty ≥ 2 thiếu dòng org_plan ⇒ gói đăng ký mặc định (không rơi về custom).
    {
        let mut c = e.t.conn().await;
        exec(
            &mut c,
            &format!("DELETE FROM c_{}.settings WHERE key = 'org_plan'", b.id()),
        )
        .await;
    }
    let lim = e.guard().limits(b).await;
    assert!(lim.bulk_messages_per_day < 5000, "{lim:?}");

    // ───── khoá kênh của chủ nền tảng
    e.set_plan(b, "ket_noi").await;
    assert!(!e.platform.channel_lock(a.id()).await.unwrap().locked);
    assert!(
        e.platform
            .set_channel_lock(a.id(), true, Some("nghi spam"))
            .await
            .unwrap()
    );
    let g3 = e.guard();
    let (code, msg) = blocked(g3.assert_outbound(a, OutboundMode::Manual, meta).await);
    assert_eq!(code, BlockCode::ChannelLocked);
    assert!(msg.contains("tạm khoá") && msg.contains("nghi spam"), "{msg}");
    assert_eq!(
        blocked(g3.reserve(a, QuotaKind::Post, 1, meta).await).0,
        BlockCode::ChannelLocked
    );
    assert_eq!(
        blocked(g3.reserve(a, QuotaKind::CommentReply, 1, meta).await).0,
        BlockCode::ChannelLocked
    );
    let st = g3.status(a).await.unwrap();
    assert!(st.locked.locked && st.locked.reason.as_deref() == Some("nghi spam"));
    assert!(st.warnings[0].contains("tạm khoá"));
    g3.assert_outbound(b, OutboundMode::Manual, meta).await.unwrap();
    assert!(e.platform.set_channel_lock(a.id(), false, None).await.unwrap());
    // Cache khoá 10 giây: dùng guard/platform mới để thấy ngay.
    let p2 = Platform::new(&e.db, None);
    assert!(!p2.channel_lock(a.id()).await.unwrap().locked);
    assert!(!e.platform.set_channel_lock(9999, true, None).await.unwrap());

    // ───── tỉ lệ lỗi Graph → tạm dừng (A: hai lỗi #368)
    let g4 = e.guard();
    g4.record_graph(a, OK).await;
    g4.record_graph(a, send(Some(368), 400)).await;
    g4.record_graph(a, send(Some(368), 400)).await;
    let r = g4.block_reason(a, auto, meta).await.unwrap().expect("A phải tạm dừng");
    assert_eq!(r.code, BlockCode::ChannelPaused);
    assert!(r.message.contains("tạm dừng đến"));
    assert_eq!(
        blocked(g4.reserve(a, QuotaKind::CommentReply, 1, meta).await).0,
        BlockCode::ChannelPaused
    );
    // Tin tay của A, và B, vẫn chạy; phạm vi Zalo không bị chặn theo Graph.
    assert!(g4.block_reason(a, OutboundMode::Manual, meta).await.unwrap().is_none());
    assert!(g4.block_reason(b, auto, meta).await.unwrap().is_none());
    assert!(g4.block_reason(a, auto, OutboundScope::Other).await.unwrap().is_none());
    let st = g4.status(a).await.unwrap();
    assert!(st.auto_pause.as_ref().unwrap().reason.contains("#368"));
    assert!(st.recent_events.iter().any(|ev| ev.kind == "auto_pause"));
    assert!(st.warnings.join(" ").contains("tạm dừng"));
    assert_eq!(e.events(a, "auto_pause").await, 1);
    // Tiến trình khác (guard mới, cache trống) đọc trạng thái từ DB.
    assert!(e.guard().block_reason(a, auto, meta).await.unwrap().is_some());
    // Mở lại sớm.
    assert!(g4.resume(a, "Mở lại gửi tự động").await);
    assert!(g4.block_reason(a, auto, meta).await.unwrap().is_none());
    assert!(!g4.resume(a, "Mở lại gửi tự động").await);

    // Lỗi thường (190) + thành công: không tạm dừng; #17/#32/#551 tỉ lệ cao thì tạm dừng.
    for _ in 0..30 {
        g4.record_graph(b, send(Some(190), 400)).await;
    }
    for _ in 0..30 {
        g4.record_graph(b, OK).await;
    }
    assert!(g4.block_reason(b, auto, meta).await.unwrap().is_none());
    for i in 0..30 {
        g4.record_graph(b, send(Some([17, 32, 551][i % 3]), 400)).await;
    }
    assert_eq!(
        g4.block_reason(b, auto, meta).await.unwrap().unwrap().code,
        BlockCode::ChannelPaused
    );

    // ───── không phải lỗi do công ty
    let g5 = e.guard();
    for i in 0..60 {
        g5.record_graph(a, read_fail(if i % 2 == 1 { 10 } else { 200 })).await;
    }
    for _ in 0..5 {
        g5.record_graph(a, OK).await;
    }
    for _ in 0..40 {
        g5.record_graph(a, send(Some(200), 400)).await;
    }
    for code in [10, 551] {
        for _ in 0..40 {
            g5.record_graph(
                a,
                GraphOutcome {
                    subcode: Some(2_018_278),
                    ..send(Some(code), 400)
                },
            )
            .await;
        }
    }
    assert!(g5.block_reason(a, auto, meta).await.unwrap().is_none());

    // Backoff cấp app: một lần lẻ hoặc lời gọi ĐỌC không kích; lặp ≥ 3 lời gọi gửi thì cả app lùi (kể cả Zalo thì không), tin tay vẫn gửi.
    let g6 = e.guard();
    g6.record_graph(a, send(Some(613), 400)).await;
    for _ in 0..20 {
        g6.record_graph(
            a,
            GraphOutcome {
                send: false,
                ..send(None, 429)
            },
        )
        .await;
    }
    assert!(g6.block_reason(a, auto, meta).await.unwrap().is_none());
    let before = e.events(a, "auto_pause").await;
    g6.record_graph(a, send(Some(4), 400)).await;
    g6.record_graph(a, send(None, 429)).await;
    let r = g6.block_reason(a, auto, meta).await.unwrap().unwrap();
    assert_eq!(r.code, BlockCode::ChannelPaused);
    assert!(r.message.contains("giới hạn tần suất chung"));
    assert!(r.until.is_some());
    assert!(g6.block_reason(a, OutboundMode::Manual, meta).await.unwrap().is_none());
    assert!(
        g6.block_reason(b, auto, meta).await.unwrap().is_some(),
        "backoff cấp app áp cho mọi công ty"
    );
    assert!(g6.block_reason(a, auto, OutboundScope::Other).await.unwrap().is_none());
    assert_eq!(
        e.events(a, "auto_pause").await,
        before,
        "giới hạn cấp app không đổ cho công ty"
    );
    // Khoá kênh chặn cả hai phạm vi.
    assert!(e.platform.set_channel_lock(a.id(), true, Some("thử")).await.unwrap());
    let g7 = e.guard();
    assert_eq!(
        g7.block_reason(a, auto, OutboundScope::Other)
            .await
            .unwrap()
            .unwrap()
            .code,
        BlockCode::ChannelLocked
    );
    assert!(e.platform.set_channel_lock(a.id(), false, None).await.unwrap());

    // ───── NOTIFY graph do tiến trình khác phát vào cửa sổ lỗi của guard này
    let listen_opts = e.t.cfg(true).connect_options().unwrap();
    let mut rx = sync::listen(listen_opts);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let g8 = e.guard();
    // Hai lỗi #368 của A do tiến trình khác phát (origin khác: tin của chính mình bị lọc ở bên nghe).
    let a_before = e.events(a, "auto_pause").await;
    {
        let mut c = e.t.conn().await;
        for _ in 0..2 {
            let mut f = Map::new();
            f.insert("ok".into(), json!(false));
            f.insert("h".into(), json!(400));
            f.insert("code".into(), json!(368));
            f.insert("send".into(), json!(true));
            let payload = sync::build_payload("node-khac-1", "graph", i64::from(a.id()), &f).unwrap();
            sqlx::query("SELECT pg_notify($1, $2)")
                .bind(sync::SYNC_CHANNEL)
                .bind(payload)
                .execute(&mut c)
                .await
                .unwrap();
        }
    }
    let mut got = 0;
    while got < 2 {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("nhận NOTIFY")
            .expect("kênh mở");
        if matches!(ev, SyncEvent::Message(_)) {
            g8.on_sync_event(&ev).await;
            got += 1;
        }
    }
    assert_eq!(
        e.events(a, "auto_pause").await,
        a_before + 1,
        "hai lỗi #368 phát qua NOTIFY ⇒ A tạm dừng"
    );
    assert!(g8.block_reason(a, auto, meta).await.unwrap().is_some());
    // Resync xoá cache cục bộ.
    g8.on_sync_event(&SyncEvent::Resync).await;

    // ───── tin của chính mình lan sang tiến trình khác (record_graph phát NOTIFY với origin của tiến trình này)
    let mut rx2 = sync::listen(e.t.cfg(true).connect_options().unwrap());
    tokio::time::sleep(Duration::from_millis(500)).await;
    g8.record_graph(b, send(Some(551), 400)).await;
    // Cùng tiến trình ⇒ bị lọc ở bên nghe: không có Message nào về.
    assert!(
        tokio::time::timeout(Duration::from_millis(800), async {
            loop {
                if let Some(SyncEvent::Message(m)) = rx2.recv().await {
                    break m;
                }
            }
        })
        .await
        .is_err()
    );
    drop(rx);
    drop(rx2);

    // ───── hoàn hạn mức; giữ chỗ trong giao dịch
    e.set_plan(a, "custom").await;
    assert!(e.guard().resume(a, "Mở lại gửi tự động").await); // A đang tạm dừng do bước NOTIFY
    let g9 = e.guard();
    let used0 = g9.status(a).await.unwrap().usage.bulk_messages_today;
    let bucket = g9.reserve(a, QuotaKind::BulkMessage, 2, meta).await.unwrap().unwrap();
    g9.refund(a, QuotaKind::BulkMessage, 1, Some(bucket)).await;
    assert_eq!(g9.status(a).await.unwrap().usage.bulk_messages_today, used0 + 1);
    g9.refund(a, QuotaKind::BulkMessage, 1_000_000, None).await;
    assert_eq!(g9.status(a).await.unwrap().usage.bulk_messages_today, 0);

    // Hạn mức đọc trước giao dịch; giao dịch lỗi (rollback) thì không tính.
    let ctx = g9
        .prepare_reserve(a, QuotaKind::BulkMessage, meta)
        .await
        .unwrap()
        .expect("đa công ty");
    assert_eq!(ctx.limit, 5000);
    {
        let t = e.db.tenant(a).await.unwrap();
        let mut tx = t.begin().await.unwrap();
        g9.reserve_in(&mut tx, &ctx, 7).await.unwrap();
        tx.rollback().await.unwrap();
    }
    assert_eq!(g9.status(a).await.unwrap().usage.bulk_messages_today, 0);
    // Hết hạn mức TRONG giao dịch: sự kiện không ghi trong giao dịch, chỉ ghi sau `record_blocked`.
    e.set_plan(b, "ket_noi").await;
    let g10 = e.guard();
    // B đang tạm dừng tự động nhưng `Post` chỉ chịu khoá kênh.
    let ctx_b = g10.prepare_reserve(b, QuotaKind::Post, meta).await.unwrap().unwrap();
    let ev_before = e.events(b, "limit_exceeded").await;
    let mut err = {
        let t = e.db.tenant(b).await.unwrap();
        let mut tx = t.begin().await.unwrap();
        let r = g10.reserve_in(&mut tx, &ctx_b, 1).await; // B đã dùng hết 10 bài
        tx.rollback().await.unwrap();
        r.unwrap_err()
    };
    assert_eq!(err.block_code(), Some(BlockCode::ChannelQuota));
    assert_eq!(
        e.events(b, "limit_exceeded").await,
        ev_before,
        "chưa ghi trong giao dịch"
    );
    g10.record_blocked(b, &mut err).await;
    assert_eq!(e.events(b, "limit_exceeded").await, ev_before + 1);
    g10.record_blocked(b, &mut err).await;
    assert_eq!(
        e.events(b, "limit_exceeded").await,
        ev_before + 1,
        "mỗi lần chỉ ghi một sự kiện"
    );

    // Cảnh báo nhẹ chỉ có chữ, không lộ hạn mức hay sự kiện.
    let al = serde_json::to_value(g10.alerts(a).await.unwrap()).unwrap();
    let mut keys: Vec<_> = al.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["enforced", "locked", "paused", "warnings"]);

    // ───── HTTP: hai đường settings/channel-guard
    let security = Security::new(e.db.clone(), e.platform.clone(), true);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(e.db.clone(), cache.clone());
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security.clone(), JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 2);
    let app: Router = router.with_state(Arc::new(e.guard()));
    let mut c = e.t.conn().await;
    let admin_a: i32 = sqlx::query_scalar("SELECT id FROM c_2.users ORDER BY id LIMIT 1")
        .fetch_one(&mut c)
        .await
        .unwrap();
    exec(
        &mut c,
        "INSERT INTO c_2.users (email, password_hash, full_name, status, updated_at)
         VALUES ('nv@m45.test', 'x', 'Nhân viên', 'active', now())",
    )
    .await;
    let staff_a: i32 = sqlx::query_scalar("SELECT id FROM c_2.users WHERE email = 'nv@m45.test'")
        .fetch_one(&mut c)
        .await
        .unwrap();
    let token = |user: i32, cid: i64| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        jwt::sign(
            &Claims::access(i64::from(user), "x@m45.test", None, Some(cid), now),
            JWT,
        )
        .unwrap()
    };
    let call = |path: &'static str, tok: Option<String>| {
        let app = app.clone();
        async move {
            let mut rq = Request::builder().method(Method::GET).uri(path);
            if let Some(t) = tok {
                rq = rq.header("authorization", format!("Bearer {t}"));
            }
            let resp = app.oneshot(rq.body(Body::empty()).unwrap()).await.unwrap();
            let status = resp.status().as_u16();
            let raw = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&raw).unwrap_or(Value::Null))
        }
    };
    const S: &str = "/api/v1/settings/channel-guard";
    const AL: &str = "/api/v1/settings/channel-guard/alerts";
    assert_eq!(call(S, None).await.0, 401);
    assert_eq!(call(AL, None).await.0, 401);
    // Nhân viên không có `settings.features`: 403 ở trạng thái đầy đủ, vẫn xem được cảnh báo chữ.
    assert_eq!(call(S, Some(token(staff_a, 2))).await.0, 403);
    let (st, body) = call(AL, Some(token(staff_a, 2))).await;
    assert_eq!(st, 200);
    assert_eq!(body["enforced"], true);
    assert!(body["warnings"].is_array());
    let (st, body) = call(S, Some(token(admin_a, 2))).await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body["enforced"], true);
    assert_eq!(body["plan"], "custom");
    assert_eq!(body["limits"]["recipientsPerCampaign"], 2000);
    assert!(body["usage"]["bulk_messages_today"].is_i64());
    assert!(body["recent_events"].is_array());
    assert!(body["locked"]["locked"] == false);
    let _ = g;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn ban_cai_mot_cong_ty_khong_bi_han_muc() {
    let t = TestDb::new().await;
    let db = Db::connect_lazy(&t.cfg(false)).unwrap();
    let platform = Platform::new(&db, None);
    let g = ChannelGuard::with_config(db, platform, GraphGuardConfig::from_lookup(|_| None));
    let c = CompanyRef::new(1).unwrap();
    assert!(!g.enforced());
    assert!(
        g.reserve(c, QuotaKind::BulkMessage, 1_000_000, OutboundScope::Meta)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        g.prepare_reserve(c, QuotaKind::Post, OutboundScope::Meta)
            .await
            .unwrap()
            .is_none()
    );
    g.assert_recipients(c, u32::MAX).await.unwrap();
    assert_eq!(g.recipient_cap(c).await, u32::MAX);
    for _ in 0..50 {
        g.record_graph(c, send(Some(368), 400)).await;
    }
    assert!(
        g.block_reason(c, OutboundMode::Auto, OutboundScope::Meta)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!g.resume(c, "x").await);
    let al = g.alerts(c).await.unwrap();
    assert!(!al.enforced && !al.locked && !al.paused && al.warnings.is_empty());
    let st = g.status(c).await.unwrap();
    assert!(!st.enforced && st.recent_events.is_empty());
}
