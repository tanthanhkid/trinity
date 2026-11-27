//! M29: cấu hình lương, bảo hiểm, thuế, bảng lương và KPI trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-payroll --test pg -- --ignored`
//! Dữ liệu mang tiền tố `m29`, tự dọn; các test chạy nối tiếp.

use mod_payroll::components::{self, CreateComponent, UpdateComponent};
use mod_payroll::insurance::{self, CreateInsurance, UpdateInsurance};
use mod_payroll::kpi::{self, AggregatedKpiData, CreateConfig, KpiAggregator};
use mod_payroll::rules::{self, CreateRule, UpdateRule};
use mod_payroll::tax::{self, CreateBracket, CreateSetting, UpdateBracket, UpdateSetting};
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

fn json(v: &impl serde::Serialize) -> serde_json::Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

fn from<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Chuỗi `Decimal` như JSON trả (không số 0 thừa: `8`, `10.5`).
fn ds(d: trinity_db::types::DecimalJs) -> String {
    json(&d).as_str().unwrap().to_owned()
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn clean(c: &mut PgConnection) {
    exec(c, "DELETE FROM kpi_results WHERE metric_name LIKE 'm29%' OR employee_id IN (SELECT id FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm29%@test.local'))").await;
    exec(c, "DELETE FROM kpi_configs WHERE metric_name LIKE 'm29%'").await;
    exec(
        c,
        "DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm29%@test.local')",
    )
    .await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm29%@test.local'").await;
    exec(c, "DELETE FROM salary_rule_details WHERE salary_rule_id IN (SELECT id FROM salary_rules WHERE position LIKE 'm29%')").await;
    exec(c, "DELETE FROM salary_rules WHERE position LIKE 'm29%'").await;
    exec(c, "DELETE FROM salary_components WHERE code LIKE 'm29%'").await;
    exec(c, "DELETE FROM insurance_settings WHERE code LIKE 'm29%'").await;
    exec(c, "DELETE FROM tax_brackets WHERE effective_from = '2099-01'").await;
    exec(c, "DELETE FROM payroll_tax_settings WHERE effective_from = '2099-01'").await;
}

async fn employee(c: &mut PgConnection, tag: &str, position: &str) -> (i32, i32) {
    let uid: i32 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m29{tag}@test.local', 'x', 'M29', now()) RETURNING id"
    )))
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let eid: i32 =
        sqlx::query_scalar("INSERT INTO employees (user_id, position, status) VALUES ($1, $2, 'active') RETURNING id")
            .bind(uid)
            .bind(position)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    (uid, eid)
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn thue_bac_va_giam_tru() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;

    let b: CreateBracket = from(
        serde_json::json!({"bracket_order": 1, "lower_bound": 0, "upper_bound": 5_000_000, "rate": 5, "effective_from": "2099-01"}),
    );
    b.validate().unwrap();
    let b1 = tax::create_bracket(&mut c, &b, Some(1)).await.unwrap();
    let v = json(&b1);
    assert_eq!(
        (
            v["rate"].as_str(),
            v["lower_bound"].as_i64(),
            v["upper_bound"].as_i64(),
            v["is_active"].as_bool()
        ),
        (Some("5"), Some(0), Some(5_000_000), Some(true))
    );
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        &keys[..5],
        ["id", "bracket_order", "lower_bound", "upper_bound", "rate"]
    );

    let rev_b: CreateBracket = from(
        serde_json::json!({"bracket_order": 3, "lower_bound": 0, "rate": 1, "effective_from": "2099-05", "effective_to": "2099-04"}),
    );
    assert_eq!(
        status(tax::create_bracket(&mut c, &rev_b, None).await.unwrap_err()).0,
        400
    );
    let rev_s: CreateSetting = from(
        serde_json::json!({"personal_deduction": 1, "dependent_deduction": 1, "effective_from": "2099-05", "effective_to": "2099-04"}),
    );
    assert_eq!(
        status(tax::create_setting(&mut c, &rev_s, None).await.unwrap_err()).0,
        400
    );
    let rev_u: UpdateBracket = from(serde_json::json!({"effective_to": "2098-12"}));
    assert_eq!(
        status(tax::update_bracket(&mut c, b1.id, &rev_u).await.unwrap_err()).0,
        400
    );
    // Cận trên ≤ cận dưới ⇒ 400 (tạo và sửa).
    let bad: CreateBracket = from(
        serde_json::json!({"bracket_order": 2, "lower_bound": 100, "upper_bound": 100, "rate": 10, "effective_from": "2099-01"}),
    );
    assert_eq!(
        status(tax::create_bracket(&mut c, &bad, None).await.unwrap_err()),
        (400, "\"Cận trên phải lớn hơn cận dưới\"".to_owned())
    );
    let up: UpdateBracket = from(serde_json::json!({"lower_bound": 6_000_000}));
    assert_eq!(
        status(tax::update_bracket(&mut c, b1.id, &up).await.unwrap_err()).0,
        400
    );
    // `upper_bound: null` ⇒ bậc cao nhất; rate số thập phân.
    let up: UpdateBracket = from(serde_json::json!({"upper_bound": null, "rate": 7.5, "effective_to": "2099-12"}));
    let b2 = json(&tax::update_bracket(&mut c, b1.id, &up).await.unwrap());
    assert_eq!(
        (
            b2["upper_bound"].is_null(),
            b2["rate"].as_str(),
            b2["effective_to"].as_str()
        ),
        (true, Some("7.5"), Some("2099-12"))
    );
    assert_eq!(
        status(
            tax::update_bracket(&mut c, 2_000_000_000, &UpdateBracket::default())
                .await
                .unwrap_err()
        ),
        (404, "\"Không tìm thấy bậc thuế\"".to_owned())
    );

    let s: CreateSetting = from(
        serde_json::json!({"personal_deduction": 11_000_000, "dependent_deduction": 4_400_000, "effective_from": "2099-01"}),
    );
    let s1 = tax::create_setting(&mut c, &s, None).await.unwrap();
    let us: UpdateSetting = from(serde_json::json!({"dependent_deduction": 6_000_000, "is_active": false}));
    let s2 = tax::update_setting(&mut c, s1.id, &us).await.unwrap();
    assert_eq!(
        (s2.dependent_deduction.0, s2.personal_deduction.0, s2.is_active),
        (6_000_000, 11_000_000, false)
    );
    assert_eq!(
        status(
            tax::update_setting(&mut c, 2_000_000_000, &UpdateSetting::default())
                .await
                .unwrap_err()
        )
        .0,
        404
    );

    let cfg = tax::get_config(&mut c).await.unwrap();
    assert!(cfg.brackets.iter().any(|x| x.id == b1.id) && cfg.settings.iter().any(|x| x.id == s1.id));
    assert_eq!(
        json(&tax::remove_bracket(&mut c, b1.id).await.unwrap()),
        serde_json::json!({"ok": true, "id": b1.id})
    );
    assert_eq!(status(tax::remove_bracket(&mut c, b1.id).await.unwrap_err()).0, 404);
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn bao_hiem_khong_chong_lan() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;

    let mk = |v: serde_json::Value| -> CreateInsurance {
        let i: CreateInsurance = from(v);
        i.validate().unwrap();
        i
    };
    let a = insurance::create(
        &mut c,
        &mk(serde_json::json!({"name": " BHXH ", "code": "m29_bhxh", "employee_rate": 8, "base_cap": 46_800_000, "effective_from": "2024-07", "effective_to": "2025-06"})),
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(
        (a.name.as_str(), ds(a.employee_rate), a.base_cap.map(|v| v.0)),
        ("BHXH", "8".to_owned(), Some(46_800_000))
    );
    // Chồng lấn cùng mã đang áp dụng ⇒ 400; kề nhau (2025-07) thì được; khác mã thì được; dòng tắt thì được.
    let overlap =
        mk(serde_json::json!({"name": "x", "code": "m29_bhxh", "employee_rate": 8, "effective_from": "2025-06"}));
    let (code, msg) = status(insurance::create(&mut c, &overlap, None).await.unwrap_err());
    assert_eq!(code, 400);
    assert!(msg.contains("chồng lấn"), "{msg}");
    let b = insurance::create(&mut c, &mk(serde_json::json!({"name": "BHXH mới", "code": "m29_bhxh", "employee_rate": 8.5, "effective_from": "2025-07"})), None).await.unwrap();
    assert_eq!(ds(b.employee_rate), "8.5");
    insurance::create(
        &mut c,
        &mk(serde_json::json!({"name": "BHYT", "code": "m29_bhyt", "employee_rate": 1.5, "effective_from": "2024-07"})),
        None,
    )
    .await
    .unwrap();
    insurance::create(&mut c, &mk(serde_json::json!({"name": "tắt", "code": "m29_bhxh", "employee_rate": 1, "effective_from": "2024-07", "is_active": false})), None).await.unwrap();
    // effective_to < effective_from ⇒ 400.
    let rev = mk(
        serde_json::json!({"name": "x", "code": "m29_rev", "employee_rate": 1, "effective_from": "2025-05", "effective_to": "2025-04"}),
    );
    assert_eq!(status(insurance::create(&mut c, &rev, None).await.unwrap_err()).0, 400);
    // Sửa: dòng a kéo dài sang 2025-07 thì chồng lấn dòng b; sửa chính nó không tự chồng; đóng `effective_to` bằng null.
    let ext: UpdateInsurance = from(serde_json::json!({"effective_to": "2025-07"}));
    assert_eq!(status(insurance::update(&mut c, a.id, &ext).await.unwrap_err()).0, 400);
    let same: UpdateInsurance = from(serde_json::json!({"employee_rate": 9, "sort_order": 3}));
    let a2 = insurance::update(&mut c, a.id, &same).await.unwrap();
    assert_eq!((ds(a2.employee_rate), a2.sort_order), ("9".to_owned(), 3));
    let open: UpdateInsurance = from(serde_json::json!({"effective_to": null, "is_active": false}));
    let a3 = insurance::update(&mut c, a.id, &open).await.unwrap();
    assert_eq!((a3.effective_to, a3.is_active), (None, false));
    assert_eq!(
        status(
            insurance::update(&mut c, 2_000_000_000, &UpdateInsurance::default())
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    let all = insurance::find_all(&mut c).await.unwrap();
    assert!(
        all.windows(2)
            .all(|w| (w[0].sort_order, w[0].id) <= (w[1].sort_order, w[1].id))
    );
    assert_eq!(json(&insurance::remove(&mut c, b.id).await.unwrap())["ok"], true);
    assert_eq!(status(insurance::remove(&mut c, b.id).await.unwrap_err()).0, 404);
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn thanh_phan_luong_chuan_hoa_cach_tinh() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let mk = |v: serde_json::Value| -> CreateComponent {
        let i: CreateComponent = from(v);
        i.validate().unwrap();
        i
    };
    // fixed: bỏ percent_value; mặc định applies_to = all, is_taxable = true.
    let f = components::create(
        &mut c,
        &mk(serde_json::json!({"name": "Điện thoại", "code": "m29_phone", "component_type": "allowance", "fixed_amount": 300_000, "percent_value": 9, "effective_from": "2026-07"})),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        (
            f.calc_method.as_str(),
            f.fixed_amount.map(|v| v.0),
            f.percent_value.is_none(),
            f.applies_to.as_str(),
            f.is_taxable
        ),
        ("fixed", Some(300_000), true, "all", true)
    );
    // percent_base: bỏ fixed_amount.
    let p = components::create(
        &mut c,
        &mk(serde_json::json!({"name": "Thưởng", "code": "m29_bonus", "component_type": "bonus", "calc_method": "percent_base", "percent_value": 10.5, "fixed_amount": 5, "applies_to": "rank:A1", "effective_from": "2026-07", "description": " ghi chú "})),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        (
            p.fixed_amount.is_none(),
            p.percent_value.map(ds),
            p.description.as_deref()
        ),
        (true, Some("10.5".to_owned()), Some("ghi chú"))
    );
    // Mã trùng ⇒ 409.
    let dup = mk(
        serde_json::json!({"name": "x", "code": "m29_phone", "component_type": "bonus", "effective_from": "2026-07"}),
    );
    assert_eq!(
        status(components::create(&mut c, &dup, None).await.unwrap_err()),
        (409, "\"Mã thành phần lương đã tồn tại\"".to_owned())
    );
    // Đổi cách tính: fixed → percent_base xoá fixed_amount; chỉ gửi số thì theo cách tính hiện tại.
    let to_pct: UpdateComponent = from(serde_json::json!({"calc_method": "percent_base", "percent_value": 12}));
    let f2 = components::update(&mut c, f.id, &to_pct).await.unwrap();
    assert_eq!(
        (
            f2.calc_method.as_str(),
            f2.fixed_amount.is_none(),
            f2.percent_value.map(ds)
        ),
        ("percent_base", true, Some("12".to_owned()))
    );
    // Gửi giá trị của cách tính KHÔNG khớp (cách tính hiện tại là percent_base) ⇒ 400, dòng giữ nguyên.
    let only_fixed: UpdateComponent = from(serde_json::json!({"fixed_amount": 7}));
    assert_eq!(
        status(components::update(&mut c, f.id, &only_fixed).await.unwrap_err()).0,
        400
    );
    let mismatch: UpdateComponent = from(serde_json::json!({"calc_method": "fixed", "percent_value": 5}));
    assert_eq!(
        status(components::update(&mut c, f.id, &mismatch).await.unwrap_err()).0,
        400
    );
    assert_eq!(
        ds(components::find_all(&mut c, None)
            .await
            .unwrap()
            .iter()
            .find(|x| x.id == f.id)
            .unwrap()
            .percent_value
            .unwrap()),
        "12"
    );
    // Đổi cách tính mà không gửi giá trị ⇒ mặc định 0 như lúc tạo; gửi lại cùng cách tính không đổi giá trị.
    let to_fixed: UpdateComponent = from(serde_json::json!({"calc_method": "fixed"}));
    let z = components::update(&mut c, f.id, &to_fixed).await.unwrap();
    assert_eq!(
        (z.fixed_amount.map(|v| v.0), z.percent_value.is_none()),
        (Some(0), true)
    );
    let to_pct0: UpdateComponent = from(serde_json::json!({"calc_method": "percent_base"}));
    let z = components::update(&mut c, f.id, &to_pct0).await.unwrap();
    assert_eq!(
        (z.fixed_amount.is_none(), z.percent_value.map(ds)),
        (true, Some("0".to_owned()))
    );
    let keep: UpdateComponent = from(serde_json::json!({"calc_method": "percent_base", "percent_value": 12}));
    components::update(&mut c, f.id, &keep).await.unwrap();
    let keep2: UpdateComponent = from(serde_json::json!({"calc_method": "percent_base"}));
    assert_eq!(
        components::update(&mut c, f.id, &keep2)
            .await
            .unwrap()
            .percent_value
            .map(ds),
        Some("12".to_owned())
    );
    // effective_to < effective_from ⇒ 400 (tạo và sửa).
    let rev = mk(
        serde_json::json!({"name": "x", "code": "m29_rev", "component_type": "bonus", "effective_from": "2026-07", "effective_to": "2026-06"}),
    );
    assert_eq!(status(components::create(&mut c, &rev, None).await.unwrap_err()).0, 400);
    let rev_up: UpdateComponent = from(serde_json::json!({"effective_to": "2020-01"}));
    assert_eq!(
        status(components::update(&mut c, f.id, &rev_up).await.unwrap_err()).0,
        400
    );
    let back: UpdateComponent = from(
        serde_json::json!({"calc_method": "fixed", "fixed_amount": 450_000, "description": null, "is_taxable": false}),
    );
    let f4 = components::update(&mut c, f.id, &back).await.unwrap();
    assert_eq!(
        (
            f4.fixed_amount.map(|v| v.0),
            f4.percent_value.is_none(),
            f4.description.is_none(),
            f4.is_taxable
        ),
        (Some(450_000), true, true, false)
    );
    let clash: UpdateComponent = from(serde_json::json!({"code": "m29_bonus"}));
    assert_eq!(
        status(components::update(&mut c, f.id, &clash).await.unwrap_err()).0,
        409
    );
    assert_eq!(
        status(
            components::update(&mut c, 2_000_000_000, &UpdateComponent::default())
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    // Lọc theo loại; sắp theo sort_order rồi id.
    let only_bonus = components::find_all(&mut c, Some("bonus")).await.unwrap();
    assert!(only_bonus.iter().all(|x| x.component_type == "bonus") && only_bonus.iter().any(|x| x.id == p.id));
    assert!(components::find_all(&mut c, None).await.unwrap().len() >= 2);
    assert_eq!(json(&components::remove(&mut c, p.id).await.unwrap())["ok"], true);
    assert_eq!(status(components::remove(&mut c, p.id).await.unwrap_err()).0, 404);
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn bang_luong_cong_thuc_va_thay_chi_tiet() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let mk = |v: serde_json::Value| -> CreateRule {
        let r: CreateRule = from(v);
        r.validate().unwrap();
        r
    };
    // Công thức sai ⇒ 400 và không ghi gì.
    let bad = mk(serde_json::json!({"position": "m29_staff", "name": "Q1", "details": [
        {"component": "base", "amount": "7000000"}, {"component": "kpi_bonus", "formula": "base * "}]}));
    let (code, msg) = status(rules::create(&mut c, &bad).await.unwrap_err());
    assert_eq!(code, 400);
    assert!(msg.contains("kpi_bonus") && msg.contains("base *"), "{msg}");
    assert!(rules::find_all(&mut c, Some("m29_staff")).await.unwrap().is_empty());

    let ok = mk(
        serde_json::json!({"position": "m29_staff", "name": "Q1/2026", "description": "mô tả", "details": [
        {"component": "base", "amount": "7000000"},
        {"component": "kpi_bonus", "formula": "max(0, (achievement_rate - 100) * base * 0.01)", "params": {"rate": 0.05}, "order": 5},
        {"component": "allowance", "amount": "0"}]}),
    );
    let w = json(&rules::create(&mut c, &ok).await.unwrap());
    // Ghi: amount là chuỗi, order mặc định theo vị trí.
    assert_eq!(
        (
            w["details"][0]["amount"].as_str(),
            w["details"][0]["order"].as_i64(),
            w["details"][1]["order"].as_i64(),
            w["details"][2]["amount"].as_str()
        ),
        (Some("7000000"), Some(0), Some(5), Some("0"))
    );
    assert_eq!(w["details"][1]["params"], serde_json::json!({"rate": 0.05}));
    let id = w["id"].as_i64().unwrap() as i32;
    // Đọc: amount là số, chi tiết sắp theo order.
    let r = json(&rules::find_by_id(&mut c, id).await.unwrap());
    assert_eq!(
        (
            r["details"][0]["amount"].as_i64(),
            r["details"][2]["order"].as_i64(),
            r["description"].as_str()
        ),
        (Some(7_000_000), Some(5), Some("mô tả"))
    );
    let keys: Vec<_> = r.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["id", "position", "name", "description", "details"]);
    assert_eq!(rules::find_all(&mut c, Some("m29_staff")).await.unwrap().len(), 1);
    assert_eq!(
        status(rules::find_by_id(&mut c, 2_000_000_000).await.unwrap_err()),
        (404, "\"Bảng lương #2000000000 không tồn tại\"".to_owned())
    );

    // Sửa không gửi details: giữ nguyên chi tiết; description null xoá.
    let up: UpdateRule = from(serde_json::json!({"name": "Q2/2026", "description": null}));
    up.validate().unwrap();
    let u = json(&rules::update(&mut c, id, &up).await.unwrap());
    assert_eq!(
        (
            u["name"].as_str(),
            u["description"].is_null(),
            u["details"].as_array().unwrap().len()
        ),
        (Some("Q2/2026"), true, 3)
    );
    // Công thức sai khi sửa ⇒ 400 và chi tiết cũ còn nguyên; hợp lệ thì thay toàn bộ.
    let bad: UpdateRule = from(serde_json::json!({"details": [{"component": "base", "formula": "foo(1)"}]}));
    assert_eq!(status(rules::update(&mut c, id, &bad).await.unwrap_err()).0, 400);
    assert_eq!(rules::find_by_id(&mut c, id).await.unwrap().details.len(), 3);
    let repl: UpdateRule = from(serde_json::json!({"details": [{"component": "base", "formula": "revenue * 0.005"}]}));
    let u = json(&rules::update(&mut c, id, &repl).await.unwrap());
    assert_eq!(
        (
            u["details"].as_array().unwrap().len(),
            u["details"][0]["formula"].as_str(),
            u["details"][0]["amount"].is_null()
        ),
        (1, Some("revenue * 0.005"), true)
    );
    assert_eq!(
        status(
            rules::update(&mut c, 2_000_000_000, &UpdateRule::default())
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    clean(&mut c).await;
}

struct Fixed(&'static str, f64);

impl KpiAggregator for Fixed {
    fn aggregate_for_employee(&self, _user_id: i32, _month: &str) -> AggregatedKpiData {
        AggregatedKpiData::from([(self.0.to_owned(), self.1)])
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn kpi_cau_hinh_tinh_va_chot_thang() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let (uid, eid) = employee(&mut c, "a", "sales").await;
    let (_u2, eid2) = employee(&mut c, "b", "operations").await;

    let cfg = |v: serde_json::Value| -> CreateConfig {
        let r: CreateConfig = from(v);
        r.validate().unwrap();
        r
    };
    // Cấu hình: 409 khi trùng (role, metric); target/weight là chuỗi Decimal.
    let day = kpi::create_config(&mut c, &cfg(serde_json::json!({"role": "sales", "metric_name": "m29 tasks/day", "target": 5, "weight": 40, "unit": "count"}))).await.unwrap();
    assert_eq!(
        (ds(day.target), day.weight.map(ds), day.working_days_per_month),
        ("5".to_owned(), Some("40".to_owned()), 24)
    );
    let rev = kpi::create_config(&mut c, &cfg(serde_json::json!({"role": "sales", "metric_name": "m29 revenue", "target": 1000, "working_days_per_month": 20}))).await.unwrap();
    assert_eq!((rev.weight.is_none(), rev.working_days_per_month), (true, 20));
    let dup = kpi::create_config(
        &mut c,
        &cfg(serde_json::json!({"role": "sales", "metric_name": "m29 revenue", "target": 1})),
    )
    .await
    .unwrap_err();
    assert_eq!(status(dup).0, 409);
    let listed = kpi::get_configs(&mut c, Some("sales")).await.unwrap();
    assert!(listed.iter().all(|x| x.role == "sales") && listed.len() >= 2);
    let v = json(&day);
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "role",
            "metric_name",
            "target",
            "unit",
            "weight",
            "working_days_per_month"
        ]
    );

    // Chưa có kết quả ⇒ 404; tính với nguồn số liệu: 60/120 = 50%, 1500/1000 = 150%.
    assert_eq!(
        status(kpi::get_mine(&mut c, uid, eid, "2099-03").await.unwrap_err()).0,
        404
    );
    let ids = [i64::from(eid), i64::from(eid2)];
    // Chưa có nguồn số liệu ⇒ 501 và không ghi gì (không ghi đè chỉ số bằng 0).
    assert_eq!(
        status(kpi::calculate(&mut c, "2099-03", Some(&ids), None).await.unwrap_err()).0,
        501
    );
    let none: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM kpi_results WHERE month = '2099-03'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(none, 0);
    let processed = kpi::calculate(&mut c, "2099-03", Some(&ids), Some(&Fixed("m29 tasks/day", 60.0)))
        .await
        .unwrap();
    // Nhân viên `operations` không có cấu hình nên không sinh dòng nào, nhưng vẫn được duyệt.
    assert_eq!(processed["processed"], 2);
    let mine = json(&kpi::get_mine(&mut c, uid, eid, "2099-03").await.unwrap());
    assert_eq!(
        mine["metrics"]["m29 tasks/day"],
        serde_json::json!({"actual": "60", "target": "120", "rate": "50", "achieved": false})
    );
    assert_eq!(mine["metrics"]["m29 revenue"]["actual"], "0");
    // (50 + 0) / 2 = 25 ⇒ behind.
    assert_eq!(
        (
            mine["achievement_rate"].as_f64(),
            mine["status"].as_str(),
            mine["is_locked"].as_bool()
        ),
        (Some(25.0), Some("behind"), Some(false))
    );
    let keys: Vec<_> = mine.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "employee_id",
            "month",
            "metrics",
            "achievement_rate",
            "status",
            "is_locked"
        ]
    );
    // Tính lại cập nhật chứ không nhân đôi dòng.
    kpi::calculate(&mut c, "2099-03", Some(&ids), Some(&Fixed("m29 revenue", 1500.0)))
        .await
        .unwrap();
    let again = json(&kpi::get_mine(&mut c, uid, eid, "2099-03").await.unwrap());
    assert_eq!(
        (
            again["metrics"]["m29 revenue"]["rate"].as_str(),
            again["metrics"]["m29 revenue"]["achieved"].as_bool(),
            again["metrics"]["m29 tasks/day"]["actual"].as_str()
        ),
        (Some("150"), Some(true), Some("0"))
    );
    assert_eq!(
        (again["achievement_rate"].as_f64(), again["status"].as_str()),
        (Some(75.0), Some("behind"))
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM kpi_results WHERE employee_id = $1 AND month = '2099-03'")
        .bind(eid)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n, 2);

    // Chỉ xem KPI của CHÍNH mình: hồ sơ người khác ⇒ 404 "Không tìm thấy".
    assert_eq!(
        status(kpi::get_mine(&mut c, uid, eid2, "2099-03").await.unwrap_err()),
        (404, "\"Không tìm thấy\"".to_owned())
    );
    assert_eq!(
        status(kpi::get_mine(&mut c, uid, 2_000_000_000, "2099-03").await.unwrap_err()).0,
        404
    );

    // Chốt tháng: không có dữ liệu ⇒ 404; chốt ⇒ khoá; chốt lại ⇒ 409; tính lại ⇒ 400.
    assert_eq!(status(kpi::close_month(&mut c, "2099-04").await.unwrap_err()).0, 404);
    let closed = kpi::close_month(&mut c, "2099-03").await.unwrap();
    assert_eq!(
        (closed["closed"].as_bool(), closed["locked_count"].as_i64()),
        (Some(true), Some(2))
    );
    assert_eq!(status(kpi::close_month(&mut c, "2099-03").await.unwrap_err()).0, 409);
    assert_eq!(
        status(
            kpi::calculate(&mut c, "2099-03", None, Some(&Fixed("m29 revenue", 1.0)))
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    let locked = json(&kpi::get_mine(&mut c, uid, eid, "2099-03").await.unwrap());
    assert_eq!(locked["is_locked"], true);
    clean(&mut c).await;
}

/// Hai request đồng thời cùng mã và khoảng tháng chồng nhau: đúng một cái được ghi (khoá advisory theo mã).
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn bao_hiem_dong_thoi_khong_chong_lan() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    for round in 0..10 {
        let code = format!("m29_race{round}");
        let mk = |name: &str| -> CreateInsurance {
            from(serde_json::json!({"name": name, "code": code, "employee_rate": 8, "effective_from": "2024-07"}))
        };
        let (a, b) = (mk("a"), mk("b"));
        let (mut ca, mut cb) = (conn().await, conn().await);
        let (ta, tb) = (
            tokio::spawn(async move { insurance::create(&mut ca, &a, None).await.map(|_| ()) }),
            tokio::spawn(async move { insurance::create(&mut cb, &b, None).await.map(|_| ()) }),
        );
        let (ra, rb) = (ta.await.unwrap(), tb.await.unwrap());
        assert_eq!(u8::from(ra.is_ok()) + u8::from(rb.is_ok()), 1, "vòng {round}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM insurance_settings WHERE code = $1")
            .bind(&code)
            .fetch_one(&mut *c)
            .await
            .unwrap();
        assert_eq!(n, 1, "vòng {round}");
    }
    clean(&mut c).await;
}

/// M30a: đọc cấu hình thật từ DB rồi tính phiếu; kết quả khớp tay (bảng bước tính ở `calc.rs`).
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tinh_phieu_tu_cau_hinh_db() {
    use mod_payroll::calc::{EmployeeInput, ManualInput, compute_payslip, kpi_achieved_count, load_config};
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    // Cấu hình mẫu 2099: bảo hiểm 8% (trần 46,8tr) và 1,5%, giảm trừ 11tr/4,4tr, hai bậc thuế, một phụ cấp, một khấu trừ %.
    for (code, rate, to) in [("m29_bhxh", 8.0, None::<&str>), ("m29_bhyt", 1.5, None)] {
        let i: CreateInsurance = from(
            serde_json::json!({"name": code, "code": code, "employee_rate": rate, "base_cap": 46_800_000, "effective_from": "2099-01", "effective_to": to, "sort_order": 1}),
        );
        insurance::create(&mut c, &i, None).await.unwrap();
    }
    let s: CreateSetting = from(
        serde_json::json!({"personal_deduction": 11_000_000, "dependent_deduction": 4_400_000, "effective_from": "2099-01"}),
    );
    tax::create_setting(&mut c, &s, None).await.unwrap();
    for (order, lo, up, rate) in [(1, 0, Some(5_000_000), 5), (2, 5_000_000, None, 10)] {
        let b: CreateBracket = from(
            serde_json::json!({"bracket_order": order, "lower_bound": lo, "upper_bound": up, "rate": rate, "effective_from": "2099-01"}),
        );
        tax::create_bracket(&mut c, &b, None).await.unwrap();
    }
    let a: CreateComponent = from(
        serde_json::json!({"name": "ĐT", "code": "m29_phone", "component_type": "allowance", "fixed_amount": 500_000, "effective_from": "2099-01"}),
    );
    components::create(&mut c, &a, None).await.unwrap();
    let d: CreateComponent = from(
        serde_json::json!({"name": "Phạt", "code": "m29_late", "component_type": "deduction", "calc_method": "percent_base", "percent_value": 0.5, "effective_from": "2099-01"}),
    );
    components::create(&mut c, &d, None).await.unwrap();

    let cfg = load_config(&mut c).await.unwrap();
    let emp = EmployeeInput {
        rank_code: None,
        insurance_salary: None,
        default_insurance_salary: None,
        dependents_count: 1,
    };
    let manual = ManualInput {
        working_days: Some(12.0),
        standard_working_days: 24,
        base_salary: 20_000_000,
        training_salary: 0,
        probation_allowance: 0,
        bonus_sales_personal: 0,
        bonus_cskh_team: 0,
        bonus_milestone: 1_000_000,
        bonus_referral: 0,
        holiday_bonus: 0,
        advances: 100_000,
        personal_income_tax: 0,
    };
    // Tháng ngoài hiệu lực: không bảo hiểm, thuế, thành phần.
    let before = compute_payslip(&cfg, "2098-12", 20_000_000, 0, &emp, &manual).unwrap();
    // Tổng lương 10tr + 1tr = 11tr, trừ tạm ứng 100.000.
    assert_eq!(
        (
            before.total,
            before.deductions,
            before.insurance_json.len(),
            before.tax_json.is_none()
        ),
        (10_900_000, 0, 0, true)
    );
    let r = compute_payslip(&cfg, "2099-03", 20_000_000, 2, &emp, &manual).unwrap();
    // Thực lĩnh LCB = 20tr × 12/24 = 10tr; + thưởng mốc 1tr ⇒ tổng lương 11tr. Lương đóng BH là lương HĐ (không theo ngày
    // công): 20tr × 8% = 1.600.000, 20tr × 1,5% = 300.000 ⇒ 1.900.000. Thuế: 11tr − 1,9tr − 11tr − 4,4tr < 0 ⇒ 0.
    // Khấu trừ cấu hình: 0,5% × 20tr = 100.000. Khấu trừ = 100.000 + 1.900.000 + 0 = 2.000.000.
    // Thực nhận = 11.000.000 − 2.000.000 − 100.000 = 8.900.000. Phụ cấp 500.000 chỉ vào ảnh chụp thành phần.
    assert_eq!(
        (
            r.base_salary_actual,
            r.insurance_base,
            r.deductions,
            r.total,
            r.kpi_bonus
        ),
        (10_000_000, 20_000_000, 2_000_000, 8_900_000, 1_000_000)
    );
    assert_eq!(r.insurance_json.len(), 2);
    assert_eq!(r.components_json.len(), 2);
    assert_eq!(r.tax_json.as_ref().unwrap()["taxable_income"], 0);
    // Ca lên bậc: lương cao, nhiều bậc.
    let high = ManualInput {
        working_days: None,
        base_salary: 60_000_000,
        ..manual.clone()
    };
    let h = compute_payslip(&cfg, "2099-03", 60_000_000, 0, &emp, &high).unwrap();
    // BH: min(60tr, 46,8tr) × 9,5% = 4.446.000. Tổng lương 61tr; chịu thuế = 61tr − 4,446tr − 11tr − 4,4tr = 41.154.000.
    // Thuế = 5tr × 5% + 36.154.000 × 10% = 250.000 + 3.615.400 = 3.865.400.
    let t = h.tax_json.unwrap();
    assert_eq!(
        (t["taxable_income"].as_i64(), t["tax"].as_i64()),
        (Some(41_154_000), Some(3_865_400))
    );
    assert_eq!(h.deductions, 300_000 + 4_446_000 + 3_865_400);
    // Số chỉ số KPI đạt đọc từ DB.
    let (_u, eid) = employee(&mut c, "k", "sales").await;
    exec(&mut c, &format!("INSERT INTO kpi_results (employee_id, month, metric_name, actual_value, target_value, achieved) VALUES ({eid}, '2099-03', 'm29 a', 1, 1, true), ({eid}, '2099-03', 'm29 b', 0, 1, false), ({eid}, '2099-03', 'm29 c', 2, 1, true)")).await;
    assert_eq!(kpi_achieved_count(&mut c, eid, "2099-03").await.unwrap(), 2);
    clean(&mut c).await;
}

/// M30b: tạo, tính, sửa, duyệt hai bước (thông báo ghi cùng giao dịch), loại và khôi phục phiếu lương; hồ sơ nhân viên.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn phieu_luong_tao_sua_duyet_loai() {
    use mod_payroll::employees::{self, CreateEmployee, UpdateEmployee};
    use mod_payroll::payslips::{
        self, AddToPeriodInput, ApproveInput, Approver, GenerateInput, QueryPayslips, UpdatePayslip,
    };
    let _g = serial().lock().await;
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 2;
    let db = Db::connect(&cfg).await.expect("nối DB");
    let tenant = db.tenant(CompanyRef::DEFAULT).await.expect("tenant");
    let mut c = tenant.acquire().await.expect("acquire");
    exec(&mut c, "DELETE FROM payslips WHERE month = '2099-05'").await;
    clean(&mut c).await;
    let (u1, e1) = employee(&mut c, "p1", "sales").await;
    let (u2, _) = employee(&mut c, "p2", "sales").await;

    // Hồ sơ nhân viên: trùng user ⇒ 409; `null` ở cột bắt buộc không qua được serde.
    let dup: CreateEmployee =
        from(serde_json::json!({"user_id": u1, "position": "sales", "salary_rule_id": 1, "joined_at": "2026-01-15"}));
    assert_eq!(status(employees::create(&mut c, &dup).await.unwrap_err()).0, 409);
    let upd: UpdateEmployee = from(serde_json::json!({"department": "KD", "status": "resigned"}));
    let brief = employees::update(&mut c, e1, &upd).await.unwrap();
    assert_eq!(
        (brief.department.as_deref(), brief.status.as_str()),
        (Some("KD"), "resigned")
    );
    let back: UpdateEmployee = from(serde_json::json!({"status": "active"}));
    employees::update(&mut c, e1, &back).await.unwrap();
    let detail = employees::find_by_id(&mut c, e1, None).await.unwrap();
    assert_eq!(detail["status"], "active");
    assert_eq!(
        status(employees::find_by_id(&mut c, e1, Some(&[u2])).await.unwrap_err()).0,
        404
    );

    // Tạo phiếu: nhân viên active được tính; chạy lại giữ nháp.
    let g: GenerateInput = from(serde_json::json!({"month": "2099-05", "employee_ids": [e1]}));
    assert_eq!(payslips::generate(&mut c, &g).await.unwrap().generated, 1);
    let q = QueryPayslips {
        month: "2099-05".into(),
        team_id: None,
        status: None,
    };
    let list = payslips::find_all(&mut c, &q, None).await.unwrap();
    let id = i32::try_from(list[0]["id"].as_i64().unwrap()).unwrap();
    assert_eq!(list[0]["status"], "draft");
    assert_eq!(payslips::find_all(&mut c, &q, Some(&[u2])).await.unwrap().len(), 0);
    let patch: UpdatePayslip =
        from(serde_json::json!({"base_salary": "10000000", "working_days": null, "advances": "100000"}));
    let p = payslips::update(&mut c, id, &patch, None).await.unwrap();
    assert_eq!(
        (p["base_salary"].as_str(), p["advances"].as_str()),
        (Some("10000000"), Some("100000"))
    );
    assert_eq!(payslips::find_mine(&mut c, u1, Some("2099-05")).await.unwrap().len(), 1);

    // Loại khỏi kỳ rồi thêm lại.
    let r = payslips::remove_from_period(&mut c, id, u2, false).await.unwrap();
    assert_eq!(r["employee_id"], e1);
    assert_eq!(status(payslips::find_by_id(&mut c, id, None).await.unwrap_err()).0, 404);
    let again = payslips::add_to_period(
        &mut c,
        &AddToPeriodInput {
            month: "2099-05".into(),
            employee_id: i64::from(e1),
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(again["id"], id);
    drop(c);

    // Duyệt: bước 1 rồi bước 2 (thông báo cho chủ phiếu); tự duyệt ⇒ 403.
    let mut tx = tenant.begin().await.expect("begin");
    let ap = |user, team, fin| Approver {
        user_id: user,
        can_team: team,
        can_final: fin,
        team_scope: None,
    };
    let act = ApproveInput {
        action: "approve".into(),
        notes: None,
    };
    assert_eq!(
        status(
            payslips::approve(&mut tx, id, &act, &ap(u1, true, true))
                .await
                .unwrap_err()
        )
        .0,
        403
    );
    let s1 = payslips::approve(&mut tx, id, &act, &ap(u2, true, false))
        .await
        .unwrap();
    assert_eq!(s1.status, "pending_accountant");
    assert_eq!(
        status(
            payslips::approve(&mut tx, id, &act, &ap(u2, true, false))
                .await
                .unwrap_err()
        )
        .0,
        403
    );
    let s2 = payslips::approve(&mut tx, id, &act, &ap(u2, false, true))
        .await
        .unwrap();
    assert_eq!(
        (s2.status.as_str(), s2.notifications.len(), s2.notify_error.is_none()),
        ("approved", 1, true)
    );
    assert_eq!(s2.notifications[0].recipient_id, u1);
    assert_eq!(
        status(
            payslips::approve(&mut tx, id, &act, &ap(u2, true, true))
                .await
                .unwrap_err()
        )
        .0,
        409
    );
    tx.rollback().await.expect("rollback");

    let mut c = tenant.acquire().await.expect("acquire");
    exec(&mut c, "DELETE FROM payslips WHERE month = '2099-05'").await;
    clean(&mut c).await;
}
