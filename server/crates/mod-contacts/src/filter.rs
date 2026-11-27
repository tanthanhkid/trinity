//! Bộ lọc dùng chung của `GET /contacts` và `GET /contacts/export` (`build-contact-list-where.helper.ts`).
//!
//! Điều kiện ghép bằng `AND` của: phạm vi `contacts.view` (cột `assigned_to`, `created_by_id`), chưa xoá, rồi từng bộ lọc
//! giao diện. Bộ lọc không bao giờ ghi đè điều kiện phạm vi.

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_kernel::error::AppError;
use trinity_kernel::vi::{SQL_FOLD_FROM, SQL_FOLD_TO, fold_contains, trim_js};
use trinity_kernel::vn_time::{is_date_only, vn_to_utc};
use trinity_rbac::{OwnerIds, push_scope};

use crate::{MIN_MASKED_PHONE_SEARCH_DIGITS, Scopes, db};

/// Bộ lọc của danh sách (đã qua K15). Số `0` coi như không lọc (như `if (filters.source_id)` của TS).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ContactFilters {
    #[serde(default)]
    pub source_id: Option<i32>,
    #[serde(default)]
    pub stage_id: Option<i32>,
    #[serde(default)]
    pub contact_status_id: Option<i32>,
    #[serde(default)]
    pub team_id: Option<i32>,
    #[serde(default)]
    pub assigned_to: Option<i32>,
    #[serde(default)]
    pub project_id: Option<i32>,
    #[serde(default)]
    pub team_lead_id: Option<i32>,
    #[serde(default)]
    pub dept_head_id: Option<i32>,
    #[serde(default)]
    pub creator_id: Option<i32>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub created_from: Option<String>,
    #[serde(default)]
    pub created_to: Option<String>,
    /// `hot` | `warm` | `cold` | `unscored`.
    #[serde(default)]
    pub lead_label: Option<String>,
}

/// Điều kiện đã giải xong phần cần truy vấn DB (cấp dưới theo `manager_id`), sẵn sàng ghép vào truy vấn.
#[derive(Debug, Clone)]
pub struct ContactWhere {
    owner: OwnerIds,
    filters: ContactFilters,
    phone_open: bool,
    team_lead_ids: Option<Vec<i32>>,
    dept_head_ids: Option<Vec<i32>>,
    created_from: Option<DateTime<Utc>>,
    created_to: Option<DateTime<Utc>>,
}

impl ContactWhere {
    /// Chuỗi nhận dạng điều kiện (phạm vi + bộ lọc đã giải), làm khoá cache đếm.
    pub fn cache_key(&self) -> String {
        format!(
            "{:?}|{:?}|{}|{:?}|{:?}|{:?}|{:?}",
            self.owner,
            self.filters,
            self.phone_open,
            self.team_lead_ids,
            self.dept_head_ids,
            self.created_from,
            self.created_to
        )
    }

    /// Ghép điều kiện (không gồm từ khoá `WHERE`) vào truy vấn trên bảng `contacts` KHÔNG đặt bí danh.
    pub fn push(&self, qb: &mut QueryBuilder<Postgres>) {
        self.push_with(qb, "");
    }

    /// Như [`Self::push`] cho truy vấn đặt bí danh `c` cho `contacts`.
    pub fn push_aliased(&self, qb: &mut QueryBuilder<Postgres>) {
        self.push_with(qb, "c.");
    }

    fn push_with(&self, qb: &mut QueryBuilder<Postgres>, a: &str) {
        let (assigned, creator) = (format!("{a}assigned_to"), format!("{a}created_by_id"));
        push_scope(qb, &self.owner, &[&assigned, &creator]);
        qb.push(format!(" AND {a}deleted_at IS NULL"));
        let f = &self.filters;
        for (col, v) in [
            ("source_id", f.source_id),
            ("stage_id", f.stage_id),
            ("contact_status_id", f.contact_status_id),
            ("team_id", f.team_id),
            ("assigned_to", f.assigned_to),
        ] {
            if let Some(v) = v.filter(|v| *v != 0) {
                qb.push(format!(" AND {a}{col} = ")).push_bind(v);
            }
        }
        if let Some(v) = f.project_id.filter(|v| *v != 0) {
            qb.push(format!(" AND {a}project_id = ")).push_bind(v);
        }
        if let Some(v) = f.creator_id.filter(|v| *v != 0) {
            qb.push(format!(" AND {a}created_by_id = ")).push_bind(v);
        }
        if let Some(search) = f.search.as_deref().filter(|s| !s.is_empty()) {
            qb.push(" AND ");
            self.push_search(qb, search, a);
        }
        match f.lead_label.as_deref().filter(|l| !l.is_empty()) {
            Some("unscored") => {
                qb.push(format!(" AND {a}lead_label IS NULL"));
            }
            Some(l) => {
                qb.push(format!(" AND {a}lead_label = ")).push_bind(l.to_owned());
            }
            None => {}
        }
        if let Some(t) = self.created_from {
            qb.push(format!(" AND {a}created_at >= ")).push_bind(t);
        }
        if let Some(t) = self.created_to {
            qb.push(format!(" AND {a}created_at <= ")).push_bind(t);
        }
        for ids in [&self.team_lead_ids, &self.dept_head_ids].into_iter().flatten() {
            qb.push(format!(" AND {a}assigned_to = ANY("))
                .push_bind(ids.clone())
                .push(")");
        }
    }

