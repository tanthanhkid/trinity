//! M09: team và chức danh trên Postgres thật (`public` đã migrate bằng Prisma, như job Rust pg tests của CI).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-hr --test pg -- --ignored`
//! Hai test dùng dữ liệu mang tiền tố `m09` và tự dọn; chạy tuần tự (cùng đọc cả bảng `teams`/`users`).

use mod_hr::job_titles::{self, CreateJobTitle, QueryJobTitles, UpdateJobTitle};
use mod_hr::teams::{self, CreateTeam, UpdateTeam};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};

async fn conn() -> trinity_db::TenantConn {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 2;
    let db = Db::connect(&cfg).await.expect("nối DB");
    db.tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
        .acquire()
        .await
        .expect("acquire")
}

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn clean(c: &mut PgConnection) {
    sqlx::query("UPDATE employees SET team_id = NULL WHERE team_id IN (SELECT id FROM teams WHERE name LIKE 'm09%')")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM teams WHERE name LIKE 'm09%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm09-%@test.local')")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE email LIKE 'm09-%@test.local'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM job_titles WHERE rank_code LIKE 'M09%'")
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn user(c: &mut PgConnection, n: &str, manager: Option<i32>) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, manager_id, updated_at) VALUES ($1, 'x', $2, $3, now()) RETURNING id",
    )
    .bind(format!("m09-{n}@test.local"))
    .bind(format!("M09 {n}"))
    .bind(manager)
    .fetch_one(c)
    .await
    .unwrap()
}

