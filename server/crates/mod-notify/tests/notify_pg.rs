//! M32 trên Postgres thật (`public` đã migrate bằng Prisma, như job Rust pg tests):
//! `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-notify --test notify_pg -- --ignored`

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use mod_notify::delivery::{BoxFuture, Deliverer, InAppSink, WebhookPoster};
use mod_notify::events::{PayslipApproved, WsEmitItem, emit_ws_notifications, on_payslip_approved};
use mod_notify::notifications::{
    Category, Channel, SendNotification, find_by_user, mark_as_read, process_scheduled, reap_stuck_processing, send,
    unread_count,
};
use mod_notify::templates::{self, CreateTemplate, UpdateTemplate};
use serde_json::json;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_http::outbound::ssrf::SsrfPolicy;
use trinity_kernel::error::{AppError, Message};
use trinity_realtime::NotificationPayload;

const U1: i32 = 90_001;
const U2: i32 = 90_002;

#[derive(Default)]
struct Sink {
    sent: Mutex<Vec<(i64, NotificationPayload)>>,
    refreshed: Mutex<Vec<(i64, i64)>>,
}

impl InAppSink for Sink {
    fn send<'a>(&'a self, _c: i64, user: i64, p: &'a NotificationPayload) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.sent.lock().unwrap().push((user, p.clone())) })
    }

    fn refresh_unread<'a>(&'a self, c: i64, user: i64) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.refreshed.lock().unwrap().push((c, user)) })
    }
}

/// Trả lần lượt các mã HTTP đã cài (hết thì 200) và ghi lại các lần gọi.
#[derive(Default)]
struct Poster {
    codes: Mutex<Vec<u16>>,
    calls: Mutex<Vec<(String, String)>>,
    delay: Mutex<Duration>,
}

impl WebhookPoster for Poster {
    fn post<'a>(&'a self, url: &'a str, payload: String) -> BoxFuture<'a, Result<u16, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((url.to_owned(), payload));
            let delay = *self.delay.lock().unwrap();
            tokio::time::sleep(delay).await;
            let mut c = self.codes.lock().unwrap();
            Ok(if c.is_empty() { 200 } else { c.remove(0) })
        })
    }
}

/// Các test dùng chung người dùng và dòng thử, chạy lần lượt.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn setup() -> (
    tokio::sync::MutexGuard<'static, ()>,
    TenantDb,
    Deliverer,
    Arc<Sink>,
    Arc<Poster>,
) {
    let guard = SERIAL.lock().await;
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 4;
    let t = Db::connect(&cfg)
        .await
        .unwrap()
        .tenant(CompanyRef::DEFAULT)
        .await
        .unwrap();
    let (sink, poster) = (Arc::new(Sink::default()), Arc::new(Poster::default()));
    let mut d = Deliverer::new(sink.clone(), poster.clone(), SsrfPolicy::default());
    d.retry_unit = Duration::ZERO;
    clean(&t).await;
    add_users(&t).await;
    (guard, t, d, sink, poster)
}

async fn clean(t: &TenantDb) {
    let mut c = t.acquire().await.unwrap();
    sqlx::query("DELETE FROM notification_logs WHERE recipient_id IN ($1, $2)")
        .bind(U1)
        .bind(U2)
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM notification_templates WHERE name LIKE 'm32\\_%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id IN ($1, $2)")
        .bind(U1)
        .bind(U2)
        .execute(&mut *c)
        .await
        .unwrap();
}

/// `notification_logs.recipient_id` có khoá ngoại tới `users`.
async fn add_users(t: &TenantDb) {
    let mut c = t.acquire().await.unwrap();
    for id in [U1, U2] {
        sqlx::query(
            "INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES ($1, $2, 'x', 'M32', now())",
        )
        .bind(id)
        .bind(format!("m32_{id}@test.local"))
        .execute(&mut *c)
        .await
        .unwrap();
    }
}

fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

/// 03:00Z = 10:00 giờ Việt Nam (trong giờ hành chính).
const BUSY: &str = "2026-11-26T03:00:00Z";

