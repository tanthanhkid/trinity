//! «Ghi nhanh cuộc gọi» qua HTTP (`POST /api/v1/contacts/:id/notes`, router K14 thật, quyền thật, Postgres thật).
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-contacts --test notes_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9861..9869 và khách SĐT `0906861…`.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_contacts::list::CountCache;
use mod_contacts::routes::{Ctx, HookFuture, Hooks, api_router};
use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::outbox::CreatedNotification;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::router::{AccessDeps, CurrentUser};
use trinity_rbac::{OwnerIds, PermissionService, RbacCache, ScopeService};

const JWT: &str = "notes-jwt-secret-0123456789abcdef0123456789abcdef";
const ALL: i32 = 9861; // contacts.view + contacts.update phạm vi all
const OWN: i32 = 9862; // contacts.view + contacts.update phạm vi own
const VIEW: i32 = 9863; // chỉ contacts.view (all) — không được ghi chú
const SALE: i32 = 9864; // chủ khách, không quyền gì
const ALL2: i32 = 9865; // quản lý thứ hai (cùng vai trò ALL) — không phải người ghi ⇒ không hoàn tác được

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(sql: &str) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut c)
        .await
        .expect(sql);
}

async fn scalar<T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin>(
    sql: &str,
) -> T {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut c)
        .await
        .expect(sql)
}

/// Ghi lại các lần `after_note` (đồng bộ thẻ @) và `after_note_revoked` để kiểm tầng route gọi đúng khoá.
#[derive(Default)]
struct Rec(Mutex<Vec<(i32, i32, String)>>, Mutex<Vec<(i32, i32)>>);

impl Hooks for Rec {
    fn after_create<'a>(&'a self, _c: CompanyRef, _n: &'a [CreatedNotification]) -> HookFuture<'a> {
        Box::pin(async {})
    }
    fn after_remove_or_restore(&self, _c: CompanyRef) -> HookFuture<'_> {
        Box::pin(async {})
    }
    fn after_update_notes<'a>(
        &'a self,
        _c: CompanyRef,
        _u: &'a CurrentUser,
        _id: i32,
        _n: Option<&'a str>,
    ) -> HookFuture<'a> {
        Box::pin(async {})
    }
    fn after_note<'a>(
        &'a self,
        _c: CompanyRef,
        _u: &'a CurrentUser,
        contact_id: i32,
        activity_id: i32,
        note: &'a str,
    ) -> HookFuture<'a> {
        Box::pin(async move {
            self.0.lock().unwrap().push((contact_id, activity_id, note.to_owned()));
        })
    }
    fn after_note_revoked<'a>(
        &'a self,
        _c: CompanyRef,
        _u: &'a CurrentUser,
        contact_id: i32,
        activity_id: i32,
    ) -> HookFuture<'a> {
        Box::pin(async move {
            self.1.lock().unwrap().push((contact_id, activity_id));
        })
    }
}

async fn app(rec: Arc<Rec>) -> Router {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform, false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        scopes: ScopeService::new(db, cache),
        cache: CountCache::disabled(),
        hooks: rec,
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (r, _table) = api_router(deps).into_parts();
    r.with_state(ctx)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@notes.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
}

async fn post(app: &Router, path: &str, user: Option<i32>, body: Value) -> Res {
    send(app, Method::POST, path, user, body).await
}

async fn delete(app: &Router, path: &str, user: Option<i32>) -> Res {
    send(app, Method::DELETE, path, user, Value::Null).await
}

async fn send(app: &Router, method: Method, path: &str, user: Option<i32>, body: Value) -> Res {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    let resp = app
        .clone()
        .oneshot(
            b.body(if body.is_null() {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 4 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
    }
}

async fn teardown() {
    exec(
        "DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE '0906861%');
          DELETE FROM contacts WHERE phone LIKE '0906861%';
          DELETE FROM user_roles WHERE user_id BETWEEN 9861 AND 9869;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9861 AND 9869;
          DELETE FROM roles WHERE id BETWEEN 9861 AND 9869;
          DELETE FROM users WHERE id BETWEEN 9861 AND 9869",
    )
    .await;
}

async fn setup() {
    teardown().await;
    // Trigger của `users` ghi `platform.company_logins` (khoá ngoại tới công ty 1) — chỉ có khi DB đã dựng schema `platform`.
    exec(
        "DO $$ BEGIN
           IF to_regclass('platform.companies') IS NOT NULL THEN
             INSERT INTO platform.companies (id, name, schema_name) VALUES (1, 'c1', 'public') ON CONFLICT DO NOTHING;
           END IF;
         END $$",
    )
    .await;
    for (id, name) in [
        (ALL, "Quản lý"),
        (OWN, "Sale hẹp"),
        (VIEW, "Chỉ xem"),
        (SALE, "Chủ khách"),
        (ALL2, "Quản lý 2"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@notes.test', 'x', '{name}', 'active', now())"
        ))
        .await;
    }
    exec(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES
            (9861, 'notes-all', false, now()), (9862, 'notes-own', false, now()), (9863, 'notes-view', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9861, 'contacts.view', 'all'), (9861, 'contacts.update', 'all'),
            (9862, 'contacts.view', 'own'), (9862, 'contacts.update', 'own'),
            (9863, 'contacts.view', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9861, 9861), (9862, 9862), (9863, 9863), (9865, 9861)",
    )
    .await;
}

async fn contact(phone: &str, owner: i32) -> i32 {
    scalar(&format!(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, updated_at)
         VALUES ('{phone}', 'Khách {phone}', {owner}, {owner}, now()) RETURNING id"
    ))
    .await
}

