//! M31: xuất/nhập tệp phiếu lương, PDF và báo cáo trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-payroll --test pg_files -- --ignored`
//! Dữ liệu mang tiền tố `m31`, tháng `2099-06`, tự dọn.

use mod_payroll::payslips::files::{self, XLSX_MIME};
use mod_payroll::payslips::{self, GenerateInput};
use mod_payroll::reports;
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_docgen::grid::{GridSheet, Style, write_grid};

const MONTH: &str = "2099-06";

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn clean(c: &mut PgConnection) {
    exec(c, "DELETE FROM payslips WHERE month = '2099-06'").await;
    exec(
        c,
        "DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'm31%@test.local')",
    )
    .await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm31%@test.local'").await;
}

async fn employee(c: &mut PgConnection, tag: &str) -> i32 {
    let uid: i32 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m31{tag}@test.local', 'x', 'M31 {tag}', now()) RETURNING id"
    )))
    .fetch_one(&mut *c)
    .await
    .unwrap();
    sqlx::query_scalar("INSERT INTO employees (user_id, position, status) VALUES ($1, 'sales', 'active') RETURNING id")
        .bind(uid)
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

fn status(e: trinity_kernel::error::AppError) -> u16 {
    e.response(true).0
}

/// Tệp nhập: cột A "Mã NV", cột B "Đã ứng"; mỗi phần tử là (mã, số tiền).
fn import_file(rows: &[(String, f64)]) -> Vec<u8> {
    let mut g = GridSheet::new("Nhập");
    g.text(0, 0, "Mã NV", Style::default());
    g.text(0, 1, "Đã ứng", Style::default());
    for (i, (code, n)) in rows.iter().enumerate() {
        let r = 1 + i as u32;
        g.text(r, 0, code.as_str(), Style::default());
        g.number(r, 1, *n, Style::default());
    }
    write_grid(&[g]).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn xuat_nhap_tep_va_bao_cao() {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 2;
    let db = Db::connect(&cfg).await.expect("nối DB");
    let tenant = db.tenant(CompanyRef::DEFAULT).await.expect("tenant");
    let mut c = tenant.acquire().await.expect("acquire");
    clean(&mut c).await;

    // Chưa có phiếu: xuất theo kỳ ⇒ 404.
    assert_eq!(status(files::export_bulk(&mut c, MONTH, None).await.unwrap_err()), 404);

    let e1 = employee(&mut c, "a").await;
    let e2 = employee(&mut c, "b").await;
    let g = GenerateInput {
        month: MONTH.into(),
        employee_ids: Some(vec![i64::from(e1), i64::from(e2)]),
    };
    assert_eq!(payslips::generate(&mut c, &g).await.unwrap().generated, 2);
    let ids: Vec<i32> = sqlx::query_scalar("SELECT id FROM payslips WHERE month = $1 ORDER BY employee_id")
        .bind(MONTH)
        .fetch_all(&mut *c)
        .await
        .unwrap();
    assert_eq!(ids.len(), 2);

    // Xuất từng phiếu, PDF, cả kỳ, danh sách theo thứ tự.
    let x = files::export_excel(&mut c, ids[0], None).await.unwrap();
    assert_eq!((x.content_type, x.bytes.starts_with(b"PK")), (XLSX_MIME, true));
    let p = files::export_pdf(&mut c, ids[0], None).await.unwrap();
    assert!(p.bytes.starts_with(b"%PDF"));
    assert!(
        files::export_bulk(&mut c, MONTH, None)
            .await
            .unwrap()
            .bytes
            .starts_with(b"PK")
    );
    let rev = [ids[1], ids[0]];
    assert!(
        files::export_list(&mut c, MONTH, None, Some(&rev))
            .await
            .unwrap()
            .bytes
            .starts_with(b"PK")
    );
    // Ngoài phạm vi (user lạ) ⇒ 404.
    assert_eq!(
        status(files::export_excel(&mut c, ids[0], Some(&[-1])).await.unwrap_err()),
        404
    );
    assert_eq!(status(files::export_pdf(&mut c, 0, None).await.unwrap_err()), 404);

    // Mẫu nhập mở lại được.
    assert!(
        files::import_template(&mut c, MONTH)
            .await
            .unwrap()
            .bytes
            .starts_with(b"PK")
    );

    // Nhập: phiếu 2 đã duyệt ⇒ bỏ qua; mã lạ ⇒ bỏ qua; phiếu 1 đổi "Đã ứng".
    exec(
        &mut c,
        &format!("UPDATE payslips SET status = 'approved' WHERE id = {}", ids[1]),
    )
    .await;
    let code = |e: i32| format!("NV{e:04}");
    let file = import_file(&[(code(e1), 250_000.0), (code(e2), 1.0), ("KHONG-CO".into(), 5.0)]);
    let pre = files::preview_import(&mut c, &file, MONTH).await.unwrap();
    assert_eq!(pre.len(), 3);
    assert_eq!(pre.iter().map(|r| r.skipped).collect::<Vec<_>>(), [false, true, true]);
    let before = payslips::find_by_id(&mut c, ids[0], None).await.unwrap();
    assert_ne!(before["advances"].as_str(), Some("250000"), "xem trước không ghi");
    let done = files::apply_import(&mut c, &file, MONTH).await.unwrap();
    assert_eq!(done.len(), 3);
    let after = payslips::find_by_id(&mut c, ids[0], None).await.unwrap();
    assert_eq!(after["advances"].as_str(), Some("250000"));
    let untouched = payslips::find_by_id(&mut c, ids[1], None).await.unwrap();
    assert_ne!(untouched["advances"].as_str(), Some("1"));

    // Tệp hỏng ⇒ 400.
    assert_eq!(
        status(
            files::preview_import(&mut c, b"khong phai xlsx", MONTH)
                .await
                .unwrap_err()
        ),
        400
    );

    // Báo cáo.
    let s = reports::summary(&mut c, MONTH).await.unwrap();
    assert_eq!(s.total_employees, 2);
    assert!(!reports::by_department(&mut c, MONTH).await.unwrap().is_empty());
    let cmp = reports::comparison(&mut c, &[MONTH.to_owned()]).await.unwrap();
    assert_eq!(cmp.len(), 1);

    clean(&mut c).await;
}
