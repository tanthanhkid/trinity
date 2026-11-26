//! `GET /contacts/export`: xlsx danh bạ trong phạm vi `contacts.view`, áp bộ lọc giao diện đang chọn (`ContactsExportService`).
//!
//! Tối đa [`EXPORT_LIMIT`] khách MỚI NHẤT của phạm vi đã lọc (vượt thì có dòng cảnh báo, không cắt lặng lẽ), trình bày theo
//! Phòng ban → Team → NV phụ trách → Khách hàng (so sánh chữ cái tiếng Việt). SĐT và SĐT phụ che từng dòng theo
//! `contacts.phone_full`. Ô bắt đầu bằng `= + - @` được chống chèn công thức ở `trinity_docgen::xlsx`.
//!
//! Khác bản TS: tiêu đề cột nằm sau dòng mô tả khi có cảnh báo (bộ ghi xlsx chung K29 đặt dòng mô tả phía trên tiêu đề cột
//! thay vì chèn dòng 2 như `spliceRows`); nội dung ô giống.

use std::collections::HashMap;

use chrono::Utc;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::types::Timestamp;
use trinity_docgen::xlsx::{Cell, Column, SheetSpec, write_xlsx};
use trinity_kernel::error::AppError;
use trinity_kernel::vi::{Collation, compare};
use trinity_kernel::vn_time::{VnDateStyle, format_vn_date};

use crate::filter::{ContactFilters, resolve};
use crate::list::derive_stage;
use crate::{Scopes, db};

/// Trần số dòng (bảo vệ bộ nhớ và thời gian của request).
pub const EXPORT_LIMIT: usize = 20_000;
const SORT_LAST: &str = "\u{ffff}";

#[derive(sqlx::FromRow)]
struct Row {
    full_name: Option<String>,
    zalo_account: Option<String>,
    assigned_to: Option<i32>,
    created_by_id: Option<i32>,
    created_at: Timestamp,
    phone: String,
    phone_2: Option<String>,
    gender: Option<String>,
    birthday: Option<Timestamp>,
    job_title: Option<String>,
    current_address: Option<String>,
    company_name: Option<String>,
    email: Option<String>,
    assignee: Option<String>,
    creator: Option<String>,
    source: Option<String>,
    stage: Option<String>,
    status: Option<String>,
}

#[derive(Default, Clone)]
struct Placement {
    dept: Option<String>,
    team: Option<String>,
}

/// Vị trí tổ chức của từng chủ khách theo chuỗi `manager_id` (không cần vai trò): có quản lý cấp 1 và cấp 1 còn quản lý ⇒
/// phòng = quản lý của cấp 1, team = cấp 1; cấp 1 không còn quản lý ⇒ phòng = cấp 1, team = chính chủ; không có quản lý ⇒
/// cả hai là chính chủ. Chủ không tìm thấy ⇒ không có khoá.
async fn placements(conn: &mut PgConnection, owners: &[i32]) -> Result<HashMap<i32, Placement>, AppError> {
    type U = (i32, Option<String>, Option<i32>);
    async fn load(
        conn: &mut PgConnection,
        ids: &[i32],
    ) -> Result<HashMap<i32, (Option<String>, Option<i32>)>, AppError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<U> = sqlx::query_as("SELECT id, full_name, manager_id FROM users WHERE id = ANY($1)")
            .bind(ids)
            .fetch_all(conn)
            .await
            .map_err(db)?;
        Ok(rows.into_iter().map(|(id, n, m)| (id, (n, m))).collect())
    }
    let uniq = |v: Vec<i32>| {
        let mut v = v;
        v.sort_unstable();
        v.dedup();
        v
    };
    let owner_map = load(conn, &uniq(owners.to_vec())).await?;
    let leads = load(conn, &uniq(owner_map.values().filter_map(|(_, m)| *m).collect())).await?;
    let depts = load(conn, &uniq(leads.values().filter_map(|(_, m)| *m).collect())).await?;
    let mut out = HashMap::new();
    for (id, (name, manager)) in &owner_map {
        let mgr = manager.and_then(|m| leads.get(&m).map(|v| (m, v)));
        let p = match mgr {
            Some((_, (mgr_name, Some(dept_id)))) => Placement {
                dept: depts.get(dept_id).and_then(|d| d.0.clone()),
                team: mgr_name.clone(),
            },
            Some((_, (mgr_name, None))) => Placement {
                dept: mgr_name.clone(),
                team: name.clone(),
            },
            None => Placement {
                dept: name.clone(),
                team: name.clone(),
            },
        };
        out.insert(*id, p);
    }
    Ok(out)
}

fn columns() -> Vec<Column> {
    [
        ("STT", 6.0),
        ("Tên KH", 24.0),
        ("SĐT", 14.0),
        ("SĐT phụ", 14.0),
        ("Giai đoạn", 20.0),
        ("Trạng thái", 18.0),
        ("Nguồn", 16.0),
        ("Phòng ban", 22.0),
        ("Team", 22.0),
        ("Nhân viên phụ trách", 20.0),
        ("Ngày tạo", 14.0),
        ("Người khởi tạo", 20.0),
        ("Giới tính", 10.0),
        ("Ngày sinh", 14.0),
        ("Chức danh", 18.0),
        ("Địa chỉ hiện tại", 28.0),
        ("Công ty", 22.0),
        ("Email", 22.0),
        ("Zalo", 16.0),
    ]
    .into_iter()
    .map(|(h, w)| Column::new(h, w))
    .collect()
}

