//! Nhóm "Hiệu suất nhân viên" (`report-employee-performance*.service.ts`): khách mới được giao và số hoạt động trong kỳ của từng
//! nhân viên TRONG phạm vi quyền `reports.staff`, và xuất xlsx (cần thêm `reports.export`).

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use trinity_docgen::xlsx::{Cell, Column, SheetSpec, write_xlsx};
use trinity_kernel::error::AppError;
use trinity_rbac::OwnerIds;

use crate::customers::split_owner;
use crate::period::{Period, parse_period};
use crate::{Actor, Ctx, R, db, now};

/// Trần số dòng xuất (không phải PII khách hàng: chỉ tên nhân viên và số liệu tổng hợp).
pub const EXPORT_CAP: usize = 5_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub user_id: i32,
    pub full_name: String,
    pub email: String,
    pub new_customers: i64,
    pub activities_count: i64,
}

impl Row {
    fn to_json(&self) -> Value {
        json!({
            "user_id": self.user_id, "full_name": self.full_name, "email": self.email,
            "new_customers": self.new_customers, "activities_count": self.activities_count,
        })
    }
}

/// Bảng hiệu suất: chỉ nhân viên trong phạm vi (nhóm theo `assigned_to` / `created_by`, nên ghim cả cột nhóm vào phạm vi để
/// khách do mình tạo nhưng giao cho người ngoài phạm vi không làm lộ dòng của người đó).
pub async fn rows(ctx: &Ctx, actor: &Actor, p: Period) -> R<Vec<Row>> {
    let owner = ctx
        .owner_ids(actor, "reports.staff")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    if matches!(&owner, OwnerIds::Ids(v) if v.is_empty()) {
        return Ok(Vec::new());
    }
    let (all, ids) = split_owner(&owner);
    let mut c = ctx.conn(actor.company).await?;
    let by_customer: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT assigned_to, count(*) FROM contacts WHERE deleted_at IS NULL AND created_at >= $3 AND created_at <= $4
           AND assigned_to IS NOT NULL AND ($1 OR assigned_to = ANY($2)) GROUP BY assigned_to ORDER BY assigned_to",
    )
    .bind(all)
    .bind(&ids)
    .bind(p.from)
    .bind(p.to)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let by_activity: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT created_by, count(*) FROM activities WHERE created_at >= $3 AND created_at <= $4
           AND created_by IS NOT NULL AND ($1 OR created_by = ANY($2)) GROUP BY created_by ORDER BY created_by",
    )
    .bind(all)
    .bind(&ids)
    .bind(p.from)
    .bind(p.to)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let customers: BTreeMap<i32, i64> = by_customer.iter().copied().collect();
    let activities: BTreeMap<i32, i64> = by_activity.iter().copied().collect();
    // Thứ tự: nhân viên có khách mới trước, rồi nhân viên chỉ có hoạt động.
    let mut order: Vec<i32> = by_customer.iter().map(|r| r.0).collect();
    order.extend(by_activity.iter().map(|r| r.0).filter(|i| !customers.contains_key(i)));
    let names: Vec<(i32, String, String)> = if order.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, full_name, email FROM users WHERE id = ANY($1)")
            .bind(&order)
            .fetch_all(&mut *c)
            .await
            .map_err(db)?
    };
    Ok(order
        .into_iter()
        .map(|id| {
            let n = names.iter().find(|n| n.0 == id);
            Row {
                user_id: id,
                full_name: n.map_or_else(|| format!("NV #{id}"), |n| n.1.clone()),
                email: n.map_or_else(String::new, |n| n.2.clone()),
                new_customers: customers.get(&id).copied().unwrap_or(0),
                activities_count: activities.get(&id).copied().unwrap_or(0),
            }
        })
        .collect())
}

pub async fn get(ctx: &Ctx, actor: &Actor, date_from: Option<&str>, date_to: Option<&str>) -> R<Value> {
    get_at(ctx, actor, date_from, date_to, now()).await
}

pub async fn get_at(
    ctx: &Ctx,
    actor: &Actor,
    date_from: Option<&str>,
    date_to: Option<&str>,
    at: DateTime<Utc>,
) -> R<Value> {
    let p = parse_period(date_from, date_to, at)?;
    Ok(Value::Array(
        rows(ctx, actor, p).await?.iter().map(Row::to_json).collect(),
    ))
}