fn dto(user: i32, channel: Channel) -> SendNotification {
    serde_json::from_value(json!({"user_id": user, "channel": channel, "title": "Tiêu đề", "body": "Nội dung"}))
        .unwrap()
}

fn err(e: AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    match b.message {
        Message::One(m) => (s, m),
        Message::Many(m) => (s, m.join("; ")),
    }
}

async fn row(t: &TenantDb, id: i32) -> (String, i32, Option<String>, Option<String>) {
    let mut c = t.acquire().await.unwrap();
    sqlx::query_as("SELECT status, retry_count, error, webhook_url FROM notification_logs WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn mau_thong_bao() {
    let (_g, t, d, ..) = setup().await;
    let _ = &d;
    let mut c = t.acquire().await.unwrap();
    let mk = |v: serde_json::Value| -> CreateTemplate { serde_json::from_value(v).unwrap() };
    let a = templates::create(
        &mut c,
        &mk(json!({"name": "m32_a", "event_type": "m32.ev", "channel": "in_app", "subject": "Deal {{name}}", "body": "Chào {{name}} {{#if vip}}VIP{{/if}}", "recipients_rule": {"fields": ["x"]}})),
    )
    .await
    .unwrap();
    assert!(a.is_active && a.recipients_rule.is_some());
    let j: serde_json::Value = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
    let keys: Vec<_> = j.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "name",
            "event_type",
            "channel",
            "subject",
            "body",
            "recipients_rule",
            "is_active",
            "created_at",
            "updated_at"
        ]
    );

    // Cú pháp hỏng hoặc helper lạ ⇒ 400, không ghi.
    for bad in ["{{#if a}}thiếu", "{{eq a b}}"] {
        let e = templates::create(
            &mut c,
            &mk(json!({"name": "m32_bad", "event_type": "e", "channel": "push", "body": bad})),
        )
        .await
        .unwrap_err();
        let (s, m) = err(e);
        assert_eq!(s, 400);
        assert!(m.starts_with("Cú pháp template không hợp lệ: "), "{m}");
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_templates WHERE name = 'm32_bad'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // PATCH: subject null xoá, recipients_rule null xoá, vắng giữ nguyên; cú pháp mới được kiểm.
    let u = templates::update(
        &mut c,
        a.id,
        &serde_json::from_value::<UpdateTemplate>(json!({"subject": null, "recipients_rule": null})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        (u.subject.clone(), u.recipients_rule.is_none(), u.body.as_str()),
        (None, true, "Chào {{name}} {{#if vip}}VIP{{/if}}")
    );
    let e = templates::update(
        &mut c,
        a.id,
        &serde_json::from_value::<UpdateTemplate>(json!({"body": "{{foo bar}}"})).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(err(e).0, 400);
    let u = templates::update(
        &mut c,
        a.id,
        &serde_json::from_value::<UpdateTemplate>(json!({"is_active": false, "channel": "webhook"})).unwrap(),
    )
    .await
    .unwrap();
    assert!(!u.is_active && u.channel == "webhook");
    assert_eq!(
        err(templates::update(&mut c, i32::MAX, &UpdateTemplate::default())
            .await
            .unwrap_err()),
        (404, format!("Template #{} khong ton tai", i32::MAX))
    );
    assert!(templates::find_all(&mut c).await.unwrap().iter().any(|x| x.id == a.id));
    drop(c);

    // render theo id và theo (event_type, kênh) (mẫu đang tắt thì không dùng).
    let b = templates::create(
        &mut t.acquire().await.unwrap(),
        &mk(json!({"name": "m32_b", "event_type": "m32.ev2", "channel": "in_app", "subject": "Tiêu đề {{x}}", "body": "<{{x}}> {{{x}}}"})),
    )
    .await
    .unwrap();
    let r = templates::render(&t, b.id, &json!({"x": "a&b"})).await.unwrap();
    assert_eq!(
        (r.subject.as_deref(), r.body.as_str()),
        (Some("Tiêu đề a&amp;b"), "<a&amp;b> a&b")
    );
    let r = templates::render_by_event_type(&t, "m32.ev2", Channel::InApp, &json!({"x": 1}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.body, "<1> 1");
    assert!(
        templates::render_by_event_type(&t, "m32.ev2", Channel::Push, &json!({}))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        templates::render_by_event_type(&t, "m32.ev", Channel::Webhook, &json!({}))
            .await
            .unwrap()
            .is_none(),
        "mẫu tắt"
    );
    let mut c = t.acquire().await.unwrap();
    templates::remove(&mut c, b.id).await.unwrap();
    assert_eq!(err(templates::remove(&mut c, b.id).await.unwrap_err()).0, 404);
    clean(&t).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn gui_thong_bao_va_kenh() {
    let (_g, t, d, sink, poster) = setup().await;

    // In-app trong giờ hành chính: sent, đẩy socket, làm mới số đếm.
    let mut m = dto(U1, Channel::InApp);
    m.event_type = Some("m32.test".into());
    m.entity_id = Some(7);
    m.action_url = Some("/x".into());
    let r = send(&t, &d, &m, at(BUSY)).await.unwrap();
    assert_eq!(r.status, "sent");
    assert_eq!(row(&t, r.id).await.0, "sent");
    {
        let s = sink.sent.lock().unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(
            (s[0].0, s[0].1.id, s[0].1.channel.as_str(), s[0].1.action_url.as_deref()),
            (i64::from(U1), Some(r.id), "in_app", Some("/x"))
        );
    }
    assert_eq!(sink.refreshed.lock().unwrap().len(), 1);
    // Cùng nội dung trong 5 phút = trùng.
    let dup = send(&t, &d, &m, at(BUSY)).await.unwrap();
    assert_eq!((dup.id, dup.status.as_str()), (0, "deduplicated"));
    // Không có entity_id thì không dedup.
    m.entity_id = None;
    assert_ne!(send(&t, &d, &m, at(BUSY)).await.unwrap().id, 0);

    // event_type rỗng không dedup (falsy như bản TS).
    let mut e = dto(U1, Channel::InApp);
    e.event_type = Some(String::new());
    e.entity_id = Some(9);
    let a = send(&t, &d, &e, at(BUSY)).await.unwrap();
    let b = send(&t, &d, &e, at(BUSY)).await.unwrap();
    assert!(a.id != 0 && b.id != 0 && a.id != b.id);

    // scheduled_at sai dạng ⇒ 400 và không ghi dòng nào; các dạng ISO hợp lệ được nhận.
    let rows_before: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_logs WHERE recipient_id = $1")
        .bind(U1)
        .fetch_one(&mut *t.acquire().await.unwrap())
        .await
        .unwrap();
    let mut bad = dto(U1, Channel::InApp);
    bad.scheduled_at = Some("ngày mai".into());
    assert_eq!(
        err(send(&t, &d, &bad, at(BUSY)).await.unwrap_err()),
        (400, "scheduled_at must be a valid ISO 8601 date string".into())
    );
    let rows_after: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_logs WHERE recipient_id = $1")
        .bind(U1)
        .fetch_one(&mut *t.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(rows_before, rows_after);
    for (s, want) in [
        ("2026-12-01", "2026-12-01T00:00:00Z"),
        ("2026-12-01T17:00:00", "2026-12-01T17:00:00Z"),
        ("2026-12-01T17:00:00+0700", "2026-12-01T10:00:00Z"),
        ("2026-12-01T17:00+07", "2026-12-01T10:00:00Z"),
    ] {
        let mut f = dto(U1, Channel::InApp);
        f.scheduled_at = Some(s.into());
        let r = send(&t, &d, &f, at(BUSY)).await.unwrap();
        assert_eq!(r.status, "scheduled", "{s}");
        let when: DateTime<Utc> = sqlx::query_scalar("SELECT scheduled_at FROM notification_logs WHERE id = $1")
            .bind(r.id)
            .fetch_one(&mut *t.acquire().await.unwrap())
            .await
            .unwrap();
        assert_eq!(when, at(want), "{s}");
    }

    // Ngoài giờ ⇒ dời 08:00 VN kế tiếp; lịch tương lai do người gọi chọn giữ nguyên.
    let night = send(&t, &d, &dto(U1, Channel::InApp), at("2026-11-26T14:00:00Z"))
        .await
        .unwrap();
    assert_eq!(night.status, "scheduled");
    let mut c = t.acquire().await.unwrap();
    let when: DateTime<Utc> = sqlx::query_scalar("SELECT scheduled_at FROM notification_logs WHERE id = $1")
        .bind(night.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(when, at("2026-11-27T01:00:00Z"));
    let mut sch = dto(U1, Channel::InApp);
    sch.scheduled_at = Some("2026-11-26T13:00:00.000Z".into());
    let s = send(&t, &d, &sch, at(BUSY)).await.unwrap();
    assert_eq!(s.status, "scheduled");
    let when: DateTime<Utc> = sqlx::query_scalar("SELECT scheduled_at FROM notification_logs WHERE id = $1")
        .bind(s.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(when, at("2026-11-26T13:00:00Z"));
    drop(c);
    // Lịch đã qua + trong giờ ⇒ gửi ngay.
    sch.scheduled_at = Some("2026-11-26T01:00:00Z".into());
    assert_eq!(send(&t, &d, &sch, at(BUSY)).await.unwrap().status, "sent");

    // Push: không token ⇒ thử đủ 3 lần rồi failed; có token ⇒ skipped không thử lại.
    let r = send(&t, &d, &dto(U1, Channel::Push), at(BUSY)).await.unwrap();
    assert_eq!(r.status, "failed");
    let (st, retry, e, _) = row(&t, r.id).await;
    assert_eq!(
        (st.as_str(), retry, e.as_deref()),
        ("failed", 3, Some("Khong co FCM token"))
    );
    let mut p = dto(U1, Channel::Push);
    p.metadata = Some(json!({"fcm_token": "tok"}));
    let r = send(&t, &d, &p, at(BUSY)).await.unwrap();
    let (st, retry, e, _) = row(&t, r.id).await;
    assert_eq!(
        (r.status.as_str(), st.as_str(), retry, e.is_some()),
        ("skipped", "skipped", 0, true)
    );

    // Webhook: URL nội bộ bị chặn (không thử lại); 500 thử lại rồi thành công; thiếu URL; lưu webhook_url.
    let mut w = dto(U1, Channel::Webhook);
    w.metadata = Some(json!({"webhook_url": "https://127.0.0.1/hook"}));
    let r = send(&t, &d, &w, at(BUSY)).await.unwrap();
    let (st, retry, e, url) = row(&t, r.id).await;
    assert_eq!((r.status.as_str(), st.as_str(), retry), ("failed", "failed", 1));
    assert_eq!(url.as_deref(), Some("https://127.0.0.1/hook"));
    assert!(e.unwrap().contains("nội bộ"));
    assert!(
        poster.calls.lock().unwrap().is_empty(),
        "không gọi mạng khi URL bị chặn"
    );
    w.metadata = Some(json!({"webhook_url": "https://hooks.example.com/in"}));
    *poster.codes.lock().unwrap() = vec![500, 302, 204];
    let r = send(&t, &d, &w, at(BUSY)).await.unwrap();
    assert_eq!(r.status, "sent");
    let (st, retry, ..) = row(&t, r.id).await;
    assert_eq!((st.as_str(), retry), ("sent", 2));
    let calls = poster.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 3);
    let body: serde_json::Value = serde_json::from_str(&calls[0].1).unwrap();
    assert_eq!(
        (
            body["recipient_id"].clone(),
            body["title"].clone(),
            body["body"].clone()
        ),
        (json!(U1), json!("Tiêu đề"), json!("Nội dung"))
    );
    assert!(body["timestamp"].as_str().unwrap().ends_with('Z'));
    *poster.codes.lock().unwrap() = vec![503, 503, 503];
    let r = send(&t, &d, &w, at(BUSY)).await.unwrap();
    let (st, retry, e, _) = row(&t, r.id).await;
    assert_eq!(
        (r.status.as_str(), st.as_str(), retry, e.as_deref()),
        ("failed", "failed", 3, Some("HTTP 503"))
    );
    let r = send(&t, &d, &dto(U1, Channel::Webhook), at(BUSY)).await.unwrap();
    assert_eq!(row(&t, r.id).await.2.as_deref(), Some("Khong co webhook URL"));
    clean(&t).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn danh_sach_dem_va_doc() {
    let (_g, t, d, sink, _) = setup().await;
    let mut c = t.acquire().await.unwrap();
    // 5 dòng của U1 trong đó 2 dòng trùng created_at (chèn cùng một câu), 1 dòng của U2.
    sqlx::query(
        "INSERT INTO notification_logs (recipient_id, event_type, channel, title, body, status, is_read, created_at) VALUES \
         ($1, NULL,               'in_app', 't1', 'b', 'sent', false, '2026-11-26 01:00:00+00'), \
         ($1, 'chat.tag',         'in_app', 't2', 'b', 'sent', false, '2026-11-26 02:00:00+00'), \
         ($1, 'payslip.approved', 'in_app', 't3', 'b', 'sent', true,  '2026-11-26 03:00:00+00'), \
         ($1, 'internal.message', 'in_app', 't4', 'b', 'sent', false, '2026-11-26 04:00:00+00'), \
         ($1, 'x',                'in_app', 't5', 'b', 'sent', false, '2026-11-26 05:00:00+00'), \
         ($2, 'x',                'in_app', 'u2', 'b', 'sent', false, '2026-11-26 05:00:00+00')",
    )
    .bind(U1)
    .bind(U2)
    .execute(&mut *c)
    .await
    .unwrap();
    let titles =
        |p: &mod_notify::notifications::Page| p.data.iter().map(|x| x.title.clone().unwrap()).collect::<Vec<_>>();

    let p1 = find_by_user(&mut c, U1, None, 2, None).await.unwrap();
    assert_eq!(titles(&p1), ["t5", "t4"]);
    let cur = p1.next_cursor.expect("còn trang sau");
    assert_eq!(cur, p1.data[1].id);
    let p2 = find_by_user(&mut c, U1, Some(cur), 2, None).await.unwrap();
    assert_eq!(titles(&p2), ["t3", "t2"]);
    let p3 = find_by_user(&mut c, U1, Some(p2.next_cursor.unwrap()), 2, None)
        .await
        .unwrap();
    assert_eq!((titles(&p3), p3.next_cursor), (vec!["t1".to_owned()], None));
    // Lọc đã đọc / chưa đọc; khoá JSON đúng thứ tự `select`.
    assert_eq!(
        titles(&find_by_user(&mut c, U1, None, 20, Some(true)).await.unwrap()),
        ["t3"]
    );
    assert_eq!(
        find_by_user(&mut c, U1, None, 20, Some(false))
            .await
            .unwrap()
            .data
            .len(),
        4
    );
    let j: serde_json::Value = serde_json::from_str(&serde_json::to_string(&p1.data[0]).unwrap()).unwrap();
    let keys: Vec<_> = j.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "title",
            "body",
            "channel",
            "event_type",
            "action_url",
            "is_read",
            "created_at"
        ]
    );
    // Con trỏ không tồn tại ⇒ rỗng như Prisma (truy vấn con ra NULL).
    assert!(
        find_by_user(&mut c, U1, Some(i32::MAX), 20, None)
            .await
            .unwrap()
            .data
            .is_empty()
    );

    // Trùng created_at: con trỏ là dòng đầu của nhóm trùng ⇒ như Prisma, dòng trùng còn lại có thể lặp/sót; ở đây kiểm
    // đúng quy tắc `created_at <= (con trỏ)` rồi bỏ một dòng.
    sqlx::query("INSERT INTO notification_logs (recipient_id, channel, title, body, status, created_at) VALUES ($1,'in_app','d1','b','sent','2026-11-25 00:00:00+00'),($1,'in_app','d2','b','sent','2026-11-25 00:00:00+00')")
        .bind(U1)
        .execute(&mut *c)
        .await
        .unwrap();
    let all = find_by_user(&mut c, U1, None, 50, None).await.unwrap();
    let first_tie = all
        .data
        .iter()
        .find(|x| x.title.as_deref().is_some_and(|t| t.starts_with('d')))
        .unwrap()
        .id;
    let after = find_by_user(&mut c, U1, Some(first_tie), 50, None).await.unwrap();
    assert_eq!(after.data.len(), 1, "một dòng trùng created_at còn lại");

    // Số chưa đọc theo nhóm: all = 6 (5 chưa đọc ban đầu - t3 đã đọc = 4, + d1 + d2), message = 2, profile = còn lại.
    assert_eq!(unread_count(&mut c, U1, None).await.unwrap().count, 6);
    assert_eq!(
        unread_count(&mut c, U1, Some(Category::Message)).await.unwrap().count,
        2
    );
    assert_eq!(
        unread_count(&mut c, U1, Some(Category::Profile)).await.unwrap().count,
        4
    );
    drop(c);

    // Đánh dấu đã đọc: của người khác ⇒ 404; của mình ⇒ success, status read, làm mới số đếm.
    let id = p1.data[0].id;
    assert_eq!(
        err(mark_as_read(&t, &d, id, U2).await.unwrap_err()),
        (404, "Thong bao khong ton tai".into())
    );
    assert_eq!(err(mark_as_read(&t, &d, i32::MAX, U1).await.unwrap_err()).0, 404);
    assert!(mark_as_read(&t, &d, id, U1).await.unwrap().success);
    let mut c = t.acquire().await.unwrap();
    let (st, read): (String, bool) =
        sqlx::query_as("SELECT status, read_at IS NOT NULL FROM notification_logs WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!((st.as_str(), read), ("read", true));
    assert_eq!(unread_count(&mut c, U1, None).await.unwrap().count, 5);
    assert_eq!(sink.refreshed.lock().unwrap().len(), 1);
    clean(&t).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn job_hen_gio_va_reaper() {
    let (_g, t, d, sink, poster) = setup().await;
    let now = at("2026-11-26T05:00:00Z");
    let mut c = t.acquire().await.unwrap();
    let ins = "INSERT INTO notification_logs (recipient_id, event_type, channel, title, body, status, scheduled_at, claimed_at, retry_count) \
               VALUES ($1, 'm32.s', 'in_app', $2, 'b', $3, $4, $5, $6) RETURNING id";
    let mut add = async |title: &str, status: &str, sched: &str, claimed: Option<&str>, retry: i32| -> i32 {
        sqlx::query_scalar(ins)
            .bind(U1)
            .bind(title)
            .bind(status)
            .bind(at(sched))
            .bind(claimed.map(at))
            .bind(retry)
            .fetch_one(&mut *c)
            .await
            .unwrap()
    };
    let due = add("due", "scheduled", "2026-11-26T04:00:00Z", None, 0).await;
    let future = add("future", "scheduled", "2026-11-26T09:00:00Z", None, 0).await;
    let stuck_a = add(
        "stuck_a",
        "processing",
        "2026-11-26T01:00:00Z",
        Some("2026-11-26T04:00:00Z"),
        0,
    )
    .await;
    let stuck_b = add(
        "stuck_b",
        "processing",
        "2026-11-26T01:00:00Z",
        Some("2026-11-26T04:00:00Z"),
        2,
    )
    .await;
    let fresh = add(
        "fresh",
        "processing",
        "2026-11-26T04:50:00Z",
        Some("2026-11-26T04:50:00Z"),
        0,
    )
    .await;
    let old_unclaimed = add("old_unclaimed", "processing", "2026-11-26T04:00:00Z", None, 0).await;
    // Dòng hẹn giờ đã từng kẹt (retry_count = 1) và webhook luôn 503: số lần thử CỘNG DỒN (1 + 3), không bị ghi đè về 3.
    let acc = add("acc", "scheduled", "2026-11-26T04:00:00Z", None, 1).await;
    let push = add("push", "scheduled", "2026-11-26T04:00:00Z", None, 0).await;
    let strange = add("strange", "scheduled", "2026-11-26T04:00:00Z", None, 0).await;
    drop(add);
    sqlx::query(
        "UPDATE notification_logs SET channel = 'webhook', webhook_url = 'https://hooks.example.com/x' WHERE id = $1",
    )
    .bind(acc)
    .execute(&mut *c)
    .await
    .unwrap();
    sqlx::query("UPDATE notification_logs SET channel = 'push' WHERE id = $1")
        .bind(push)
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("UPDATE notification_logs SET channel = 'sms' WHERE id = $1")
        .bind(strange)
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);

    assert_eq!(reap_stuck_processing(&t, now).await.unwrap(), (2, 1));
    assert_eq!(row(&t, stuck_a).await.0, "scheduled");
    assert_eq!(row(&t, old_unclaimed).await.0, "scheduled");
    let (st, retry, e, _) = row(&t, stuck_b).await;
    assert_eq!((st.as_str(), retry), ("failed", 3));
    assert!(e.unwrap().contains("quá số lần thử"));
    assert_eq!(row(&t, fresh).await.0, "processing", "dòng mới claim chưa kẹt");

    // Job: giao các dòng đến hạn (due, stuck_a, old_unclaimed, acc, push, strange), không đụng dòng tương lai.
    *poster.codes.lock().unwrap() = vec![503, 503, 503];
    let n = process_scheduled(&t, &d, now).await.unwrap();
    assert_eq!(n, 6);
    let (st, retry, e, _) = row(&t, acc).await;
    assert_eq!((st.as_str(), retry, e.as_deref()), ("failed", 4, Some("HTTP 503")));
    let (st, retry, e, _) = row(&t, push).await;
    assert_eq!(
        (st.as_str(), retry),
        ("skipped", 0),
        "push hẹn giờ thiếu fcm_token bị bỏ qua"
    );
    assert!(e.unwrap().contains("FCM"));
    let (st, _, e, _) = row(&t, strange).await;
    assert_eq!((st.as_str(), e.as_deref()), ("failed", Some("Kenh sms khong ho tro")));
    for id in [due, stuck_a, old_unclaimed] {
        assert_eq!(row(&t, id).await.0, "sent");
    }
    assert_eq!(row(&t, future).await.0, "scheduled");
    assert_eq!(sink.sent.lock().unwrap().len(), 3);
    assert_eq!(process_scheduled(&t, &d, now).await.unwrap(), 0);
    // Hai lượt song song không giao đôi một dòng.
    let mut c = t.acquire().await.unwrap();
    for i in 0..10 {
        sqlx::query("INSERT INTO notification_logs (recipient_id, channel, title, body, status, scheduled_at) VALUES ($1,'in_app',$2,'b','scheduled','2026-11-26T04:00:00Z')")
            .bind(U1)
            .bind(format!("p{i}"))
            .execute(&mut *c)
            .await
            .unwrap();
    }
    drop(c);
    let before = sink.sent.lock().unwrap().len();
    let (a, b) = tokio::join!(process_scheduled(&t, &d, now), process_scheduled(&t, &d, now));
    assert_eq!(a.unwrap() + b.unwrap(), 10);
    assert_eq!(sink.sent.lock().unwrap().len() - before, 10);
    clean(&t).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn su_kien_noi_bo() {
    let (_g, t, d, sink, _) = setup().await;
    let p = PayslipApproved {
        payslip_id: 42,
        user_id: U1,
        month: "2026-11".into(),
        total_amount: 12_345_678.0,
    };
    on_payslip_approved(&t, &d, &p, at(BUSY)).await;
    let mut c = t.acquire().await.unwrap();
    let (title, body, ev): (String, String, String) =
        sqlx::query_as("SELECT title, body, event_type FROM notification_logs WHERE recipient_id = $1")
            .bind(U1)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(
        (title.as_str(), body.as_str(), ev.as_str()),
        (
            "Phiếu lương đã duyệt",
            "Phiếu lương tháng 2026-11: 12.345.678 VNĐ",
            "payslip.approved"
        )
    );
    assert_eq!(sink.sent.lock().unwrap().len(), 1);
    // Gọi lặp: dedup, vẫn một dòng.
    on_payslip_approved(&t, &d, &p, at(BUSY)).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_logs WHERE recipient_id = $1")
        .bind(U1)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // Mẫu đang bật được dùng thay nội dung mặc định; mẫu hỏng (lưu từ trước) rơi về mặc định.
    sqlx::query("INSERT INTO notification_templates (name, event_type, channel, subject, body, updated_at) VALUES ('m32_p', 'payslip.approved', 'in_app', 'Lương {{month}}', 'Tổng {{totalAmount}}', now())").execute(&mut *c).await.unwrap();
    drop(c);
    let p2 = PayslipApproved {
        payslip_id: 43,
        ..p.clone()
    };
    on_payslip_approved(&t, &d, &p2, at(BUSY)).await;
    let mut c = t.acquire().await.unwrap();
    let (title, body): (String, String) =
        sqlx::query_as("SELECT title, body FROM notification_logs WHERE recipient_id = $1 ORDER BY id DESC LIMIT 1")
            .bind(U1)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!((title.as_str(), body.as_str()), ("Lương 2026-11", "Tổng 12345678"));
    sqlx::query("UPDATE notification_templates SET body = '{{#if x}}hỏng' WHERE name = 'm32_p'")
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    let p3 = PayslipApproved {
        payslip_id: 44,
        total_amount: 5.0,
        ..p.clone()
    };
    on_payslip_approved(&t, &d, &p3, at(BUSY)).await;
    let mut c = t.acquire().await.unwrap();
    let body: String =
        sqlx::query_scalar("SELECT body FROM notification_logs WHERE recipient_id = $1 ORDER BY id DESC LIMIT 1")
            .bind(U1)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(body, "Phiếu lương tháng 2026-11: 5 VNĐ");
    drop(c);

    // notify-ws-emit: phát từng dòng rồi làm mới số đếm một lần mỗi người.
    let before = sink.sent.lock().unwrap().len();
    let items = vec![
        WsEmitItem {
            recipient_id: U2,
            title: "a".into(),
            body: "b".into(),
            event_type: Some("x".into()),
            action_url: None,
            log_id: Some(1),
        },
        WsEmitItem {
            recipient_id: U2,
            title: "c".into(),
            body: "d".into(),
            event_type: None,
            action_url: Some("/y".into()),
            log_id: None,
        },
    ];
    let r = emit_ws_notifications(&t, &d, &items).await;
    assert_eq!(r.emitted, 2);
    assert_eq!(sink.sent.lock().unwrap().len() - before, 2);
    assert_eq!(
        sink.refreshed
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, u)| *u == i64::from(U2))
            .count(),
        1
    );
    assert_eq!(emit_ws_notifications(&t, &d, &[]).await.emitted, 0);
    clean(&t).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn lua_bi_cat_giua_chung_chi_ket_mot_dong() {
    let (_g, t, d, _, poster) = setup().await;
    let mut c = t.acquire().await.unwrap();
    for i in 0..10 {
        sqlx::query(
            "INSERT INTO notification_logs (recipient_id, channel, title, body, status, scheduled_at, webhook_url) \
             VALUES ($1, 'webhook', $2, 'b', 'scheduled', '2026-11-26T04:00:00Z', 'https://hooks.example.com/x')",
        )
        .bind(U1)
        .bind(format!("w{i}"))
        .execute(&mut *c)
        .await
        .unwrap();
    }
    drop(c);
    // Mỗi lần gọi webhook chậm 150 ms; hết "budget" 400 ms thì lượt bị huỷ giữa chừng (như scheduler cắt job).
    *poster.delay.lock().unwrap() = Duration::from_millis(150);
    let cut = tokio::time::timeout(
        Duration::from_millis(400),
        process_scheduled(&t, &d, at("2026-11-26T05:00:00Z")),
    )
    .await;
    assert!(cut.is_err(), "lượt phải bị cắt");
    let mut c = t.acquire().await.unwrap();
    let by: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, count(*) FROM notification_logs WHERE recipient_id = $1 GROUP BY status ORDER BY status",
    )
    .bind(U1)
    .fetch_all(&mut *c)
    .await
    .unwrap();
    let n = |s: &str| by.iter().find(|(st, _)| st == s).map_or(0, |(_, n)| *n);
    assert!(n("processing") <= 1, "chỉ dòng đang giao dở có thể kẹt: {by:?}");
    assert!(
        n("sent") >= 1 && n("scheduled") >= 5,
        "các dòng chưa tới vẫn là scheduled: {by:?}"
    );
    assert_eq!(n("sent") + n("processing") + n("scheduled"), 10);
    clean(&t).await;
}
