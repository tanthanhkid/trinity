//! Dùng phạm vi dữ liệu (K13): dựng điều kiện SQL từ tập chủ sở hữu, kiểm tài nguyên theo id (404, không 403) và che số
//! điện thoại. Chuyển từ `packages/rbac-nest/src/scope-where.ts`; tập chủ sở hữu do [`crate::ScopeService::owner_ids`].

use sqlx::{Postgres, QueryBuilder};
use trinity_db::{CompanyRef, DbError};
use trinity_kernel::error::HttpError;

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
/// boolean, nên đặt giữa `AND` được): `All` ⇒ `TRUE`; một cột ⇒ `col = ANY($n)`; nhiều cột ⇒ `(c1 = ANY($n) OR c2 =
/// ANY($n+1))`. Tập rỗng ⇒ không dòng nào khớp. Cột sai tên ⇒ `FALSE` (đóng, không bao giờ mở rộng quyền xem).
pub fn push_scope(qb: &mut QueryBuilder<Postgres>, owner: &OwnerIds, fields: &[&str]) {
    let OwnerIds::Ids(ids) = owner else {
        qb.push("TRUE");
        return;
    };
    if fields.is_empty() || !fields.iter().all(|f| is_column(f)) {
        debug_assert!(false, "cột phạm vi không hợp lệ: {fields:?}");
        qb.push("FALSE");
        return;
    }
    if fields.len() > 1 {
        qb.push("(");
    }
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            qb.push(" OR ");
        }
        qb.push(*f).push(" = ANY(").push_bind(ids.clone()).push(")");
    }
    if fields.len() > 1 {
        qb.push(")");
    }
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
    allowed: Option<OwnerIds>,
}

impl PhoneMasker {
    pub fn new(allowed: Option<OwnerIds>) -> Self {
        Self { allowed }
    }

    pub fn mask(&self, owners: &[Option<i32>], phone: Option<&str>) -> Option<String> {
        if self.allowed.as_ref().is_some_and(|a| a.contains_any(owners)) {
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
        assert_eq!(sql(&ids, &["assigned_to"]), "assigned_to = ANY($1)");
        assert_eq!(
            sql(&ids, &["c.assigned_to", "created_by_id"]),
            "(c.assigned_to = ANY($1) OR created_by_id = ANY($2))"
        );
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn cot_sai_ten_dong() {
        let ids = OwnerIds::Ids(vec![1]);
        for bad in ["", "a; DROP TABLE x", "A", "1a", "a.b.c", "a b", "a\"b"] {
            assert_eq!(sql(&ids, &[bad]), "FALSE", "{bad}");
        }
        assert_eq!(sql(&ids, &[]), "FALSE");
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
