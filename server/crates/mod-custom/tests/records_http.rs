//! M18 qua HTTP (router K14, quyền, kiểm dữ liệu strict, Postgres thật): bản ghi, liên kết, tham chiếu `/refs`, xuất CSV, outbox.
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-custom --test records_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9601..9699, bảng có khoá bắt đầu bằng `m18`, khách `m18-*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_custom::{Ctx, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "m18-jwt-secret-0123456789abcdef0123456789abcdef";

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
    assert_eq!(table.len(), 27);
    App {
        router: router.with_state(ctx),
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m18.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
    text: String,
    headers: axum::http::HeaderMap,
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
    let (status, headers) = (resp.status(), resp.headers().clone());
    let raw = axum::body::to_bytes(resp.into_body(), 64 << 20).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    Res {
        status,
        body: serde_json::from_str(&text).unwrap_or(Value::Null),
        text,
        headers,
    }
}

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

const MGR: i32 = 9601; // mọi quyền bản ghi (all) + custom_objects.manage + contacts/deals/kanban.view
const OWN: i32 = 9602; // view/manage/delete/export phạm vi own
const OWN2: i32 = 9603; // như OWN, người khác
const VIEW: i32 = 9604; // chỉ custom_records.view all
const NONE: i32 = 9605; // không quyền
const NARROW: i32 = 9606; // sửa mọi bản ghi (manage all) nhưng chỉ xem phần của mình (view own)
const B: &str = "/api/v1/custom-objects";
const OBJ: &str = "m18_hs";
const REC: &str = "/api/v1/custom-objects/m18_hs/records";

async fn teardown() {
    exec(
        "DELETE FROM record_links WHERE source_type = 'record' AND source_id IN (SELECT id FROM custom_records WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm18%'));
          DELETE FROM integration_events WHERE event_type LIKE 'custom_record.%' AND (payload->'object'->>'key') LIKE 'm18%';
          DELETE FROM custom_schema_versions WHERE tool LIKE 'm18%';
          DELETE FROM custom_records WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm18%');
          DELETE FROM custom_views WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm18%');
          DELETE FROM custom_fields WHERE object_id IN (SELECT id FROM custom_objects WHERE key LIKE 'm18%');
          DELETE FROM custom_objects WHERE key LIKE 'm18%';
          DELETE FROM contacts WHERE phone LIKE 'm18-%';
          DELETE FROM user_roles WHERE user_id BETWEEN 9601 AND 9699;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9601 AND 9699;
          DELETE FROM roles WHERE id BETWEEN 9601 AND 9699;
          DELETE FROM users WHERE id BETWEEN 9601 AND 9699",
    )
    .await;
}

async fn setup() {
    exec("INSERT INTO platform.companies (id, name, schema_name) VALUES (1, 'c1', 'public') ON CONFLICT DO NOTHING")
        .await;
    teardown().await;
    for (id, name) in [
        (MGR, "Quản lý m18"),
        (OWN, "Nhân viên Một"),
        (OWN2, "Nhân viên Hai"),
        (VIEW, "Chỉ xem"),
        (NONE, "Không quyền"),
        (NARROW, "Sửa rộng xem hẹp"),
    ] {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ({id}, 'u{id}@m18.test', 'x', '{name}', now())")).await;
    }
    let own = |role: i32| {
        ["view", "manage", "delete", "export"]
            .iter()
            .map(|p| format!("({role}, 'custom_records.{p}', 'own')"))
            .collect::<Vec<_>>()
            .join(",")
    };
    exec(&format!(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES (9601, 'm18-mgr', false, now()), (9602, 'm18-own', false, now()), (9603, 'm18-own2', false, now()), (9604, 'm18-view', false, now()), (9605, 'm18-narrow', false, now());
         INSERT INTO role_permissions (role_id, permission, scope) VALUES
           (9601, 'custom_objects.manage', NULL), (9601, 'custom_records.view', 'all'), (9601, 'custom_records.manage', 'all'),
           (9601, 'custom_records.delete', 'all'), (9601, 'custom_records.export', 'all'), (9601, 'custom_records.phone_full', 'all'),
           (9601, 'contacts.view', 'all'), (9601, 'deals.view', 'all'), (9601, 'kanban.view', 'all'),
           {}, {}, (9604, 'custom_records.view', 'all'), (9605, 'custom_records.view', 'own'), (9605, 'custom_records.manage', 'all');
         INSERT INTO user_roles (user_id, role_id) VALUES (9601, 9601), (9602, 9602), (9603, 9603), (9604, 9604), (9606, 9605)",
        own(9602),
        own(9603)
    ))
    .await;
}

async fn make_object(a: &App) -> i64 {
    let r = call(
        a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": OBJ, "label": "Hồ sơ", "label_plural": "Hồ sơ", "code_prefix": "hsm" })),
    )
    .await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let fields = [
        json!({ "key": "ten", "label": "Tên", "type": "text", "required": true, "is_title": true }),
        json!({ "key": "gia", "label": "Giá", "type": "currency" }),
        json!({ "key": "sl", "label": "Số lượng", "type": "number" }),
        json!({ "key": "ngay", "label": "Ngày", "type": "date" }),
        json!({ "key": "gio", "label": "Giờ", "type": "datetime" }),
        json!({ "key": "sdt", "label": "SĐT", "type": "phone" }),
        json!({ "key": "mail", "label": "Mail", "type": "email", "is_unique": true }),
        json!({ "key": "tt", "label": "Trạng thái", "type": "select", "options": { "choices": [{ "label": "Mới", "value": "moi" }, { "label": "Đã đăng ký", "value": "dk" }] } }),
        json!({ "key": "tag", "label": "Nhãn", "type": "multi_select", "options": { "choices": [{ "label": "A", "value": "a" }, { "label": "B", "value": "b" }] } }),
        json!({ "key": "ok", "label": "Xong", "type": "boolean" }),
        json!({ "key": "pt", "label": "Phần trăm", "type": "percent" }),
        json!({ "key": "web", "label": "Web", "type": "url" }),
        json!({ "key": "nguoi", "label": "Người", "type": "user" }),
        json!({ "key": "khach", "label": "Khách", "type": "relation", "options": { "target": "contact", "multiple": false } }),
        json!({ "key": "lk", "label": "Liên kết", "type": "link" }),
        json!({ "key": "ghichu", "label": "Ghi chú", "type": "long_text" }),
        json!({ "key": "tong", "label": "Tổng", "type": "formula", "options": { "expression": "{gia}*2+{pt}", "format": "currency" } }),
    ];
    for f in fields {
        let r = call(
            a,
            Method::POST,
            &format!("{B}/{OBJ}/fields"),
            Some(MGR),
            Some(f.clone()),
        )
        .await;
        assert_eq!(r.status, 201, "{f}: {:?}", r.body);
    }
    scalar::<i32>(&format!("SELECT id FROM custom_objects WHERE key = '{OBJ}'"))
        .await
        .into()
}

async fn post(a: &App, user: i32, data: Value) -> Res {
    call(a, Method::POST, REC, Some(user), Some(json!({ "data": data }))).await
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn errs(r: &Res) -> Value {
    r.body["errors"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ghi_doc_loc_sap_xep() {
    setup().await;
    let a = app().await;
    make_object(&a).await;

    // Quyền: 401, 403 (thiếu manage), kiểm dữ liệu strict trước.
    assert_eq!(call(&a, Method::GET, REC, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, REC, Some(NONE), None).await.status, 403);
    assert_eq!(post(&a, VIEW, json!({ "ten": "x" })).await.status, 403);
    let bad = call(&a, Method::POST, REC, Some(MGR), Some(json!({ "data": "x", "la": 1 }))).await;
    assert_eq!(bad.status, 400);
    assert!(
        bad.body["message"].to_string().contains("data phải là object"),
        "{:?}",
        bad.body
    );
    assert!(bad.body["message"].to_string().contains("property la should not exist"));

    // Kiểm giá trị theo trường: lỗi gom theo khoá, câu tiếng Việt như Node.
    let r = post(
        &a,
        MGR,
        json!({ "gia": -5, "sl": "abc", "ngay": "2026-02-30", "gio": "x", "sdt": "123", "mail": "khong-phai", "tt": "zzz", "tag": ["a", "q"],
                 "web": "ftp://x.vn", "nguoi": 0, "khach": "a", "lk": ["@@@"], "tong": 1, "la": 1, "pt": 5000 }),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body["message"], "Dữ liệu không hợp lệ");
    let e = errs(&r);
    for (k, want) in [
        ("ten", "“Tên” là bắt buộc"),
        ("gia", "không được âm"),
        ("sl", "“Số lượng” phải là số"),
        ("ngay", "“Ngày” phải là ngày hợp lệ dạng YYYY-MM-DD"),
        ("gio", "“Giờ” phải là ngày giờ hợp lệ"),
        ("sdt", "số điện thoại Việt Nam"),
        ("mail", "không phải email hợp lệ"),
        ("tt", "không nằm trong danh sách lựa chọn"),
        ("tag", "“q”"),
        ("web", "chỉ chấp nhận http:// hoặc https://"),
        ("nguoi", "mã tham chiếu không hợp lệ"),
        ("khach", "mã tham chiếu không hợp lệ"),
        ("lk", "không phải mã bản ghi"),
        ("tong", "là trường công thức, tính tự động nên không nhập được"),
        ("la", "Trường không tồn tại"),
        ("pt", "−1000% đến 1000%"),
    ] {
        assert!(e[k].as_str().unwrap_or_default().contains(want), "{k}: {e}");
    }

    // Tạo hợp lệ: mã sinh bằng trigger, công thức tính, SĐT chuẩn hoá; người giữ phone_full thấy số thật.
    let khach: i32 = scalar(&format!(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, updated_at) VALUES ('m18-1', 'Trần Thị Bình', {MGR}, {MGR}, now()) RETURNING id"
    ))
    .await;
    let r = post(
        &a,
        MGR,
        json!({ "ten": "  Nguyễn Văn An ", "gia": "1500000", "pt": 10, "ngay": "2026-11-27", "gio": "2026-11-27T10:30:00+07:00", "sdt": "+84 901-234-567",
                 "mail": "AN@Example.com", "tt": "dk", "tag": ["a", "a", "b"], "ok": "true", "web": "https://a.vn/x", "nguoi": OWN, "khach": khach, "ghichu": "Gặp @hs1" }),
    )
    .await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let id1 = r.body["id"].as_i64().unwrap();
    assert_eq!(r.body["code"], "HSM001");
    assert_eq!(r.body["title"], "Nguyễn Văn An");
    let d = &r.body["data"];
    assert_eq!(d["gia"], 1_500_000);
    assert_eq!(d["tong"], 3_000_000.1);
    assert_eq!(d["sdt"], "0901234567");
    assert_eq!(d["mail"], "an@example.com");
    assert_eq!(d["tag"], json!(["a", "b"]));
    assert_eq!(d["gio"], "2026-11-27T03:30:00.000Z");
    assert_eq!(d["ok"], true);
    assert_eq!(r.body["owner_id"], MGR);
    assert_eq!(
        r.body["relations"]["khach"],
        json!({ "id": khach, "title": "Trần Thị Bình", "accessible": true })
    );
    assert_eq!(r.body["relations"]["nguoi"]["title"], "Nhân viên Một");

    // Trùng trường duy nhất (không phân biệt hoa thường) ⇒ 400 theo trường.
    let dup = post(&a, MGR, json!({ "ten": "Khác", "mail": "an@EXAMPLE.com" })).await;
    assert_eq!(dup.status, 400);
    assert_eq!(errs(&dup)["mail"], "“Mail” đã tồn tại, không được trùng");

    // Thêm vài bản ghi để lọc, sắp xếp, phân trang.
    for (i, (ten, gia, tt)) in [
        ("Bình", 300, "moi"),
        ("Cường", 100, "dk"),
        ("Dung", 200, "moi"),
        ("Em", 0, "moi"),
    ]
    .iter()
    .enumerate()
    {
        let mut data = json!({ "ten": ten, "tt": tt, "ngay": format!("2026-11-{:02}", 20 + i) });
        if *gia > 0 {
            data["gia"] = json!(gia);
        }
        assert_eq!(post(&a, MGR, data).await.status, 201);
    }
    let all = call(&a, Method::GET, REC, Some(MGR), None).await;
    assert_eq!(all.status, 200);
    assert_eq!(all.body["total"], 5);
    assert_eq!(all.body["items"].as_array().unwrap().len(), 5);
    assert_eq!(all.body["items"][0]["code"], "HSM005", "id giảm dần");

    let by = |q: &str| {
        let a = &a;
        let q = q.to_owned();
        async move { call(a, Method::GET, &format!("{REC}?{q}"), Some(MGR), None).await }
    };
    let ids = |r: &Res| {
        r.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["data"]["ten"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    // sắp xếp theo số (NULL xếp cuối cả hai chiều), theo chữ, theo cập nhật
    assert_eq!(
        ids(&by("sort=field:gia&dir=asc").await),
        ["Cường", "Dung", "Bình", "Nguyễn Văn An", "Em"]
    );
    assert_eq!(
        ids(&by("sort=field:gia&dir=desc").await),
        ["Nguyễn Văn An", "Bình", "Dung", "Cường", "Em"]
    );
    assert_eq!(
        ids(&by("sort=title&dir=asc").await),
        ["Bình", "Cường", "Dung", "Em", "Nguyễn Văn An"]
    );
    // con trỏ: duyệt hết theo sắp xếp số, không lặp, không sót
    let mut seen = Vec::new();
    let mut cursor = String::new();
    for _ in 0..6 {
        let r = by(&format!("sort=field:gia&dir=asc&limit=2&cursor={cursor}")).await;
        assert_eq!(r.status, 200, "{:?}", r.body);
        seen.extend(ids(&r));
        match r.body["next_cursor"].as_str() {
            Some(c) => cursor = c.to_owned(),
            None => break,
        }
    }
    assert_eq!(seen, ["Cường", "Dung", "Bình", "Nguyễn Văn An", "Em"]);
    // trang theo số
    let p2 = by("limit=2&page=2").await;
    assert_eq!(ids(&p2), ["Cường", "Bình"]);
    assert_eq!(p2.body["total"], 5);
    // lọc: lựa chọn (value hoặc nhãn), khoảng số, ngày, đúng/sai, id liên kết
    assert_eq!(
        by(&format!("filter={}", enc(&json!({ "tt": "moi" }).to_string())))
            .await
            .body["total"],
        3
    );
    assert_eq!(
        by(&format!("filter={}", enc(&json!({ "tt": "Đã đăng ký" }).to_string())))
            .await
            .body["total"],
        2
    );
    assert_eq!(
        by(&format!(
            "filter={}",
            enc(&json!({ "gia": { "min": 150, "max": 300 } }).to_string())
        ))
        .await
        .body["total"],
        2
    );
    assert_eq!(
        by(&format!(
            "filter={}",
            enc(&json!({ "ngay": { "from": "2026-11-21", "to": "2026-11-22" } }).to_string())
        ))
        .await
        .body["total"],
        2
    );
    assert_eq!(
        by(&format!("filter={}", enc(&json!({ "ok": true }).to_string())))
            .await
            .body["total"],
        1
    );
    assert_eq!(
        by(&format!("filter={}", enc(&json!({ "khach": [khach] }).to_string())))
            .await
            .body["total"],
        1
    );
    assert_eq!(
        by(&format!("filter={}", enc(&json!({ "tag": ["b"] }).to_string())))
            .await
            .body["total"],
        1
    );
    for (f, want) in [
        ("{\"tt\":\"khong\"}", "Value hợp lệ"),
        ("{\"sdt\":\"x\"}", "Không lọc được theo trường"),
        ("nope", "không phải JSON"),
        ("[1]", "phải là object"),
        ("{\"gia\":{\"min\":\"a\"}}", "cần số hợp lệ"),
    ] {
        let r = by(&format!("filter={}", enc(f))).await;
        assert_eq!(r.status, 400, "{f}");
        assert!(msg(&r).contains(want), "{f}: {}", msg(&r));
    }
    assert_eq!(by("sort=field:sdt").await.status, 400);
    assert_eq!(by("sort=zzz").await.status, 400);
    assert_eq!(by("cursor=%25%25%25").await.status, 400);
    // ô tìm: không dấu, không phân biệt hoa thường, theo mã, theo nhãn lựa chọn, theo tên khách liên kết; `%` và `_` không là ký tự đại diện
    assert_eq!(ids(&by("q=nguyen%20van").await), ["Nguyễn Văn An"]);
    assert_eq!(ids(&by("q=hsm002").await), ["Bình"]);
    assert_eq!(by("q=dang%20ky").await.body["total"], 2);
    assert_eq!(ids(&by("q=tran%20thi").await), ["Nguyễn Văn An"]);
    assert_eq!(by("q=%25").await.body["total"], 0);
    assert_eq!(by("q=_").await.body["total"], 0);
    // tham số sai kiểu
    for q in ["limit=101", "limit=0", "page=0", "dir=up", "x=1"] {
        assert_eq!(by(q).await.status, 400, "{q}");
    }

    // Chi tiết, ngoài phạm vi → 404, id không phải số → 400, id quá lớn → 404.
    let one = call(&a, Method::GET, &format!("{REC}/{id1}"), Some(MGR), None).await;
    assert_eq!(one.status, 200);
    assert_eq!(one.body["id"], id1);
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{id1}"), Some(OWN), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/abc"), Some(MGR), None)
            .await
            .status,
        400
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/99999999999"), Some(MGR), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(
            &a,
            Method::GET,
            "/api/v1/custom-objects/khong_co/records",
            Some(MGR),
            None
        )
        .await
        .status,
        404
    );

    // Sửa: chỉ trường gửi lên đổi, null xoá giá trị, công thức tính lại, trùng duy nhất với bản khác vẫn chặn, chính nó thì không.
    let up = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id1}"),
        Some(MGR),
        Some(json!({ "data": { "gia": 2000000, "ghichu": null, "mail": "an@example.com" } })),
    )
    .await;
    assert_eq!(up.status, 200, "{:?}", up.body);
    assert_eq!(up.body["data"]["gia"], 2_000_000);
    assert_eq!(up.body["data"]["tong"], 4_000_000.1);
    assert_eq!(up.body["data"]["ten"], "Nguyễn Văn An");
    assert!(up.body["data"].get("ghichu").is_none());
    let clash = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{}", id1 + 1),
        Some(MGR),
        Some(json!({ "data": { "mail": "AN@example.com" } })),
    )
    .await;
    assert_eq!(clash.status, 400);
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{REC}/{id1}"),
            Some(MGR),
            Some(json!({ "data": { "ten": null } }))
        )
        .await
        .status,
        400
    );
    // giao người phụ trách: ngoài phạm vi 400; người không tồn tại 400
    let as_own = post(&a, OWN, json!({ "ten": "Của OWN" })).await;
    assert_eq!(as_own.status, 201);
    let own_id = as_own.body["id"].as_i64().unwrap();
    let give = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{own_id}"),
        Some(OWN),
        Some(json!({ "data": {}, "owner_id": OWN2 })),
    )
    .await;
    assert_eq!(give.status, 400);
    assert_eq!(
        errs(&give)["owner_id"],
        "Không giao được cho người này (ngoài phạm vi của bạn)"
    );
    let ghost = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{own_id}"),
        Some(MGR),
        Some(json!({ "data": {}, "owner_id": 99_999_999 })),
    )
    .await;
    assert_eq!(errs(&ghost)["owner_id"], "Người phụ trách không tồn tại hoặc đã khoá");
    let moved = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{own_id}"),
        Some(MGR),
        Some(json!({ "data": {}, "owner_id": OWN2 })),
    )
    .await;
    assert_eq!(moved.status, 200);
    assert_eq!(moved.body["owner_id"], OWN2);
    // OWN không còn thấy bản ghi này (đã chuyển; created_by vẫn là OWN nên vẫn thấy): kiểm theo created_by
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{own_id}"), Some(OWN), None)
            .await
            .status,
        200
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{own_id}"), Some(OWN2), None)
            .await
            .status,
        200
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{id1}"), Some(OWN2), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{REC}/{id1}"),
            Some(OWN2),
            Some(json!({ "data": { "ten": "x" } }))
        )
        .await
        .status,
        404
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{REC}/{id1}"), Some(OWN2), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{REC}/{id1}"), Some(VIEW), None)
            .await
            .status,
        403
    );

    // Lookup: chỉ {id, code, title} trong phạm vi; `%` không phải ký tự đại diện... (Prisma contains không thoát, như Node)
    let lk = call(&a, Method::GET, &format!("{B}/{OBJ}/lookup?q=nguy"), Some(MGR), None).await;
    assert_eq!(lk.status, 200);
    assert_eq!(
        lk.body,
        json!([{ "id": id1, "code": "HSM001", "title": "Nguyễn Văn An" }])
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/{OBJ}/lookup"), Some(OWN), None)
            .await
            .body
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // `%` và `_` trong ô tìm của lookup không là ký tự đại diện; id người phụ trách ngoài int4 ⇒ 400, không 500.
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/{OBJ}/lookup?q=%25"), Some(MGR), None)
            .await
            .body,
        json!([])
    );
    let huge = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id1}"),
        Some(MGR),
        Some(json!({ "data": {}, "owner_id": 99_999_999_999_i64 })),
    )
    .await;
    assert_eq!(huge.status, 400, "{:?}", huge.body);

    // Xoá mềm + sự kiện outbox cùng giao dịch.
    let del = call(&a, Method::DELETE, &format!("{REC}/{id1}"), Some(MGR), None).await;
    assert_eq!((del.status, del.body), (StatusCode::OK, json!({ "ok": true })));
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{id1}"), Some(MGR), None)
            .await
            .status,
        404
    );
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM custom_records WHERE id = {id1} AND deleted_at IS NOT NULL"
        ))
        .await,
        1
    );
    for (ev, n) in [("created", 6), ("updated", 2), ("deleted", 1)] {
        let c: i64 = scalar(&format!("SELECT count(*) FROM integration_events WHERE event_type = 'custom_record.{ev}' AND payload->'object'->>'key' = '{OBJ}'")).await;
        assert_eq!(c, n, "sự kiện {ev}");
    }
    let snap: Value = serde_json::from_str(&scalar::<String>(&format!("SELECT payload::text FROM integration_events WHERE event_type = 'custom_record.updated' AND resource_id = '{id1}' ORDER BY id DESC LIMIT 1")).await).unwrap();
    assert_eq!(snap["changed_fields"], json!(["gia", "ghichu"]));
    assert_eq!(snap["record"]["phone_fields"], json!(["sdt"]));
    assert!(
        snap["record"]["data"].get("tong").is_none(),
        "snapshot không có công thức"
    );
    assert_eq!(snap["object"]["key"], OBJ);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn che_sdt_theo_quyen() {
    setup().await;
    let a = app().await;
    make_object(&a).await;
    let r = post(&a, OWN, json!({ "ten": "Của OWN", "sdt": "0901234567" })).await;
    assert_eq!(r.status, 201);
    // OWN không có phone_full ⇒ số bị che ngay cả trong phản hồi của chính mình; MGR (phone_full all) thấy số thật.
    assert_eq!(r.body["data"]["sdt"], "***567");
    let id = r.body["id"].as_i64().unwrap();
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{id}"), Some(MGR), None)
            .await
            .body["data"]["sdt"],
        "0901234567"
    );
    let list = call(&a, Method::GET, REC, Some(VIEW), None).await;
    assert_eq!(list.body["items"][0]["data"]["sdt"], "***567");
    // Ghi: PATCH bởi người giữ phone_full cũng trả số thật; người không có thì che.
    let up = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id}"),
        Some(MGR),
        Some(json!({ "data": { "ten": "Đổi" } })),
    )
    .await;
    assert_eq!(up.body["data"]["sdt"], "0901234567");
    let own_up = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id}"),
        Some(OWN),
        Some(json!({ "data": { "ten": "Đổi 2" } })),
    )
    .await;
    assert_eq!(own_up.body["data"]["sdt"], "***567");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "cần Postgres"]
async fn chen_dong_thoi_50_ban_ghi_khong_trung_ma() {
    setup().await;
    let a = Arc::new(app().await);
    make_object(&a).await;
    let mut tasks = Vec::new();
    for i in 0..50 {
        let a = Arc::clone(&a);
        tasks.push(tokio::spawn(async move {
            post(&a, MGR, json!({ "ten": format!("Bản ghi {i}") })).await
        }));
    }
    let mut codes = std::collections::BTreeSet::new();
    for t in tasks {
        let r = t.await.unwrap();
        assert_eq!(r.status, 201, "{:?}", r.body);
        codes.insert(r.body["code"].as_str().unwrap().to_owned());
    }
    assert_eq!(codes.len(), 50, "50 mã khác nhau");
    assert_eq!(codes.first().map(String::as_str), Some("HSM001"));
    assert_eq!(codes.last().map(String::as_str), Some("HSM050"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn xuat_csv_chong_chen_cong_thuc() {
    setup().await;
    let a = app().await;
    make_object(&a).await;
    for (ten, gia) in [("=HYPERLINK(\"http://x\")", 5), ("@cmd, \"ok\"", 7), ("Bình thường", 9)] {
        assert_eq!(
            post(
                &a,
                MGR,
                json!({ "ten": ten, "gia": gia, "tt": "dk", "ngay": "2026-11-27", "ok": true, "tag": ["a", "b"] })
            )
            .await
            .status,
            201
        );
    }
    let x = format!("{REC}/export");
    assert_eq!(call(&a, Method::GET, &x, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, &x, Some(VIEW), None).await.status, 403);
    let r = call(&a, Method::GET, &x, Some(MGR), None).await;
    assert_eq!(r.status, 200);
    let h = |k: &str| {
        r.headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    assert_eq!(h("content-type"), "text/csv; charset=utf-8");
    assert_eq!(
        (
            h("x-total-rows").as_str(),
            h("x-exported-rows").as_str(),
            h("x-truncated").as_str()
        ),
        ("3", "3", "false")
    );
    assert!(
        h("content-disposition").starts_with("attachment; filename=\"m18_hs-"),
        "{}",
        h("content-disposition")
    );
    assert_eq!(h("cache-control"), "private, no-store");
    assert!(r.text.starts_with('\u{feff}'), "BOM");
    let lines: Vec<&str> = r.text.trim_end_matches("\r\n").split("\r\n").collect();
    assert!(lines[0].starts_with("\u{feff}ID,Mã,Tên,Giá,"), "{}", lines[0]);
    assert!(lines[0].ends_with(",Người phụ trách,Ngày tạo,Cập nhật lần cuối"));
    assert_eq!(lines.len(), 4);
    assert!(lines[1].contains(",Bình thường,9,"), "{}", lines[1]);
    assert!(lines[1].contains(",27/11/2026,"), "ngày dd/mm/yyyy: {}", lines[1]);
    assert!(
        lines[1].contains(",Đã đăng ký,") || lines[1].contains("Có"),
        "{}",
        lines[1]
    );
    assert!(lines[1].contains("A; B"), "nhãn lựa chọn: {}", lines[1]);
    assert!(lines[2].contains("\"'@cmd, \"\"ok\"\"\""), "{}", lines[2]);
    assert!(lines[3].contains("\"'=HYPERLINK(\"\"http://x\"\")\""), "{}", lines[3]);
    // Lọc áp dụng cho xuất; ô tìm cũng vậy.
    let f = call(
        &a,
        Method::GET,
        &format!("{x}?filter={}", enc(&json!({ "gia": { "min": 8 } }).to_string())),
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(f.headers.get("x-total-rows").and_then(|v| v.to_str().ok()), Some("1"));
    // Phạm vi xuất ∩ phạm vi xem: OWN không thấy bản ghi của MGR nên xuất 0.
    let o = call(&a, Method::GET, &x, Some(OWN), None).await;
    assert_eq!(o.headers.get("x-total-rows").and_then(|v| v.to_str().ok()), Some("0"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn lien_ket_tham_chieu_va_truy_nguoc() {
    setup().await;
    let a = app().await;
    let obj = make_object(&a).await;
    // Bảng thứ hai có quan hệ trỏ về Hồ sơ để thử `related`.
    let r = call(
        &a,
        Method::POST,
        B,
        Some(MGR),
        Some(json!({ "key": "m18_dk", "label": "Ghi danh", "label_plural": "Ghi danh", "code_prefix": "gdm" })),
    )
    .await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    let f = call(&a, Method::POST, &format!("{B}/m18_dk/fields"), Some(MGR), Some(json!({ "key": "hs", "label": "Hồ sơ", "type": "relation", "options": { "target_object_id": obj, "multiple": true } }))).await;
    assert_eq!(f.status, 201, "{:?}", f.body);
    let t = call(
        &a,
        Method::POST,
        &format!("{B}/m18_dk/fields"),
        Some(MGR),
        Some(json!({ "key": "tieude", "label": "Tiêu đề", "type": "text", "is_title": true })),
    )
    .await;
    assert_eq!(t.status, 201);

    let hs1 = post(&a, MGR, json!({ "ten": "Hồ sơ Một" })).await;
    let hs2 = post(
        &a,
        MGR,
        json!({ "ten": "Hồ sơ Hai", "lk": ["HSM001", "@hsm001"], "ghichu": "xem @HSM001 và email a@hsm001.vn" }),
    )
    .await;
    assert_eq!(hs2.status, 201, "{:?}", hs2.body);
    let (id1, id2) = (hs1.body["id"].as_i64().unwrap(), hs2.body["id"].as_i64().unwrap());
    // Trường Liên kết lưu `loại:id`, không lưu mã; relations có nhãn + mã + bảng + đường mở.
    assert_eq!(hs2.body["data"]["lk"], json!([format!("record:{id1}")]));
    let rel = &hs2.body["relations"]["lk"][0];
    assert_eq!(
        (
            rel["type"].as_str(),
            rel["code"].as_str(),
            rel["title"].as_str(),
            rel["table"].as_str()
        ),
        (Some("record"), Some("HSM001"), Some("Hồ sơ Một"), Some("Hồ sơ"))
    );
    assert_eq!(rel["href"], format!("/x/m18_hs/{id1}"));
    // Cạnh `record_links`: một từ trường Liên kết, một từ thẻ @ trong ô chữ dài.
    let edges: i64 = scalar(&format!("SELECT count(*) FROM record_links WHERE source_type = 'record' AND source_id = {id2} AND target_type = 'record' AND target_id = {id1}")).await;
    assert_eq!(edges, 2);
    // Mã không tồn tại / ngoài phạm vi: một câu chung, không phân biệt.
    let miss = post(&a, MGR, json!({ "ten": "x", "lk": ["HSM999", "KH999"] })).await;
    assert_eq!(miss.status, 400);
    assert!(
        errs(&miss)["lk"]
            .as_str()
            .unwrap()
            .contains("không tìm thấy HSM999, KH999 (hoặc bạn không có quyền xem)"),
        "{:?}",
        errs(&miss)
    );
    let hidden = post(&a, OWN, json!({ "ten": "y", "lk": ["HSM001"] })).await;
    assert_eq!(hidden.status, 400, "người ghi không thấy bản ghi đích");

    // Sửa: chỉ ghi lại cạnh của trường liên kết đã đổi; gỡ thẻ thì cạnh biến mất.
    let up = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id2}"),
        Some(MGR),
        Some(json!({ "data": { "lk": null, "ghichu": "hết nhắc" } })),
    )
    .await;
    assert_eq!(up.status, 200, "{:?}", up.body);
    assert_eq!(
        scalar::<i64>(&format!("SELECT count(*) FROM record_links WHERE source_id = {id2}")).await,
        0
    );

    // related: bản ghi bảng khác trỏ tới.
    let dk = call(
        &a,
        Method::POST,
        &format!("{B}/m18_dk/records"),
        Some(MGR),
        Some(json!({ "data": { "tieude": "Đăng ký 1", "hs": [id1] } })),
    )
    .await;
    assert_eq!(dk.status, 201, "{:?}", dk.body);
    let rl = call(&a, Method::GET, &format!("{REC}/{id1}/related"), Some(MGR), None).await;
    assert_eq!(rl.status, 200);
    assert_eq!(
        rl.body[0]["object"],
        json!({ "key": "m18_dk", "label_plural": "Ghi danh" })
    );
    assert_eq!(rl.body[0]["field"], json!({ "key": "hs", "label": "Hồ sơ" }));
    assert_eq!(rl.body[0]["total"], 1);
    assert_eq!(rl.body[0]["items"][0]["title"], "Đăng ký 1");
    // người ghi trường quan hệ phải thấy đích: OWN không chọn được hồ sơ của MGR
    let own_rel = call(
        &a,
        Method::POST,
        &format!("{B}/m18_dk/records"),
        Some(OWN),
        Some(json!({ "data": { "tieude": "z", "hs": [id1] } })),
    )
    .await;
    assert_eq!(own_rel.status, 400);
    assert!(
        errs(&own_rel)["hs"]
            .as_str()
            .unwrap()
            .contains("không tồn tại hoặc bạn không có quyền chọn")
    );

    // /refs: gợi ý theo mã, theo tên không dấu; resolve; xem nhanh; truy ngược; quyền.
    let sg = call(&a, Method::GET, "/api/v1/refs/suggest?q=@hsm", Some(MGR), None).await;
    assert_eq!(sg.status, 200);
    assert_eq!(sg.body[0]["code"], "HSM001");
    assert_eq!(sg.body[0]["ref"], format!("record:{id1}"));
    let by_name = call(&a, Method::GET, "/api/v1/refs/suggest?q=hai", Some(MGR), None).await;
    assert_eq!(by_name.body[0]["title"], "Hồ sơ Hai");
    assert_eq!(
        call(&a, Method::GET, "/api/v1/refs/suggest?q=hs", Some(NONE), None)
            .await
            .status,
        403
    );
    assert_eq!(
        call(&a, Method::GET, "/api/v1/refs/suggest?limit=99", Some(MGR), None)
            .await
            .status,
        400
    );
    let rs = call(
        &a,
        Method::GET,
        "/api/v1/refs/resolve?codes=hsm2,HSM001,ZZ9",
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(rs.status, 200);
    let got: Vec<&str> = rs
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["requested"].as_str().unwrap())
        .collect();
    assert_eq!(got, ["HSM002", "HSM001"]);
    assert_eq!(
        call(&a, Method::GET, "/api/v1/refs/resolve", Some(MGR), None)
            .await
            .status,
        400
    );
    let pv = call(
        &a,
        Method::GET,
        &format!("/api/v1/refs/record/{id1}/preview"),
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(pv.status, 200, "{:?}", pv.body);
    assert_eq!(pv.body["title"], "Hồ sơ Một");
    assert!(pv.body["fields"].is_array());
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("/api/v1/refs/record/{id1}/preview"),
            Some(OWN),
            None
        )
        .await
        .status,
        404
    );
    assert_eq!(
        call(&a, Method::GET, "/api/v1/refs/loai/1/preview", Some(MGR), None)
            .await
            .status,
        400
    );
    assert_eq!(
        call(&a, Method::GET, "/api/v1/refs/record/abc/preview", Some(MGR), None)
            .await
            .status,
        400
    );
    // truy ngược: cần một cạnh hiện hành
    let back_src = post(&a, MGR, json!({ "ten": "Nguồn", "lk": ["HSM001"] })).await;
    assert_eq!(back_src.status, 201);
    let bl = call(
        &a,
        Method::GET,
        &format!("/api/v1/refs/record/{id1}/backlinks"),
        Some(MGR),
        None,
    )
    .await;
    assert_eq!(bl.status, 200, "{:?}", bl.body);
    assert_eq!(bl.body[0]["source"]["title"], "Nguồn");
    assert_eq!(bl.body[0]["fields"], json!(["Liên kết"]));
    assert_eq!(
        call(
            &a,
            Method::GET,
            "/api/v1/refs/record/99999999/backlinks",
            Some(MGR),
            None
        )
        .await
        .status,
        404
    );
    assert_eq!(
        call(
            &a,
            Method::GET,
            &format!("/api/v1/refs/record/{id1}/backlinks"),
            Some(OWN),
            None
        )
        .await
        .status,
        404
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn phan_hoi_ghi_khong_ro_ri_ngoai_pham_vi_xem() {
    setup().await;
    let a = app().await;
    make_object(&a).await;
    let r = post(&a, MGR, json!({ "ten": "Của MGR", "sdt": "0901234567" })).await;
    let id = r.body["id"].as_i64().unwrap();
    // NARROW sửa được mọi bản ghi nhưng chỉ xem phần của mình: PATCH thành công mà phản hồi chỉ có {id}, không đọc lộ dữ liệu.
    let up = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id}"),
        Some(NARROW),
        Some(json!({ "data": { "ten": "Đổi bởi NARROW" } })),
    )
    .await;
    assert_eq!((up.status, up.body), (StatusCode::OK, json!({ "id": id })));
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{id}"), Some(NARROW), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{REC}/{id}"), Some(MGR), None)
            .await
            .body["data"]["ten"],
        "Đổi bởi NARROW"
    );
    // Bản ghi của chính NARROW: phản hồi đầy đủ.
    let own = post(&a, NARROW, json!({ "ten": "Của NARROW" })).await;
    assert_eq!(own.status, 201);
    assert_eq!(own.body["data"]["ten"], "Của NARROW");
    // Giao người phụ trách ngoài phạm vi sửa của người ghi bị chặn; trong phạm vi (all) thì cho.
    let ok = call(
        &a,
        Method::PATCH,
        &format!("{REC}/{id}"),
        Some(NARROW),
        Some(json!({ "data": {}, "owner_id": OWN })),
    )
    .await;
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    // Quyền ghi bị thu thì tạo bị chặn ở tầng service (403 từ guard của route, không lọt xuống DB).
    assert_eq!(post(&a, VIEW, json!({ "ten": "x" })).await.status, 403);
    // Hai PATCH song song khác trường không ghi đè nhau (khoá dòng, không lost update).
    let a2 = Arc::new(a);
    let (x, y) = (Arc::clone(&a2), Arc::clone(&a2));
    let path = format!("{REC}/{}", own.body["id"]);
    let (p1, p2) = (path.clone(), path.clone());
    let t1 = tokio::spawn(async move {
        call(
            &x,
            Method::PATCH,
            &p1,
            Some(NARROW),
            Some(json!({ "data": { "gia": 11 } })),
        )
        .await
    });
    let t2 = tokio::spawn(async move {
        call(
            &y,
            Method::PATCH,
            &p2,
            Some(NARROW),
            Some(json!({ "data": { "sl": 22 } })),
        )
        .await
    });
    assert_eq!(t1.await.unwrap().status, 200);
    assert_eq!(t2.await.unwrap().status, 200);
    let fin = call(&a2, Method::GET, &path, Some(NARROW), None).await;
    assert_eq!(
        (fin.body["data"]["gia"].as_i64(), fin.body["data"]["sl"].as_i64()),
        (Some(11), Some(22))
    );
}
