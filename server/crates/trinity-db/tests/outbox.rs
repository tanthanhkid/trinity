//! K36: cổng sự kiện tích hợp, thông báo dùng chung và kênh `trinity_sync` phía Rust.
//!
//! Cần Postgres với `public` đã migrate bằng Prisma, một DB riêng cho test này (bảng `integration_events`, `notification_logs`
//! bị TRUNCATE): `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test outbox -- --ignored --test-threads=1`
//!
//! So với bản Node: `fixtures/k36/expected.json` do `gen.cjs` sinh từ `publishIntegrationEvent` và `createMany` thật của Node
//! cho 10 kịch bản trong `scenarios.json`; test chạy cùng kịch bản bằng hàm Rust rồi so từng dòng.

use std::time::Duration;

use serde_json::{Map, Value};
use sqlx::postgres::PgListener;
use sqlx::{Connection, PgConnection, Row};
use trinity_db::outbox::{NewNotification, OutboxError, create_notification, publish_integration_event};
use trinity_db::sync::{self, SyncEvent};
use trinity_db::{CompanyRef, Db, DbConfig};

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn db() -> Db {
    let mut c = DbConfig::new(url());
    c.pool_size = 4;
    c.acquire_timeout = Duration::from_secs(5);
    Db::connect(&c).await.expect("kết nối DB")
}

async fn reset(c: &mut PgConnection) {
    sqlx::query("TRUNCATE integration_events, notification_logs RESTART IDENTITY CASCADE")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE email LIKE 'k36-%@example.com'")
        .execute(&mut *c)
        .await
        .unwrap();
}

/// `notification_logs.recipient_id` có FK tới `users`; DB test rỗng nên tạo người nhận tối thiểu.
async fn ensure_users(c: &mut PgConnection) {
    for id in [4, 6, 7, 8] {
        sqlx::query("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ($1, $2, 'x', 'Test', now()) ON CONFLICT (id) DO NOTHING")
            .bind(id)
            .bind(format!("k36-{id}@example.com"))
            .execute(&mut *c)
            .await
            .unwrap();
    }
}

