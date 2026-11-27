//! M17 qua HTTP (router K14, quyền, kiểm dữ liệu strict và Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-custom --test custom_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9501..9599 và bảng có khoá bắt đầu bằng `m17`.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_custom::views::ViewSpec;
use mod_custom::{Actor, Ctx, api_router, menu, versions, views};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "m17-jwt-secret-0123456789abcdef0123456789abcdef";
const CO: CompanyRef = CompanyRef::DEFAULT;

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

struct App {
    router: Router,
    ctx: Arc<Ctx>,
}

async fn app() -> App {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        scopes: ScopeService::new(db, cache),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 15);
    App {
        router: router.with_state(ctx.clone()),
        ctx,
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m17.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
}

async fn call(app: &App, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = app.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
    }
}

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

const MGR: i32 = 9501; // custom_objects.manage + custom_records.view/manage + contacts.view all
const VIEWER_A: i32 = 9502; // custom_records.view, vai trò 9502
const VIEWER_B: i32 = 9503; // custom_records.view, vai trò 9503
const NONE: i32 = 9504; // không quyền
const B: &str = "/api/v1/custom-objects";

async fn teardown() {
    exec(
        "DELETE FROM custom_schema_versions WHERE tool LIKE 'm17%';
          DELETE FROM custom_records WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm17%');
          DELETE FROM custom_views WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm17%');
          DELETE FROM custom_fields WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm17%');
          DELETE FROM custom_objects WHERE key LIKE 'm17%';
          DELETE FROM contacts WHERE phone LIKE 'm17-%';
          DELETE FROM settings WHERE key = 'org_features';
          DELETE FROM user_roles WHERE user_id BETWEEN 9501 AND 9599;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9501 AND 9599;
          DELETE FROM roles WHERE id BETWEEN 9501 AND 9599;
          DELETE FROM users WHERE id BETWEEN 9501 AND 9599",
    )
    .await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [
        (MGR, "Quản lý m17"),
        (VIEWER_A, "Xem A"),
        (VIEWER_B, "Xem B"),
        (NONE, "Không quyền"),
    ] {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({id}, 'u{id}@m17.test', 'x', '{name}', now())")).await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9501, 'm17-manage', false, now()), (9502, 'm17-a', false, now()), (9503, 'm17-b', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9501, 'custom_objects.manage', NULL), (9501, 'custom_records.view', 'all'), (9501, 'custom_records.manage', 'all'), (9501, 'contacts.view', 'all'),
            (9502, 'custom_records.view', 'all'), (9503, 'custom_records.view', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9501, 9501), (9502, 9502), (9503, 9503)").await;
}

async fn actor_mgr() -> Actor {
    let grants =
        trinity_rbac::grants::grants_from_json(&json!({ "custom_objects.manage": true, "custom_records.view": "all" }));
    Actor {
        user_id: MGR,
        company: CO,
        grants,
        is_admin: false,
    }
}

fn err<T>(r: Result<T, trinity_kernel::error::AppError>) -> String {
    r.err().map(|e| e.to_string()).unwrap_or_default()
}

fn id_of(r: &Res) -> i64 {
    r.body["id"].as_i64().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn bang_quyen_va_hien_thi() {
    setup().await;
    let a = app().await;
    // 401/403; kiểm dữ liệu strict: trường lạ và sai kiểu bị chặn bằng câu của class-validator.
    assert_eq!(call(&a, Method::GET, B, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, B, Some(VIEWER_A), None).await.status, 403);
    assert_eq!(
        call(&a, Method::POST, B, Some(VIEWER_A), Some(json!({}))).await.status,
        403
    );
    let bad = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "Khach", "label": "", "label_plural": 5, "la": 1 })),
    )
    .await;
    assert_eq!(bad.status, 400);
    let m = bad.body["message"].to_string();
    for want in [
        "key chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ, tối đa 48 ký tự",
        "Tên không được rỗng",
        "Tên số nhiều phải là chuỗi",
        "property la should not exist",
    ] {
        assert!(m.contains(want), "{want} trong {m}");
    }

    // Tạo: tiền tố tự sinh khi bỏ trống; chuẩn hoá khi gửi; trùng khoá 409; từ khoá hệ thống, icon, tiền tố lõi/trùng.
    let r = call(&a, Method::POST, B, Some(MGR), Some(json!({ "key": "m17_khach", "label": " Khách ", "label_plural": "Khách", "icon": "users", "description": "  mô tả " }))).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    assert_eq!(
        (
            r.body["label"].as_str(),
            r.body["description"].as_str(),
            r.body["icon"].as_str()
        ),
        (Some("Khách"), Some("mô tả"), Some("users"))
    );
    assert!(
        r.body["code_prefix"]
            .as_str()
            .is_some_and(|p| (2..=4).contains(&p.len())),
        "{:?}",
        r.body["code_prefix"]
    );
    assert_eq!(r.body["fields"], json!([]));
    assert_eq!(
        (r.body["show_in_nav"].clone(), r.body["is_active"].clone()),
        (json!(true), json!(true))
    );
    let dup = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_khach", "label": "x", "label_plural": "x" })),
    )
    .await;
    assert_eq!(
        (dup.status, msg(&dup).as_str()),
        (StatusCode::CONFLICT, "Mã “m17_khach” đã được dùng")
    );
    let kw = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "nav", "label": "x", "label_plural": "x" })),
    )
    .await;
    assert_eq!(
        (kw.status, msg(&kw).as_str()),
        (
            StatusCode::BAD_REQUEST,
            "Mã “nav” là từ khoá của hệ thống, hãy chọn mã khác"
        )
    );
    let ic = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_ic", "label": "x", "label_plural": "x", "icon": "khong-co" })),
    )
    .await;
    assert_eq!(msg(&ic), "Biểu tượng không nằm trong danh sách cho phép");
    let core = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_core", "label": "x", "label_plural": "x", "code_prefix": "kh" })),
    )
    .await;
    assert!(msg(&core).contains("dành cho bảng lõi"), "{}", msg(&core));
    let hs = call(&a, Method::POST, B, Some(MGR), Some(json!({ "key": "m17_hs", "label": "Hồ sơ", "label_plural": "Hồ sơ", "code_prefix": "hsx", "visible_role_ids": [9502, 9502], "nav_order": 7 }))).await;
    assert_eq!(
        (
            hs.status,
            hs.body["code_prefix"].as_str(),
            hs.body["visible_role_ids"].clone(),
            hs.body["nav_order"].as_i64()
        ),
        (StatusCode::CREATED, Some("HSX"), json!([9502]), Some(7))
    );
    let taken = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_hs2", "label": "x", "label_plural": "x", "code_prefix": "HSX" })),
    )
    .await;
    assert_eq!(
        (taken.status, msg(&taken).as_str()),
        (StatusCode::CONFLICT, "Tiền tố mã “HSX” đã được bảng khác dùng")
    );
    let nr = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_nr", "label": "x", "label_plural": "x", "visible_role_ids": [999999] })),
    )
    .await;
    assert_eq!(msg(&nr), "Có vai trò không tồn tại trong danh sách “được thấy”");

    // Danh sách (quản lý) kèm số trường/bản ghi; sửa; đổi tiền tố có bí danh và đánh lại mã bản ghi.
    exec("INSERT INTO custom_records (object_id, data, code_seq, code, updated_at) SELECT id, '{}', 1, code_prefix || '001', now() FROM custom_objects WHERE key = 'm17_hs'").await;
    let list = call(&a, Method::GET, B, Some(MGR), None).await;
    let hs_row = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["key"] == "m17_hs")
        .unwrap()
        .clone();
    assert_eq!(
        (hs_row["field_count"].as_i64(), hs_row["record_count"].as_i64()),
        (Some(0), Some(1))
    );
    let hs_id = id_of(&hs);
    let up = call(
        &a,
        Method::PATCH,
        &format!("{B}/m17_hs"),
        Some(MGR),
        Some(json!({ "label": "Hồ sơ mới", "description": null, "icon": null, "code_prefix": "hso" })),
    )
    .await;
    assert_eq!(up.status, 200, "{:?}", up.body);
    assert_eq!(
        (
            up.body["label"].as_str(),
            up.body["description"].clone(),
            up.body["code_prefix"].as_str()
        ),
        (Some("Hồ sơ mới"), Value::Null, Some("HSO"))
    );
    assert_eq!(up.body["code_prefix_aliases"], json!(["HSX"]));
    assert_eq!(
        scalar::<String>(&format!("SELECT code FROM custom_records WHERE object_id = {hs_id}")).await,
        "HSO001"
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/m17_hs"),
            Some(MGR),
            Some(json!({ "code_prefix": "kh" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/m17_hs"),
            Some(MGR),
            Some(json!({ "key": "x" }))
        )
        .await
        .status,
        400,
        "strict: không sửa key"
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/khong_co"),
            Some(MGR),
            Some(json!({ "label": "x" }))
        )
        .await
        .status,
        404
    );

    // Menu và quyền thấy theo vai trò: m17_hs chỉ vai trò 9502; m17_khach mọi người; bảng tắt chỉ người quản lý.
    call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_tat", "label": "Tắt", "label_plural": "Tắt", "is_active": false })),
    )
    .await;
    let nav = |u: i32| {
        let a = &a;
        async move {
            let r = call(a, Method::GET, &format!("{B}/nav"), Some(u), None).await;
            r.body
                .as_array()
                .unwrap()
                .iter()
                .filter(|i| i["key"].as_str().is_some_and(|k| k.starts_with("m17")))
                .map(|i| i["key"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(nav(VIEWER_A).await, ["m17_khach", "m17_hs"]);
    assert_eq!(nav(VIEWER_B).await, ["m17_khach"]);
    assert_eq!(
        nav(MGR).await.len(),
        2,
        "bảng tắt không có trong menu kể cả người quản lý"
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/nav"), Some(NONE), None)
            .await
            .status,
        403
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/m17_hs"), Some(VIEWER_A), None)
            .await
            .status,
        200
    );
    let hidden = call(&a, Method::GET, &format!("{B}/m17_hs"), Some(VIEWER_B), None).await;
    assert_eq!(
        (hidden.status, msg(&hidden).as_str()),
        (StatusCode::NOT_FOUND, "Không tìm thấy tính năng này")
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/m17_tat"), Some(VIEWER_A), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/m17_tat"), Some(MGR), None)
            .await
            .status,
        200
    );

    // Xoá mềm: chặn khi còn trường liên kết của bảng khác trỏ tới; xoá được thì 404 sau đó và mã tạo lại được.
    let f = call(
        &a,
        Method::POST,
        &format!("{B}/m17_khach/fields"),
        Some(MGR),
        Some(json!({ "label": "Hồ sơ", "type": "relation", "options": { "target_object_id": hs_id } })),
    )
    .await;
    assert_eq!(f.status, 201, "{:?}", f.body);
    assert_eq!(
        f.body["options"],
        json!({ "multiple": false, "target_object_id": hs_id })
    );
    let blocked = call(&a, Method::DELETE, &format!("{B}/m17_hs"), Some(MGR), None).await;
    assert_eq!(
        (blocked.status, msg(&blocked).as_str()),
        (
            StatusCode::CONFLICT,
            "Không xoá được: còn trường liên kết trỏ tới “Hồ sơ mới” (Khách › Hồ sơ). Hãy xoá/đổi các trường đó trước."
        )
    );
    // Định nghĩa trả kèm đích liên kết nếu người xem thấy bảng đích.
    let def_mgr = call(&a, Method::GET, &format!("{B}/m17_khach"), Some(MGR), None).await;
    assert_eq!(def_mgr.body["fields"][0]["options"]["target_key"], json!("m17_hs"));
    assert_eq!(def_mgr.body["fields"][0]["options"]["target_label"], json!("Hồ sơ"));
    let def_b = call(&a, Method::GET, &format!("{B}/m17_khach"), Some(VIEWER_B), None).await;
    assert!(
        def_b.body["fields"][0]["options"].get("target_key").is_none(),
        "người không thấy bảng đích không biết tên nó"
    );
    call(
        &a,
        Method::DELETE,
        &format!("{B}/m17_khach/fields/ho_so"),
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/m17_hs"), Some(MGR), None)
            .await
            .body,
        json!({ "ok": true })
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/m17_hs"), Some(MGR), None)
            .await
            .status,
        404
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn truong_va_cong_thuc() {
    setup().await;
    let a = app().await;
    let o = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_don", "label": "Đơn", "label_plural": "Đơn" })),
    )
    .await;
    let oid = id_of(&o);
    let fp = format!("{B}/m17_don/fields");
    let add = |body: Value| {
        let (a, fp) = (&a, fp.clone());
        async move { call(a, Method::POST, &fp, Some(MGR), Some(body)).await }
    };
    // Trường đầu kiểu cho phép làm tiêu đề tự thành tiêu đề; mã sinh từ tên; sort_order cách 10.
    let t = add(json!({ "label": "Tên đơn", "type": "text" })).await;
    assert_eq!(t.status, 201, "{:?}", t.body);
    assert_eq!(
        (
            t.body["key"].as_str(),
            t.body["is_title"].clone(),
            t.body["sort_order"].as_i64(),
            t.body["required"].clone()
        ),
        (Some("ten_don"), json!(true), Some(10), json!(false))
    );
    assert_eq!(
        t.body.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        [
            "id",
            "key",
            "label",
            "type",
            "required",
            "is_unique",
            "is_title",
            "show_in_list",
            "sort_order",
            "options",
            "help_text"
        ]
    );
    let g = add(json!({ "label": "Giá gốc", "type": "currency", "required": true, "help_text": "  VND " })).await;
    assert_eq!(
        (
            g.body["key"].as_str(),
            g.body["is_title"].clone(),
            g.body["help_text"].as_str()
        ),
        (Some("gia_goc"), json!(false), Some("VND"))
    );
    add(json!({ "label": "Ưu đãi", "type": "percent" })).await;
    add(json!({ "label": "Ngày giao", "type": "date" })).await;
    let sel = add(json!({ "label": "Trạng thái", "type": "select", "options": { "choices": [{ "label": "Mới" }, { "label": "Mới" }, { "label": "Xong", "color": "green", "value": "done" }] } })).await;
    assert_eq!(
        sel.body["options"]["choices"],
        json!([{ "label": "Mới", "value": "moi" }, { "label": "Mới", "value": "moi_2" }, { "color": "green", "label": "Xong", "value": "done" }])
    );
    // Công thức hợp lệ; sai tham chiếu, sai kiểu, cờ cấm.
    let f = add(json!({ "label": "Thành tiền", "type": "formula", "options": { "expression": "{gia_goc}*(1-{uu_dai})", "format": "currency", "decimals": 0 } })).await;
    assert_eq!(f.status, 201, "{:?}", f.body);
    assert_eq!(
        (f.body["required"].clone(), f.body["options"]["format"].clone()),
        (json!(false), json!("currency"))
    );
    let bad_ref = add(json!({ "label": "Lỗi", "type": "formula", "options": { "expression": "{khong_co}*2" } })).await;
    assert_eq!(bad_ref.status, 400);
    assert!(msg(&bad_ref).starts_with("Công thức: "), "{}", msg(&bad_ref));
    let not_num = add(json!({ "label": "Lỗi 2", "type": "formula", "options": { "expression": "{ten_don}" } })).await;
    assert!(msg(&not_num).starts_with("Công thức: "), "{}", msg(&not_num));
    let flags =
        add(json!({ "label": "Lỗi 3", "type": "formula", "required": true, "options": { "expression": "1+1" } })).await;
    assert_eq!(
        msg(&flags),
        "Trường công thức tự tính nên không đặt được “bắt buộc” hay “duy nhất”"
    );
    assert_eq!(
        msg(&add(json!({ "label": "SĐT", "type": "phone", "is_unique": true })).await),
        "Kiểu trường này không đặt được “duy nhất” (chỉ văn bản ngắn, số, tiền, email, đường dẫn, ngày; SĐT không đặt duy nhất được để tránh dò số)"
    );
    assert_eq!(
        msg(&add(json!({ "label": "Gợi ý", "type": "currency", "is_title": true })).await),
        "Trường tiêu đề phải là văn bản ngắn, số, email hoặc ngày"
    );
    let dup = add(json!({ "label": "Giá gốc", "type": "number" })).await;
    assert_eq!(
        (dup.status, msg(&dup).as_str()),
        (StatusCode::CONFLICT, "Mã trường “gia_goc” đã tồn tại")
    );
    assert_eq!(
        msg(&add(json!({ "key": "constructor", "label": "x", "type": "text" })).await),
        "Mã trường “constructor” là từ khoá của hệ thống, hãy chọn mã khác"
    );
    assert_eq!(
        msg(&add(json!({ "label": "Liên kết", "type": "relation", "options": { "target_object_id": 999999 } })).await),
        "Thực thể đích của trường liên kết không tồn tại"
    );
    assert_eq!(
        msg(&add(json!({ "label": "Chọn", "type": "select" })).await),
        "Danh sách lựa chọn không được trống"
    );
    assert_eq!(add(json!({ "label": "x", "type": "khac" })).await.status, 400);
    // Mã từng có dữ liệu cũ không dùng lại được.
    exec(&format!(
        "INSERT INTO custom_records (object_id, data, updated_at) VALUES ({oid}, '{{\"cu\": 1}}', now())"
    ))
    .await;
    assert!(
        msg(&add(json!({ "key": "cu", "label": "Cũ", "type": "number" })).await).starts_with("Mã “cu” từng được dùng")
    );

    // Sửa: đổi tiêu đề dựng lại title; không bỏ tiêu đề nếu chưa chọn trường khác; kiểu đổi bị chặn khi có dữ liệu.
    exec(&format!("UPDATE custom_records SET data = '{{\"ten_don\": \"Đơn 1\", \"trang_thai\": \"done\", \"gia_goc\": 100}}', title = NULL WHERE object_id = {oid}")).await;
    let fe = |k: &str| format!("{B}/m17_don/fields/{k}");
    let tit = call(
        &a,
        Method::PATCH,
        &fe("ngay_giao"),
        Some(MGR),
        Some(json!({ "is_title": true })),
    )
    .await;
    assert_eq!(
        (tit.status, tit.body["is_title"].clone()),
        (StatusCode::OK, json!(true)),
        "{:?}",
        tit.body
    );
    assert!(scalar::<bool>("SELECT (SELECT is_title FROM custom_fields WHERE object_id = (SELECT id FROM custom_objects WHERE key = 'm17_don') AND key = 'ten_don') = false").await);
    let notitle = call(
        &a,
        Method::PATCH,
        &fe("ngay_giao"),
        Some(MGR),
        Some(json!({ "is_title": false })),
    )
    .await;
    assert_eq!(
        msg(&notitle),
        "Phải chọn trường khác làm tiêu đề trước khi bỏ tiêu đề của trường này"
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &fe("ten_don"),
            Some(MGR),
            Some(json!({ "is_title": true }))
        )
        .await
        .status,
        200
    );
    let tchg = call(
        &a,
        Method::PATCH,
        &fe("gia_goc"),
        Some(MGR),
        Some(json!({ "type": "text" })),
    )
    .await;
    assert_eq!(tchg.status, 409);
    // Trường đang là tiêu đề không đổi sang long_text (tiêu đề phải là văn bản ngắn); trường thường text ⇄ long_text tương thích.
    assert_eq!(
        msg(&call(
            &a,
            Method::PATCH,
            &fe("ten_don"),
            Some(MGR),
            Some(json!({ "type": "long_text" }))
        )
        .await),
        "Trường tiêu đề phải là văn bản ngắn, số, email hoặc ngày"
    );
    add(json!({ "label": "Ghi chú", "type": "text" })).await;
    exec(&format!(
        "UPDATE custom_records SET data = data || '{{\"ghi_chu\": \"abc\"}}' WHERE object_id = {oid}"
    ))
    .await;
    let lt = call(
        &a,
        Method::PATCH,
        &fe("ghi_chu"),
        Some(MGR),
        Some(json!({ "type": "long_text" })),
    )
    .await;
    assert_eq!(
        (lt.status, lt.body["type"].as_str()),
        (StatusCode::OK, Some("long_text"))
    );
    assert_eq!(
        call(&a, Method::DELETE, &fe("ghi_chu"), Some(MGR), None).await.status,
        200
    );
    let drop_choice = call(
        &a,
        Method::PATCH,
        &fe("trang_thai"),
        Some(MGR),
        Some(json!({ "options": { "choices": [{ "label": "Mới" }] } })),
    )
    .await;
    assert_eq!(
        (drop_choice.status, msg(&drop_choice).as_str()),
        (
            StatusCode::CONFLICT,
            "Không bỏ được lựa chọn đang có bản ghi dùng: done"
        )
    );
    let ftype = call(
        &a,
        Method::PATCH,
        &fe("thanh_tien"),
        Some(MGR),
        Some(json!({ "type": "number" })),
    )
    .await;
    assert_eq!(msg(&ftype), "Không đổi kiểu của trường công thức; hãy tạo trường mới");
    let uq = call(
        &a,
        Method::PATCH,
        &fe("gia_goc"),
        Some(MGR),
        Some(json!({ "is_unique": true })),
    )
    .await;
    assert_eq!(uq.status, 200, "chưa có bản ghi trùng: bật được");
    exec(&format!(
        "INSERT INTO custom_records (object_id, data, updated_at) VALUES ({oid}, '{{\"gia_goc\": 100}}', now())"
    ))
    .await;
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &fe("ten_don"),
            Some(MGR),
            Some(json!({ "is_unique": true }))
        )
        .await
        .status,
        200
    );
    // Hai bản ghi cùng tên (không phân biệt hoa/thường) chặn việc bật “duy nhất”.
    exec(&format!("INSERT INTO custom_records (object_id, data, updated_at) VALUES ({oid}, '{{\"gia_goc\": 100, \"trang_thai\": \"moi\", \"ten_don\": \"ĐƠN 1\"}}', now())")).await;
    // Xoá: công thức đang dùng; tiêu đề.
    let del_ref = call(&a, Method::DELETE, &fe("gia_goc"), Some(MGR), None).await;
    assert_eq!(
        (del_ref.status, msg(&del_ref).as_str()),
        (
            StatusCode::CONFLICT,
            "Không xoá được: trường công thức “Thành tiền” đang dùng trường này"
        )
    );
    let del_title = call(&a, Method::DELETE, &fe("ten_don"), Some(MGR), None).await;
    assert_eq!(
        msg(&del_title),
        "Đây là trường tiêu đề. Hãy chọn trường khác làm tiêu đề trước khi xoá."
    );
    assert_eq!(
        call(&a, Method::DELETE, &fe("khong_co"), Some(MGR), None).await.status,
        404
    );
    assert_eq!(
        call(&a, Method::DELETE, &fe("ngay_giao"), Some(MGR), None).await.body,
        json!({ "ok": true })
    );

    // Đổi thứ tự: phải đủ và đúng; xem trước công thức.
    let order = |keys: Value| {
        let a = &a;
        async move {
            call(
                a,
                Method::PUT,
                &format!("{B}/m17_don/fields/order"),
                Some(MGR),
                Some(json!({ "keys": keys })),
            )
            .await
        }
    };
    assert_eq!(
        msg(&order(json!(["ten_don"])).await),
        "Danh sách thứ tự phải gồm đúng và đủ các trường hiện có"
    );
    assert_eq!(order(json!([])).await.status, 400);
    let ok = order(json!(["thanh_tien", "trang_thai", "uu_dai", "gia_goc", "ten_don"])).await;
    assert_eq!((ok.status, ok.body), (StatusCode::OK, json!({ "ok": true })));
    let keys = call(&a, Method::GET, &format!("{B}/m17_don"), Some(MGR), None).await;
    assert_eq!(
        keys.body["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["thanh_tien", "trang_thai", "uu_dai", "gia_goc", "ten_don"]
    );
    let pv = |body: Value| {
        let a = &a;
        async move { call(a, Method::POST, &format!("{B}/formula/preview"), Some(MGR), Some(body)).await }
    };
    let p = pv(json!({ "object_key": "m17_don", "expression": "{gia_goc}*(1-{uu_dai})", "sample": { "gia_goc": 200000, "uu_dai": 10 } })).await;
    assert_eq!(
        (p.status, p.body),
        (StatusCode::CREATED, json!({ "ok": true, "result": 180000 }))
    );
    let miss = pv(json!({ "object_key": "m17_don", "expression": "{gia_goc}*2" })).await;
    assert_eq!(miss.body, json!({ "ok": true, "result": null }));
    let err = pv(json!({ "object_key": "m17_don", "expression": "{khong_co}" })).await;
    assert_eq!(err.body["ok"], json!(false));
    assert!(err.body["error"].as_str().unwrap().starts_with("Công thức: "));
    assert_eq!(
        pv(json!({ "object_key": "khong_co", "expression": "1" })).await.status,
        404
    );
    assert_eq!(pv(json!({ "object_key": "m17_don" })).await.status, 400);
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn man_xem_phien_ban_menu_tra_cuu() {
    setup().await;
    let a = app().await;
    let o = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m17_vd", "label": "Việc", "label_plural": "Việc" })),
    )
    .await;
    let oid = id_of(&o);
    let add = |body: Value| {
        let a = &a;
        async move { call(a, Method::POST, &format!("{B}/m17_vd/fields"), Some(MGR), Some(body)).await }
    };
    add(json!({ "label": "Tên", "type": "text" })).await;
    add(json!({ "label": "Trạng thái", "type": "select", "options": { "choices": [{ "label": "Mới", "value": "moi" }, { "label": "Xong", "value": "xong" }] } })).await;
    add(json!({ "label": "Hạn", "type": "date" })).await;
    add(json!({ "label": "Số", "type": "number" })).await;

    // Màn xem: tạo qua module (công cụ MCP), đọc qua HTTP; bộ lọc đã lưu được dọn khi lựa chọn không còn.
    let mgr = actor_mgr().await;
    let mut c = a.ctx.conn(CO).await.unwrap();
    let def = mod_custom::access::load_visible_object(&mut c, &mgr, "m17_vd", None)
        .await
        .unwrap();
    let spec = |key: &str, kind: &str, config: Value| ViewSpec {
        key: key.into(),
        label: format!("Màn {key}"),
        kind: kind.into(),
        config,
        icon: None,
        show_in_nav: Some(true),
    };
    let kb = views::create(&mut c, &def, &spec("bang", "kanban", json!({ "group_by": "trang_thai", "card_fields": ["ten"], "filter": { "trang_thai": ["moi", "Xong"] }, "la": 1 })), MGR).await.unwrap();
    assert_eq!(
        kb.config.0,
        json!({ "card_fields": ["ten"], "filter": { "trang_thai": ["moi", "Xong"] }, "group_by": "trang_thai" })
    );
    assert!(
        err(views::create(&mut c, &def, &spec("bang", "list", json!({})), MGR).await)
            .contains("đã có view khoá “bang”")
    );
    assert!(
        err(views::create(&mut c, &def, &spec("k2", "kanban", json!({ "group_by": "so" })), MGR).await)
            .contains("kanban chỉ chia cột theo trường “lựa chọn” (select)")
    );
    assert!(
        err(views::create(&mut c, &def, &spec("k3", "kanban", json!({})), MGR).await).contains("Kanban cần group_by")
    );
    assert!(
        err(views::create(
            &mut c,
            &def,
            &spec("l1", "calendar", json!({ "date_field": "ten" })),
            MGR
        )
        .await)
        .contains("lịch chỉ dùng trường ngày")
    );
    assert!(
        err(views::create(&mut c, &def, &spec("g1", "gantt", json!({})), MGR).await)
            .contains("Loại màn “gantt” chưa được Trinity hỗ trợ.")
    );
    assert!(
        err(views::create(
            &mut c,
            &def,
            &spec("s1", "list", json!({ "sort": { "field": "trang_thai2" } })),
            MGR
        )
        .await)
        .contains("sort.field phải là trường sắp xếp được")
    );
    assert!(
        err(views::create(
            &mut c,
            &def,
            &spec("f1", "list", json!({ "filter": { "ten": "a" } })),
            MGR
        )
        .await)
        .contains("Không lọc được theo trường “ten”")
    );
    let cal = views::create(
        &mut c,
        &def,
        &spec(
            "lich",
            "calendar",
            json!({ "date_field": "han", "mode": "week", "sort": { "field": "so", "dir": "desc" } }),
        ),
        MGR,
    )
    .await
    .unwrap();
    assert_eq!(
        cal.config.0,
        json!({ "date_field": "han", "mode": "week", "sort": { "dir": "desc", "field": "so" } })
    );
    exec("UPDATE custom_views SET visible_role_ids = ARRAY[9502] WHERE key = 'lich'").await;
    drop(c);
    exec(&format!("UPDATE custom_fields SET options = jsonb_set(options, '{{choices}}', '[{{\"value\": \"moi\", \"label\": \"Mới\"}}]') WHERE object_id = {oid} AND key = 'trang_thai'")).await;
    let lv = call(&a, Method::GET, &format!("{B}/m17_vd/views"), Some(VIEWER_B), None).await;
    assert_eq!(lv.status, 200);
    let keys = |r: &Res| {
        r.body
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["key"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(keys(&lv), ["bang"], "màn 'lich' chỉ vai trò 9502");
    assert_eq!(
        keys(&call(&a, Method::GET, &format!("{B}/m17_vd/views"), Some(VIEWER_A), None).await),
        ["bang", "lich"]
    );
    let gv = call(&a, Method::GET, &format!("{B}/m17_vd/views/bang"), Some(VIEWER_B), None).await;
    assert_eq!(gv.status, 200);
    assert_eq!(
        gv.body["config"]["filter"],
        json!({ "trang_thai": ["moi"] }),
        "lựa chọn đã bị xoá khỏi bộ lọc đã lưu"
    );
    assert_eq!(
        (
            gv.body["href"].as_str(),
            gv.body["object_key"].as_str(),
            gv.body["type"].as_str()
        ),
        (Some("/x/m17_vd/v/bang"), Some("m17_vd"), Some("kanban"))
    );
    let hid = call(&a, Method::GET, &format!("{B}/m17_vd/views/lich"), Some(VIEWER_B), None).await;
    assert_eq!(
        (hid.status, msg(&hid).as_str()),
        (StatusCode::NOT_FOUND, "Không tìm thấy màn xem này")
    );
    // Menu gồm màn gắn menu mà người xem thấy.
    let nav = call(&a, Method::GET, &format!("{B}/nav"), Some(VIEWER_A), None).await;
    let hrefs: Vec<&str> = nav
        .body
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["href"].as_str())
        .filter(|h| h.contains("m17_vd"))
        .collect();
    assert_eq!(hrefs, ["/x/m17_vd", "/x/m17_vd/v/bang", "/x/m17_vd/v/lich"]);
    // Sửa/xoá mềm màn.
    let mut c = a.ctx.conn(CO).await.unwrap();
    let upd = views::update(
        &mut c,
        &def,
        "lich",
        &json!({ "label": "Lịch mới", "is_deleted": true }),
        MGR,
    )
    .await
    .unwrap();
    assert_eq!(
        (upd.label.as_str(), upd.show_in_nav, upd.deleted_at.is_some()),
        ("Lịch mới", false, true)
    );
    assert!(err(views::update(&mut c, &def, "lich", &json!({}), MGR).await).contains("không có view “lich”"));

    // Phiên bản cấu trúc: chụp, đổi, so, quay lui.
    let v1 = versions::save(&mut c, None, "m17-thu", "trước khi đổi", MGR)
        .await
        .unwrap();
    drop(c);
    call(&a, Method::DELETE, &format!("{B}/m17_vd/fields/so"), Some(MGR), None).await;
    call(
        &a,
        Method::PATCH,
        &format!("{B}/m17_vd/fields/han"),
        Some(MGR),
        Some(json!({ "label": "Hạn chót" })),
    )
    .await;
    call(&a, Method::DELETE, &format!("{B}/m17_vd"), Some(MGR), None).await;
    let mut c = a.ctx.conn(CO).await.unwrap();
    let snap = versions::load(&mut c, v1).await.unwrap();
    let d = versions::diff(&mut c, &snap).await.unwrap();
    let row = d["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["key"] == "m17_vd")
        .unwrap();
    assert_eq!(row["change"], json!("bảng được HIỆN LẠI"));
    assert_eq!(versions::list(&mut c, 5).await.unwrap()[0]["tool"], json!("m17-thu"));
    assert!(err(versions::load(&mut c, 99_999_999).await).contains("Không có phiên bản cấu trúc #99999999."));
    drop(c);
    let mut tx = a.ctx.begin(CO).await.unwrap();
    assert_eq!(
        versions::restore(&mut tx, v1, MGR).await.unwrap(),
        json!({ "restored_version": v1 })
    );
    tx.commit().await.unwrap();
    let back = call(&a, Method::GET, &format!("{B}/m17_vd"), Some(MGR), None).await;
    assert_eq!(back.status, 200, "{:?}", back.body);
    let labels: Vec<&str> = back.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["label"].as_str().unwrap())
        .collect();
    assert_eq!(
        labels,
        ["Tên", "Trạng thái", "Hạn", "Số"],
        "trường bị xoá hiện lại, nhãn trả về bản cũ"
    );

    // Menu: đặt lại thứ tự và quyền thấy theo tên vai trò (không phân biệt hoa/thường); mục lặp bị từ chối.
    let entries = [
        menu::MenuEntry {
            object: "m17_vd".into(),
            view: Some("bang".into()),
            roles: None,
        },
        menu::MenuEntry {
            object: "m17_vd".into(),
            view: None,
            roles: Some(vec!["M17-A".into()]),
        },
    ];
    let mut tx = a.ctx.begin(CO).await.unwrap();
    assert_eq!(
        menu::apply(&mut tx, &entries, MGR).await.unwrap(),
        json!({ "shown": 2 })
    );
    tx.commit().await.unwrap();
    assert_eq!(scalar::<String>("SELECT show_in_nav::text || '/' || nav_order::text || '/' || visible_role_ids::text FROM custom_objects WHERE key = 'm17_vd'").await, "true/2/{9502}");
    assert_eq!(
        scalar::<String>("SELECT show_in_nav::text || '/' || nav_order::text FROM custom_views WHERE key = 'bang'")
            .await,
        "true/1"
    );
    let mut tx = a.ctx.begin(CO).await.unwrap();
    assert!(err(menu::apply(&mut tx, &[entries[0].clone(), entries[0].clone()], MGR).await).contains("bị lặp"));
    assert!(err(menu::apply(&mut tx, &[], MGR).await).contains("Menu cần ít nhất một mục."));
    let bad_role = [menu::MenuEntry {
        object: "m17_vd".into(),
        view: None,
        roles: Some(vec!["không có".into()]),
    }];
    assert!(err(menu::apply(&mut tx, &bad_role, MGR).await).contains("Không có vai trò “không có”. Vai trò hiện có:"));
    drop(tx);

    // Tra cứu: người dùng trong phạm vi và khách (cần ≥ 2 ký tự).
    let u = call(
        &a,
        Method::GET,
        &format!("{B}/lookup/users?q=xem&limit=5"),
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(u.status, 200);
    assert_eq!(
        u.body,
        json!([{ "id": VIEWER_A, "title": "Xem A" }, { "id": VIEWER_B, "title": "Xem B" }])
    );
    exec("INSERT INTO contacts (full_name, phone, assigned_to, updated_at) VALUES ('Trần Khách m17', 'm17-1', 9501, now()), ('Người lạ m17', 'm17-2', 9502, now())").await;
    let ct = call(&a, Method::GET, &format!("{B}/lookup/contacts?q=m17"), Some(MGR), None).await;
    assert_eq!(ct.body.as_array().unwrap().len(), 2);
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/lookup/contacts?q=m"), Some(MGR), None)
            .await
            .body,
        json!([])
    );
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("{B}/lookup/contacts?q=m17"),
            Some(VIEWER_A),
            None
        )
        .await
        .body,
        json!([]),
        "không có contacts.view: rỗng"
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/lookup/contacts?q=m17"), Some(NONE), None)
            .await
            .status,
        403
    );
    let bad = call(
        &a,
        Method::GET,
        &format!("{B}/lookup/users?limit=500&for=all&x=1"),
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(bad.status, 400);
    teardown().await;
}
