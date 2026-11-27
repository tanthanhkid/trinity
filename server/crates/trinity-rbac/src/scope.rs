//! Dùng phạm vi dữ liệu (K13): dựng điều kiện SQL từ tập chủ sở hữu, kiểm tài nguyên theo id (404, không 403) và che số
//! điện thoại. Chuyển từ `packages/rbac-nest/src/scope-where.ts`; tập chủ sở hữu do [`crate::ScopeService::owner_ids`].

use std::collections::HashSet;
use std::fmt;

use sqlx::{Postgres, QueryBuilder};
use trinity_db::{CompanyRef, DbError};
use trinity_kernel::error::{AppError, HttpError};

use crate::grants::Grants;
use crate::service::{OwnerIds, ScopeService};

/// Tên cột hợp lệ để ghép vào SQL: `cot` hoặc `bang.cot`, chỉ chữ thường/số/gạch dưới. Giá trị lạ không bao giờ được ghép.
fn is_column(f: &str) -> bool {
    !f.is_empty()
        && f.split('.').count() <= 2
        && f.split('.').all(|p| {
            !p.is_empty()
                && !p.as_bytes()[0].is_ascii_digit()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
}

/// Ghép điều kiện phạm vi vào truy vấn đang dựng, như `AND: [scopeWhere(...), ...]` của bản TS (luôn là MỘT biểu thức
/// boolean, nên đặt giữa `AND` được): `All` ⇒ `TRUE`; một cột ⇒ `"col" = ANY($n)`; nhiều cột ⇒ `("c1" = ANY($n) OR
/// "c2" = ANY($n+1))`. Tập rỗng ⇒ không dòng nào khớp. Mỗi đoạn tên cột được đặt trong dấu nháy kép (tên trùng từ khoá
/// như `user` vẫn chạy). Cột sai tên ⇒ `FALSE` (đóng, không bao giờ mở rộng quyền xem), kiểm TRƯỚC nhánh `All` để lỗi
/// của nơi gọi lộ ra ở mọi vai, không chỉ ở người bị giới hạn; lỗi chỉ ghi log (cả debug lẫn release cùng một hành vi).
pub fn push_scope(qb: &mut QueryBuilder<Postgres>, owner: &OwnerIds, fields: &[&str]) {
    if fields.is_empty() || !fields.iter().all(|f| is_column(f)) {
        tracing::error!(?fields, "cột phạm vi không hợp lệ, đóng truy vấn");
        qb.push("FALSE");
        return;
    }
    let OwnerIds::Ids(ids) = owner else {
        qb.push("TRUE");
        return;
    };
    if fields.len() > 1 {
        qb.push("(");
    }
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            qb.push(" OR ");
        }
        qb.push(quote_column(f))
            .push(" = ANY(")
            .push_bind(ids.clone())
            .push(")");
    }
    if fields.len() > 1 {
        qb.push(")");
    }
}

/// `bang.cot` ⇒ `"bang"."cot"`. Chỉ gọi sau [`is_column`] nên không có ký tự nháy bên trong.
fn quote_column(f: &str) -> String {
    f.split('.')
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join(".")
}

impl OwnerIds {
    /// Một trong các chủ sở hữu (bỏ qua `None`) nằm trong phạm vi?
    pub fn contains_any(&self, owners: &[Option<i32>]) -> bool {
        match self {
            Self::All => true,
            Self::Ids(ids) => owners.iter().flatten().any(|o| ids.contains(o)),
        }
    }
}

/// Tài nguyên theo id ngoài phạm vi ⇒ 404 "Không tìm thấy", không 403. `allowed = None` (không có quyền) cũng 404.
pub fn assert_in_scope(allowed: Option<&OwnerIds>, owners: &[Option<i32>]) -> Result<(), Box<HttpError>> {
    match allowed {
        Some(a) if a.contains_any(owners) => Ok(()),
        _ => Err(Box::new(HttpError::not_found("Không tìm thấy"))),
    }
}

/// Giữ 3 số cuối, che toàn bộ đầu số: `0900000168` ⇒ `***168`. Chuỗi rỗng và `None` giữ nguyên.
pub fn mask_phone(phone: Option<&str>) -> Option<String> {
    let p = phone?;
    if p.is_empty() {
        return Some(String::new());
    }
    let digits: String = p.chars().filter(char::is_ascii_digit).collect();
    Some(if digits.len() <= 3 {
        "***".to_owned()
    } else {
        format!("***{}", &digits[digits.len() - 3..])
    })
}

/// Danh sách dài: lấy tập chủ sở hữu MỘT lần rồi che từng dòng bằng tập đó.
#[derive(Debug, Clone)]
pub struct PhoneMasker {
    allowed: Option<Allowed>,
}

/// Tập chủ sở hữu dựng một lần thành `HashSet` để mỗi dòng kiểm O(1) (danh sách dài).
#[derive(Debug, Clone)]
enum Allowed {
    All,
    Ids(HashSet<i32>),
}

impl PhoneMasker {
    pub fn new(allowed: Option<OwnerIds>) -> Self {
        let allowed = allowed.map(|a| match a {
            OwnerIds::All => Allowed::All,
            OwnerIds::Ids(ids) => Allowed::Ids(ids.into_iter().collect()),
        });
        Self { allowed }
    }

    pub fn mask(&self, owners: &[Option<i32>], phone: Option<&str>) -> Option<String> {
        let visible = match &self.allowed {
            None => false,
            Some(Allowed::All) => true,
            Some(Allowed::Ids(ids)) => owners.iter().flatten().any(|o| ids.contains(o)),
        };
        if visible {
            return phone.map(str::to_owned);
        }
        mask_phone(phone)
    }
}

