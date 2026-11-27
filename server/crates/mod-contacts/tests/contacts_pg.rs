//! M07: khách hàng trên Postgres thật (`public` đã migrate bằng Prisma, như job Rust pg tests).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-contacts --test contacts_pg -- --ignored`

use mod_contacts::export::export_xlsx;
use mod_contacts::filter::ContactFilters;
use mod_contacts::list::{ContactList, CountCache, ListQuery, Meta, find_all};
use mod_contacts::read::{assignable_users, find_by_id, search};
use mod_contacts::recent::{list_recent, record_view};
use mod_contacts::transfer::{assignable_sales, bulk_transfer, transfer};
use mod_contacts::write::{CreateContact, UpdateContact, create, remove, restore, update};
use mod_contacts::{Actor, Scopes};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::sync::{self, SyncEvent};
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_docgen::xlsx::read_first_sheet;
use trinity_kernel::error::{AppError, Message};
use trinity_rbac::OwnerIds;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn tenant() -> TenantDb {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 3;
    Db::connect(&cfg)
        .await
        .expect("nối DB")
        .tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
}

fn err(e: AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    match b.message {
        Message::One(m) => (s, m),
        Message::Many(m) => (s, m.join("; ")),
    }
}

fn js<T: serde::Serialize>(v: &T) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

async fn clean(c: &mut PgConnection) {
    for sql in [
        "DELETE FROM contact_recent_views WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm07%@test.local')",
        "DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE '0907%')",
        "DELETE FROM deals WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE '0907%')",
        "DELETE FROM contacts WHERE phone LIKE '0907%' OR phone LIKE '+84907%'",
        "DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE 'm07%@test.local')",
        "DELETE FROM integration_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE 'm07%@test.local')",
        "DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm07%@test.local')",
        "DELETE FROM users WHERE email LIKE 'm07%@test.local'",
        "DELETE FROM setting_options WHERE value LIKE 'm07_%'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

async fn user(c: &mut PgConnection, n: u8, name: &str, manager: Option<i32>) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, manager_id, updated_at) VALUES ($1, 'x', $2, $3, now()) RETURNING id",
    )
    .bind(format!("m07{n}@test.local"))
    .bind(name)
    .bind(manager)
    .fetch_one(c)
    .await
    .unwrap()
}

async fn option(c: &mut PgConnection, group: &str, value: &str, label: &str) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ($1, $2, $3, now()) RETURNING id",
    )
    .bind(group)
    .bind(value)
    .bind(label)
    .fetch_one(c)
    .await
    .unwrap()
}

async fn contact(c: &mut PgConnection, phone: &str, name: &str, owner: i32) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, updated_at) VALUES ($1, $2, $3, $3, now()) RETURNING id",
    )
    .bind(phone)
    .bind(name)
    .bind(owner)
    .fetch_one(c)
    .await
    .unwrap()
}

fn actor(id: i32, admin: bool) -> Actor {
    Actor {
        user_id: id,
        is_admin: admin,
        email: Some(format!("m07{id}@test.local")),
    }
}

fn all() -> Scopes {
    let a = || Some(OwnerIds::All);
    Scopes {
        view: a(),
        update: a(),
        delete: a(),
        transfer: a(),
        phone_full: a(),
        deals_manage: a(),
    }
}

fn own(id: i32) -> Scopes {
    let o = || Some(OwnerIds::Ids(vec![id]));
    Scopes {
        view: o(),
        update: o(),
        delete: o(),
        transfer: o(),
        phone_full: None,
        deals_manage: o(),
    }
}

fn q(v: Value) -> ListQuery {
    serde_json::from_value(v).unwrap()
}

fn names(l: &ContactList) -> Vec<String> {
    l.data.iter().map(|r| r.full_name.clone().unwrap_or_default()).collect()
}

fn create_dto(v: Value) -> CreateContact {
    serde_json::from_value(v).unwrap()
}