    /// Ô tìm: SĐT (chứa) hoặc tên (không phân biệt hoa/thường và dấu). Không có `contacts.phone_full` toàn công ty thì chỉ
    /// khớp theo SĐT khi gõ đủ [`MIN_MASKED_PHONE_SEARCH_DIGITS`] chữ số (list che SĐT, tra chứa ngắn là oracle dò số).
    fn push_search(&self, qb: &mut QueryBuilder<Postgres>, search: &str, a: &str) {
        let term = trim_js(search);
        let digits: String = term.chars().filter(char::is_ascii_digit).collect();
        let digits_only = digits.chars().count() >= 6 && digits == term;
        let phone_allowed = self.phone_open || digits.chars().count() >= MIN_MASKED_PHONE_SEARCH_DIGITS;
        if digits_only && phone_allowed {
            qb.push(format!("{a}phone LIKE "))
                .push_bind(format!("%{digits}%"))
                .push(" ESCAPE '\\'");
            return;
        }
        let by_name = |qb: &mut QueryBuilder<Postgres>| {
            qb.push(format!("({a}full_name ILIKE "))
                .push_bind(format!("%{}%", escape_like(term)))
                .push(" ESCAPE '\\'");
            push_folded_ids(qb, term, a);
            qb.push(")");
        };
        if phone_allowed && !digits_only {
            qb.push(format!("({a}phone LIKE "))
                .push_bind(format!("%{}%", escape_like(term)))
                .push(" ESCAPE '\\' OR ");
            by_name(qb);
            qb.push(")");
        } else {
            by_name(qb);
        }
    }
}

/// Thoát `\`, `%`, `_` để chuỗi người dùng gõ khớp theo nghĩa đen trong `LIKE`/`ILIKE ... ESCAPE '\'`.
pub(crate) fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// ` OR id IN (…)`: id khách chưa xoá có tên chứa `term` sau khi bỏ dấu, 5000 khách mới nhất (`foldedIds`). Gập bằng
/// `translate(lower())` của PG thuần, không cần `unaccent`.
pub(crate) fn push_folded_ids(qb: &mut QueryBuilder<Postgres>, term: &str, a: &str) {
    qb.push(format!(
        " OR {a}id IN (SELECT id FROM contacts WHERE deleted_at IS NULL AND translate(lower(full_name), "
    ))
    .push_bind(SQL_FOLD_FROM)
    .push(", ")
    .push_bind(SQL_FOLD_TO)
    .push(") LIKE ")
    .push_bind(fold_contains(term))
    .push(" ESCAPE '\\' ORDER BY id DESC LIMIT 5000)");
}

/// Giải bộ lọc: nạp cấp dưới của `team_lead_id` (1 cấp) và `dept_head_id` (2 cấp) theo `users.manager_id`.
pub async fn resolve(
    conn: &mut PgConnection,
    scopes: &Scopes,
    filters: &ContactFilters,
) -> Result<ContactWhere, AppError> {
    let team_lead_ids = match filters.team_lead_id.filter(|v| *v != 0) {
        Some(id) => Some(with_self(id, direct_reports(conn, &[id]).await?)),
        None => None,
    };
    let dept_head_ids = match filters.dept_head_id.filter(|v| *v != 0) {
        Some(id) => {
            let direct = direct_reports(conn, &[id]).await?;
            let second = if direct.is_empty() {
                Vec::new()
            } else {
                direct_reports(conn, &direct).await?
            };
            let mut all = direct;
            all.extend(second);
            Some(with_self(id, all))
        }
        None => None,
    };
    Ok(ContactWhere {
        owner: scopes.view_or_empty(),
        filters: filters.clone(),
        phone_open: scopes.phone_full == Some(OwnerIds::All),
        team_lead_ids,
        dept_head_ids,
        created_from: filters.created_from.as_deref().and_then(|s| parse_bound(s, false)),
        created_to: filters.created_to.as_deref().and_then(|s| parse_bound(s, true)),
    })
}

