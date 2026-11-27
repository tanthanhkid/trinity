//! Bài lặp và nhập CSV (M55b) trên Postgres thật, cổng bài đăng giả (M54a chưa gộp). Pool chỉ 1 kết nối: mã giữ kết nối khi xin
//! kết nối thứ hai sẽ treo. Dữ liệu mang tiền tố `m55b`.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_m55b cargo test -p mod-social --test recurrence_pg -- --ignored`

use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use mod_social::dto_recur::RecurrenceBody;
use mod_social::import::{self, ImportMode, ImportPorts, NoQueue};
use mod_social::ports::{CreateFailure, DraftsPort, PostInput, PostsPort, RecurrenceGuard, ValidatedPost};
use mod_social::recurrences;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_kernel::error::AppError;

/// 2026-11-27 (thứ Sáu) 10:00 giờ Việt Nam.
const NOW_MS: i64 = 1_795_748_400_000;

#[derive(Default)]
struct FakePosts {
    next: AtomicI32,
    made: Mutex<Vec<(String, PostInput)>>,
}

impl PostsPort for FakePosts {
    async fn validate(&self, _user: i32, input: &PostInput) -> Result<ValidatedPost, AppError> {
        Ok(ValidatedPost { scheduled_at: input.scheduled_at })
    }

    async fn create(
        &self,
        _user: i32,
        input: &PostInput,
        dedupe: &str,
        _guard: Option<RecurrenceGuard>,
    ) -> Result<i32, CreateFailure> {
        self.made.lock().unwrap().push((dedupe.to_owned(), input.clone()));
        Ok(1000 + self.next.fetch_add(1, Ordering::SeqCst))
    }

    async fn cancel(&self, _post_id: i32) -> Result<(), AppError> {
        Ok(())
    }
}

#[derive(Default)]
struct FakeDrafts {
    made: Mutex<Vec<String>>,
}

impl DraftsPort for FakeDrafts {
    async fn check(&self, _user: i32, _input: &PostInput) -> Result<(), AppError> {
        Ok(())
    }

    async fn create(&self, _user: i32, _input: &PostInput, _source: &str, dedupe: &str) -> Result<i32, AppError> {
        let mut m = self.made.lock().unwrap();
        m.push(dedupe.to_owned());
        Ok(i32::try_from(m.len()).unwrap())
    }
}

fn code(e: AppError) -> (u16, Value) {
    let (s, b) = e.response(true);
    (s, serde_json::to_value(&b.message).unwrap())
}

async fn clean(c: &mut PgConnection) {
    for sql in [
        "DELETE FROM social_recurrences WHERE title LIKE 'm55b%'",
        "DELETE FROM social_accounts WHERE external_id LIKE 'm55b%'",
        "DELETE FROM users WHERE email LIKE 'm55b%@test.local'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn bai_lap_va_nhap_csv() {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let tdb = db.tenant(CompanyRef::DEFAULT).await.unwrap();
    let now: DateTime<Utc> = DateTime::from_timestamp_millis(NOW_MS).unwrap();

    let (user, account): (i32, i32) = {
        let mut c = tdb.acquire().await.unwrap();
        clean(&mut c).await;
        let user: i32 = sqlx::query_scalar(
            "INSERT INTO users (email, password_hash, full_name, status, updated_at) \
             VALUES ('m55bb@test.local', 'x', 'M55b', 'active', now()) RETURNING id",
        )
        .fetch_one(&mut *c)
        .await
        .unwrap();
        let account: i32 = sqlx::query_scalar(
            "INSERT INTO social_accounts (network, external_id, name, access_token_enc, connected_by) \
             VALUES ('facebook', 'm55b-page', 'm55b page', 'x', $1) RETURNING id",
        )
        .bind(user)
        .fetch_one(&mut *c)
        .await
        .unwrap();
        (user, account)
    };
    let posts = FakePosts::default();

    // ── Bài lặp ──
    let body = |v: Value| RecurrenceBody::from_json(&v).unwrap();
    let created = recurrences::create(
        &tdb,
        &posts,
        user,
        &body(json!({
            "title": "m55b hằng tuần",
            "template": { "content": "m55b nội dung", "targets": [{ "account_id": account }] },
            "rule": { "freq": "weekly", "interval": 1, "weekdays": [1, 3], "time": "09:00" },
            "starts_on": "2026-11-27"
        })),
        now,
    )
    .await
    .unwrap();
    assert!(created.active);
    assert_eq!(created.next_times.len(), 3);
    assert_eq!(recurrences::list(&tdb, now).await.unwrap().len(), 1);

    // Luật không hợp lệ ⇒ 400.
    let bad = recurrences::create(
        &tdb,
        &posts,
        user,
        &body(json!({
            "title": "m55b sai",
            "template": { "content": "x", "targets": [{ "account_id": account }] },
            "rule": { "freq": "monthly", "interval": 1, "month_day": 31, "time": "09:00" },
            "starts_on": "2026-11-27",
            "ends_on": "2026-11-28"
        })),
        now,
    )
    .await
    .unwrap_err();
    assert_eq!(code(bad).0, 400);

    let paused = recurrences::pause(&tdb, &posts, created.id, now).await.unwrap();
    assert!(!paused.active && paused.next_times.is_empty());
    let resumed = recurrences::resume(&tdb, &posts, created.id, now).await.unwrap();
    assert!(resumed.active);
    assert_eq!(code(recurrences::get(&tdb, 0, now).await.unwrap_err()).0, 404);
    recurrences::remove(&tdb, &posts, created.id).await.unwrap();
    assert_eq!(code(recurrences::get(&tdb, created.id, now).await.unwrap_err()).0, 404);

    // ── Nhập CSV ──
    let drafts = FakeDrafts::default();
    let ports = ImportPorts { posts: &posts, drafts: &drafts, queue: &NoQueue };
    let csv = "noi_dung,kenh,gio_dang\nm55b một,m55b page,\nm55b hai,Không có kênh,\n";
    let plan = import::plan(&tdb, &ports, user, csv, ImportMode::Drafts, now).await.unwrap();
    assert_eq!((plan.total, plan.ok_count, plan.error_count), (2, 1, 1));
    assert_eq!(
        plan.rows[1].errors,
        vec!["Không tìm thấy kênh \"Không có kênh\"."],
        "dòng 3 của tệp báo kênh lạ"
    );
    // Mã sai ⇒ 409; mã đúng ⇒ chỉ dòng hợp lệ được tạo, dòng lỗi bị bỏ qua.
    let wrong = import::import_csv(&tdb, &ports, user, csv, ImportMode::Drafts, "sai", now)
        .await
        .unwrap_err();
    assert_eq!(code(wrong).0, 409);
    let done = import::import_csv(&tdb, &ports, user, csv, ImportMode::Drafts, &plan.plan_hash, now)
        .await
        .unwrap();
    assert_eq!((done.created.len(), done.skipped.len()), (1, 1));
    assert!(drafts.made.lock().unwrap()[0].starts_with("csv-import:"));
    // Bài hẹn giờ không có khung hàng đợi ⇒ dòng "hàng đợi" báo lỗi.
    let q = import::plan(
        &tdb,
        &ports,
        user,
        &format!("noi_dung,kenh,gio_dang\nm55b ba,{account},hàng đợi\n"),
        ImportMode::Schedule,
        now,
    )
    .await
    .unwrap();
    assert_eq!(q.error_count, 1);

    let mut c = tdb.acquire().await.unwrap();
    clean(&mut c).await;
}
