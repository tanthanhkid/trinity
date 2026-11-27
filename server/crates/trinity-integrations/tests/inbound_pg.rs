//! M35 trên Postgres thật (schema thật do `provision_company` migrate): nguồn webhook vào, nhận khách, trùng lặp không tạo hai khách,
//! chữ ký, hạn mức, nhật ký.
//!
//! Test tự tạo một DB trống (`<DB của TEST_DATABASE_URL>_m35_<pid>_<n>`), tạo một công ty (c_2) rồi xoá DB:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-integrations --test inbound_pg -- --ignored`

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::platform::Platform;
use trinity_db::provision::{ProvisionInput, provision_company};
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb, migrate};
use trinity_integrations::webhooks::inbound::receive::{InboundError, InboundRequest, InboundService, Outcome};
use trinity_integrations::webhooks::inbound::sources::{
    self, Actor, CreateInboundSource, SourceError, Tenant, UpdateInboundSource,
};
use trinity_integrations::webhooks::secret::{KeyError, KeySource};
use trinity_integrations::webhooks::signature::build_signature_header;
use trinity_rbac::OwnerIds;

const KEY: [u8; 32] = [7; 32];

const SETUP: &str = "
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
";

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn url_for(db: &str) -> String {
    let base = base_url();
    let (head, query) = base
        .split_once('?')
        .map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
    let (server, _) = head.rsplit_once('/').expect("URL có tên DB");
    query.map_or_else(|| format!("{server}/{db}"), |q| format!("{server}/{db}?{q}"))
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

impl Drop for TestDb {
    fn drop(&mut self) {
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(mut admin) = PgConnection::connect(&base_url()).await {
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

struct Env {
    t: TestDb,
    tdb: TenantDb,
    company: CompanyRef,
    admin: i32,
    /// Sale nhận khách (đang hoạt động).
    sale: i32,
    /// Người ngoài tầm `contacts.transfer`.
    other: i32,
    /// Id nguồn khách đang bật.
    src_opt: i32,
}

impl Env {
    /// Kết nối thường, đã đặt `search_path` về schema công ty (trigger mã khách gọi hàm không kèm schema).
    async fn conn(&self) -> PgConnection {
        let mut c = PgConnection::connect(&self.t.url).await.unwrap();
        exec(&mut c, "SET search_path TO c_2, public").await;
        c
    }

    async fn scalar(&self, sql: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
            .fetch_one(&mut self.conn().await)
            .await
            .unwrap()
    }
}

async fn env() -> Env {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let base = base_url();
    let dbname = base
        .split_once('?')
        .map_or(base.as_str(), |(h, _)| h)
        .rsplit_once('/')
        .map(|(_, d)| d.to_owned())
        .unwrap();
    let name = format!(
        "{dbname}_m35_{}_{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let mut admin_conn = PgConnection::connect(&base).await.unwrap();
    exec(
        &mut admin_conn,
        &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"),
    )
    .await;
    exec(&mut admin_conn, &format!("CREATE DATABASE \"{name}\"")).await;
    let url = url_for(&name);
    let t = TestDb { name, url: url.clone() };
    exec(&mut PgConnection::connect(&url).await.unwrap(), SETUP).await;
    let mut cfg = DbConfig::new(url);
    cfg.multi_tenant = true;
    cfg.pool_size = 16;
    cfg.acquire_timeout = Duration::from_secs(30);
    cfg.statement_timeout = Duration::ZERO;
    let db = Db::connect_lazy(&cfg).unwrap();
    let platform = Platform::new(&db, None);
    let res = provision_company(
        &db,
        &platform,
        &migrate::embedded_migrations(),
        migrate::latest_embedded(),
        &ProvisionInput {
            company_name: "Công ty M35".into(),
            admin_email: "admin@m35.test".into(),
            admin_password: "mat-khau-thu-123".into(),
            admin_name: "Quản trị".into(),
        },
    )
    .await
    .unwrap();
    let company = res.company;
    let mut c = PgConnection::connect(&t.url).await.unwrap();
    exec(
        &mut c,
        "INSERT INTO c_2.users (email, password_hash, full_name, status, updated_at) VALUES
           ('sale@m35.test', 'x', 'Sale', 'active', now()), ('other@m35.test', 'x', 'Người ngoài', 'active', now());
         INSERT INTO c_2.users (email, password_hash, full_name, status, updated_at) VALUES ('off@m35.test', 'x', 'Nghỉ', 'locked', now())",
    )
    .await;
    let id_of = |email: &str| format!("SELECT id FROM c_2.users WHERE email = '{email}'");
    let sale: i32 = sqlx::query_scalar(AssertSqlSafe(id_of("sale@m35.test")))
        .fetch_one(&mut c)
        .await
        .unwrap();
    let other: i32 = sqlx::query_scalar(AssertSqlSafe(id_of("other@m35.test")))
        .fetch_one(&mut c)
        .await
        .unwrap();
    let admin: i32 = sqlx::query_scalar(AssertSqlSafe(id_of("admin@m35.test")))
        .fetch_one(&mut c)
        .await
        .unwrap();
    let src_opt: i32 = sqlx::query_scalar(
        "SELECT id FROM c_2.setting_options WHERE group_key = 'contact_source' AND is_active ORDER BY id LIMIT 1",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    let tdb = db.tenant(company).await.unwrap();
    Env {
        t,
        tdb,
        company,
        admin,
        sale,
        other,
        src_opt,
    }
}

fn keys() -> KeySource {
    Arc::new(|| Ok(KEY))
}

fn service(enabled: bool) -> InboundService {
    InboundService::new(keys(), Arc::new(move || enabled))
}

fn tenant(e: &Env) -> Tenant {
    Tenant {
        company_id: e.company.id(),
        multi_tenant: true,
    }
}

fn actor(e: &Env, transfer: Option<OwnerIds>) -> Actor {
    Actor {
        user_id: e.admin,
        transfer,
    }
}

async fn create_source(e: &Env, signed: bool) -> Value {
    let mut c = e.tdb.acquire().await.unwrap();
    sources::create(
        &mut c,
        &keys(),
        tenant(e),
        &CreateInboundSource {
            name: "Landing page".into(),
            default_assignee_id: e.sale,
            contact_source_id: e.src_opt,
            project_id: None,
            signed,
        },
        &actor(e, Some(OwnerIds::All)),
    )
    .await
    .unwrap()
}

async fn post(
    svc: &InboundService,
    e: &Env,
    token: &str,
    body: &Value,
    sig: Option<&str>,
) -> Result<trinity_integrations::webhooks::inbound::receive::InboundResult, InboundError> {
    let raw = serde_json::to_vec(body).unwrap();
    svc.receive(
        &e.tdb,
        token,
        &InboundRequest {
            raw_body: Some(&raw),
            body,
            signature: sig,
        },
    )
    .await
}

fn lead(phone: &str, extra: Value) -> Value {
    let mut b = json!({ "name": "Khách thử", "phone": phone });
    b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    b
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn quan_tri_nguon_token_phan_quyen_va_xoa() {
    let e = env().await;
    let created = create_source(&e, true).await;
    let token = created["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("whk_") && token.len() == 47);
    assert_eq!(
        created["path"],
        format!("/api/v1/hooks/in/{token}?cid=2"),
        "bản nhiều công ty có gợi ý ?cid="
    );
    assert!(created["signing_secret"].as_str().unwrap().starts_with("whsec_"));
    assert_eq!(created["signed"], true);
    assert!(created.get("token_hash").is_none() && created.get("signing_secret_enc").is_none());
    let id = i32::try_from(created["id"].as_i64().unwrap()).unwrap();

    let mut c = e.tdb.acquire().await.unwrap();
    // Danh sách và chi tiết KHÔNG có token/secret, vẫn có cờ `signed`.
    let list = sources::list(&mut c).await.unwrap();
    assert_eq!(list["data"].as_array().unwrap().len(), 1);
    let got = sources::get(&mut c, id).await.unwrap();
    for v in [&list["data"][0], &got] {
        assert!(v.get("token").is_none() && v.get("path").is_none() && v.get("signing_secret").is_none());
        assert_eq!(v["signed"], true);
        assert_eq!(v["token_prefix"], &token[..12]);
    }
    assert!(matches!(
        sources::get(&mut c, 99_999).await,
        Err(SourceError::NotFound(_))
    ));

    // Người nhận: phải hoạt động và nằm trong `contacts.transfer` của người cấu hình.
    let mk = |assignee: i32, source: i32, project: Option<i32>| CreateInboundSource {
        name: "X".into(),
        default_assignee_id: assignee,
        contact_source_id: source,
        project_id: project,
        signed: false,
    };
    let off: i32 = e
        .scalar("SELECT id::bigint FROM c_2.users WHERE email = 'off@m35.test'")
        .await
        .try_into()
        .unwrap();
    let a_all = actor(&e, Some(OwnerIds::All));
    let err = sources::create(&mut c, &keys(), tenant(&e), &mk(off, e.src_opt, None), &a_all)
        .await
        .unwrap_err();
    assert!(matches!(&err, SourceError::BadRequest(m) if m == "Người nhận không tồn tại hoặc không hoạt động"));
    let a_few = actor(&e, Some(OwnerIds::Ids(vec![e.sale])));
    let err = sources::create(&mut c, &keys(), tenant(&e), &mk(e.other, e.src_opt, None), &a_few)
        .await
        .unwrap_err();
    assert_eq!(err.http_status(), 403);
    let a_none = actor(&e, None);
    assert_eq!(
        sources::create(&mut c, &keys(), tenant(&e), &mk(e.sale, e.src_opt, None), &a_none)
            .await
            .unwrap_err()
            .http_status(),
        403
    );
    // Tự gán cho mình thì không cần phạm vi.
    assert!(
        sources::create(&mut c, &keys(), tenant(&e), &mk(e.admin, e.src_opt, None), &a_none)
            .await
            .is_ok()
    );
    // Nguồn khách sai nhóm, dự án không có.
    let stage: i32 = e
        .scalar("SELECT id::bigint FROM c_2.setting_options WHERE group_key = 'contact_stage' LIMIT 1")
        .await
        .try_into()
        .unwrap();
    let err = sources::create(&mut c, &keys(), tenant(&e), &mk(e.sale, stage, None), &a_all)
        .await
        .unwrap_err();
    assert!(matches!(&err, SourceError::BadRequest(m) if m.contains("không thuộc nhóm nguồn khách")));
    let err = sources::create(&mut c, &keys(), tenant(&e), &mk(e.sale, e.src_opt, Some(9999)), &a_all)
        .await
        .unwrap_err();
    assert!(matches!(&err, SourceError::BadRequest(m) if m == "project_id không tồn tại"));
    // Thiếu khoá mã hoá ⇒ 503.
    let no_key: KeySource = Arc::new(|| {
        Err(KeyError(
            "INTEGRATIONS_SECRET_KEY chưa được cấu hình (cần 32 byte base64)".into(),
        ))
    });
    assert_eq!(
        sources::create(&mut c, &no_key, tenant(&e), &mk(e.sale, e.src_opt, None), &a_all)
            .await
            .unwrap_err()
            .http_status(),
        503
    );

    // Sửa: đổi tên + bỏ dự án; `signed:true` cấp secret mới (trả một lần); `signed:false` bỏ yêu cầu chữ ký.
    let upd = UpdateInboundSource {
        name: Some("Đổi tên".into()),
        project_id: Some(None),
        ..Default::default()
    };
    let r = sources::update(&mut c, &keys(), id, &upd, &a_all).await.unwrap();
    assert_eq!(r["name"], "Đổi tên");
    assert!(r.get("signing_secret").is_none());
    let r = sources::update(
        &mut c,
        &keys(),
        id,
        &UpdateInboundSource {
            signed: Some(true),
            ..Default::default()
        },
        &a_all,
    )
    .await
    .unwrap();
    assert!(r["signing_secret"].as_str().unwrap().starts_with("whsec_"));
    let r = sources::update(
        &mut c,
        &keys(),
        id,
        &UpdateInboundSource {
            signed: Some(false),
            ..Default::default()
        },
        &a_all,
    )
    .await
    .unwrap();
    assert_eq!(r["signed"], false);
    // Chỉ TẮT nguồn thì không cần phạm vi với người nhận; đổi khác thì cần.
    let off_only = UpdateInboundSource {
        is_active: Some(false),
        ..Default::default()
    };
    assert_eq!(
        sources::update(&mut c, &keys(), id, &off_only, &a_none).await.unwrap()["is_active"],
        false
    );
    let rename = UpdateInboundSource {
        name: Some("Z".into()),
        ..Default::default()
    };
    assert_eq!(
        sources::update(&mut c, &keys(), id, &rename, &a_none)
            .await
            .unwrap_err()
            .http_status(),
        403
    );

    // Tạo lại token: URL cũ vô hiệu ngay.
    sources::update(
        &mut c,
        &keys(),
        id,
        &UpdateInboundSource {
            is_active: Some(true),
            ..Default::default()
        },
        &a_all,
    )
    .await
    .unwrap();
    let svc = service(true);
    drop(c);
    assert!(
        post(&svc, &e, &token, &lead("0912000001", json!({})), None)
            .await
            .is_ok()
    );
    let mut c = e.tdb.acquire().await.unwrap();
    assert_eq!(
        sources::rotate_token(&mut c, tenant(&e), id, &a_none)
            .await
            .unwrap_err()
            .http_status(),
        403
    );
    let rot = sources::rotate_token(&mut c, tenant(&e), id, &a_all).await.unwrap();
    let new_token = rot["token"].as_str().unwrap().to_owned();
    assert_ne!(new_token, token);
    drop(c);
    assert!(matches!(
        post(&svc, &e, &token, &lead("0912000002", json!({})), None).await,
        Err(InboundError::NotFound)
    ));
    assert!(
        post(&svc, &e, &new_token, &lead("0912000002", json!({})), None)
            .await
            .is_ok()
    );

    // Xoá: biên nhận idempotency đi theo, token hết dùng; nhật ký quản trị ghi đủ.
    post(
        &svc,
        &e,
        &new_token,
        &lead("0912000003", json!({ "external_id": "e-1" })),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM c_2.webhook_inbound_receipts WHERE source_id = {id}"
        ))
        .await,
        1
    );
    let mut c = e.tdb.acquire().await.unwrap();
    assert_eq!(
        sources::remove(&mut c, id, &a_all).await.unwrap(),
        json!({ "deleted": true })
    );
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM c_2.webhook_inbound_receipts WHERE source_id = {id}"
        ))
        .await,
        0
    );
    assert!(matches!(
        sources::remove(&mut c, id, &a_all).await,
        Err(SourceError::NotFound(_))
    ));
    drop(c);
    assert!(matches!(
        post(&svc, &e, &new_token, &lead("0912000004", json!({})), None).await,
        Err(InboundError::NotFound)
    ));
    for action in [
        "source.created",
        "source.updated",
        "source.token_rotated",
        "source.deleted",
    ] {
        assert!(
            e.scalar(&format!(
                "SELECT count(*) FROM c_2.integration_audit_logs WHERE channel = 'webhook_in' AND action = '{action}'"
            ))
            .await
                >= 1,
            "{action}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn nhan_khach_trung_lap_khong_tao_hai_khach() {
    let e = env().await;
    let svc = service(true);
    let created = create_source(&e, false).await;
    let token = created["token"].as_str().unwrap().to_owned();
    let sid = created["id"].as_i64().unwrap();
    let public = json!({ "status": "accepted", "contact_id": null });

    // Số mới ⇒ tạo khách thuộc sale nhận, nguồn khách của nguồn, `contact.created` (origin webhook_in), activity, nhật ký.
    let r = post(&svc, &e, &token, &lead("+84 912 000 010", json!({ "email": "a@x.vn", "note": "quan tâm", "source": "FB", "external_id": "L-1", "extra": { "utm": "x" } })), None)
        .await
        .unwrap();
    assert_eq!((r.http_status, &r.body, r.outcome), (200, &public, Outcome::Created));
    let cid = r.contact_id.unwrap();
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone = '0912000010'")
            .await,
        1
    );
    let (assigned, source, email): (i32, i32, Option<String>) = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT assigned_to, source_id, email FROM c_2.contacts WHERE id = {cid}"
    )))
    .fetch_one(&mut e.conn().await)
    .await
    .unwrap();
    assert_eq!(
        (assigned, source, email.as_deref()),
        (e.sale, e.src_opt, Some("a@x.vn"))
    );
    let ev: Value = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT payload FROM c_2.integration_events WHERE event_type = 'contact.created' AND resource_id = '{cid}'"
    )))
    .fetch_one(&mut e.conn().await)
    .await
    .unwrap();
    assert_eq!(ev["origin"], "webhook_in");
    assert_eq!(ev["contact"]["phone"], "0912000010");
    let act: (Value, Value) = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT details, metadata FROM c_2.activities WHERE contact_id = {cid}"
    )))
    .fetch_one(&mut e.conn().await)
    .await
    .unwrap();
    assert_eq!(act.0["description"], "Tạo từ webhook \"Landing page\" (FB) — quan tâm");
    assert_eq!(act.1["external_id"], "L-1");
    assert_eq!(act.1["extra"]["utm"], "x");

    // Gửi lại cùng external_id ⇒ replayed: không thêm khách, không thêm activity, cùng phản hồi.
    let r = post(
        &svc,
        &e,
        &token,
        &lead("0912000010", json!({ "external_id": "L-1" })),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        (&r.body, r.outcome, r.contact_id),
        (&public, Outcome::Replayed, Some(cid))
    );
    assert_eq!(
        e.scalar(&format!("SELECT count(*) FROM c_2.activities WHERE contact_id = {cid}"))
            .await,
        1
    );

    // Số đã có của người KHÁC ⇒ không tạo khách thứ hai, chỉ ghi dấu vết ngắn (không `extra`, ghi chú cắt 500); phản hồi y hệt.
    let other_c: i32 = sqlx::query_scalar(AssertSqlSafe(format!(
        "INSERT INTO c_2.contacts (phone, full_name, assigned_to, updated_at) VALUES ('0912000020', 'Của người khác', {}, now()) RETURNING id",
        e.other
    )))
    .fetch_one(&mut e.conn().await)
    .await
    .unwrap();
    let long = "n".repeat(900);
    let r = post(
        &svc,
        &e,
        &token,
        &lead("0912000020", json!({ "note": long, "extra": { "k": "v" } })),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        (&r.body, r.outcome, r.contact_id),
        (&public, Outcome::Duplicate, Some(other_c))
    );
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone IN ('0912000020', '84912000020', '+84912000020')")
            .await,
        1
    );
    let a2: (Value, Value) = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT details, metadata FROM c_2.activities WHERE contact_id = {other_c}"
    )))
    .fetch_one(&mut e.conn().await)
    .await
    .unwrap();
    assert!(
        a2.0["description"]
            .as_str()
            .unwrap()
            .starts_with("Khách gửi lại từ webhook")
    );
    assert!(a2.0["description"].as_str().unwrap().chars().count() < 600);
    assert!(a2.1.get("extra").is_none());
    // Số lưu dạng +84 vẫn là trùng.
    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO c_2.contacts (phone, assigned_to, updated_at) VALUES ('+84912000030', {}, now())",
        e.sale
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();
    let r = post(&svc, &e, &token, &lead("0912000030", json!({})), None)
        .await
        .unwrap();
    assert_eq!(r.outcome, Outcome::Duplicate);
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone IN ('0912000030', '+84912000030')")
            .await,
        1
    );

    // 12 request song song cùng SĐT mới (khác external_id) ⇒ đúng MỘT khách.
    let svc2 = Arc::new(svc.clone());
    let e = Arc::new(e);
    let mut hs = Vec::new();
    for i in 0..12 {
        let (svc, e, token) = (svc2.clone(), e.clone(), token.clone());
        hs.push(tokio::spawn(async move {
            post(
                &svc,
                &e,
                &token,
                &lead("0912000040", json!({ "external_id": format!("P-{i}") })),
                None,
            )
            .await
            .unwrap()
            .outcome
        }));
    }
    let mut outs = Vec::new();
    for h in hs {
        outs.push(h.await.unwrap());
    }
    assert_eq!(outs.iter().filter(|o| **o == Outcome::Created).count(), 1, "{outs:?}");
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone = '0912000040'")
            .await,
        1
    );
    // 8 request song song cùng external_id ⇒ đúng MỘT khách.
    let mut hs = Vec::new();
    for _ in 0..8 {
        let (svc, e, token) = (svc2.clone(), e.clone(), token.clone());
        hs.push(tokio::spawn(async move {
            post(
                &svc,
                &e,
                &token,
                &lead("0912000050", json!({ "external_id": "SAME" })),
                None,
            )
            .await
            .unwrap()
            .outcome
        }));
    }
    let mut outs = Vec::new();
    for h in hs {
        outs.push(h.await.unwrap());
    }
    assert_eq!(outs.iter().filter(|o| **o == Outcome::Created).count(), 1, "{outs:?}");
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone = '0912000050'")
            .await,
        1
    );
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM c_2.webhook_inbound_receipts WHERE source_id = {sid} AND external_id = 'SAME'"
        ))
        .await,
        1
    );

    // Nhật ký nội bộ ghi kết quả thật, không có SĐT/body, tác nhân không phải sale nhận.
    let rows: Vec<(String, Option<i32>, Value, Option<String>)> = sqlx::query_as(
        "SELECT status, user_id, metadata, client_id FROM c_2.integration_audit_logs WHERE channel = 'webhook_in' AND action = 'receive'",
    )
    .fetch_all(&mut e.conn().await)
    .await
    .unwrap();
    assert!(rows.len() >= 20);
    for (status, user, meta, client) in &rows {
        assert_eq!((status.as_str(), *user), ("ok", None));
        assert_eq!(client.as_deref(), Some(format!("source:{sid}").as_str()));
        assert!(!meta.to_string().contains("0912"), "{meta}");
    }
    let results: Vec<_> = rows.iter().filter_map(|r| r.2["result"].as_str()).collect();
    for k in ["created", "duplicate", "replayed"] {
        assert!(results.contains(&k), "{k}");
    }
    assert!(
        e.scalar(&format!(
            "SELECT count(*) FROM c_2.webhook_inbound_sources WHERE id = {sid} AND last_received_at IS NOT NULL"
        ))
        .await
            == 1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn xac_thuc_chu_ky_han_muc_va_loi() {
    let e = env().await;
    let svc = service(true);
    let ok_body = lead("0912000100", json!({}));

    // Cờ tắt, token sai định dạng, token lạ ⇒ 404 không phân biệt.
    let signed = create_source(&e, true).await;
    let token = signed["token"].as_str().unwrap().to_owned();
    let secret = signed["signing_secret"].as_str().unwrap().to_owned();
    let sid = signed["id"].as_i64().unwrap();
    assert!(matches!(
        post(&service(false), &e, &token, &ok_body, None).await,
        Err(InboundError::NotFound)
    ));
    assert!(matches!(
        post(&svc, &e, "whk_ngan", &ok_body, None).await,
        Err(InboundError::NotFound)
    ));
    assert!(matches!(
        post(&svc, &e, &format!("whk_{}", "A".repeat(43)), &ok_body, None).await,
        Err(InboundError::NotFound)
    ));

    // Nguồn có secret: thiếu/sai/hết hạn chữ ký ⇒ 401 chung chung; đúng ⇒ qua. Chữ ký ký trên đúng byte của thân.
    let raw = serde_json::to_vec(&ok_body).unwrap();
    for sig in [
        None,
        Some("t=1,v1=abc".to_owned()),
        Some(build_signature_header("whsec_sai", &raw, now_ms())),
        Some(build_signature_header(&secret, &raw, now_ms() - 3_600_000)),
    ] {
        let err = post(&svc, &e, &token, &ok_body, sig.as_deref()).await.unwrap_err();
        assert!(
            matches!(&err, InboundError::Unauthorized(m) if m == "Chữ ký không hợp lệ"),
            "{err:?}"
        );
    }
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone = '0912000100'")
            .await,
        0
    );
    let good = build_signature_header(&secret, &raw, now_ms());
    assert_eq!(
        post(&svc, &e, &token, &ok_body, Some(&good)).await.unwrap().outcome,
        Outcome::Created
    );
    // Thiếu khoá giải mã ⇒ 503, KHÔNG bỏ qua kiểm chữ ký.
    let no_key = InboundService::new(Arc::new(|| Err(KeyError("thiếu khoá".into()))), Arc::new(|| true));
    let err = post(&no_key, &e, &token, &ok_body, Some(&good)).await.unwrap_err();
    assert_eq!(err.http_status(), 503);
    // Sai chữ ký bị đếm riêng: vượt 30 lần/phút ⇒ 429.
    let mut last = None;
    for _ in 0..40 {
        last = Some(post(&svc, &e, &token, &ok_body, Some("t=1,v1=abc")).await.unwrap_err());
    }
    assert!(matches!(last, Some(InboundError::RateLimited { .. })));
    // Nhật ký: 401 là `denied`; 429 chỉ ghi lần ĐẦU mỗi cửa sổ.
    assert!(e.scalar("SELECT count(*) FROM c_2.integration_audit_logs WHERE channel = 'webhook_in' AND status = 'denied' AND http_status = 401").await >= 4);
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.integration_audit_logs WHERE channel = 'webhook_in' AND http_status = 429")
            .await,
        1
    );

    // Nguồn không ký: thân rỗng / quá lớn / payload sai (không chép lại SĐT) / người nhận nghỉ / nguồn khách bị tắt.
    let plain = create_source(&e, false).await;
    let pt = plain["token"].as_str().unwrap().to_owned();
    let pid = plain["id"].as_i64().unwrap();
    let empty = svc
        .receive(
            &e.tdb,
            &pt,
            &InboundRequest {
                raw_body: None,
                body: &json!({}),
                signature: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(&empty, InboundError::BadRequest(m) if m.contains("Body phải là JSON")));
    let big = json!({ "name": "A", "phone": "0912000101", "note": "x".repeat(70_000) });
    let err = post(&svc, &e, &pt, &big, None).await.unwrap_err();
    assert_eq!(err.http_status(), 413);
    let err = post(&svc, &e, &pt, &json!({ "name": "A", "phone": "0912000101999" }), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, InboundError::BadRequest(m) if m.contains("phone") && !m.contains("0912000101999")),
        "{err:?}"
    );
    let err = post(&svc, &e, &pt, &json!([1]), None).await.unwrap_err();
    assert!(matches!(&err, InboundError::BadRequest(m) if m.contains("object")));
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone = '0912000101'")
            .await,
        0
    );
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE c_2.users SET status = 'locked' WHERE id = {}",
        e.sale
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();
    let err = post(&svc, &e, &pt, &lead("0912000102", json!({})), None)
        .await
        .unwrap_err();
    assert!(matches!(&err, InboundError::Unprocessable(m) if m.contains("Người nhận mặc định")));
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE c_2.users SET status = 'active' WHERE id = {}",
        e.sale
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE c_2.setting_options SET is_active = false WHERE id = {}",
        e.src_opt
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();
    let err = post(&svc, &e, &pt, &lead("0912000102", json!({})), None)
        .await
        .unwrap_err();
    assert_eq!(err.http_status(), 422);
    assert_eq!(
        e.scalar("SELECT count(*) FROM c_2.contacts WHERE phone = '0912000102'")
            .await,
        0
    );
    // Nguồn tắt ⇒ 404.
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE c_2.setting_options SET is_active = true WHERE id = {}",
        e.src_opt
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE c_2.webhook_inbound_sources SET is_active = false WHERE id = {pid}"
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();
    assert!(matches!(
        post(&svc, &e, &pt, &lead("0912000103", json!({})), None).await,
        Err(InboundError::NotFound)
    ));
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE c_2.webhook_inbound_sources SET is_active = true WHERE id = {pid}"
    )))
    .execute(&mut e.conn().await)
    .await
    .unwrap();

    // Hạn mức 100 request/phút/nguồn: request 101 ⇒ 429 (chỉ lần đầu ghi nhật ký).
    let lim = create_source(&e, false).await;
    let lt = lim["token"].as_str().unwrap().to_owned();
    let lid = lim["id"].as_i64().unwrap();
    for i in 0..100 {
        post(
            &svc,
            &e,
            &lt,
            &lead("0912000200", json!({ "external_id": format!("R-{i}") })),
            None,
        )
        .await
        .unwrap();
    }
    let first = post(&svc, &e, &lt, &lead("0912000200", json!({})), None)
        .await
        .unwrap_err();
    assert!(
        matches!(first, InboundError::RateLimited { first_in_window: true, retry_after_sec } if retry_after_sec >= 1)
    );
    let again = post(&svc, &e, &lt, &lead("0912000200", json!({})), None)
        .await
        .unwrap_err();
    assert!(matches!(
        again,
        InboundError::RateLimited {
            first_in_window: false,
            ..
        }
    ));
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM c_2.integration_audit_logs WHERE client_id = 'source:{lid}' AND http_status = 429"
        ))
        .await,
        1
    );
    let _ = sid;
}