/// `[id, ...ids]` không trùng.
fn with_self(id: i32, ids: Vec<i32>) -> Vec<i32> {
    let mut v = vec![id];
    for i in ids {
        if !v.contains(&i) {
            v.push(i);
        }
    }
    v
}

async fn direct_reports(conn: &mut PgConnection, managers: &[i32]) -> Result<Vec<i32>, AppError> {
    let rows: Vec<(i32,)> =
        sqlx::query_as("SELECT id FROM users WHERE manager_id = ANY($1) AND deleted_at IS NULL ORDER BY id")
            .bind(managers)
            .fetch_all(conn)
            .await
            .map_err(db)?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Mốc `created_from`/`created_to`. `YYYY-MM-DD` là cả ngày đó theo giờ Việt Nam (00:00:00.000 và 23:59:59.999 +07:00);
/// chuỗi ISO có giờ dùng nguyên văn (không múi giờ ⇒ UTC như `new Date` trên máy chủ); không đọc được ⇒ bỏ qua bộ lọc.
fn parse_bound(s: &str, end: bool) -> Option<DateTime<Utc>> {
    if is_date_only(s) {
        let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
        let t = if end {
            NaiveTime::from_hms_milli_opt(23, 59, 59, 999)?
        } else {
            NaiveTime::MIN
        };
        return Some(vn_to_utc(d, t));
    }
    parse_js_instant(s)
}

/// Chuỗi ngày giờ ISO 8601 như `new Date(s)`: có múi giờ thì theo múi giờ, không có thì UTC.
pub fn parse_js_instant(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(n.and_utc());
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .map(|d| d.and_time(NaiveTime::MIN).and_utc())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn where_of(owner: OwnerIds, filters: ContactFilters, phone_open: bool) -> String {
        let w = ContactWhere {
            owner,
            created_from: filters.created_from.as_deref().and_then(|s| parse_bound(s, false)),
            created_to: filters.created_to.as_deref().and_then(|s| parse_bound(s, true)),
            filters,
            phone_open,
            team_lead_ids: None,
            dept_head_ids: None,
        };
        let mut qb = QueryBuilder::<Postgres>::new("");
        w.push(&mut qb);
        qb.sql().as_str().to_owned()
    }

    #[test]
    fn pham_vi_luon_dung_dau_va_khong_bi_loc_de() {
        let s = where_of(OwnerIds::Ids(vec![1]), ContactFilters::default(), false);
        assert_eq!(
            s,
            r#"("assigned_to" = ANY($1) OR "created_by_id" = ANY($2)) AND deleted_at IS NULL"#
        );
        let all = where_of(OwnerIds::All, ContactFilters::default(), false);
        assert!(all.starts_with("TRUE AND deleted_at IS NULL"));
    }

    #[test]
    fn tim_so_dien_thoai_can_du_chu_so_khi_khong_co_phone_full_all() {
        let f = |q: &str| ContactFilters {
            search: Some(q.into()),
            ..ContactFilters::default()
        };
        // 6 chữ số, không có quyền mở toàn bộ số: chỉ tìm theo tên.
        let masked = where_of(OwnerIds::All, f("094601"), false);
        assert!(!masked.contains("phone LIKE"), "{masked}");
        assert!(masked.contains("full_name ILIKE"));
        // Đủ 9 chữ số: tìm theo SĐT.
        assert!(where_of(OwnerIds::All, f("094601234"), false).contains("phone LIKE"));
        // Có phone_full all: 6 chữ số là đủ.
        assert!(where_of(OwnerIds::All, f("094601"), true).contains("phone LIKE"));
        // Từ khoá chữ: có quyền thì cả SĐT lẫn tên.
        let both = where_of(OwnerIds::All, f("minh"), true);
        assert!(both.contains("phone LIKE") && both.contains("full_name ILIKE"));
    }

    #[test]
    fn nhan_diem_dan_ngay_theo_gio_viet_nam() {
        // 2026-01-01 00:00 +07:00 = 2025-12-31 17:00 UTC
        let from = parse_bound("2026-01-01", false).unwrap();
        assert_eq!(from.to_rfc3339(), "2025-12-31T17:00:00+00:00");
        let to = parse_bound("2026-01-01", true).unwrap();
        assert_eq!(to.to_rfc3339(), "2026-01-01T16:59:59.999+00:00");
        assert_eq!(
            parse_bound("2026-01-01T10:00:00Z", false).unwrap().to_rfc3339(),
            "2026-01-01T10:00:00+00:00"
        );
        assert!(parse_bound("rác", false).is_none());
    }
}