async fn employee(c: &mut PgConnection, user_id: i32) {
    sqlx::query("INSERT INTO employees (user_id, position) VALUES ($1, 'sales')")
        .bind(user_id)
        .execute(c)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn vong_doi_team_va_thanh_vien() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let lead = user(&mut c, "lead", None).await;
    let direct = user(&mut c, "direct", None).await;
    let under = user(&mut c, "under", Some(lead)).await;
    for u in [lead, direct, under] {
        employee(&mut c, u).await;
    }

    let t = teams::create(
        &mut c,
        &CreateTeam {
            name: "  m09 Nhóm A ".into(),
            department: Some("  Kinh doanh ".into()),
            description: Some("   ".into()),
            team_lead_id: Some(lead),
            color: Some("#ABCDEF".into()),
        },
    )
    .await
    .expect("tạo");
    assert_eq!(t.name, "m09 Nhóm A");
    assert_eq!(t.department.as_deref(), Some("Kinh doanh"));
    assert_eq!(t.description, None);
    assert_eq!(t.color.as_deref(), Some("#abcdef"));
    assert_eq!(t.team_lead_name.as_deref(), Some("M09 lead"));
    // Chưa gán trực tiếp: trưởng nhóm và người dưới quyền tính theo cây quản lý.
    assert_eq!(t.member_count, 2);
    let json = serde_json::from_str::<serde_json::Value>(&serde_json::to_string(&t).unwrap()).unwrap();
    let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "name",
            "department",
            "description",
            "team_lead_id",
            "team_lead_name",
            "color",
            "member_count"
        ]
    );

    // Trùng tên ⇒ 409; người phụ trách không tồn tại ⇒ 400.
    let dup = teams::create(
        &mut c,
        &CreateTeam {
            name: "m09 Nhóm A".into(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status(dup.unwrap_err()).0, 409);
    let bad = teams::create(
        &mut c,
        &CreateTeam {
            name: "m09 B".into(),
            team_lead_id: Some(-5),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(status(bad.unwrap_err()).0, 400);
    let empty = teams::create(
        &mut c,
        &CreateTeam {
            name: "   ".into(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(
        status(empty.unwrap_err()),
        (400, "\"Tên team không được rỗng\"".to_owned())
    );

    // Gán trực tiếp: bỏ trùng và id không dương; chỉ nhân viên chưa xoá.
    let added = teams::add_members(&mut c, t.id, &[direct, direct, 0, -3])
        .await
        .unwrap();
    assert_eq!(added.added, 1);
    assert_eq!(teams::add_members(&mut c, t.id, &[]).await.unwrap().added, 0);
    assert_eq!(
        status(teams::add_members(&mut c, 0, &[direct]).await.unwrap_err()).0,
        404
    );
    let members = teams::list_members(&mut c, t.id).await.unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].user_id, direct);
    assert_eq!(members[0].email.as_deref(), Some("m09-direct@test.local"));
    assert_eq!(members[0].role, None);
    assert_eq!(teams::find_one(&mut c, t.id).await.unwrap().member_count, 3);

    // Sửa: null xoá, vắng giữ nguyên, màu sai thành null.
    let upd: UpdateTeam = serde_json::from_str(r#"{"department":null,"color":"xanh","name":" m09 Nhóm A2 "}"#).unwrap();
    let t2 = teams::update(&mut c, t.id, &upd).await.unwrap();
    assert_eq!((t2.name.as_str(), t2.department, t2.color), ("m09 Nhóm A2", None, None));
    assert_eq!(t2.team_lead_id, Some(lead));
    let upd: UpdateTeam = serde_json::from_str(r#"{"team_lead_id":null}"#).unwrap();
    assert_eq!(teams::update(&mut c, t.id, &upd).await.unwrap().team_lead_id, None);
    assert_eq!(
        status(teams::update(&mut c, 0, &UpdateTeam::default()).await.unwrap_err()).0,
        404
    );

    // Bộ lọc: team không có người phụ trách chỉ hiện khi include_unled và có nhân viên gán trực tiếp.
    assert!(
        !teams::list_for_filter(&mut c, false)
            .await
            .unwrap()
            .iter()
            .any(|r| r.id == t.id)
    );
    assert!(
        teams::list_for_filter(&mut c, true)
            .await
            .unwrap()
            .iter()
            .any(|r| r.id == t.id)
    );
    let lf = teams::list_team_lead_filter(&mut c).await.unwrap();
    // Người đang quản lý người khác nhưng chưa có team xuất hiện với tên họ.
    assert!(
        lf.iter().any(|r| r.team_lead_id == lead && r.name == "M09 lead"),
        "{lf:?}"
    );

    // Gỡ thành viên: đúng team mới được, sai team ⇒ 404.
    assert_eq!(
        status(teams::remove_member(&mut c, t.id, under).await.unwrap_err()).0,
        404
    );
    teams::remove_member(&mut c, t.id, direct).await.unwrap();
    assert!(teams::list_members(&mut c, t.id).await.unwrap().is_empty());

    // Xoá team gỡ team_id nhưng giữ nhân viên.
    teams::add_members(&mut c, t.id, &[direct]).await.unwrap();
    teams::remove(&mut c, t.id).await.unwrap();
    assert_eq!(status(teams::find_one(&mut c, t.id).await.unwrap_err()).0, 404);
    let tid: Option<i32> = sqlx::query_scalar("SELECT team_id FROM employees WHERE user_id = $1")
        .bind(direct)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(tid, None);
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn vong_doi_chuc_danh() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let input = CreateJobTitle {
        category: "Nhân viên".into(),
        rank_code: "M09CV".into(),
        name: "Chuyên viên".into(),
        symbol: "CV".into(),
        base_salary: Some(9_000_000),
        standard_target: None,
        default_insurance_salary: None,
        review_cycle_months: 3,
        is_active: None,
        sort_order: Some(7),
    };
    input.validate().unwrap();
    let j = job_titles::create(&mut c, &input).await.expect("tạo");
    // Lương là chuỗi, mặc định 0, đang hiệu lực.
    let json = serde_json::from_str::<serde_json::Value>(&serde_json::to_string(&j).unwrap()).unwrap();
    assert_eq!(json["base_salary"], "9000000");
    assert_eq!(json["standard_target"], "0");
    assert!(json["default_insurance_salary"].is_null());
    assert_eq!(json["is_active"], true);
    let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "category",
            "rank_code",
            "name",
            "symbol",
            "base_salary",
            "standard_target",
            "default_insurance_salary",
            "review_cycle_months",
            "is_active",
            "sort_order",
            "created_at",
            "updated_at"
        ]
    );

    let dup = job_titles::create(&mut c, &input).await;
    assert_eq!(
        status(dup.unwrap_err()),
        (409, "\"Mã cấp bậc \\\"M09CV\\\" đã tồn tại\"".to_owned())
    );

    // Sửa: null xoá mức BHXH, vắng giữ nguyên, rỗng ⇒ 400.
    let set: UpdateJobTitle =
        serde_json::from_str(r#"{"default_insurance_salary":4500000,"is_active":false}"#).unwrap();
    let j2 = job_titles::update(&mut c, j.id, &set).await.unwrap();
    assert_eq!(j2.default_insurance_salary.as_deref(), Some("4500000"));
    assert!(!j2.is_active);
    assert_eq!(j2.base_salary, "9000000");
    let clear: UpdateJobTitle = serde_json::from_str(r#"{"default_insurance_salary":null}"#).unwrap();
    assert_eq!(
        job_titles::update(&mut c, j.id, &clear)
            .await
            .unwrap()
            .default_insurance_salary,
        None
    );
    let none = job_titles::update(&mut c, j.id, &UpdateJobTitle::default()).await;
    assert_eq!(
        status(none.unwrap_err()),
        (400, "\"Không có trường nào cần cập nhật\"".to_owned())
    );
    assert_eq!(status(job_titles::update(&mut c, 0, &clear).await.unwrap_err()).0, 404);

    // Lọc và thứ tự.
    let q = QueryJobTitles {
        category: Some("Nhân viên".into()),
        is_active: Some(false),
    };
    assert!(
        job_titles::find_all(&mut c, &q)
            .await
            .unwrap()
            .iter()
            .any(|r| r.id == j.id)
    );
    let q = QueryJobTitles {
        category: None,
        is_active: Some(true),
    };
    assert!(
        !job_titles::find_all(&mut c, &q)
            .await
            .unwrap()
            .iter()
            .any(|r| r.id == j.id)
    );
    let all = job_titles::find_all(&mut c, &QueryJobTitles::default()).await.unwrap();
    assert!(
        all.windows(2)
            .all(|w| (w[0].sort_order, w[0].id) <= (w[1].sort_order, w[1].id))
    );

    // Xoá: nhân viên giữ chức danh này về NULL, không mất.
    let u = user(&mut c, "jt", None).await;
    employee(&mut c, u).await;
    sqlx::query("UPDATE employees SET job_title_id = $1 WHERE user_id = $2")
        .bind(j.id)
        .bind(u)
        .execute(&mut *c)
        .await
        .unwrap();
    job_titles::remove(&mut c, j.id).await.unwrap();
    assert_eq!(status(job_titles::find_one(&mut c, j.id).await.unwrap_err()).0, 404);
    let jt: Option<i32> = sqlx::query_scalar("SELECT job_title_id FROM employees WHERE user_id = $1")
        .bind(u)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(jt, None);
    clean(&mut c).await;
}