async fn note_count(id: i32) -> i64 {
    scalar(&format!(
        "SELECT count(*) FROM activities WHERE contact_id = {id} AND action = 'note'"
    ))
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ghi_chu_khach_qua_http_dung_quyen_va_pham_vi() {
    setup().await;
    let rec = Arc::new(Rec::default());
    let a = app(rec.clone()).await;
    let theirs = contact("0906861001", SALE).await;
    let mine = contact("0906861002", OWN).await;
    let path = |id: i32| format!("/api/v1/contacts/{id}/notes");
    let ok_body = json!({ "note": "  Khách hỏi giá bộ ga gối, hẹn @KH999 chiều mai  " });

    // Không đăng nhập 401; thiếu contacts.update 403.
    assert_eq!(post(&a, &path(theirs), None, ok_body.clone()).await.status, 401);
    assert_eq!(post(&a, &path(theirs), Some(VIEW), ok_body.clone()).await.status, 403);
    assert_eq!(post(&a, &path(theirs), Some(SALE), ok_body.clone()).await.status, 403);

    // Body sai ⇒ 400, không ghi gì.
    for bad in [
        json!({}),
        json!({ "note": null }),
        json!({ "note": "   " }),
        json!({ "note": 12 }),
        json!({ "note": "ok", "la": 1 }),
        json!({ "note": "a".repeat(2001) }),
    ] {
        let r = post(&a, &path(theirs), Some(ALL), bad.clone()).await;
        assert_eq!(r.status, 400, "{bad}: {:?}", r.body);
    }
    assert_eq!(note_count(theirs).await, 0);

    // Ghi được: 201, dòng `note` vào dòng thời gian (cắt khoảng trắng), người ghi = người gọi, hook thẻ @ đúng khoá.
    let r = post(&a, &path(theirs), Some(ALL), ok_body).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    assert_eq!(r.body["action"], "note");
    assert_eq!(r.body["contact_id"], theirs);
    assert_eq!(r.body["created_by"], ALL);
    assert_eq!(
        r.body["details"],
        json!({ "description": "Khách hỏi giá bộ ga gối, hẹn @KH999 chiều mai" })
    );
    assert!(r.body["metadata"].is_null(), "{:?}", r.body);
    let activity = i32::try_from(r.body["id"].as_i64().unwrap()).unwrap();
    assert_eq!(note_count(theirs).await, 1);
    assert_eq!(
        rec.0.lock().unwrap().clone(),
        vec![(
            theirs,
            activity,
            "Khách hỏi giá bộ ga gối, hẹn @KH999 chiều mai".to_owned()
        )]
    );

    // Phạm vi `own`: khách người khác ⇒ 404 (không lộ tồn tại); khách của mình ⇒ 201.
    assert_eq!(
        post(&a, &path(theirs), Some(OWN), json!({ "note": "x" })).await.status,
        404
    );
    assert_eq!(note_count(theirs).await, 1);
    let r = post(&a, &path(mine), Some(OWN), json!({ "note": "Gọi lần 2" })).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    assert_eq!(note_count(mine).await, 1);

    // Id lạ / ngoài int4 / khách đã xoá mềm ⇒ 404.
    assert_eq!(
        post(&a, &path(2_000_000_000), Some(ALL), json!({ "note": "x" }))
            .await
            .status,
        404
    );
    assert_eq!(
        post(
            &a,
            "/api/v1/contacts/99999999999/notes",
            Some(ALL),
            json!({ "note": "x" })
        )
        .await
        .status,
        404
    );
    exec(&format!("UPDATE contacts SET deleted_at = now() WHERE id = {mine}")).await;
    assert_eq!(
        post(&a, &path(mine), Some(ALL), json!({ "note": "x" })).await.status,
        404
    );
    assert_eq!(note_count(mine).await, 1);
    teardown().await;
}

/// Hoàn tác ghi chú (`DELETE /contacts/:id/notes/:noteId`): chỉ người vừa ghi, trong 10 giây; người khác 403, quá hạn 409,
/// sai khách / không phải ghi chú / ngoài phạm vi 404; xong thì dòng `activities` mất và hook xoá thẻ @ được gọi.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn hoan_tac_ghi_chu_chi_nguoi_ghi_trong_10_giay() {
    setup().await;
    let rec = Arc::new(Rec::default());
    let a = app(rec.clone()).await;
    let theirs = contact("0906861011", SALE).await;
    let other = contact("0906861012", SALE).await;
    let mine = contact("0906861013", OWN).await;
    let add = |id: i32| format!("/api/v1/contacts/{id}/notes");
    let undo = |id: i32, n: i64| format!("/api/v1/contacts/{id}/notes/{n}");

    let r = post(&a, &add(theirs), Some(ALL), json!({ "note": "Hẹn @KH999" })).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let n = r.body["id"].as_i64().unwrap();

    // Không đăng nhập 401; thiếu contacts.update 403.
    assert_eq!(delete(&a, &undo(theirs, n), None).await.status, 401);
    assert_eq!(delete(&a, &undo(theirs, n), Some(VIEW)).await.status, 403);
    // Phạm vi own, khách người khác ⇒ 404 (không lộ tồn tại).
    assert_eq!(delete(&a, &undo(theirs, n), Some(OWN)).await.status, 404);
    // Ghi chú không thuộc khách này / id lạ ⇒ 404.
    assert_eq!(delete(&a, &undo(other, n), Some(ALL)).await.status, 404);
    assert_eq!(delete(&a, &undo(theirs, 2_000_000_000), Some(ALL)).await.status, 404);
    // Không phải ghi chú (vd stage_change) ⇒ 404.
    let stage: i64 = scalar::<i32>(&format!(
        "INSERT INTO activities (contact_id, action, details, created_by) VALUES ({theirs}, 'stage_change', '{{}}', {ALL}) RETURNING id"
    ))
    .await
    .into();
    assert_eq!(delete(&a, &undo(theirs, stage), Some(ALL)).await.status, 404);
    // Người khác (dù cùng quyền all) ⇒ 403.
    let r = delete(&a, &undo(theirs, n), Some(ALL2)).await;
    assert_eq!(r.status, 403, "{:?}", r.body);
    assert_eq!(note_count(theirs).await, 1);
    assert!(rec.1.lock().unwrap().is_empty());

    // Người ghi, trong hạn ⇒ 200, mất dòng, hook xoá thẻ @ đúng khoá; lần hai ⇒ 404.
    let r = delete(&a, &undo(theirs, n), Some(ALL)).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["revoked"], true);
    assert_eq!(note_count(theirs).await, 0);
    assert_eq!(rec.1.lock().unwrap().clone(), vec![(theirs, i32::try_from(n).unwrap())]);
    assert_eq!(delete(&a, &undo(theirs, n), Some(ALL)).await.status, 404);

    // Quá 10 giây (lùi created_at bằng SQL) ⇒ 409, không xoá.
    let r = post(&a, &add(mine), Some(OWN), json!({ "note": "Gọi lần 2" })).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let m = r.body["id"].as_i64().unwrap();
    exec(&format!(
        "UPDATE activities SET created_at = now() - interval '11 seconds' WHERE id = {m}"
    ))
    .await;
    let r = delete(&a, &undo(mine, m), Some(OWN)).await;
    assert_eq!(r.status, 409, "{:?}", r.body);
    assert_eq!(note_count(mine).await, 1);
    // Khách đã xoá mềm ⇒ 404.
    exec(&format!("UPDATE activities SET created_at = now() WHERE id = {m}; UPDATE contacts SET deleted_at = now() WHERE id = {mine}")).await;
    assert_eq!(delete(&a, &undo(mine, m), Some(OWN)).await.status, 404);
    assert_eq!(note_count(mine).await, 1);
    teardown().await;
}