impl ScopeService {
    /// `assertInScope`: lấy tập chủ sở hữu của `permission` rồi kiểm.
    pub async fn assert_in_scope(
        &self,
        company: CompanyRef,
        user: i32,
        grants: &Grants,
        permission: &str,
        owners: &[Option<i32>],
    ) -> Result<(), ScopeError> {
        let allowed = self.owner_ids(company, user, grants, permission).await?;
        assert_in_scope(allowed.as_ref(), owners).map_err(ScopeError::NotFound)
    }

    /// `maskPhoneFor`: số thật khi chủ sở hữu trong phạm vi của `permission`, ngược lại bị che.
    pub async fn mask_phone_for(
        &self,
        company: CompanyRef,
        user: i32,
        grants: &Grants,
        permission: &str,
        owners: &[Option<i32>],
        phone: Option<&str>,
    ) -> Result<Option<String>, DbError> {
        let allowed = self.owner_ids(company, user, grants, permission).await?;
        Ok(PhoneMasker::new(allowed).mask(owners, phone))
    }
}

/// Lỗi của kiểm phạm vi theo id: 404 hoặc lỗi DB.
#[derive(Debug)]
pub enum ScopeError {
    NotFound(Box<HttpError>),
    Db(DbError),
}

impl From<DbError> for ScopeError {
    fn from(e: DbError) -> Self {
        Self::Db(e)
    }
}

impl fmt::Display for ScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(e) => fmt::Display::fmt(e, f),
            Self::Db(e) => fmt::Display::fmt(e, f),
        }
    }
}

impl std::error::Error for ScopeError {}

/// 404 giữ nguyên; lỗi DB đi qua `AppError::Db` (đầu ra 500 như mọi lỗi DB khác).
impl From<ScopeError> for AppError {
    fn from(e: ScopeError) -> Self {
        match e {
            ScopeError::NotFound(h) => Self::Http(*h),
            ScopeError::Db(d) => Self::Db(d),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql(owner: &OwnerIds, fields: &[&str]) -> String {
        let mut qb = QueryBuilder::<Postgres>::new("");
        push_scope(&mut qb, owner, fields);
        qb.sql().as_str().to_owned()
    }

    #[test]
    fn dieu_kien_sql() {
        assert_eq!(sql(&OwnerIds::All, &["assigned_to"]), "TRUE");
        let ids = OwnerIds::Ids(vec![1, 2]);
        assert_eq!(sql(&ids, &["assigned_to"]), "\"assigned_to\" = ANY($1)");
        assert_eq!(
            sql(&ids, &["c.assigned_to", "created_by_id"]),
            "(\"c\".\"assigned_to\" = ANY($1) OR \"created_by_id\" = ANY($2))"
        );
    }

    #[test]
    fn tu_khoa_duoc_quote() {
        let ids = OwnerIds::Ids(vec![1]);
        assert_eq!(sql(&ids, &["user"]), "\"user\" = ANY($1)");
    }

    #[test]
    fn cot_sai_ten_dong_ca_debug() {
        let ids = OwnerIds::Ids(vec![1]);
        for bad in ["", "a; DROP TABLE x", "A", "1a", "a.b.c", "a b", "a\"b"] {
            assert_eq!(sql(&ids, &[bad]), "FALSE", "{bad}");
        }
        assert_eq!(sql(&ids, &[]), "FALSE");
        // Kiểm tên cột cả khi vai `All`: lỗi của nơi gọi không bị che.
        assert_eq!(sql(&OwnerIds::All, &["a; DROP TABLE x"]), "FALSE");
        assert_eq!(sql(&OwnerIds::All, &[]), "FALSE");
    }

    #[test]
    fn kiem_theo_id_va_che_so() {
        let ids = OwnerIds::Ids(vec![1, 2]);
        assert!(assert_in_scope(Some(&OwnerIds::All), &[Some(999)]).is_ok());
        assert!(assert_in_scope(Some(&ids), &[None, Some(2)]).is_ok());
        for e in [
            assert_in_scope(Some(&ids), &[Some(999)]),
            assert_in_scope(Some(&ids), &[None]),
            assert_in_scope(Some(&ids), &[]),
            assert_in_scope(None, &[Some(1)]),
        ] {
            let b = e.unwrap_err().body();
            assert_eq!(b.status_code, 404);
            assert_eq!(
                serde_json::to_value(&b.message).unwrap(),
                serde_json::json!("Không tìm thấy")
            );
        }
        assert_eq!(mask_phone(Some("0900000168")).as_deref(), Some("***168"));
        assert_eq!(mask_phone(Some("+84 900-000-168")).as_deref(), Some("***168"));
        assert_eq!(mask_phone(None), None);
        assert_eq!(mask_phone(Some("")).as_deref(), Some(""));
        assert_eq!(mask_phone(Some("12")).as_deref(), Some("***"));
        assert_eq!(mask_phone(Some("abc")).as_deref(), Some("***"));
        let m = PhoneMasker::new(Some(ids.clone()));
        assert_eq!(m.mask(&[Some(2)], Some("0900000168")).as_deref(), Some("0900000168"));
        assert_eq!(m.mask(&[Some(999)], Some("0900000168")).as_deref(), Some("***168"));
        assert_eq!(
            PhoneMasker::new(Some(OwnerIds::All))
                .mask(&[Some(999)], Some("0900000168"))
                .as_deref(),
            Some("0900000168")
        );
        assert_eq!(
            PhoneMasker::new(None).mask(&[Some(1)], Some("0900000168")).as_deref(),
            Some("***168")
        );
        assert_eq!(m.mask(&[Some(2)], None), None);
    }
}