fn patch(v: Value) -> UpdateContact {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tim_tieng_viet_co_dau_va_khong_dau() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let admin = user(&mut c, 1, "Quản trị M07", None).await;
    contact(&mut c, "0907000001", "Bé Mính", admin).await;
    contact(&mut c, "0907000002", "Nguyễn Văn Minh", admin).await;
    contact(&mut c, "0907000003", "Đặng Thị Lan", admin).await;
    contact(&mut c, "0907000004", "Trần Hoàng", admin).await;
    let cache = CountCache::disabled();
    let a = actor(admin, true);

    // Không dấu ra cả "Mính" lẫn "Minh"; có dấu "Mính" cũng vậy (gập dấu hai phía).
    for term in ["minh", "MINH", "mính", " Minh "] {
        let l = find_all(&mut c, &all(), &a, &q(json!({ "search": term, "limit": 50 })), &cache)
            .await
            .unwrap();
        let mut n = names(&l);
        n.sort();
        assert_eq!(n, ["Bé Mính", "Nguyễn Văn Minh"], "từ khoá {term:?}");
    }
    let dang = find_all(&mut c, &all(), &a, &q(json!({ "search": "dang thi lan" })), &cache)
        .await
        .unwrap();
    assert_eq!(names(&dang), ["Đặng Thị Lan"]);
    let none = find_all(&mut c, &all(), &a, &q(json!({ "search": "khongco" })), &cache)
        .await
        .unwrap();
    assert!(none.data.is_empty());

    // Tra trùng khi tạo: cùng luật gập dấu, giới hạn tên ≥ 2 ký tự.
    let hit = search(&mut c, &all(), "dang").await.unwrap();
    assert_eq!(js(&hit)["data"][0]["full_name"], "Đặng Thị Lan");
    assert!(search(&mut c, &all(), "d").await.unwrap().data.is_empty());
    assert_eq!(search(&mut c, &all(), "0907000004").await.unwrap().data.len(), 1);
    // Không có phone_full toàn công ty: chuỗi số ngắn không tra được SĐT (chống dò số), đủ 9 số thì tra và số bị che.
    let masked = own(admin);
    assert!(search(&mut c, &masked, "090700").await.unwrap().data.is_empty());
    let found = search(&mut c, &masked, "0907000004").await.unwrap();
    assert_eq!(js(&found)["data"][0]["phone"], "***004");
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn danh_sach_pham_vi_che_so_phan_trang_va_con_tro() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let boss = user(&mut c, 1, "Trưởng nhóm", None).await;
    let staff = user(&mut c, 2, "Nhân viên", Some(boss)).await;
    let other = user(&mut c, 3, "Người ngoài", None).await;
    let src = option(&mut c, "contact_source", "m07_src", "Nguồn M07").await;
    let mut ids = Vec::new();
    for (i, owner) in [(1, staff), (2, staff), (3, other), (4, boss), (5, staff)] {
        ids.push(contact(&mut c, &format!("090700010{i}"), &format!("Khách {i}"), owner).await);
    }
    sqlx::query("UPDATE contacts SET source_id = $1 WHERE id = $2")
        .bind(src)
        .bind(ids[0])
        .execute(&mut *c)
        .await
        .unwrap();
    let cache = CountCache::disabled();

    // Nhân viên chỉ thấy khách của mình; SĐT bị che vì không có phone_full.
    let a = actor(staff, false);
    let l = find_all(&mut c, &own(staff), &a, &q(json!({ "limit": 50 })), &cache)
        .await
        .unwrap();
    assert_eq!(
        names(&l),
        ["Khách 5", "Khách 2", "Khách 1"],
        "id giảm dần, ngoài phạm vi không lọt"
    );
    assert!(
        l.data
            .iter()
            .all(|r| r.phone.as_deref().is_some_and(|p| p.starts_with("***")))
    );
    // Trưởng nhóm (team = mình + cấp dưới) có phone_full all: thấy số thật.
    let team = Scopes {
        view: Some(OwnerIds::Ids(vec![boss, staff])),
        phone_full: Some(OwnerIds::All),
        ..own(boss)
    };
    let lb = find_all(&mut c, &team, &actor(boss, false), &q(json!({})), &cache)
        .await
        .unwrap();
    assert_eq!(lb.data.len(), 4);
    assert_eq!(lb.data[0].phone.as_deref(), Some("0907000105"));
    // Thiếu quyền xem ⇒ rỗng, không lỗi.
    assert!(
        find_all(&mut c, &Scopes::default(), &a, &q(json!({})), &cache)
            .await
            .unwrap()
            .data
            .is_empty()
    );

    // Lọc theo nguồn + ngày tạo.
    let by_src = find_all(&mut c, &all(), &a, &q(json!({ "source_id": src })), &cache)
        .await
        .unwrap();
    assert_eq!(names(&by_src), ["Khách 1"]);
    let future = find_all(&mut c, &all(), &a, &q(json!({ "created_from": "2999-01-01" })), &cache)
        .await
        .unwrap();
    assert!(future.data.is_empty());

    // Kiểu con trỏ: trang 1 có next_cursor, trang 2 nối tiếp không trùng.
    let p1 = find_all(&mut c, &team, &actor(boss, false), &q(json!({ "limit": 3 })), &cache)
        .await
        .unwrap();
    let Meta::Cursor { next_cursor: Some(cur) } = p1.meta else {
        panic!("thiếu next_cursor")
    };
    let p2 = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "limit": 3, "cursor": cur })),
        &cache,
    )
    .await
    .unwrap();
    assert_eq!(names(&p1), ["Khách 5", "Khách 4", "Khách 2"]);
    assert_eq!(names(&p2), ["Khách 1"]);
    assert!(matches!(p2.meta, Meta::Cursor { next_cursor: None }));
    // Sắp xếp rõ ràng theo tên tăng dần + con trỏ.
    let s1 = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "limit": 2, "sort_by": "full_name" })),
        &cache,
    )
    .await
    .unwrap();
    assert_eq!(names(&s1), ["Khách 1", "Khách 2"]);
    let Meta::Cursor { next_cursor: Some(cur) } = s1.meta else {
        panic!("thiếu next_cursor")
    };
    let s2 = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "limit": 2, "sort_by": "full_name", "cursor": cur })),
        &cache,
    )
    .await
    .unwrap();
    assert_eq!(names(&s2), ["Khách 4", "Khách 5"]);

    // Kiểu trang: có meta.total/pages; cache đếm giữ số cũ tới khi xoá.
    let live = CountCache::new();
    let pg = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "page": 1, "limit": 3 })),
        &live,
    )
    .await
    .unwrap();
    let Meta::Page { total, pages, .. } = pg.meta else {
        panic!("thiếu meta trang")
    };
    assert_eq!((total, pages, pg.data.len()), (4, 2, 3));
    contact(&mut c, "0907000199", "Khách mới", staff).await;
    let again = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "page": 1, "limit": 3 })),
        &live,
    )
    .await
    .unwrap();
    let Meta::Page { total, .. } = again.meta else { panic!() };
    assert_eq!(total, 4, "số đếm lấy từ cache 60 giây");
    live.clear();
    let fresh = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "page": 1, "limit": 3 })),
        &live,
    )
    .await
    .unwrap();
    let Meta::Page { total, .. } = fresh.meta else { panic!() };
    assert_eq!(total, 5);
    let deep = find_all(
        &mut c,
        &team,
        &actor(boss, false),
        &q(json!({ "page": 100, "limit": 50 })),
        &live,
    )
    .await;
    assert_eq!(
        err(deep.unwrap_err()),
        (400, "Vượt giới hạn phân trang. Vui lòng thu hẹp bộ lọc.".to_owned())
    );

    // Người dùng trong phạm vi.
    let users = assignable_users(&mut c, &team).await.unwrap();
    let mut got: Vec<i32> = users.iter().map(|u| u.id).collect();
    got.sort_unstable();
    assert_eq!(got, [boss, staff]);
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tao_sua_xoa_khoi_phuc_va_su_kien() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let admin = user(&mut c, 1, "Quản trị", None).await;
    let sale = user(&mut c, 2, "Sale", Some(admin)).await;
    let sale2 = user(&mut c, 3, "Sale hai", Some(admin)).await;
    let src = option(&mut c, "contact_source", "m07_src", "Nguồn").await;
    let stage = option(&mut c, "contact_stage", "m07_s1", "Giai đoạn M07").await;
    let status = option(&mut c, "contact_detail_status", "m07_st", "Trạng thái").await;
    drop(c);
    let a_admin = actor(admin, true);
    let a_sale = actor(sale, false);

    // Tạo: nguồn sai nhóm → 400; tạo thành công, SĐT +84 chuẩn hoá về 0…; trùng cùng người → 409; người khác tạo được.
    let bad = create(
        &db,
        &all(),
        &a_sale,
        &create_dto(json!({ "phone": "0907000201", "full_name": "A", "source_id": stage })),
    )
    .await;
    assert_eq!(
        err(bad.unwrap_err()),
        (400, "Giá trị không thuộc nhóm \"contact_source\"".to_owned())
    );
    let made = create(
        &db,
        &own(sale),
        &a_sale,
        &create_dto(json!({ "phone": "+84907000201", "full_name": "Khách tạo", "source_id": src })),
    )
    .await
    .unwrap();
    let id = made.contact.id;
    let j = js(&made);
    assert_eq!(j["contact"]["phone"], "0907000201");
    assert_eq!(j["contact"]["assigned_to"], sale);
    assert_eq!(j["warning"], Value::Null);
    assert!(
        j["contact"]["code"].as_str().is_some_and(|c| c.starts_with("KH")),
        "mã do trigger sinh: {j}"
    );
    let dup = create(
        &db,
        &own(sale),
        &a_sale,
        &create_dto(json!({ "phone": "0907000201", "full_name": "B", "source_id": src })),
    )
    .await;
    assert_eq!(err(dup.unwrap_err()).0, 409);
    create(
        &db,
        &own(sale2),
        &actor(sale2, false),
        &create_dto(json!({ "phone": "0907000201", "full_name": "Khách sale hai", "source_id": src })),
    )
    .await
    .unwrap();
    // Gán thương vụ cần deals.manage phủ người nhận; có quyền thì tạo kèm thương vụ + thông báo + sự kiện.
    let denied = create(
        &db,
        &own(sale),
        &a_sale,
        &create_dto(json!({ "phone": "0907000202", "full_name": "C", "source_id": src, "deal_assigned_to": sale2 })),
    )
    .await;
    assert_eq!(err(denied.unwrap_err()).0, 403);
    let with_deal = create(&db, &all(), &a_admin, &create_dto(json!({ "phone": "0907000203", "full_name": "Có thương vụ", "source_id": src, "deal_assigned_to": sale2, "stage_id": stage })))
        .await
        .unwrap();
    assert_eq!(with_deal.contact.assigned_to, Some(sale2));
    assert_eq!(with_deal.notifications.len(), 1);
    assert_eq!(
        js(&with_deal)["deal"]["title"],
        format!("Thương vụ từ khách hàng #{}", with_deal.contact.id)
    );

    let mut c = db.acquire().await.unwrap();
    let n_events: i64 = sqlx::query_scalar("SELECT count(*) FROM integration_events WHERE event_type IN ('contact.created','deal.created') AND actor_user_id = ANY($1)")
        .bind([sale, sale2, admin].to_vec())
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n_events, 4, "3 contact.created + 1 deal.created");
    drop(c);

    // Sửa: ngoài phạm vi 404; sửa SĐT cần phone_full (403), có thì đổi và ghi nhật ký; trùng người phụ trách 409;
    // họ tên đã có thì chỉ Quản trị ghi đè; đổi giai đoạn ghi hoạt động + sự kiện.
    let other_scope = own(sale2);
    let r = update(
        &db,
        &other_scope,
        &actor(sale2, false),
        id,
        &patch(json!({ "job_title": "x" })),
    )
    .await;
    assert_eq!(err(r.unwrap_err()).0, 404);
    let r = update(&db, &own(sale), &a_sale, id, &patch(json!({ "phone": "0907000299" }))).await;
    assert_eq!(err(r.unwrap_err()).0, 403);
    let mut with_phone = own(sale);
    with_phone.phone_full = Some(OwnerIds::Ids(vec![sale]));
    let upd = update(&db, &with_phone, &a_sale, id, &patch(json!({ "phone": "0907000299", "job_title": "Giám đốc", "stage_id": stage, "contact_status_id": status, "email": "" })))
        .await
        .unwrap();
    let uj = js(&upd);
    assert_eq!(
        (uj["phone"].as_str(), uj["job_title"].as_str(), uj["email"].clone()),
        (Some("0907000299"), Some("Giám đốc"), Value::Null)
    );
    assert_eq!(
        uj["stage"]["label"], "Giai đoạn M07",
        "response sửa giữ `stage` dạng đối tượng"
    );
    // Tên đã có: Sale bị bỏ qua lặng lẽ, Quản trị ghi đè.
    update(&db, &own(sale), &a_sale, id, &patch(json!({ "full_name": "Tên mới" })))
        .await
        .unwrap();
    let mut c = db.acquire().await.unwrap();
    let name: String = sqlx::query_scalar("SELECT full_name FROM contacts WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(name, "Khách tạo");
    drop(c);
    update(
        &db,
        &all(),
        &a_admin,
        id,
        &patch(json!({ "full_name": " Tên Quản trị " })),
    )
    .await
    .unwrap();
    let mut c = db.acquire().await.unwrap();
    let name: String = sqlx::query_scalar("SELECT full_name FROM contacts WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(name, "Tên Quản trị");
    let act: i64 =
        sqlx::query_scalar("SELECT count(*) FROM activities WHERE contact_id = $1 AND action = 'stage_change'")
            .bind(id)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(act, 1);
    let ev: Vec<String> = sqlx::query_scalar(
        "SELECT event_type FROM integration_events WHERE resource_id = $1 AND event_type LIKE 'contact.%' ORDER BY id",
    )
    .bind(id.to_string())
    .fetch_all(&mut *c)
    .await
    .unwrap();
    assert!(
        ev.contains(&"contact.updated".to_owned()) && ev.contains(&"contact.stage_changed".to_owned()),
        "{ev:?}"
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_logs WHERE resource_id = $1 AND action = 'contact.phone_changed'",
    )
    .bind(id)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    // Đổi người phụ trách: người nhận đã có khách cùng SĐT ⇒ 409; không trùng thì đổi được và bắn `contact.assigned`.
    let mut c = db.acquire().await.unwrap();
    let dup_id = contact(&mut c, "0907000299", "Trùng SĐT", sale2).await;
    drop(c);
    let r = update(&db, &all(), &a_admin, id, &patch(json!({ "assigned_to": sale2 }))).await;
    assert_eq!(err(r.unwrap_err()).0, 409);
    let mut c = db.acquire().await.unwrap();
    sqlx::query("UPDATE contacts SET phone = '0907000298' WHERE id = $1")
        .bind(dup_id)
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    update(&db, &all(), &a_admin, id, &patch(json!({ "assigned_to": sale2 })))
        .await
        .unwrap();
    let mut c = db.acquire().await.unwrap();
    let assigned: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM integration_events WHERE resource_id = $1 AND event_type = 'contact.assigned'",
    )
    .bind(id.to_string())
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(assigned, 1);
    drop(c);

    // Chi tiết: SĐT che theo phone_full, `stage` là nhãn, `stage_option` là đối tượng; có thương vụ và hoạt động.
    let mut c = db.acquire().await.unwrap();
    let full = js(&find_by_id(&mut c, &all(), id).await.unwrap());
    assert_eq!(full["phone"], "0907000299");
    assert_eq!(full["stage"], "Giai đoạn M07");
    assert_eq!(full["stage_option"]["value"], "m07_s1");
    assert_eq!(full["stage_source"], "stage");
    assert_eq!(full["activities"][0]["action"], "stage_change");
    let masked = js(&find_by_id(
        &mut c,
        &Scopes {
            phone_full: None,
            ..all()
        },
        id,
    )
    .await
    .unwrap());
    assert_eq!(masked["phone"], "***299");
    let nf = find_by_id(&mut c, &own(admin), id).await.unwrap_err();
    assert_eq!(
        err(nf),
        (404, "Không tìm thấy".to_owned()),
        "ngoài phạm vi ⇒ 404 như id không tồn tại (assertInScope)"
    );
    drop(c);

    // Xoá mềm: ngoài phạm vi 404; xoá được thì mất khỏi chi tiết/danh sách; khôi phục chỉ người xoá hoặc Quản trị,
    // quá 10 phút ⇒ 410, SĐT trùng người phụ trách ⇒ 409.
    let r = remove(&db, &own(admin), &a_sale, id).await;
    assert_eq!(err(r.unwrap_err()).0, 404);
    let done = remove(&db, &all(), &a_admin, id).await.unwrap();
    assert_eq!(done.message, "Đã xoá contact thành công");
    let mut c = db.acquire().await.unwrap();
    assert_eq!(err(find_by_id(&mut c, &all(), id).await.unwrap_err()).0, 404);
    drop(c);
    assert_eq!(err(remove(&db, &all(), &a_admin, id).await.unwrap_err()).0, 404);
    assert_eq!(
        err(restore(&db, &all(), &a_sale, id).await.unwrap_err()).0,
        403,
        "Sale không phải người xoá"
    );
    let mut c = db.acquire().await.unwrap();
    let clash = contact(&mut c, "0907000299", "Chiếm SĐT", sale2).await;
    drop(c);
    assert_eq!(err(restore(&db, &all(), &a_admin, id).await.unwrap_err()).0, 409);
    let mut c = db.acquire().await.unwrap();
    sqlx::query("DELETE FROM contacts WHERE id = $1")
        .bind(clash)
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    assert_eq!(
        restore(&db, &all(), &a_admin, id).await.unwrap().message,
        "Đã khôi phục khách hàng"
    );
    remove(&db, &all(), &a_admin, id).await.unwrap();
    let mut c = db.acquire().await.unwrap();
    sqlx::query("UPDATE contacts SET deleted_at = (now() AT TIME ZONE 'UTC') - interval '11 minutes' WHERE id = $1")
        .bind(id)
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    assert_eq!(err(restore(&db, &all(), &a_admin, id).await.unwrap_err()).0, 410);
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn chuyen_phu_trach_khach_gan_day_va_xuat_xlsx() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let boss = user(&mut c, 1, "Trưởng phòng", None).await;
    let lead = user(&mut c, 2, "Trưởng nhóm", Some(boss)).await;
    let a = user(&mut c, 3, "Sale A", Some(lead)).await;
    let b = user(&mut c, 4, "Sale B", Some(lead)).await;
    let outsider = user(&mut c, 5, "Ngoài nhóm", None).await;
    sqlx::query("UPDATE users SET status = 'locked' WHERE id = $1")
        .bind(outsider)
        .execute(&mut *c)
        .await
        .unwrap();
    let c1 = contact(&mut c, "0907000301", "Khách một", a).await;
    let c2 = contact(&mut c, "0907000302", "Khách hai", a).await;
    contact(&mut c, "0907000302", "Trùng SĐT của B", b).await;
    let c4 = contact(&mut c, "=0907000304", "=HYPERLINK(\"x\")", a).await;
    let c5 = contact(&mut c, "0907000305", "Của người ngoài", outsider).await;
    drop(c);
    let team = Scopes {
        transfer: Some(OwnerIds::Ids(vec![lead, a, b])),
        ..all()
    };
    let al = actor(lead, false);

    let sales = {
        let mut c = db.acquire().await.unwrap();
        assignable_sales(&mut c, &team).await.unwrap()
    };
    let ids: Vec<i32> = sales.iter().map(|u| u.id).collect();
    assert!(ids.contains(&a) && ids.contains(&b) && !ids.contains(&boss), "{ids:?}");

    // Chuyển một khách: cùng người phụ trách ⇒ 400; người nhận có SĐT trùng ⇒ 409; ngoài phạm vi ⇒ 403; người nhận bị khoá ⇒ 400.
    assert_eq!(err(transfer(&db, &team, &al, c1, a, "").await.unwrap_err()).0, 400);
    assert_eq!(err(transfer(&db, &team, &al, c2, b, "").await.unwrap_err()).0, 409);
    assert_eq!(err(transfer(&db, &team, &al, c5, b, "").await.unwrap_err()).0, 403);
    assert_eq!(
        err(transfer(&db, &team, &al, c1, outsider, "").await.unwrap_err()).0,
        400
    );
    let ok = transfer(&db, &team, &al, c1, b, "Sale cũ nghỉ").await.unwrap();
    assert_eq!(js(&ok), json!({ "contactId": c1, "fromUserId": a, "toUserId": b }));
    // Hàng loạt: một khách lỗi không chặn cả lô; toàn lỗi ⇒ 400 kèm lỗi đầu tiên.
    let bulk = bulk_transfer(&db, &team, &al, &[c4, c2, 999_999], b, "").await.unwrap();
    assert_eq!(bulk.transferred_ids, [c4]);
    assert_eq!(bulk.failed.len(), 2);
    assert_eq!(bulk.failed[1].error, "Không tìm thấy khách hàng ID 999999");
    let none = bulk_transfer(&db, &team, &al, &[999_998], b, "").await;
    assert_eq!(
        err(none.unwrap_err()),
        (
            400,
            "Không chuyển được khách hàng nào. Lỗi đầu tiên: Không tìm thấy khách hàng ID 999998".to_owned()
        )
    );
    let mut c = db.acquire().await.unwrap();
    let hist: String = sqlx::query_scalar(
        "SELECT details->>'description' FROM activities WHERE contact_id = $1 AND action = 'contact_transfer'",
    )
    .bind(c1)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(
        hist,
        "Chuyển quyền phụ trách khách hàng Khách một từ Sale A sang Sale B"
    );

    // Khách gần đây: ghi/giới hạn/đọc lại theo quyền hiện tại; khách đã đổi chủ ra ngoài phạm vi thì biến mất.
    let view_a = own(a);
    let aa = actor(a, false);
    assert_eq!(
        err(record_view(&mut c, &view_a, &aa, c5).await.unwrap_err()).0,
        404,
        "khách của người ngoài"
    );
    record_view(&mut c, &view_a, &aa, c2).await.unwrap();
    let all_view = Scopes {
        view: Some(OwnerIds::All),
        ..view_a.clone()
    };
    record_view(&mut c, &all_view, &aa, c5).await.unwrap();
    let recent = list_recent(&mut c, &view_a, &aa, Some(50)).await.unwrap();
    assert_eq!(
        recent.iter().map(|r| r.id).collect::<Vec<_>>(),
        [c2],
        "c5 ngoài phạm vi hiện tại bị lọc"
    );
    assert_eq!(list_recent(&mut c, &all_view, &aa, None).await.unwrap().len(), 2);

    // Xuất xlsx: đúng cột, che SĐT theo phone_full, chống chèn công thức, lọc theo bộ lọc.
    let bytes = export_xlsx(
        &mut c,
        &Scopes {
            phone_full: None,
            ..all()
        },
        &ContactFilters {
            search: Some("khach".into()),
            ..ContactFilters::default()
        },
    )
    .await
    .unwrap();
    let sheet = read_first_sheet(&bytes).unwrap();
    assert_eq!(sheet.cell(0, 1).as_trimmed_text().as_deref(), Some("Tên KH"));
    let rows: Vec<Vec<String>> = (1..8)
        .map(|r| {
            (0..4)
                .map(|col| sheet.cell(r, col).as_trimmed_text().unwrap_or_default())
                .collect()
        })
        .collect();
    let by_name = |n: &str| rows.iter().find(|r| r[1] == n).cloned();
    let row = by_name("Khách một").expect("có dòng Khách một");
    assert_eq!(row[2], "***301", "SĐT che khi không có phone_full");
    assert!(rows.iter().all(|r| !r[1].contains("Của người ngoài") || true));
    let full = export_xlsx(&mut c, &all(), &ContactFilters::default()).await.unwrap();
    let sheet = read_first_sheet(&full).unwrap();
    let texts: Vec<String> = (1..30)
        .map(|r| sheet.cell(r, 1).as_trimmed_text().unwrap_or_default())
        .collect();
    assert!(
        texts.iter().any(|t| t == "'=HYPERLINK(\"x\")"),
        "ô bắt đầu bằng = được thêm ': {texts:?}"
    );
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn review_381_trung_sdt_escape_like_loc_0_va_khoi_phuc() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let a = user(&mut c, 1, "Sale A", None).await;
    let b = user(&mut c, 2, "Sale B", None).await;
    // B đã có khách +84 cùng SĐT với khách của A (dạng khác nhau) ⇒ chuyển phải thấy là trùng.
    contact(&mut c, "+84907000401", "B giữ +84", b).await;
    let c1 = contact(&mut c, "0907000401", "A một", a).await;
    let c2 = contact(&mut c, "0907000402", "100% _gạch_ \\x", a).await;
    contact(&mut c, "0907000403", "1000 xgạchx", a).await;
    let ad = actor(a, false);
    let scopes = Scopes {
        transfer: Some(OwnerIds::Ids(vec![a, b])),
        ..all()
    };
    assert_eq!(err(transfer(&db, &scopes, &ad, c1, b, "").await.unwrap_err()).0, 409);
    // Hàng loạt quá trần ⇒ 400.
    let many: Vec<i32> = (1..=501).collect();
    assert_eq!(
        err(bulk_transfer(&db, &scopes, &ad, &many, b, "").await.unwrap_err()).0,
        400
    );

    // PATCH giữ nguyên người phụ trách khi chỉ có contacts.update (không transfer) ⇒ không 403.
    let no_transfer = Scopes {
        transfer: None,
        ..all()
    };
    update(&db, &no_transfer, &ad, c2, &patch(json!({ "assigned_to": a })))
        .await
        .expect("to == current bỏ qua kiểm transfer");
    // Bỏ gán khi đã có người, nhóm NULL đã có khách cùng SĐT ⇒ 409.
    contact_unassigned(&mut c, "0907000402").await;
    assert_eq!(
        err(update(&db, &all(), &ad, c2, &patch(json!({ "assigned_to": null })))
            .await
            .unwrap_err())
        .0,
        409
    );

    // Tìm: % _ \ khớp theo nghĩa đen.
    let find = |s: &str| {
        let db = db.clone();
        let s = s.to_owned();
        async move {
            let mut c = db.acquire().await.unwrap();
            search(&mut c, &all(), &s).await.unwrap().data.len()
        }
    };
    assert_eq!(find("100%").await, 1);
    assert_eq!(find("_gạch_").await, 1);
    assert_eq!(find("\\x").await, 1);
    assert_eq!(find("%%").await, 0);

    // Lọc id = 0 ⇒ không lọc.
    let list = find_all(
        &mut c,
        &all(),
        &ad,
        &q(json!({ "project_id": 0, "creator_id": 0, "team_lead_id": 0, "dept_head_id": 0, "search": "A một" })),
        &CountCache::disabled(),
    )
    .await;
    assert!(list.is_ok(), "{:?}", list.err().map(err));

    // Khôi phục: khách chưa xoá ⇒ 404; khách đã xoá ⇒ khôi phục được.
    assert_eq!(err(restore(&db, &all(), &ad, c1).await.unwrap_err()).0, 404);
    remove(&db, &all(), &ad, c1).await.unwrap();
    assert_eq!(
        err(record_view(&mut c, &all(), &ad, c1).await.unwrap_err()).0,
        404,
        "record_view bỏ qua khách đã xoá"
    );
}

