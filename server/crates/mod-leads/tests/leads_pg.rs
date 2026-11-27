//! M24: chấm điểm khách và nhắc việc treo trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-leads --test leads_pg -- --ignored`

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use mod_leads::lead::{self, RunOutcome};
use mod_leads::stale::{self, DEFAULT_CONFIG};
use mod_leads::{Features, jobs};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_kernel::error::{AppError, Message};
use trinity_rbac::OwnerIds;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Flags(AtomicBool);

impl Features for Flags {
    async fn enabled(&self, _conn: &mut PgConnection, _key: &str) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

async fn connect() -> Db {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 4;
    Db::connect(&cfg).await.expect("nối DB")
}

async fn tenant() -> TenantDb {
    connect().await.tenant(CompanyRef::DEFAULT).await.expect("tenant")
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
        "DELETE FROM kanban_cards WHERE title LIKE 'M24 %'",
        "DELETE FROM kanban_boards WHERE name LIKE 'M24 %'",
        "DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE '0924%')",
        "DELETE FROM deals WHERE title LIKE 'M24 %'",
        "DELETE FROM lead_ai_intents WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE '0924%')",
        "DELETE FROM contacts WHERE phone LIKE '0924%'",
        "DELETE FROM notification_logs WHERE event_type = 'stale_work.digest'",
        "DELETE FROM settings WHERE key IN ('lead_scoring_rules', 'lead_scoring_outbox_cursor', 'stale_work_config', 'stale_work_last_digest')",
        "DELETE FROM integration_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE 'm24%@test.local')",
        "DELETE FROM users WHERE email LIKE 'm24%@test.local'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

async fn user(c: &mut PgConnection, n: u8, name: &str, manager: Option<i32>) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, manager_id, updated_at) VALUES ($1, 'x', $2, $3, now()) RETURNING id",
    )
    .bind(format!("m24{n}@test.local"))
    .bind(name)
    .bind(manager)
    .fetch_one(c)
    .await
    .unwrap()
}

/// Khách tạo cách đây `age_days` ngày.
async fn contact(c: &mut PgConnection, phone: &str, owner: i32, age_days: i64) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, created_at, updated_at)
         VALUES ($1, $1, $2, $2, now() - ($3 || ' days')::interval, now()) RETURNING id",
    )
    .bind(phone)
    .bind(owner)
    .bind(age_days.to_string())
    .fetch_one(c)
    .await
    .unwrap()
}