/// Tên file tải về: `khach-hang-<ngày UTC>.xlsx` (như `toISOString().slice(0, 10)` của bản TS).
pub fn export_filename(now: chrono::DateTime<Utc>) -> String {
    format!("khach-hang-{}.xlsx", now.format("%Y-%m-%d"))
}

/// Dựng bytes xlsx.
pub async fn export_xlsx(
    conn: &mut PgConnection,
    scopes: &Scopes,
    filters: &ContactFilters,
) -> Result<Vec<u8>, AppError> {
    let wh = resolve(&mut *conn, scopes, filters).await?;
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT c.full_name, c.zalo_account, c.assigned_to, c.created_by_id, c.created_at, c.phone, c.phone_2, c.gender, c.birthday,
           c.job_title, c.current_address, c.company_name, c.email, au.full_name AS assignee, cr.full_name AS creator,
           so.label AS source, st.label AS stage, cs.label AS status
         FROM contacts c LEFT JOIN users au ON au.id = c.assigned_to LEFT JOIN users cr ON cr.id = c.created_by_id
         LEFT JOIN setting_options so ON so.id = c.source_id LEFT JOIN setting_options st ON st.id = c.stage_id
         LEFT JOIN setting_options cs ON cs.id = c.contact_status_id WHERE ",
    );
    wh.push_aliased(&mut qb);
    qb.push(" ORDER BY c.id DESC LIMIT ")
        .push_bind(i64::try_from(EXPORT_LIMIT + 1).unwrap_or(20_001));
    let mut rows: Vec<Row> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    let truncated = rows.len() > EXPORT_LIMIT;
    rows.truncate(EXPORT_LIMIT);

    let owner_ids: Vec<i32> = rows.iter().filter_map(|r| r.assigned_to).collect();
    let place = placements(conn, &owner_ids).await?;
    let key = |r: &Row| {
        let p = r.assigned_to.and_then(|a| place.get(&a));
        format!(
            "{} {} {} {}",
            p.and_then(|p| p.dept.as_deref()).unwrap_or(SORT_LAST),
            p.and_then(|p| p.team.as_deref()).unwrap_or(SORT_LAST),
            r.assignee.as_deref().unwrap_or(SORT_LAST),
            r.full_name.as_deref().unwrap_or(SORT_LAST)
        )
    };
    let mut keyed: Vec<(String, Row)> = rows.into_iter().map(|r| (key(&r), r)).collect();
    keyed.sort_by(|a, b| compare(&a.0, &b.0, Collation::Vi));

    let masker = scopes.masker();
    let data: Vec<Vec<Cell>> = keyed
        .iter()
        .enumerate()
        .map(|(i, (_, r))| {
            let p = r.assigned_to.and_then(|a| place.get(&a)).cloned().unwrap_or_default();
            let owners = [r.assigned_to, r.created_by_id];
            let t = |s: Option<&str>| Cell::text(s.unwrap_or_default());
            let gender = r.gender.as_deref().map(|g| match g {
                "nam" => "Nam",
                "nu" => "Nữ",
                other => other,
            });
            vec![
                Cell::int(i64::try_from(i + 1).unwrap_or(0)),
                t(r.full_name.as_deref()),
                Cell::text(masker.mask(&owners, Some(&r.phone)).unwrap_or_default()),
                Cell::text(masker.mask(&owners, r.phone_2.as_deref()).unwrap_or_default()),
                Cell::text(derive_stage_label(r.stage.as_deref())),
                t(r.status.as_deref()),
                t(r.source.as_deref()),
                Cell::text(p.dept.unwrap_or_else(|| "Chưa phân phòng".to_owned())),
                Cell::text(p.team.unwrap_or_else(|| "Chưa phân team".to_owned())),
                Cell::text(r.assignee.clone().unwrap_or_else(|| "Chưa gán".to_owned())),
                Cell::text(format_vn_date(r.created_at.0, VnDateStyle::DayMonthYear)),
                t(r.creator.as_deref()),
                t(gender),
                Cell::text(
                    r.birthday
                        .map(|b| format_vn_date(b.0, VnDateStyle::DayMonthYear))
                        .unwrap_or_default(),
                ),
                t(r.job_title.as_deref()),
                t(r.current_address.as_deref()),
                t(r.company_name.as_deref()),
                t(r.email.as_deref()),
                t(r.zalo_account.as_deref()),
            ]
        })
        .collect();

    let subtitle = truncated.then(|| {
        String::from(
            "⚠ Dữ liệu (trong phạm vi bộ lọc đang chọn) vượt quá 20.000 bản ghi — file chỉ chứa 20.000 bản ghi MỚI NHẤT (trình bày theo Phòng ban → Team → NV phụ trách → Khách hàng). Thu hẹp bộ lọc để xem đầy đủ."
        )
    });
    write_xlsx(&[SheetSpec {
        name: "Khách hàng".to_owned(),
        title: None,
        subtitle,
        columns: columns(),
        rows: data,
    }])
    .map_err(AppError::internal)
}

fn derive_stage_label(label: Option<&str>) -> String {
    let json = label.map(|l| trinity_db::types::JsonValue(serde_json::json!({ "label": l })));
    derive_stage(json.as_ref()).0
}