/// Lõi dùng chung với tool MCP `add_contact_note`: ghi thêm khoá `details` và `metadata` của AI, phạm vi giống HTTP.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn loi_add_note_dung_chung_voi_tool_ai() {
    use mod_contacts::notes::add_note;
    setup().await;
    let id = contact("0906861003", SALE).await;
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let mut extra = Map::new();
    extra.insert("source".into(), json!("ai_action"));
    let row = add_note(
        &mut c,
        Some(&OwnerIds::All),
        ALL,
        id,
        "Ghi chú từ AI",
        extra,
        Some(json!({ "ai_action_draft_id": 42 })),
    )
    .await
    .unwrap();
    assert_eq!(row.contact_id, id);
    let details: Value = scalar(&format!("SELECT details FROM activities WHERE id = {}", row.id)).await;
    assert_eq!(
        details,
        json!({ "description": "Ghi chú từ AI", "source": "ai_action" })
    );
    let meta: Value = scalar(&format!("SELECT metadata FROM activities WHERE id = {}", row.id)).await;
    assert_eq!(meta, json!({ "ai_action_draft_id": 42 }));
    // Ngoài phạm vi / không có quyền ⇒ 404 và không ghi.
    let e = add_note(&mut c, Some(&OwnerIds::Ids(vec![OWN])), OWN, id, "x", Map::new(), None)
        .await
        .unwrap_err();
    assert_eq!(e.response(true).0, 404);
    let e = add_note(&mut c, None, OWN, id, "x", Map::new(), None)
        .await
        .unwrap_err();
    assert_eq!(e.response(true).0, 404);
    assert_eq!(note_count(id).await, 1);
    teardown().await;
}
