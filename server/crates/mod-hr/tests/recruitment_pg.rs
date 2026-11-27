//! M12 tuyển dụng với Postgres thật. Cần DB riêng đã có schema (Prisma hoặc `psql -f server/contracts/schema.sql`); các bảng
//! `recruitment_*`, `users`, `roles`… bị TRUNCATE:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-hr --test recruitment_pg -- --ignored --test-threads=1`

use mod_hr::recruitment as rc;
use serde_json::{Map, Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_kernel::error::AppError;

async fn setup() -> PgConnection {
    let mut c = PgConnection::connect(&std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL"))
        .await
        .expect("kết nối DB");
    exec(&mut c, "TRUNCATE recruitment_candidates, recruitment_positions, role_permissions, user_roles, roles, users RESTART IDENTITY CASCADE").await;
    // Trigger của `users` ghi `platform.company_logins` (khoá ngoại tới công ty 1).
    sqlx::query(
        "INSERT INTO platform.companies (id, name, schema_name) VALUES (1, 'c1', 'public') ON CONFLICT DO NOTHING",
    )
    .execute(&mut c)
    .await
    .expect("platform.companies");
    c
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

fn js<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

fn body(name: &str, v: Value) -> Map<String, Value> {
    rc::validate(name, &v).unwrap_or_else(|e| panic!("{name} {v}: {e:?}"))
}

fn query(name: &str, v: Value) -> Map<String, Value> {
    body(name, v)
}

fn err_text(e: AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: u16, text: &str) {
    let (s, m) = err_text(r.unwrap_err());
    assert_eq!(s, code, "{m}");
    assert!(m.contains(text), "{m} thiếu {text}");
}

fn cand(name: &str) -> Value {
    json!({"full_name": name})
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn kiem_du_lieu_vao_dung_cau_class_validator() {
    // Thân sai: câu lỗi và khoá lạ do bộ kiểm chung K15 (đã đối chiếu ValidationPipe thật ở trinity-http).
    for (name, v, want) in [
        ("CreateCandidateDto", json!({}), "full_name"),
        (
            "CreateCandidateDto",
            json!({"full_name": "A", "interview_time": "25:00"}),
            "Giờ phỏng vấn phải dạng HH:mm",
        ),
        (
            "CreateCandidateDto",
            json!({"full_name": "A", "stage": "xx"}),
            "stage must be one of",
        ),
        (
            "CreateCandidateDto",
            json!({"full_name": "A", "hack": 1}),
            "property hack should not exist",
        ),
        (
            "CreateCandidateDto",
            json!({"full_name": "A", "cost": -1}),
            "cost must not be less than 0",
        ),
        ("CreatePositionDto", json!({"job_code": "J"}), "department"),
        (
            "CreatePositionDto",
            json!({"job_code": "J", "department": "D", "position_title": "T", "headcount": 0, "recruiter_id": 1, "opened_date": "2026-01-01"}),
            "headcount must not be less than 1",
        ),
        ("UpdateCandidateDto", json!({"stage": null}), "stage must be one of"),
        ("UpdatePositionDto", json!({"status": "zzz"}), "status must be one of"),
        (
            "QueryCandidatesDto",
            json!({"page_size": "1000"}),
            "page_size must not be greater than 100",
        ),
        (
            "QueryCandidatesDto",
            json!({"sort_by": "phone"}),
            "sort_by must be one of",
        ),
        (
            "QueryPositionsDto",
            json!({"page": "0"}),
            "page must not be less than 1",
        ),
        (
            "QueryRecruitmentStatsDto",
            json!({"date_from": "khong-phai-ngay"}),
            "date_from must be a valid ISO 8601 date string",
        ),
    ] {
        expect_err(rc::validate(name, &v), 400, want);
    }
    // Hợp lệ: chuỗi số của query chuyển thành số.
    let q = query("QueryCandidatesDto", json!({"page": "2", "page_size": "10"}));
    assert_eq!((q["page"].clone(), q["page_size"].clone()), (json!(2), json!(10)));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn ung_vien_tao_sua_xoa_liet_ke() {
    let mut c = setup().await;
    exec(&mut c, "INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES (5, 'hr@x.vn', 'x', 'Chị HR', 'active', now())").await;

    // Tạo với mặc định; ngày theo UTC của thời điểm (múi giờ +07 qua nửa đêm UTC lùi một ngày).
    let a = rc::create_candidate(&mut c, &body("CreateCandidateDto", cand("An")), 5)
        .await
        .unwrap();
    assert_eq!(
        (a.stage.as_str(), a.decision.as_str(), a.recruitment_type.as_str()),
        ("applied", "pending", "external")
    );
    let full = body(
        "CreateCandidateDto",
        json!({
        "full_name": "Bình 100%", "phone": "0912", "email": "b@x.vn", "position": "Dev", "department": "Công nghệ", "source": "Facebook",
        "stage": "interview", "decision": "pending", "recruitment_type": "internal", "applied_date": "2026-03-10T01:00:00+07:00",
        "cost": 500000, "note": "ghi chú", "gender": "F", "interview_date": "2026-03-12", "interview_time": "09:30", "recruiter_id": 5}),
    );
    let b = rc::create_candidate(&mut c, &full, 5).await.unwrap();
    assert_eq!(
        b.applied_date.as_deref(),
        Some("2026-03-09"),
        "01:00+07 = 18:00Z hôm trước"
    );
    assert_eq!(
        (b.recruiter_name.as_deref(), b.interview_time.as_deref(), b.cost),
        (Some("Chị HR"), Some("09:30"), Some(500_000))
    );
    assert!(js(&b).starts_with(r#"{"id":2,"full_name":"Bình 100%","phone":"0912","email":"b@x.vn","position":"Dev","department":"Công nghệ","source":"Facebook","stage":"interview","decision":"pending","recruitment_type":"internal","applied_date":"2026-03-09","cost":500000,"note":"ghi chú","gender":"F","interview_date":"2026-03-12","interview_time":"09:30","recruiter_id":5,"recruiter_name":"Chị HR","created_at":""#));
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT created_by FROM recruitment_candidates WHERE id = 2")
            .fetch_one(&mut c)
            .await
            .unwrap(),
        5
    );
    let cc = rc::create_candidate(
        &mut c,
        &body(
            "CreateCandidateDto",
            json!({"full_name": "Chi", "applied_date": "2026-01-05", "cost": 100, "source": "Zalo"}),
        ),
        5,
    )
    .await
    .unwrap();

    // Liệt kê: mặc định applied_date mới trước, NULL cuối, id giảm dần.
    let all = rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({})))
        .await
        .unwrap();
    assert_eq!(
        all.data.iter().map(|r| r.full_name.as_str()).collect::<Vec<_>>(),
        ["Bình 100%", "Chi", "An"]
    );
    assert_eq!(
        js(&all.pagination),
        r#"{"total":3,"page":1,"page_size":25,"total_pages":1,"hasMore":false}"#
    );
    // Lọc, tìm (không thoát % và _ như Prisma: `%` khớp mọi dòng), sắp xếp, phân trang.
    let f = rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"stage": "interview"})))
        .await
        .unwrap();
    assert_eq!(f.data.len(), 1);
    assert_eq!(
        rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"search": "%"})))
            .await
            .unwrap()
            .data
            .len(),
        3
    );
    assert_eq!(
        rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"search": "  100%  "})))
            .await
            .unwrap()
            .data
            .len(),
        1
    );
    assert_eq!(
        rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"search": "B@X.VN"})))
            .await
            .unwrap()
            .data
            .len(),
        1,
        "ILIKE theo email"
    );
    assert_eq!(
        rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"search": "   "})))
            .await
            .unwrap()
            .data
            .len(),
        3,
        "chỉ khoảng trắng ⇒ không lọc"
    );
    assert_eq!(
        rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"source": ""})))
            .await
            .unwrap()
            .data
            .len(),
        3,
        "chuỗi rỗng ⇒ không lọc"
    );
    let by_cost = rc::list_candidates(
        &mut c,
        &query("QueryCandidatesDto", json!({"sort_by": "cost", "sort_dir": "asc"})),
    )
    .await
    .unwrap();
    assert_eq!(
        by_cost.data.iter().map(|r| r.full_name.as_str()).collect::<Vec<_>>(),
        ["Chi", "Bình 100%", "An"],
        "NULL cuối"
    );
    let by_cost_desc = rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"sort_by": "cost"})))
        .await
        .unwrap();
    assert_eq!(by_cost_desc.data[0].full_name, "Bình 100%");
    assert_eq!(by_cost_desc.data[2].full_name, "An", "NULL vẫn cuối khi giảm dần");
    let p2 = rc::list_candidates(
        &mut c,
        &query("QueryCandidatesDto", json!({"page": "2", "page_size": "2"})),
    )
    .await
    .unwrap();
    assert_eq!(
        (p2.data.len(), js(&p2.pagination)),
        (
            1,
            r#"{"total":3,"page":2,"page_size":2,"total_pages":2,"hasMore":false}"#.to_owned()
        )
    );
    let p1 = rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"page_size": "2"})))
        .await
        .unwrap();
    assert!(p1.pagination.has_more);
    let beyond = rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({"page": "9"})))
        .await
        .unwrap();
    assert_eq!((beyond.data.len(), beyond.pagination.total_pages), (0, 1));

    // Sửa một phần; `null` xoá cột cho phép NULL; khoá vắng giữ nguyên.
    let u = rc::update_candidate(
        &mut c,
        a.id,
        &body(
            "UpdateCandidateDto",
            json!({"stage": "offer", "phone": "0999", "cost": 7, "recruiter_id": 5, "interview_time": "10:00"}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            u.stage.as_str(),
            u.phone.as_deref(),
            u.cost,
            u.recruiter_name.as_deref()
        ),
        ("offer", Some("0999"), Some(7), Some("Chị HR"))
    );
    let cleared = rc::update_candidate(
        &mut c,
        a.id,
        &body(
            "UpdateCandidateDto",
            json!({"phone": null, "recruiter_id": null, "applied_date": null}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            cleared.phone,
            cleared.recruiter_id,
            cleared.recruiter_name,
            cleared.applied_date,
            cleared.stage.as_str(),
            cleared.cost
        ),
        (None, None, None, None, "offer".to_owned().as_str(), Some(7))
    );
    let touched =
        sqlx::query_scalar::<_, bool>("SELECT updated_at > created_at FROM recruitment_candidates WHERE id = 1")
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert!(touched, "updated_at đổi khi sửa");
    expect_err(
        rc::update_candidate(&mut c, 999, &body("UpdateCandidateDto", json!({"stage": "hired"}))).await,
        404,
        "Không tìm thấy ứng viên",
    );
    // Xoá.
    assert_eq!(
        js(&rc::remove_candidate(&mut c, cc.id).await.unwrap()),
        format!(r#"{{"ok":true,"id":{}}}"#, cc.id)
    );
    expect_err(
        rc::remove_candidate(&mut c, cc.id).await,
        404,
        "Không tìm thấy ứng viên",
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn vi_tri_tao_sua_xoa_liet_ke() {
    let mut c = setup().await;
    exec(&mut c, "INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES (5, 'hr@x.vn', 'x', 'Chị HR', 'active', now())").await;
    let dto = |code: &str, dept: &str| json!({"job_code": code, "department": dept, "position_title": format!("Chức {code}"), "headcount": 2, "recruiter_id": 5, "opened_date": "2026-02-01"});
    let p1 = rc::create_position(&mut c, &body("CreatePositionDto", dto("J1", "Kinh doanh")), 5)
        .await
        .unwrap();
    assert_eq!(
        (p1.status.as_str(), p1.recruiter_name.as_deref(), p1.team.clone()),
        ("open", Some("Chị HR"), None)
    );
    assert!(js(&p1).starts_with(r#"{"id":1,"job_code":"J1","department":"Kinh doanh","team":null,"position_title":"Chức J1","headcount":2,"recruiter_id":5,"recruiter_name":"Chị HR","opened_date":"2026-02-01","expected_start_date":null,"description":null,"requirements":null,"recruitment_cost":null,"status":"open","created_at":""#));
    let mut full = dto("J2", "Công nghệ");
    full["team"] = json!("Backend");
    full["description"] = json!("mô tả");
    full["requirements"] = json!("yêu cầu");
    full["recruitment_cost"] = json!(1000);
    full["expected_start_date"] = json!("2026-04-01");
    full["status"] = json!("closed");
    let p2 = rc::create_position(&mut c, &body("CreatePositionDto", full), 5)
        .await
        .unwrap();
    assert_eq!(
        (
            p2.status.as_str(),
            p2.team.as_deref(),
            p2.expected_start_date.as_deref()
        ),
        ("closed", Some("Backend"), Some("2026-04-01"))
    );
    exec(&mut c, "INSERT INTO recruitment_positions (job_code, department, position_title, headcount, status, updated_at) VALUES ('J3', 'Khác', 'Không ngày mở', 1, 'open', now())").await;

    let all = rc::list_positions(&mut c, &query("QueryPositionsDto", json!({})))
        .await
        .unwrap();
    assert_eq!(
        all.data.iter().map(|r| r.job_code.as_str()).collect::<Vec<_>>(),
        ["J2", "J1", "J3"],
        "opened_date giảm dần, mới nhất hết, NULL cuối (cùng ngày: id giảm dần)"
    );
    assert_eq!(
        rc::list_positions(&mut c, &query("QueryPositionsDto", json!({"status": "closed"})))
            .await
            .unwrap()
            .data
            .len(),
        1
    );
    assert_eq!(
        rc::list_positions(&mut c, &query("QueryPositionsDto", json!({"department": "Công nghệ"})))
            .await
            .unwrap()
            .data
            .len(),
        1
    );
    assert_eq!(
        rc::list_positions(&mut c, &query("QueryPositionsDto", json!({"search": "backend"})))
            .await
            .unwrap()
            .data
            .len(),
        1,
        "tìm theo team"
    );
    assert_eq!(
        rc::list_positions(&mut c, &query("QueryPositionsDto", json!({"search": "j1"})))
            .await
            .unwrap()
            .data
            .len(),
        1,
        "tìm theo mã, không phân biệt hoa thường"
    );
    let by_head = rc::list_positions(
        &mut c,
        &query("QueryPositionsDto", json!({"sort_by": "headcount", "sort_dir": "asc"})),
    )
    .await
    .unwrap();
    assert_eq!(by_head.data[0].job_code, "J3");

    // Sửa: team/description/requirements rỗng ⇒ NULL; recruiter_id null xoá; vắng giữ nguyên.
    let u = rc::update_position(&mut c, p2.id, &body("UpdatePositionDto", json!({"team": "", "description": "", "requirements": "mới", "headcount": 5, "recruiter_id": null, "status": "open"}))).await.unwrap();
    assert_eq!(
        (
            u.team,
            u.description,
            u.requirements.as_deref(),
            u.headcount,
            u.recruiter_id,
            u.status.as_str()
        ),
        (None, None, Some("mới"), 5, None, "open")
    );
    assert_eq!(u.recruitment_cost, Some(1000));
    expect_err(
        rc::update_position(&mut c, 999, &body("UpdatePositionDto", json!({"status": "closed"}))).await,
        404,
        "Không tìm thấy vị trí tuyển dụng",
    );
    assert_eq!(
        js(&rc::remove_position(&mut c, p1.id).await.unwrap()),
        r#"{"ok":true,"id":1}"#
    );
    expect_err(
        rc::remove_position(&mut c, p1.id).await,
        404,
        "Không tìm thấy vị trí tuyển dụng",
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn thong_ke_va_nguoi_phu_trach() {
    let mut c = setup().await;
    exec(&mut c, "INSERT INTO recruitment_candidates (full_name, source, stage, decision, recruitment_type, applied_date, cost, updated_at) VALUES \
      ('a', 'Facebook', 'applied', 'pending', 'external', '2026-01-10', 100, now()), \
      ('b', 'Facebook', 'interview', 'hired', 'internal', '2026-01-20', 200, now()), \
      ('c', NULL, 'applied', 'rejected', 'external', '2026-02-05', NULL, now()), \
      ('d', 'Zalo', 'offer', 'pending', 'external', NULL, 50, now())").await;
    let s = serde_json::to_value(
        rc::stats(&mut c, &query("QueryRecruitmentStatsDto", json!({})))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(s["total"], 4);
    assert_eq!(s["total_cost"], 350);
    assert_eq!(s["by_source"], json!({"Facebook": 2, "Zalo": 1, "Không rõ": 1}));
    assert_eq!(s["by_stage"], json!({"applied": 2, "interview": 1, "offer": 1}));
    assert_eq!(s["by_decision"], json!({"pending": 2, "hired": 1, "rejected": 1}));
    assert_eq!(s["by_type"], json!({"internal": 1, "external": 3}));
    assert_eq!(
        s["by_month"],
        json!([{"month": "2026-01", "count": 2}, {"month": "2026-02", "count": 1}]),
        "dòng không có applied_date không vào theo tháng"
    );
    // Khoảng ngày: dòng không có applied_date bị loại khi có bộ lọc.
    let r = serde_json::to_value(
        rc::stats(
            &mut c,
            &query(
                "QueryRecruitmentStatsDto",
                json!({"date_from": "2026-01-15", "date_to": "2026-02-01T00:00:00Z"}),
            ),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (r["total"].clone(), r["total_cost"].clone(), r["by_month"].clone()),
        (json!(1), json!(200), json!([{"month": "2026-01", "count": 1}]))
    );
    let none = serde_json::to_value(
        rc::stats(
            &mut c,
            &query("QueryRecruitmentStatsDto", json!({"date_from": "2030-01-01"})),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (
            none["total"].clone(),
            none["total_cost"].clone(),
            none["by_type"].clone()
        ),
        (json!(0), json!(0), json!({"internal": 0, "external": 0}))
    );

    // Người phụ trách: vai trò hệ thống hoặc có `recruitment.manage`; chỉ người đang hoạt động, chưa xoá, theo tên.
    exec(&mut c, "INSERT INTO users (id, email, password_hash, full_name, status, updated_at, deleted_at) VALUES \
      (1, 'ad@x.vn', 'x', 'Zed Admin', 'active', now(), NULL), (2, 'hr@x.vn', 'x', 'An HR', 'active', now(), NULL), (3, 'lock@x.vn', 'x', 'Bình khoá', 'locked', now(), NULL), \
      (4, 'del@x.vn', 'x', 'Chi xoá', 'active', now(), now()), (5, 'view@x.vn', 'x', 'Dũng chỉ xem', 'active', now(), NULL), (6, 'none@x.vn', 'x', 'Em không vai', 'active', now(), NULL); \
      INSERT INTO roles (id, name, is_system, updated_at) VALUES (1, 'Quản trị', true, now()), (2, 'HR', false, now()), (3, 'Xem', false, now()); \
      INSERT INTO role_permissions (role_id, permission, scope) VALUES (2, 'recruitment.manage', NULL), (3, 'recruitment.view', NULL); \
      INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (2, 2), (3, 2), (4, 2), (5, 3)").await;
    let rs = rc::list_recruiters(&mut c).await.unwrap();
    assert_eq!(
        js(&rs),
        r#"[{"id":2,"full_name":"An HR","email":"hr@x.vn"},{"id":1,"full_name":"Zed Admin","email":"ad@x.vn"}]"#
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn so_ngoai_int4_trang_qua_lon_va_thu_tu_khoa_stats() {
    let mut c = setup().await;
    // Số hợp lệ theo class-validator nhưng ngoài int4: 400, KHÔNG lưu NULL và KHÔNG xoá giá trị cũ.
    let big = 3_000_000_000_i64;
    expect_err(
        rc::create_candidate(
            &mut c,
            &body("CreateCandidateDto", json!({"full_name": "A", "cost": big})),
            1,
        )
        .await,
        400,
        "cost phải nhỏ hơn hoặc bằng 2147483647",
    );
    expect_err(
        rc::create_candidate(
            &mut c,
            &body("CreateCandidateDto", json!({"full_name": "A", "recruiter_id": big})),
            1,
        )
        .await,
        400,
        "recruiter_id",
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM recruitment_candidates")
            .fetch_one(&mut c)
            .await
            .unwrap(),
        0,
        "không tạo dòng nào"
    );
    let a = rc::create_candidate(
        &mut c,
        &body(
            "CreateCandidateDto",
            json!({"full_name": "A", "cost": 100, "applied_date": "2026-03"}),
        ),
        1,
    )
    .await
    .unwrap();
    assert_eq!(a.applied_date.as_deref(), Some("2026-03-01"), "YYYY-MM");
    expect_err(
        rc::update_candidate(
            &mut c,
            a.id,
            &body("UpdateCandidateDto", json!({"full_name": "B", "cost": big})),
        )
        .await,
        400,
        "cost phải nhỏ hơn hoặc bằng 2147483647",
    );
    let after = rc::list_candidates(&mut c, &query("QueryCandidatesDto", json!({})))
        .await
        .unwrap();
    assert_eq!(
        (after.data[0].cost, after.data[0].full_name.as_str()),
        (Some(100), "A"),
        "không đổi gì khi một trường lỗi"
    );
    let dto = |extra: Value| {
        let mut v = json!({"job_code": "J", "department": "D", "position_title": "T", "headcount": 1, "recruiter_id": 1, "opened_date": "2026-01-01"});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };
    expect_err(
        rc::create_position(&mut c, &body("CreatePositionDto", dto(json!({"headcount": big}))), 1).await,
        400,
        "headcount",
    );
    expect_err(
        rc::create_position(
            &mut c,
            &body("CreatePositionDto", dto(json!({"recruitment_cost": big}))),
            1,
        )
        .await,
        400,
        "recruitment_cost",
    );
    // Các dạng ngày mà `@IsDateString` và `new Date` cùng nhận.
    for (input, want) in [
        ("2026", "2026-01-01"),
        ("2026-03-10 01:00+07:00", "2026-03-09"),
        ("2026-03-10T01:00+0700", "2026-03-09"),
        ("2026-03-10T01:00Z", "2026-03-10"),
        ("2026-02-30", "2026-03-02"),
    ] {
        let p = rc::create_position(
            &mut c,
            &body("CreatePositionDto", dto(json!({"opened_date": input}))),
            1,
        )
        .await
        .unwrap();
        assert_eq!(p.opened_date.as_deref(), Some(want), "{input}");
    }
    // Trang quá lớn: trang rỗng, không tràn số.
    let far = rc::list_candidates(
        &mut c,
        &query(
            "QueryCandidatesDto",
            json!({"page": "9007199254740991", "page_size": "100"}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        (far.data.len(), far.pagination.total, far.pagination.has_more),
        (0, 1, false)
    );
    let far_p = rc::list_positions(&mut c, &query("QueryPositionsDto", json!({"page": "9007199254740991"})))
        .await
        .unwrap();
    assert!(far_p.data.is_empty());
    // Thứ tự khoá `/stats` như Node.
    let s = js(&rc::stats(&mut c, &query("QueryRecruitmentStatsDto", json!({})))
        .await
        .unwrap());
    assert!(s.starts_with(r#"{"total":1,"total_cost":100,"by_source":{"#), "{s}");
    assert!(
        s.find("by_stage").unwrap() < s.find("by_decision").unwrap()
            && s.find("by_decision").unwrap() < s.find("by_type").unwrap()
            && s.find("by_type").unwrap() < s.find("by_month").unwrap(),
        "{s}"
    );
}