/// Tên tệp xuất: `hieu-suat-nhan-vien-YYYY-MM-DD.xlsx` (ngày UTC như `toISOString().slice(0, 10)`).
pub fn export_filename(at: DateTime<Utc>) -> String {
    format!("hieu-suat-nhan-vien-{}.xlsx", at.format("%Y-%m-%d"))
}

/// Trang tính xuất: sắp theo khách mới giảm dần (ổn định), tối đa [`EXPORT_CAP`] dòng; quá trần thì có dòng cảnh báo đầu.
pub fn sheet(rows: &[Row], cap: usize) -> SheetSpec {
    let mut sorted: Vec<&Row> = rows.iter().collect();
    sorted.sort_by_key(|r| std::cmp::Reverse(r.new_customers));
    let truncated = sorted.len() > cap;
    let mut out: Vec<Vec<Cell>> = Vec::new();
    if truncated {
        out.push(vec![Cell::text(format!(
            "⚠ Danh sách vượt {} nhân viên — chỉ hiện {} dòng đầu (sắp theo khách mới giảm dần).",
            vn_int(cap),
            vn_int(cap)
        ))]);
    }
    for (i, r) in sorted.into_iter().take(cap).enumerate() {
        out.push(vec![
            Cell::int(i64::try_from(i + 1).unwrap_or(0)),
            Cell::text(&r.full_name),
            Cell::text(&r.email),
            Cell::int(r.new_customers),
            Cell::int(r.activities_count),
        ]);
    }
    SheetSpec {
        name: "Hiệu suất nhân viên".to_owned(),
        title: None,
        subtitle: None,
        columns: vec![
            Column::new("STT", 6.0),
            Column::new("Nhân viên", 26.0),
            Column::new("Email", 26.0),
            Column::new("Khách mới được giao", 18.0),
            Column::new("Số hoạt động", 16.0),
        ],
        rows: out,
    }
}

/// `toLocaleString('vi-VN')` của số nguyên: dấu chấm tách nghìn.
fn vn_int(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(ch);
    }
    out
}

/// `GET /reports/employee-performance/export`: tệp xlsx (ô bắt đầu bằng `= + - @` đã chống chèn công thức ở K29).
pub async fn export(ctx: &Ctx, actor: &Actor, date_from: Option<&str>, date_to: Option<&str>) -> R<Vec<u8>> {
    let p = parse_period(date_from, date_to, now())?;
    let rows = rows(ctx, actor, p).await?;
    write_xlsx(&[sheet(&rows, EXPORT_CAP)]).map_err(AppError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinity_docgen::xlsx::read_first_sheet;

    fn row(id: i32, name: &str, n: i64) -> Row {
        Row {
            user_id: id,
            full_name: name.to_owned(),
            email: format!("u{id}@x.vn"),
            new_customers: n,
            activities_count: 1,
        }
    }

    #[test]
    fn xuat_sap_giam_dan_va_chong_cong_thuc() {
        let rows = [row(1, "An", 1), row(2, "=HYPERLINK(\"x\")", 5), row(3, "Bình", 5)];
        let bytes = write_xlsx(&[sheet(&rows, EXPORT_CAP)]).unwrap();
        let s = read_first_sheet(&bytes).unwrap();
        // Ổn định: hai dòng cùng 5 giữ thứ tự gốc; ô công thức được thêm dấu nháy.
        let name = |r: usize| s.cell(r, 1).as_trimmed_text().unwrap_or_default();
        assert_eq!(
            (name(1), name(2), name(3)),
            ("'=HYPERLINK(\"x\")".to_owned(), "Bình".to_owned(), "An".to_owned())
        );
        assert_eq!(s.cell(0, 3).as_trimmed_text().as_deref(), Some("Khách mới được giao"));
    }

    #[test]
    fn qua_tran_co_dong_canh_bao() {
        let rows: Vec<Row> = (1..=4).map(|i| row(i, "x", i64::from(i))).collect();
        let sh = sheet(&rows, 3);
        assert_eq!(sh.rows.len(), 4);
        assert!(matches!(&sh.rows[0][0], Cell::Text(t) if t.contains("vượt 3 nhân viên")));
        assert_eq!(vn_int(5000), "5.000");
        assert_eq!(vn_int(1_234_567), "1.234.567");
    }

    #[test]
    fn ten_tep() {
        let at = DateTime::parse_from_rfc3339("2026-11-27T20:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(export_filename(at), "hieu-suat-nhan-vien-2026-11-27.xlsx");
    }
}