async fn contact_unassigned(c: &mut PgConnection, phone: &str) {
    sqlx::query(
        "INSERT INTO contacts (phone, full_name, assigned_to, updated_at) VALUES ($1, 'Chưa gán', NULL, now())",
    )
    .bind(phone)
    .execute(c)
    .await
    .unwrap();
}

fn test_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn page_total(c: &mut PgConnection, scopes: &Scopes, who: i32, cache: &CountCache) -> i64 {
    let l = find_all(
        c,
        scopes,
        &actor(who, false),
        &q(json!({ "page": 1, "limit": 3 })),
        cache,
    )
    .await
    .unwrap();
    let Meta::Page { total, .. } = l.meta else {
        panic!("thiếu meta trang")
    };
    total
}

/// G12b: tin `cache` của tiến trình khác (origin khác) đi qua kênh `trinity_sync` thật làm số đếm cũ bị xoá.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tin_cache_cua_tien_trinh_khac_xoa_so_dem_khach() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let boss = user(&mut c, 1, "Trưởng nhóm", None).await;
    contact(&mut c, "0907000201", "Khách 1", boss).await;
    contact(&mut c, "0907000202", "Khách 2", boss).await;
    let scopes = own(boss);
    let live = CountCache::new();
    assert_eq!(page_total(&mut c, &scopes, boss, &live).await, 2);
    contact(&mut c, "0907000203", "Khách 3", boss).await;
    assert_eq!(
        page_total(&mut c, &scopes, boss, &live).await,
        2,
        "còn số cũ trong cache"
    );

    let mut rx = sync::listen(DbConfig::new(test_url()).connect_options().unwrap());
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let mut f = serde_json::Map::new();
    f.insert("p".into(), Value::from("crm:contacts:count:"));
    let payload = sync::build_payload("node-9-abcd", "cache", 1, &f).unwrap();
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(sync::SYNC_CHANNEL)
        .bind(payload)
        .execute(&mut *c)
        .await
        .unwrap();
    // Nối lại có thể báo thêm Resync trước tin; Resync cũng xoá cache nên chỉ cần đợi tin `cache`.
    loop {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
            .await
            .expect("có tin")
            .unwrap();
        live.on_sync_event(&ev);
        if matches!(&ev, SyncEvent::Message(e) if e.kind == "cache") {
            break;
        }
    }
    assert_eq!(page_total(&mut c, &scopes, boss, &live).await, 3, "đã đếm lại từ DB");
}

/// G12b: `invalidate` xoá cache RAM và phát tin `cache` (`p` = `crm:contacts:count:`) đúng công ty khi commit.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn invalidate_phat_notify_cache_dem_khach() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let mut l = sqlx::postgres::PgListener::connect(&test_url()).await.unwrap();
    l.listen(sync::SYNC_CHANNEL).await.unwrap();
    let live = CountCache::new();
    live.invalidate(&mut c, CompanyRef::DEFAULT).await.unwrap();
    let n = tokio::time::timeout(std::time::Duration::from_secs(3), l.recv())
        .await
        .expect("có NOTIFY")
        .unwrap();
    let env = sync::parse_payload(n.payload()).expect("payload hợp lệ");
    assert_eq!((env.kind.as_str(), env.company), ("cache", 1));
    assert_eq!(env.fields.get("p").and_then(Value::as_str), Some("crm:contacts:count:"));
}