async fn read_events(c: &mut PgConnection) -> Vec<Value> {
    sqlx::query(
        "SELECT event_type, resource, resource_id, payload::text AS payload, actor_user_id, dispatched_at IS NULL AS pending
         FROM integration_events ORDER BY id",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap()
    .iter()
    .map(|r| {
        serde_json::json!({
            "event_type": r.get::<String, _>("event_type"),
            "resource": r.get::<String, _>("resource"),
            "resource_id": r.get::<String, _>("resource_id"),
            "payload": r.get::<String, _>("payload"),
            "actor_user_id": r.get::<Option<i32>, _>("actor_user_id"),
            "pending": r.get::<bool, _>("pending"),
        })
    })
    .collect()
}

async fn read_notes(c: &mut PgConnection) -> Vec<Value> {
    sqlx::query(
        "SELECT recipient_id, event_type, channel, title, body, status, retry_count, is_read, action_url, sent_at IS NOT NULL AS sent
         FROM notification_logs ORDER BY id",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap()
    .iter()
    .map(|r| {
        serde_json::json!({
            "recipient_id": r.get::<i32, _>("recipient_id"),
            "event_type": r.get::<Option<String>, _>("event_type"),
            "channel": r.get::<String, _>("channel"),
            "title": r.get::<Option<String>, _>("title"),
            "body": r.get::<Option<String>, _>("body"),
            "status": r.get::<String, _>("status"),
            "retry_count": r.get::<i32, _>("retry_count"),
            "is_read": r.get::<bool, _>("is_read"),
            "action_url": r.get::<Option<String>, _>("action_url"),
            "sent": r.get::<bool, _>("sent"),
        })
    })
    .collect()
}

fn note(u: i32) -> NewNotification {
    NewNotification {
        recipient_id: u,
        event_type: "deal.assigned".into(),
        title: "T".into(),
        body: "B".into(),
        action_url: Some("/contacts".into()),
    }
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn muoi_kich_ban_giong_ban_node() {
    let db = db().await;
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/k36/scenarios.json")).unwrap();
    let expected: Value = serde_json::from_str(include_str!("fixtures/k36/expected.json")).unwrap();
    let mut admin = PgConnection::connect(&url()).await.unwrap();
    reset(&mut admin).await;
    ensure_users(&mut admin).await;
    let tenant = db.tenant(CompanyRef::DEFAULT).await.unwrap();

    let list = scenarios["scenarios"].as_array().unwrap();
    assert_eq!(list.len(), 10);
    for (s, exp) in list.iter().zip(expected["scenarios"].as_array().unwrap()) {
        let name = s["name"].as_str().unwrap();
        assert_eq!(exp["name"], s["name"]);
        let mut tx = tenant.begin().await.unwrap();
        if let Some(e) = s.get("event") {
            let id = &e["id"];
            let rid = id.as_str().map_or_else(|| id.to_string(), str::to_owned);
            publish_integration_event(
                &mut tx,
                e["type"].as_str().unwrap(),
                &e["payload"],
                rid,
                e["actor"].as_i64().map(|a| a as i32),
            )
            .await
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        }
        if let Some(n) = s.get("notify") {
            let items: Vec<NewNotification> = n
                .as_array()
                .unwrap()
                .iter()
                .map(|x| NewNotification {
                    recipient_id: x["recipient_id"].as_i64().unwrap() as i32,
                    event_type: x["event_type"].as_str().unwrap().to_owned(),
                    title: x["title"].as_str().unwrap().to_owned(),
                    body: x["body"].as_str().unwrap().to_owned(),
                    action_url: x["action_url"].as_str().map(str::to_owned),
                })
                .collect();
            let made = create_notification(&mut tx, &items)
                .await
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(made.len(), items.len(), "{name}");
            for (m, i) in made.iter().zip(&items) {
                assert_eq!(m.recipient_id, i.recipient_id, "{name}: thứ tự trả về theo đầu vào");
                assert_eq!(
                    (&m.title, &m.body, &m.action_url),
                    (&i.title, &i.body, &i.action_url),
                    "{name}: dữ liệu để đẩy socket nội bộ"
                );
            }
        }
        tx.commit().await.unwrap();
        assert_eq!(
            Value::Array(read_events(&mut admin).await),
            exp["events"],
            "{name}: integration_events"
        );
        assert_eq!(
            Value::Array(read_notes(&mut admin).await),
            exp["notifications"],
            "{name}: notification_logs"
        );
        sqlx::query("TRUNCATE integration_events, notification_logs RESTART IDENTITY CASCADE")
            .execute(&mut admin)
            .await
            .unwrap();
    }
    reset(&mut admin).await;
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn loai_la_bi_tu_choi_rollback_khong_de_lai_dong_va_dong_nam_trong_hang_doi_node() {
    let db = db().await;
    let tenant = db.tenant(CompanyRef::DEFAULT).await.unwrap();
    let mut admin = PgConnection::connect(&url()).await.unwrap();
    reset(&mut admin).await;
    let mut tx = tenant.begin().await.unwrap();
    let err = publish_integration_event(&mut tx, "khong.co", &Value::Null, 1, None)
        .await
        .unwrap_err();
    assert!(matches!(err, OutboxError::UnknownEvent(_)));
    tx.rollback().await.unwrap();

    let mut tx = tenant.begin().await.unwrap();
    publish_integration_event(
        &mut tx,
        "contact.created",
        &serde_json::json!({"contact": {"id": 1}}),
        1,
        Some(1),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert!(
        read_events(&mut admin).await.is_empty(),
        "rollback ⇒ không có sự kiện ảo"
    );

    // commit: dòng có `dispatched_at IS NULL` = đúng điều kiện `fetchPending` của bộ phát Node, nhặt ở lượt tick kế (10 giây)
    let mut tx = tenant.begin().await.unwrap();
    publish_integration_event(&mut tx, "deal.won", &serde_json::json!({"deal": {"id": 5}}), 5, None)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM integration_events WHERE dispatched_at IS NULL AND event_type = 'deal.won'",
    )
    .fetch_one(&mut admin)
    .await
    .unwrap();
    assert_eq!(n, 1);
    reset(&mut admin).await;
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn bell_chi_phat_khi_commit_dung_khuon_va_listener_loc_tin_cua_minh() {
    let db = db().await;
    let tenant = db.tenant(CompanyRef::DEFAULT).await.unwrap();
    let mut admin = PgConnection::connect(&url()).await.unwrap();
    reset(&mut admin).await;
    ensure_users(&mut admin).await;
    // Người nghe thô (thấy cả tin của chính tiến trình này) + `sync::listen` (đã lọc tin của mình)
    let mut raw = PgListener::connect(&url()).await.unwrap();
    raw.listen(sync::SYNC_CHANNEL).await.unwrap();
    let mut filtered = sync::listen(DbConfig::new(url()).connect_options().unwrap());
    tokio::time::sleep(Duration::from_millis(400)).await;

    let mut tx = tenant.begin().await.unwrap();
    create_notification(&mut tx, &[note(7)]).await.unwrap();
    tx.rollback().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), raw.recv())
            .await
            .is_err(),
        "rollback ⇒ không phát tin"
    );

    let t0 = std::time::Instant::now();
    let mut tx = tenant.begin().await.unwrap();
    let made = create_notification(&mut tx, &[note(7), note(6), note(7)])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let n = tokio::time::timeout(Duration::from_secs(2), raw.recv())
        .await
        .expect("có tin trong 2 giây")
        .unwrap();
    assert!(t0.elapsed() < Duration::from_secs(2));
    let e = sync::parse_payload(n.payload()).expect("đúng khuôn");
    assert_eq!(
        (e.kind.as_str(), e.company, e.origin.as_str()),
        ("bell", 1, sync::origin())
    );
    assert_eq!(
        e.fields["u"],
        serde_json::json!([7, 6]),
        "người nhận khử trùng, giữ thứ tự"
    );
    assert_eq!(
        e.fields["n"],
        serde_json::json!(made.iter().map(|m| m.id).collect::<Vec<_>>())
    );
    // dòng đọc được từ DB theo id (bên nhận đọc nội dung từ DB)
    let ids: Vec<i32> = made.iter().map(|m| m.id).collect();
    let cnt: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_logs WHERE id = ANY($1)")
        .bind(&ids)
        .fetch_one(&mut admin)
        .await
        .unwrap();
    assert_eq!(cnt, 3);
    // tin do chính mình phát bị lọc
    assert!(
        tokio::time::timeout(Duration::from_millis(300), filtered.recv())
            .await
            .is_err()
    );

    // tin từ "tiến trình khác" (origin khác) tới được người nghe đã lọc
    let mut f = Map::new();
    f.insert("ids".into(), Value::from("*"));
    let payload = sync::build_payload("node-1-abcd", "rbac", 1, &f).unwrap();
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(sync::SYNC_CHANNEL)
        .bind(payload)
        .execute(&mut admin)
        .await
        .unwrap();
    match tokio::time::timeout(Duration::from_secs(2), filtered.recv())
        .await
        .unwrap()
        .unwrap()
    {
        SyncEvent::Message(e) => assert_eq!((e.origin.as_str(), e.kind.as_str()), ("node-1-abcd", "rbac")),
        SyncEvent::Resync => panic!("không phải resync"),
    }
    reset(&mut admin).await;
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn bell_nhieu_nguoi_chia_lo_duoi_gioi_han() {
    let mut raw = PgListener::connect(&url()).await.unwrap();
    raw.listen(sync::SYNC_CHANNEL).await.unwrap();
    let users: Vec<i32> = (1..=450).collect();
    let ids: Vec<i32> = (100_000..100_450).collect();
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let mut tx = c.begin().await.unwrap();
    sync::publish_bell_in_tx(&mut tx, 3, &users, &ids).await.unwrap();
    tx.commit().await.unwrap();
    let mut total = 0;
    for _ in 0..3 {
        let n = tokio::time::timeout(Duration::from_secs(2), raw.recv())
            .await
            .expect("đủ 3 lô")
            .unwrap();
        assert!(n.payload().len() < sync::SYNC_MAX_BYTES);
        let e = sync::parse_payload(n.payload()).unwrap();
        assert_eq!((e.kind.as_str(), e.company), ("bell", 3));
        assert!(e.fields["u"].as_array().unwrap().len() <= sync::BELL_CHUNK);
        total += e.fields["n"].as_array().unwrap().len();
    }
    assert_eq!(total, 450);
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn mat_ket_noi_nghe_thi_gui_resync_va_van_nhan_tin_sau_do() {
    let mut admin = PgConnection::connect(&url()).await.unwrap();
    let mut rx = sync::listen(DbConfig::new(url()).connect_options().unwrap());
    tokio::time::sleep(Duration::from_millis(500)).await;
    // cắt kết nối nghe (kết nối riêng của listener, application_name mặc định của sqlx)
    let killed: i64 = sqlx::query_scalar(
        "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'LISTEN%trinity_sync%'",
    )
    .fetch_one(&mut admin)
    .await
    .unwrap();
    assert!(killed >= 1, "phải có kết nối đang LISTEN");
    let ev = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("có Resync")
        .unwrap();
    assert_eq!(ev, SyncEvent::Resync);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let payload = sync::build_payload("node-9-abcd", "cache", 1, &Map::new()).unwrap();
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(sync::SYNC_CHANNEL)
        .bind(payload)
        .execute(&mut admin)
        .await
        .unwrap();
    match tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap()
    {
        SyncEvent::Message(e) => assert_eq!(e.kind, "cache"),
        SyncEvent::Resync => {
            // nối lại có thể báo thêm một Resync trước tin: chấp nhận, rồi phải thấy tin
            match tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                SyncEvent::Message(e) => assert_eq!(e.kind, "cache"),
                SyncEvent::Resync => panic!("không thấy tin sau khi nối lại"),
            }
        }
    }
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn bo_receiver_thi_ket_noi_nghe_dong_lai() {
    let mut admin = PgConnection::connect(&url()).await.unwrap();
    let before = listeners(&mut admin).await;
    let rx = sync::listen(DbConfig::new(url()).connect_options().unwrap());
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(listeners(&mut admin).await, before + 1);
    drop(rx);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        listeners(&mut admin).await,
        before,
        "task dừng và nhả kết nối khi receiver bị bỏ"
    );
}

async fn listeners(c: &mut PgConnection) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%trinity_sync%'")
        .fetch_one(c)
        .await
        .unwrap()
}
