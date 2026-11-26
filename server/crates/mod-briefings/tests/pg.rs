//! M23: bản tin trên Postgres thật. Cần DB riêng đã migrate bằng Prisma (bảng của test bị TRUNCATE):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-briefings --test pg -- --ignored --test-threads=1`

#![allow(clippy::type_complexity)] // bảng dữ liệu mẫu dạng bộ giá trị

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use mod_briefings::types::{Owners, ScopeKind, Slot};
use mod_briefings::{Error, Ports, RunDue};
use sqlx::{PgConnection, Row};
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};

fn at(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

/// 08:30 sáng thứ sáu 27/11/2026 giờ Việt Nam.
fn now() -> DateTime<Utc> {
    at("2026-11-27T01:30:00Z")
}

struct TestPorts {
    feature: AtomicBool,
}

impl TestPorts {
    fn new(feature: bool) -> Self {
        Self {
            feature: AtomicBool::new(feature),
        }
    }
}

impl Ports for TestPorts {
    async fn feature_on(&self, _conn: &mut PgConnection) -> bool {
        self.feature.load(Ordering::SeqCst)
    }
    async fn recipients(&self, _conn: &mut PgConnection) -> Vec<i32> {
        vec![4, 1, 2, 3, 2]
    }
    async fn owners_for(&self, _conn: &mut PgConnection, user_id: i32, _email: &str) -> Option<Owners> {
        match user_id {
            1 => Some(Owners::All),
            2 => Some(Owners::Users(vec![2])),
            3 => Some(Owners::Users(vec![3, 2])),
            _ => None,
        }
    }
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn setup() -> (Db, TenantDb) {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 4;
    let db = Db::connect(&cfg).await.expect("kết nối DB");
    let t = db.tenant(CompanyRef::new(1).unwrap()).await.unwrap();
    let mut c = t.acquire().await.unwrap();
    exec(
        &mut c,
        "TRUNCATE users, briefings, settings, contacts, deals, activities, kanban_boards, notification_logs, roles RESTART IDENTITY CASCADE",
    )
    .await;
    for (id, status) in [(1, "active"), (2, "active"), (3, "active"), (4, "inactive")] {
        sqlx::query("INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES ($1, $2, 'x', $3, $4, now())")
            .bind(id)
            .bind(format!("u{id}@example.com"))
            .bind(format!("Người {id}"))
            .bind(status)
            .execute(&mut *c)
            .await
            .unwrap();
    }
    drop(c);
    (db, t)
}

/// Dữ liệu số liệu cố định, cửa sổ của slot sáng tại [`now`]: kỳ này = ngày VN 26/11, kỳ trước = 25/11, lịch hẹn = 27/11.
async fn seed_metrics(t: &TenantDb) {
    let mut c = t.acquire().await.unwrap();
    // Khách: (phone, assigned_to, created_by_id, created_at, reminder_at, deleted)
    let contacts: [(&str, Option<i32>, Option<i32>, &str, Option<&str>, bool); 6] = [
        (
            "0900000001",
            Some(2),
            None,
            "2026-11-26T03:00:00Z",
            Some("2026-11-27T03:00:00Z"),
            false,
        ),
        ("0900000002", Some(2), None, "2026-11-26T05:00:00Z", None, false),
        (
            "0900000003",
            Some(3),
            None,
            "2026-11-26T06:00:00Z",
            Some("2026-11-27T03:00:00Z"),
            false,
        ),
        (
            "0900000004",
            Some(2),
            None,
            "2026-11-25T03:00:00Z",
            Some("2026-11-28T03:00:00Z"),
            false,
        ),
        ("0900000005", Some(3), None, "2026-11-26T07:00:00Z", None, true),
        ("0900000006", None, Some(2), "2026-11-26T08:00:00Z", None, false),
    ];
    for (phone, a, cb, created, rem, del) in contacts {
        sqlx::query(
            "INSERT INTO contacts (phone, assigned_to, created_by_id, created_at, reminder_at, deleted_at, updated_at)
             VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, CASE WHEN $6 THEN now() END, now())",
        )
        .bind(phone)
        .bind(a)
        .bind(cb)
        .bind(created)
        .bind(rem)
        .bind(del)
        .execute(&mut *c)
        .await
        .unwrap();
    }
    // Hoạt động: (action, contact_id, created_at)
    let acts: [(&str, Option<i32>, &str); 5] = [
        ("stage_change", Some(1), "2026-11-26T04:00:00Z"),
        ("stage_change", Some(3), "2026-11-26T04:00:00Z"),
        ("stage_change", Some(4), "2026-11-25T04:00:00Z"),
        ("stage_change", None, "2026-11-26T04:00:00Z"),
        ("note", Some(1), "2026-11-26T04:00:00Z"),
    ];
    for (action, contact, created) in acts {
        sqlx::query("INSERT INTO activities (action, contact_id, created_at) VALUES ($1, $2, $3::timestamptz)")
            .bind(action)
            .bind(contact)
            .bind(created)
            .execute(&mut *c)
            .await
            .unwrap();
    }
    // Deal: (status, assigned_to, value, won_at, updated_at, created_at)
    let deals: [(&str, i32, i64, Option<&str>, &str, &str); 6] = [
        (
            "won",
            2,
            1_000_000,
            Some("2026-11-26T04:00:00Z"),
            "2026-11-26T04:00:00Z",
            "2026-01-01T00:00:00Z",
        ),
        (
            "won",
            3,
            500_000,
            Some("2026-11-26T05:00:00Z"),
            "2026-11-26T05:00:00Z",
            "2026-01-01T00:00:00Z",
        ),
        ("won", 2, 250_000, None, "2026-11-26T06:00:00Z", "2026-01-01T00:00:00Z"),
        (
            "won",
            2,
            300_000,
            Some("2026-11-25T04:00:00Z"),
            "2026-11-25T04:00:00Z",
            "2026-11-25T03:00:00Z",
        ),
        ("lost", 3, 100_000, None, "2026-11-26T07:00:00Z", "2026-01-01T00:00:00Z"),
        ("open", 2, 900_000, None, "2026-11-26T08:00:00Z", "2026-11-26T08:00:00Z"),
    ];
    for (status, a, value, won, upd, created) in deals {
        sqlx::query(
            "INSERT INTO deals (title, status, assigned_to, created_by, value, won_at, updated_at, created_at)
             VALUES ('d', $1, $2, 1, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)",
        )
        .bind(status)
        .bind(a)
        .bind(value)
        .bind(won)
        .bind(upd)
        .bind(created)
        .execute(&mut *c)
        .await
        .unwrap();
    }
    exec(&mut c, "INSERT INTO kanban_boards (id, name) VALUES (1, 'b')").await;
    exec(
        &mut c,
        "INSERT INTO kanban_columns (id, board_id, name, position) VALUES (1, 1, 'c', 1)",
    )
    .await;
    // Việc: (assignee, due_at, completed_at, deleted_at)
    let cards: [(i32, &str, Option<&str>, Option<&str>); 5] = [
        (2, "2026-11-26T00:00:00Z", None, None),
        (3, "2026-11-26T00:00:00Z", None, None),
        (2, "2026-11-26T00:00:00Z", Some("2026-11-26T01:00:00Z"), None),
        (2, "2026-11-26T00:00:00Z", None, Some("2026-11-26T01:00:00Z")),
        (2, "2026-11-28T00:00:00Z", None, None),
    ];
    for (i, (assignee, due, done, del)) in cards.into_iter().enumerate() {
        sqlx::query(
            "INSERT INTO kanban_cards (board_id, column_id, position, title, created_by, assignee_id, due_at, completed_at, deleted_at)
             VALUES (1, 1, $1, 'k', 1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz)",
        )
        .bind(i as f64)
        .bind(assignee)
        .bind(due)
        .bind(done)
        .bind(del)
        .execute(&mut *c)
        .await
        .unwrap();
    }
}

fn tojson<T: serde::Serialize>(v: &T) -> serde_json::Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

fn status(e: Error) -> u16 {
    match e {
        Error::Http(h) => h.status(),
        Error::Internal(m) => panic!("lỗi nội bộ: {m}"),
    }
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn so_lieu_theo_pham_vi_quyen() {
    let (_db, t) = setup().await;
    seed_metrics(&t).await;
    let mut c = t.acquire().await.unwrap();

    let all = mod_briefings::aggregate::collect(&mut c, &Owners::All, Slot::Morning, now())
        .await
        .unwrap();
    assert_eq!(
        (all.scope, all.people_count, all.day.as_str()),
        (ScopeKind::Company, 3, "2026-11-27")
    );
    let m = &all.metrics;
    assert_eq!((m.new_contacts.value, m.new_contacts.prev), (4, 1));
    assert_eq!((m.stage_changes.value, m.stage_changes.prev), (3, 1));
    assert_eq!((m.deals_created.value, m.deals_created.prev), (1, 1));
    assert_eq!((m.deals_won.value, m.deals_won.prev), (3, 1));
    assert_eq!((m.won_value.value, m.won_value.prev), (1_750_000, 300_000));
    assert_eq!((m.deals_lost.value, m.deals_lost.prev), (1, 0));
    assert_eq!((m.overdue_tasks, m.callbacks), (2, 2));
    let top: Vec<(i32, &str, i64, i64)> = m
        .top_sellers
        .iter()
        .map(|s| (s.user_id, s.name.as_str(), s.won_count, s.won_value))
        .collect();
    assert_eq!(top, [(2, "Người 2", 2, 1_250_000), (3, "Người 3", 1, 500_000)]);

    let own = mod_briefings::aggregate::collect(&mut c, &Owners::Users(vec![2]), Slot::Morning, now())
        .await
        .unwrap();
    assert_eq!((own.scope, own.people_count), (ScopeKind::Own, 1));
    let m = &own.metrics;
    assert_eq!((m.new_contacts.value, m.new_contacts.prev), (3, 1));
    assert_eq!((m.stage_changes.value, m.stage_changes.prev), (1, 1));
    assert_eq!((m.deals_created.value, m.deals_created.prev), (1, 1));
    assert_eq!((m.deals_won.value, m.deals_won.prev), (2, 1));
    assert_eq!((m.won_value.value, m.won_value.prev), (1_250_000, 300_000));
    assert_eq!((m.deals_lost.value, m.deals_lost.prev), (0, 0));
    assert_eq!((m.overdue_tasks, m.callbacks), (1, 1));
    assert!(m.top_sellers.is_empty(), "một người thì không có bảng nổi bật");

    let team = mod_briefings::aggregate::collect(&mut c, &Owners::Users(vec![3, 2]), Slot::Morning, now())
        .await
        .unwrap();
    assert_eq!(
        (team.scope, team.people_count, team.metrics.top_sellers.len()),
        (ScopeKind::Team, 2, 2)
    );

    // Danh sách rỗng = không ai: toàn số 0, không tự nới thành cả công ty.
    let none = mod_briefings::aggregate::collect(&mut c, &Owners::Users(vec![]), Slot::Morning, now())
        .await
        .unwrap();
    assert_eq!(
        (none.people_count, none.metrics),
        (0, mod_briefings::types::Metrics::default())
    );

    // Slot chiều: kỳ này là hôm nay tới giờ (chưa có gì), kỳ trước = hôm qua cùng thời điểm (08:30 ngày 26: trước mốc dữ liệu 03:00Z? 01:30Z ngày 26 < 03:00Z).
    let eve = mod_briefings::aggregate::collect(&mut c, &Owners::All, Slot::Evening, now())
        .await
        .unwrap();
    assert_eq!(
        (eve.period_label.as_str(), eve.reminder_label.as_str()),
        ("hôm nay", "ngày mai")
    );
    assert_eq!(eve.metrics.new_contacts.value, 0);
    assert_eq!(
        eve.metrics.callbacks, 1,
        "lịch hẹn nhắc của ngày mai (28/11): khách thứ tư"
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn cau_hinh_doc_ghi_va_kiem_dau_vao() {
    let (_db, t) = setup().await;
    let ports = TestPorts::new(true);
    let r = mod_briefings::get_config(&t, &ports).await.unwrap();
    let v = tojson(&r);
    assert_eq!(
        v["config"],
        serde_json::json!({"enabled": false, "morning_enabled": true, "evening_enabled": true, "morning_time": "08:00", "evening_time": "17:30", "in_app": true})
    );
    assert_eq!(v["available"], serde_json::json!({"feature": true}));

    let c = mod_briefings::update_config(&t, &serde_json::json!({"enabled": true, "morning_time": "07:15"}), 1)
        .await
        .unwrap();
    assert!(c.enabled);
    assert_eq!((c.morning_time.as_str(), c.evening_time.as_str()), ("07:15", "17:30"));
    // Lưu bền và gộp dần.
    let c = mod_briefings::update_config(&t, &serde_json::json!({"in_app": false}), 2)
        .await
        .unwrap();
    assert_eq!((c.enabled, c.in_app, c.morning_time.as_str()), (true, false, "07:15"));
    let mut conn = t.acquire().await.unwrap();
    let by: Option<i32> = sqlx::query_scalar("SELECT updated_by FROM settings WHERE key = 'briefing_config'")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(by, Some(2));
    drop(conn);
    for bad in [
        serde_json::json!({"enabled": "yes"}),
        serde_json::json!({"morning_time": "7:15"}),
        serde_json::json!({"evening_time": 5}),
    ] {
        assert_eq!(
            status(mod_briefings::update_config(&t, &bad, 1).await.unwrap_err()),
            400
        );
    }
    // JSON hỏng trong settings ⇒ mặc định, không lỗi.
    let mut conn = t.acquire().await.unwrap();
    exec(
        &mut conn,
        "UPDATE settings SET value = '{khong-phai-json' WHERE key = 'briefing_config'",
    )
    .await;
    assert_eq!(
        mod_briefings::config::get(&mut conn).await,
        mod_briefings::types::Config::default()
    );
}

async fn count(t: &TenantDb, sql: &str) -> i64 {
    let mut c = t.acquire().await.unwrap();
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn gui_ban_tin_idempotent_thong_bao_va_xem() {
    let (_db, t) = setup().await;
    seed_metrics(&t).await;
    let ports = TestPorts::new(true);

    let r = mod_briefings::run_slot(&t, &ports, Slot::Morning, None, now())
        .await
        .unwrap();
    // 4 người nhận (trùng id gộp lại); người 4 bị khoá nên không có bản tin.
    assert_eq!((r.recipients, r.created, r.skipped), (4, 3, 0));
    assert_eq!(r.channels.get("in_app"), Some(&3));
    assert_eq!(count(&t, "SELECT count(*) FROM briefings").await, 3);
    let mut c = t.acquire().await.unwrap();
    let rows = sqlx::query(
        "SELECT recipient_id, event_type, title, body, action_url FROM notification_logs ORDER BY recipient_id",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].get::<String, _>("event_type"), "briefing.morning");
    assert!(rows[0].get::<String, _>("title").starts_with("Bản tin sáng 27/11 — "));
    assert!(
        rows[0]
            .get::<String, _>("body")
            .starts_with("Khách mới hôm qua: 4 (tăng 3 so với hôm trước).")
    );
    let b1: (i32, String, String) = sqlx::query_as("SELECT id, title, channels::text FROM briefings WHERE user_id = 1")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(b1.1, "Bản tin sáng 27/11 — Toàn công ty");
    assert_eq!(b1.2, "[\"in_app\"]");
    assert_eq!(
        rows[0].get::<Option<String>, _>("action_url"),
        Some(format!("/briefings?id={}", b1.0))
    );
    let titles: Vec<String> = sqlx::query_scalar("SELECT title FROM briefings ORDER BY user_id")
        .fetch_all(&mut *c)
        .await
        .unwrap();
    assert_eq!(titles[1], "Bản tin sáng 27/11 — Của riêng bạn");
    assert_eq!(titles[2], "Bản tin sáng 27/11 — Nhóm của bạn");
    drop(c);

    // Chạy lại: không gửi trùng.
    let r2 = mod_briefings::run_slot(&t, &ports, Slot::Morning, None, now())
        .await
        .unwrap();
    assert_eq!((r2.recipients, r2.created, r2.skipped), (1, 0, 3));
    assert_eq!(count(&t, "SELECT count(*) FROM briefings").await, 3);
    assert_eq!(count(&t, "SELECT count(*) FROM notification_logs").await, 3);
    // Slot chiều cùng ngày là bản tin khác.
    let r3 = mod_briefings::run_slot(&t, &ports, Slot::Evening, None, now())
        .await
        .unwrap();
    assert_eq!(r3.created, 3);

    // Xem: danh sách của chính mình (mới nhất trước), chi tiết người khác là 404.
    let list = mod_briefings::list(&t, 2).await.unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].slot.as_str(), list[1].slot.as_str()), ("evening", "morning"));
    let lv = tojson(&list[1]);
    assert_eq!(
        lv.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        ["id", "slot", "day", "title", "text", "channels", "created_at"]
    );
    let one = mod_briefings::one(&t, 2, list[1].id).await.unwrap();
    let ov = tojson(&one);
    assert_eq!(ov["data"]["scope"], "self");
    assert_eq!(
        ov["data"]["metrics"]["newContacts"],
        serde_json::json!({"value": 3, "prev": 1})
    );
    assert_eq!(status(mod_briefings::one(&t, 3, list[1].id).await.unwrap_err()), 404);
    assert_eq!(status(mod_briefings::one(&t, 2, 99_999).await.unwrap_err()), 404);
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn tat_in_app_thi_khong_thong_bao() {
    let (_db, t) = setup().await;
    seed_metrics(&t).await;
    let ports = TestPorts::new(true);
    mod_briefings::update_config(&t, &serde_json::json!({"in_app": false}), 1)
        .await
        .unwrap();
    let r = mod_briefings::run_slot(&t, &ports, Slot::Morning, None, now())
        .await
        .unwrap();
    assert_eq!((r.created, r.channels.len()), (3, 0));
    assert_eq!(count(&t, "SELECT count(*) FROM notification_logs").await, 0);
    assert_eq!(
        count(&t, "SELECT count(*) FROM briefings WHERE channels = '[]'::jsonb").await,
        3
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn job_chay_khi_bat_cong_tac_va_den_gio() {
    let (db, t) = setup().await;
    seed_metrics(&t).await;
    let ports = Arc::new(TestPorts::new(true));

    // Tắt mặc định.
    assert_eq!(
        mod_briefings::run_due(&t, ports.as_ref(), now()).await.unwrap(),
        RunDue::Skipped("config-off")
    );
    assert_eq!(count(&t, "SELECT count(*) FROM briefings").await, 0);
    mod_briefings::update_config(&t, &serde_json::json!({"enabled": true}), 1)
        .await
        .unwrap();
    // Cờ tính năng tắt.
    ports.feature.store(false, Ordering::SeqCst);
    assert_eq!(
        mod_briefings::run_due(&t, ports.as_ref(), now()).await.unwrap(),
        RunDue::Skipped("feature-off")
    );
    ports.feature.store(true, Ordering::SeqCst);
    // 08:30: chỉ slot sáng (08:00) tới giờ.
    let RunDue::Ran(runs) = mod_briefings::run_due(&t, ports.as_ref(), now()).await.unwrap() else {
        panic!("phải chạy")
    };
    assert_eq!(runs.len(), 1);
    assert_eq!((runs[0].slot, runs[0].created), (Slot::Morning, 3));
    // 13:00: hết thời gian bù của sáng (4 giờ), chưa tới 17:30.
    let RunDue::Ran(runs) = mod_briefings::run_due(&t, ports.as_ref(), at("2026-11-27T06:00:00Z"))
        .await
        .unwrap()
    else {
        panic!("phải chạy")
    };
    assert!(runs.is_empty());
    // 17:45: slot chiều.
    let RunDue::Ran(runs) = mod_briefings::run_due(&t, ports.as_ref(), at("2026-11-27T10:45:00Z"))
        .await
        .unwrap()
    else {
        panic!("phải chạy")
    };
    assert_eq!((runs.len(), runs[0].slot), (1, Slot::Evening));
    // Tắt từng slot.
    mod_briefings::update_config(
        &t,
        &serde_json::json!({"morning_enabled": false, "evening_enabled": false}),
        1,
    )
    .await
    .unwrap();
    let RunDue::Ran(runs) = mod_briefings::run_due(&t, ports.as_ref(), at("2026-11-28T01:30:00Z"))
        .await
        .unwrap()
    else {
        panic!("phải chạy")
    };
    assert!(runs.is_empty());

    // Hàm job do scheduler gọi cho từng công ty: chạy được và không lỗi.
    let spec = mod_briefings::job::job_spec(db.clone(), ports).unwrap();
    assert_eq!(spec.name, "briefings.run-due");
    (spec.run)(CompanyRef::new(1).unwrap()).await.unwrap();
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn run_now_va_preview_can_co_tinh_nang() {
    let (_db, t) = setup().await;
    seed_metrics(&t).await;
    let ports = TestPorts::new(false);
    assert_eq!(
        status(mod_briefings::run_now(&t, &ports, None, now()).await.unwrap_err()),
        403
    );
    assert_eq!(
        status(
            mod_briefings::preview(&t, &ports, 1, "u1@example.com", None, now())
                .await
                .unwrap_err()
        ),
        403
    );
    ports.feature.store(true, Ordering::SeqCst);
    assert_eq!(
        status(
            mod_briefings::run_now(&t, &ports, Some("noon"), now())
                .await
                .unwrap_err()
        ),
        400
    );
    // Mặc định theo giờ VN: 08:30 ⇒ sáng.
    let r = mod_briefings::run_now(&t, &ports, None, now()).await.unwrap();
    assert_eq!((r.slot, r.created), (Slot::Morning, 3));
    // Xem thử không lưu, không gửi; người không có phạm vi nhận null.
    let before = count(&t, "SELECT count(*) FROM notification_logs").await;
    let p = mod_briefings::preview(&t, &ports, 2, "u2@example.com", Some("evening"), now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!((p.data.slot, p.data.scope), (Slot::Evening, ScopeKind::Own));
    assert!(p.content.title.starts_with("Bản tin chiều 27/11"));
    assert!(
        mod_briefings::preview(&t, &ports, 9, "x@example.com", None, now())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&t, "SELECT count(*) FROM notification_logs").await, before);
    assert_eq!(
        count(&t, "SELECT count(*) FROM briefings WHERE slot = 'evening'").await,
        0
    );
    // Chiều theo giờ VN: 17:00 ⇒ evening.
    assert_eq!(mod_briefings::now_slot(at("2026-11-27T10:00:00Z")), Slot::Evening);
    assert_eq!(mod_briefings::now_slot(at("2026-11-27T04:59:00Z")), Slot::Morning);
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn danh_sach_nguoi_nhan_theo_quyen() {
    let (_db, t) = setup().await;
    let mut c = t.acquire().await.unwrap();
    exec(&mut c, "INSERT INTO roles (id, name, is_system) VALUES (1, 'Quản trị', true), (2, 'Xem báo cáo', false), (3, 'Khác', false)").await;
    exec(
        &mut c,
        "INSERT INTO role_permissions (role_id, permission) VALUES (2, 'reports.overview'), (3, 'contacts.view')",
    )
    .await;
    exec(
        &mut c,
        "INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (2, 2), (3, 3), (4, 2), (2, 3)",
    )
    .await;
    let ids = mod_briefings::roster_with_permission(&mut c, "reports.overview")
        .await
        .unwrap();
    assert_eq!(
        ids,
        [1, 2],
        "quản trị luôn có; vai trò có quyền; không có quyền thì không; người bị khoá thì không"
    );
}