async fn ts(c: &mut PgConnection, sql: &'static str, id: i32) -> Option<DateTime<Utc>> {
    sqlx::query_scalar(sql).bind(id).fetch_one(c).await.unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn cham_diem_quy_tac_tung_khach_outbox_va_job() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let a = user(&mut c, 1, "Sale A", None).await;
    let b = user(&mut c, 2, "Sale B", None).await;
    let now = Utc::now();

    // Quy tắc: mặc định khi chưa lưu; lưu rác ⇒ chuẩn hoá về mặc định theo trường.
    let r0 = lead::rules_response(&mut c, false).await.unwrap();
    assert_eq!(js(&r0.rules), js(&r0.defaults));
    let saved = lead::save_rules(
        &mut c,
        &json!({ "thresholds": { "hot": 90, "warm": 50 }, "stage": "rác" }),
        a,
    )
    .await
    .unwrap();
    assert_eq!((saved.thresholds.hot, saved.thresholds.warm), (90.0, 50.0));
    assert_eq!(lead::get_rules(&mut c).await.unwrap(), saved);
    lead::save_rules(&mut c, &json!({}), a).await.unwrap();

    // Chấm một khách: tương tác thật được đếm, hoạt động hệ thống thì không; ghi vào cột mà KHÔNG đổi updated_at.
    let mine = contact(&mut c, "0924000101", a, 1).await;
    let theirs = contact(&mut c, "0924000102", b, 1).await;
    for _ in 0..3 {
        sqlx::query("INSERT INTO activities (contact_id, action, created_by) VALUES ($1, 'note', $2)")
            .bind(mine)
            .bind(a)
            .execute(&mut *c)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO activities (contact_id, action, created_by) VALUES ($1, 'stage_change', $2)")
        .bind(mine)
        .bind(a)
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("INSERT INTO lead_ai_intents (contact_id, intent, updated_at) VALUES ($1, 1, now())")
        .bind(mine)
        .execute(&mut *c)
        .await
        .unwrap();
    let before = ts(&mut c, "SELECT updated_at FROM contacts WHERE id = $1", mine).await;
    let view_a = Some(OwnerIds::Ids(vec![a]));
    let scored = js(&lead::recompute_one(&mut c, view_a.as_ref(), mine, now).await.unwrap());
    let reasons = scored["lead_score_reasons"].as_array().unwrap();
    let pts = |k: &str| reasons.iter().find(|r| r["key"] == k).map(|r| r["points"].clone());
    assert_eq!(
        pts("interactions"),
        Some(json!(12)),
        "3 tương tác thật × 4, stage_change không tính"
    );
    assert_eq!(pts("ai_intent"), Some(json!(10)));
    assert_eq!(pts("profile"), Some(json!(5)));
    let score = scored["lead_score"].as_i64().unwrap();
    assert!(score > 0);
    let label = if score >= 70 {
        "hot"
    } else if score >= 40 {
        "warm"
    } else {
        "cold"
    };
    assert_eq!(scored["lead_label"].as_str(), Some(label));
    assert_eq!(
        before,
        ts(&mut c, "SELECT updated_at FROM contacts WHERE id = $1", mine).await,
        "không nhảy updated_at"
    );
    // Ngoài phạm vi ⇒ 404; không có ⇒ 404.
    assert_eq!(
        err(lead::recompute_one(&mut c, view_a.as_ref(), theirs, now)
            .await
            .unwrap_err())
        .0,
        404
    );
    assert_eq!(
        err(lead::recompute_one(&mut c, view_a.as_ref(), 999_999, now)
            .await
            .unwrap_err())
        .0,
        404
    );

    // Chấm lại khách chưa chấm: `theirs` được chấm.
    assert!(lead::rescore_stale(&mut c, 500, now).await.unwrap() >= 1);
    assert!(
        ts(&mut c, "SELECT lead_scored_at FROM contacts WHERE id = $1", theirs)
            .await
            .is_some()
    );

    // Outbox: lần đầu chỉ đặt con trỏ; sự kiện sau đó chấm khách liên quan và đẩy con trỏ.
    assert_eq!(lead::consume_outbox(&mut c, 500, now).await.unwrap(), 0);
    let cur: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'lead_scoring_outbox_cursor'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    let fresh = contact(&mut c, "0924000103", a, 0).await;
    sqlx::query("INSERT INTO integration_events (event_type, resource, resource_id, payload, actor_user_id) VALUES ('contact.created', 'contact', $1, '{}'::jsonb, $2)")
        .bind(fresh.to_string())
        .bind(a)
        .execute(&mut *c)
        .await
        .unwrap();
    assert_eq!(lead::consume_outbox(&mut c, 500, now).await.unwrap(), 1);
    assert!(
        ts(&mut c, "SELECT lead_scored_at FROM contacts WHERE id = $1", fresh)
            .await
            .is_some(),
        "khách vừa tạo được chấm từ sự kiện outbox"
    );
    let cur2: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'lead_scoring_outbox_cursor'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(cur2.parse::<i64>().unwrap() > cur.parse::<i64>().unwrap());
    assert_eq!(
        lead::consume_outbox(&mut c, 500, now).await.unwrap(),
        0,
        "không đọc lại sự kiện cũ"
    );

    // Job: cờ tổ chức tắt ⇒ bỏ qua; bật ⇒ chạy; khai báo job dựng được.
    let flags = Flags(AtomicBool::new(false));
    assert_eq!(
        lead::run_once(&mut c, &flags, now).await.unwrap(),
        RunOutcome::Skipped("org-flag-off")
    );
    flags.0.store(true, Ordering::SeqCst);
    assert!(matches!(
        lead::run_once(&mut c, &flags, now).await.unwrap(),
        RunOutcome::Ran(_)
    ));
    assert!(jobs::lead_spec(connect().await, std::sync::Arc::new(Flags(AtomicBool::new(true)))).is_ok());
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn viec_treo_quet_thong_ke_va_tong_hop_nguyen_tu() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let boss = user(&mut c, 1, "Trưởng phòng", None).await;
    let lead_u = user(&mut c, 2, "Trưởng nhóm", Some(boss)).await;
    let sale = user(&mut c, 3, "Sale", Some(lead_u)).await;
    let now = Utc::now();

    // Cấu hình: mặc định; lưu rác ⇒ về mặc định theo trường.
    assert_eq!(stale::get_config(&mut c).await.unwrap(), DEFAULT_CONFIG);
    let cfg = stale::save_config(&mut c, &json!({ "contact_days": 3, "digest_hour": 99 }), boss)
        .await
        .unwrap();
    assert_eq!((cfg.contact_days, cfg.digest_hour), (3, 8));
    stale::save_config(&mut c, &json!({ "contact_days": 3, "digest_hour": 0 }), boss)
        .await
        .unwrap();

    // Dữ liệu của Sale: khách im lặng 10 ngày (tính; stage_change không phải liên hệ), khách có ghi chú 1 giờ trước (không),
    // khách mới (không); deal mở không đổi 20 ngày (tính); việc quá hạn (tính); lịch hẹn lỡ của khách im lặng (tính).
    let silent = contact(&mut c, "0924000201", sale, 10).await;
    let touched = contact(&mut c, "0924000202", sale, 10).await;
    contact(&mut c, "0924000203", sale, 1).await;
    sqlx::query("INSERT INTO activities (contact_id, action, created_by, created_at) VALUES ($1, 'note', $2, now() - interval '1 hour')")
        .bind(touched)
        .bind(sale)
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("INSERT INTO activities (contact_id, action, created_by, created_at) VALUES ($1, 'stage_change', $2, now() - interval '1 day')")
        .bind(silent)
        .bind(sale)
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("INSERT INTO deals (title, status, assigned_to, created_by, contact_id, updated_at) VALUES ('M24 deal treo', 'open', $1, $1, NULL, now() - interval '20 days')")
        .bind(sale)
        .execute(&mut *c)
        .await
        .unwrap();
    let board: i32 = sqlx::query_scalar("INSERT INTO kanban_boards (name) VALUES ('M24 board') RETURNING id")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    let col: i32 =
        sqlx::query_scalar("INSERT INTO kanban_columns (board_id, name, position) VALUES ($1, 'Todo', 1) RETURNING id")
            .bind(board)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    sqlx::query("INSERT INTO kanban_cards (board_id, column_id, position, title, created_by, assignee_id, due_at) VALUES ($1, $2, 1, 'M24 quá hạn', $3, $3, now() - interval '1 day')")
        .bind(board)
        .bind(col)
        .bind(sale)
        .execute(&mut *c)
        .await
        .unwrap();
    for id in [touched, silent] {
        sqlx::query("UPDATE contacts SET reminder_at = now() - interval '5 hours' WHERE id = $1")
            .bind(id)
            .execute(&mut *c)
            .await
            .unwrap();
    }

    let sum = stale::summary_for(&mut c, sale, now).await.unwrap();
    // `touched` có ghi chú SAU giờ hẹn ⇒ không tính lỡ; `silent` thì có.
    assert_eq!(
        js(&sum.own),
        json!({ "silent_contacts": 1, "silent_deals": 1, "overdue_tasks": 1, "missed_reminders": 1 }),
        "{:?}",
        sum.own
    );
    assert_eq!(sum.team.total(), 0, "Sale không có cấp dưới");
    let lead_sum = stale::summary_for(&mut c, lead_u, now).await.unwrap();
    assert_eq!(lead_sum.own.total(), 0);
    assert_eq!(lead_sum.team, sum.own, "Trưởng nhóm thấy việc của cấp dưới");
    assert_eq!(
        stale::summary_for(&mut c, boss, now).await.unwrap().team,
        sum.own,
        "Trưởng phòng thấy cả cây"
    );

    // Người nhận = chủ việc + mọi cấp trên.
    let mut who: Vec<i32> = stale::build_digests(&mut c, now)
        .await
        .unwrap()
        .iter()
        .map(|d| d.recipient_id)
        .collect();
    who.sort_unstable();
    assert_eq!(who, [boss, lead_u, sale]);
    drop(c);

    let flags = Flags(AtomicBool::new(false));
    let off = stale::run_once(&db, &flags, now, false).await.unwrap();
    assert_eq!((off.result.sent, off.result.skipped), (0, Some("org-flag-off")));
    flags.0.store(true, Ordering::SeqCst);

    // Chưa tới giờ gửi (23 giờ, bây giờ 00:30 giờ Việt Nam) ⇒ bỏ qua.
    {
        let mut c = db.acquire().await.unwrap();
        stale::save_config(&mut c, &json!({ "contact_days": 3, "digest_hour": 23 }), boss)
            .await
            .unwrap();
    }
    let early: DateTime<Utc> = "2026-11-27T17:30:00Z".parse().unwrap();
    assert_eq!(
        stale::run_once(&db, &flags, early, false).await.unwrap().result.skipped,
        Some("chua-den-gio")
    );
    {
        let mut c = db.acquire().await.unwrap();
        stale::save_config(&mut c, &json!({ "contact_days": 3, "digest_hour": 0 }), boss)
            .await
            .unwrap();
    }

    // Hai lượt chạy song song cùng ngày: đúng một bên gửi (nhận lượt nguyên tử), bên kia "da-gui-hom-nay".
    let (r1, r2) = tokio::join!(
        stale::run_once(&db, &flags, now, false),
        stale::run_once(&db, &flags, now, false)
    );
    let (r1, r2) = (r1.unwrap(), r2.unwrap());
    assert_eq!(r1.result.sent + r2.result.sent, 3, "{:?} {:?}", r1.result, r2.result);
    assert!([r1.result.skipped, r2.result.skipped].contains(&Some("da-gui-hom-nay")));
    let winner = if r1.result.sent == 3 { &r1 } else { &r2 };
    assert!(winner.notifications.iter().all(|n| n.event_type == "stale_work.digest"));
    let sale_n = winner.notifications.iter().find(|n| n.recipient_id == sale).unwrap();
    assert_eq!(sale_n.action_url.as_deref(), Some("/contacts"));
    assert!(
        sale_n.body.starts_with("Của bạn: 1 khách im lặng quá 3 ngày"),
        "{}",
        sale_n.body
    );
    let boss_n = winner.notifications.iter().find(|n| n.recipient_id == boss).unwrap();
    assert!(boss_n.body.starts_with("Nhóm của bạn:"), "{}", boss_n.body);
    let mut c = db.acquire().await.unwrap();
    let logs: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_logs WHERE event_type = 'stale_work.digest'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(logs, 3);
    drop(c);
    // Lượt thường tiếp theo vẫn bỏ qua; chạy tay (force) gửi lại.
    assert_eq!(
        stale::run_once(&db, &flags, now, false).await.unwrap().result.skipped,
        Some("da-gui-hom-nay")
    );
    assert_eq!(stale::run_once(&db, &flags, now, true).await.unwrap().result.sent, 3);
}
