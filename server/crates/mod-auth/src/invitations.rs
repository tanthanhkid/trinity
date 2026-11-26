//! Đăng ký công ty và lời mời nhân viên (M02, docs/rust/PLAN.md mục 4.6). Chuyển từ `packages/rbac-nest/src/invitations.ts`,
//! `plan-limits.ts`, `company-token.ts` và `register`/`previewInvitation`/`acceptInvitation` của `auth.service.ts`; bản TS là chuẩn
//! hành vi (câu lỗi, thứ tự khoá, luật chống leo thang quyền).
//!
//! Lời mời bằng link (chưa có dịch vụ gửi mail): token = `cN.` + 32 byte ngẫu nhiên base64url (công ty 1 không có tiền tố); DB chỉ
//! giữ SHA-256 của token; hết hạn sau 7 ngày, dùng một lần, huỷ được; mỗi lời mời còn nhận được giữ một chỗ trong `maxUsers` của gói.
//!
//! **Thứ tự khoá**: khoá advisory của công ty (`USER_SLOT_LOCK`, id công ty) là câu ĐẦU của mọi giao dịch đụng lời mời hay đếm chỗ
//! (tạo, huỷ, mời lại, nhận, thêm người), rồi mới tới dòng lời mời: không thể khoá chéo nhau.
//!
//! Đây là lớp logic + DB như phần còn lại của module: nối route (K14), xác thực DTO và đọc IP khách làm ở router.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::TimeDelta;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::types::chrono::{DateTime, Utc};
use sqlx::{AssertSqlSafe, PgConnection};
use trinity_auth::password;
use trinity_db::provision::{ProvisionError, ProvisionInput, provision_company};
use trinity_db::{CompanyRef, Db, LATEST_MIGRATION, TenantTx};
use trinity_kernel::error::HttpError;
use trinity_rbac::{Grants, OwnerIds, ScopeService, catalog, is_subset, merge_grants, normalize_grant};

use crate::{AuthFail, AuthService, GrantsSource, LoginReason, Res, UserGrants, internal};

pub const INVITE_TTL_DAYS: i64 = 7;
/// Khoá advisory "đếm chỗ trống rồi thêm người" (khoá đôi: loại khoá + id công ty), như `USER_SLOT_LOCK` của bản TS.
pub const USER_SLOT_LOCK: i32 = 726_354_004;
pub const INVITATION_GONE_MESSAGE: &str =
    "Lời mời không còn hiệu lực (đã dùng, đã bị huỷ hoặc hết hạn). Hãy nhờ chủ công ty gửi link mới.";

/// Lời mời "nhận được thật": còn hạn, chưa dùng/huỷ, vai trò còn tồn tại, người mời còn hoạt động với quyền `users.manage`
/// (vai trò hệ thống hoặc có dòng quyền). Bảng gọi không kèm schema nên theo `search_path` của công ty.
pub const USABLE_INVITATION_SQL: &str = "
  i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  AND i.role_id IS NOT NULL AND EXISTS (SELECT 1 FROM roles r0 WHERE r0.id = i.role_id)
  AND EXISTS (
    SELECT 1 FROM users u WHERE u.id = i.created_by AND u.status = 'active' AND u.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'users.manage'
         WHERE ur.user_id = u.id AND (r.is_system OR rp.role_id IS NOT NULL)))";

/// `unusable` = còn hạn nhưng không nhận được nữa (người mời mất quyền/bị khoá hoặc vai trò đã bị xoá).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationStatus {
    Pending,
    Accepted,
    Revoked,
    Expired,
    Unusable,
}

impl InvitationStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Revoked => "revoked",
            Self::Expired => "expired",
            Self::Unusable => "unusable",
        }
    }
}

pub fn invitation_status(
    accepted_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> InvitationStatus {
    if accepted_at.is_some() {
        InvitationStatus::Accepted
    } else if revoked_at.is_some() {
        InvitationStatus::Revoked
    } else if expires_at <= now {
        InvitationStatus::Expired
    } else {
        InvitationStatus::Pending
    }
}

pub fn hash_invite_token(raw: &str) -> String {
    let d = Sha256::digest(raw.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Tiền tố công ty của bí mật: công ty 1 không có (định dạng cũ vẫn dùng được).
pub fn company_token_prefix(company_id: i32) -> String {
    if company_id == 1 {
        String::new()
    } else {
        format!("c{company_id}.")
    }
}

/// Công ty mà một bí mật tự nhận thuộc về: `^c([1-9][0-9]{0,9})\.(.+)$` (dotall), không tiền tố = công ty 1.
pub fn company_id_of_token(raw: &str) -> i64 {
    let Some(rest) = raw.strip_prefix('c') else { return 1 };
    let Some((digits, secret)) = rest.split_once('.') else {
        return 1;
    };
    let ok = !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0')
        && !secret.is_empty();
    if ok { digits.parse().unwrap_or(1) } else { 1 }
}

pub fn new_invite_token(company_id: i32) -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("không đọc được nguồn ngẫu nhiên của hệ điều hành: {e}"))?;
    Ok(format!(
        "{}{}",
        company_token_prefix(company_id),
        URL_SAFE_NO_PAD.encode(b)
    ))
}

/// Đường dẫn trang nhận lời mời trên web.
pub fn invite_path(token: &str) -> String {
    format!("/invite/{token}")
}

fn iso(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Người thực hiện (đã xác thực, đã nạp quyền).
#[derive(Debug, Clone)]
pub struct Actor {
    pub user_id: i32,
    pub company: CompanyRef,
    pub is_admin: bool,
    pub grants: Grants,
}

/// Một vai trò kèm quyền (`role_permissions`).
#[derive(Debug, Clone)]
struct RoleWithGrants {
    id: i32,
    name: String,
    is_system: bool,
    grants: Grants,
}

/// Quyền gộp của các vai trò (`grantsOfRoles`).
fn grants_of_roles(roles: &[&RoleWithGrants]) -> Grants {
    merge_grants(roles.iter().map(|r| &r.grants))
}

fn grants_from_rows(rows: &[(String, Option<String>)]) -> Grants {
    let mut g = Grants::new();
    for (perm, scope) in rows {
        if let Some(v) = normalize_grant(perm, scope.as_deref()) {
            g.insert(perm.clone(), v);
        }
    }
    g
}

async fn load_role(conn: &mut PgConnection, id: i32) -> Result<Option<RoleWithGrants>, sqlx::Error> {
    let Some((name, is_system)) =
        sqlx::query_as::<_, (String, bool)>("SELECT name, is_system FROM roles WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
    else {
        return Ok(None);
    };
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT permission, scope FROM role_permissions WHERE role_id = $1")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?;
    Ok(Some(RoleWithGrants {
        id,
        name,
        is_system,
        grants: grants_from_rows(&rows),
    }))
}

/// Đã có người dùng (chưa xoá mềm) mang email này trong công ty của kết nối.
async fn email_taken(conn: &mut PgConnection, email: &str) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1")
        .bind(email)
        .fetch_optional(conn)
        .await
}

fn fail_sql(what: &str, e: sqlx::Error) -> AuthFail {
    internal(what, e)
}

fn gone() -> AuthFail {
    HttpError::nest(410, Some(INVITATION_GONE_MESSAGE.into())).into()
}

fn conflict(msg: &str) -> AuthFail {
    HttpError::conflict(msg).into()
}

pub fn user_limit_message(max: i64) -> String {
    format!("Gói hiện tại tối đa {max} người, liên hệ để nâng gói.")
}

/// Lấy khoá advisory số chỗ của công ty đến hết giao dịch. Gọi TRƯỚC khi đụng lời mời / đếm chỗ.
pub async fn lock_user_slots(conn: &mut PgConnection, company: CompanyRef) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1::int, $2::int)")
        .bind(USER_SLOT_LOCK)
        .bind(company.id())
        .execute(conn)
        .await?;
    Ok(())
}

/// Gói đang áp cho công ty. Một công ty (`multi_tenant = false`) coi như không có số công ty.
fn plan_max_users(raw: Option<&str>, company: CompanyRef, multi_tenant: bool) -> Option<i64> {
    let cat = catalog();
    let key = cat.resolve_plan_for_company(raw.map(str::trim), multi_tenant.then(|| company.id()));
    cat.plan(key).and_then(|p| p.max_users)
}

/// Chặn thêm/kích hoạt user khi `người active + lời mời đang chờ` đã đạt `maxUsers` của gói (`custom` = không giới hạn). PHẢI gọi
/// trong giao dịch và TRƯỚC khi ghi người mới: lấy khoá advisory đến hết giao dịch nên hai lượt đồng thời ở ngưỡng chỉ một lượt qua.
pub async fn assert_user_slot_available(conn: &mut PgConnection, company: CompanyRef, multi_tenant: bool) -> Res<()> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'org_plan'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| fail_sql("gói", e))?;
    let Some(max) = plan_max_users(raw.as_deref(), company, multi_tenant) else {
        return Ok(());
    };
    lock_user_slots(conn, company)
        .await
        .map_err(|e| fail_sql("khoá chỗ", e))?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE status = 'active' AND deleted_at IS NULL")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| fail_sql("đếm người", e))?;
    let pending: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT count(*)::bigint FROM user_invitations i WHERE {USABLE_INVITATION_SQL}"
    )))
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| fail_sql("đếm lời mời", e))?;
    if active + pending >= max {
        return Err(conflict(&user_limit_message(max)));
    }
    Ok(())
}

/// Phạm vi lời mời theo `users.manage`: `All` thấy/huỷ mọi lời mời; phạm vi hẹp chỉ lời mời do người trong phạm vi đó tạo.
pub async fn invitation_scope(scope: &ScopeService, actor: &Actor) -> Res<OwnerIds> {
    Ok(scope
        .owner_ids(actor.company, actor.user_id, &actor.grants, "users.manage")
        .await
        .map_err(|e| internal("phạm vi users.manage", e))?
        .unwrap_or(OwnerIds::Ids(Vec::new())))
}

fn owner_allows(owners: &OwnerIds, created_by: Option<i32>) -> bool {
    match owners {
        OwnerIds::All => true,
        OwnerIds::Ids(ids) => created_by.is_some_and(|c| ids.contains(&c)),
    }
}

/// Vai trò người dùng được phép mời vào (`invitableRoles`): ẩn vai trò hệ thống nếu không phải Quản trị, ẩn vai trò có quyền vượt mình.
pub async fn invitable_roles(db: &Db, actor: &Actor) -> Res<Value> {
    let mut c = db
        .tenant(actor.company)
        .await
        .map_err(|e| internal("tenant", e))?
        .acquire()
        .await
        .map_err(|e| internal("acquire", e))?;
    let ids: Vec<(i32,)> = sqlx::query_as("SELECT id FROM roles ORDER BY id ASC LIMIT 200")
        .fetch_all(&mut *c)
        .await
        .map_err(|e| fail_sql("vai trò", e))?;
    let mut data = Vec::new();
    for (id,) in ids {
        let Some(r) = load_role(&mut c, id).await.map_err(|e| fail_sql("vai trò", e))? else {
            continue;
        };
        if actor.is_admin || (!r.is_system && is_subset(&grants_of_roles(&[&r]), &actor.grants)) {
            data.push(json!({ "id": r.id, "name": r.name, "is_system": r.is_system }));
        }
    }
    Ok(json!({ "data": data }))
}

/// Cùng luật chống leo thang quyền như gán vai trò: không mời được vào vai trò to hơn mình.
async fn assert_can_invite_to_role(conn: &mut PgConnection, actor: &Actor, role_id: i32) -> Res<RoleWithGrants> {
    let role = load_role(conn, role_id)
        .await
        .map_err(|e| fail_sql("vai trò", e))?
        .ok_or_else(|| HttpError::not_found("Không tìm thấy vai trò"))?;
    if !actor.is_admin {
        if role.is_system {
            return Err(HttpError::forbidden("Chỉ Quản trị mới được mời vào vai trò Quản trị").into());
        }
        if !is_subset(&grants_of_roles(&[&role]), &actor.grants) {
            return Err(HttpError::forbidden("Không thể cấp quyền bạn không có").into());
        }
    }
    Ok(role)
}

#[derive(Debug, sqlx::FromRow)]
struct InvRow {
    id: i32,
    email: String,
    role_id: Option<i32>,
    expires_at: DateTime<Utc>,
    accepted_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    created_by: Option<i32>,
    created_at: DateTime<Utc>,
}

const INV_COLS: &str = "id, email, role_id, expires_at, accepted_at, revoked_at, created_by, created_at";

/// Thêm người trực tiếp cho một email đang có lời mời chờ: lời mời đó hết ý nghĩa, huỷ nó TRONG giao dịch thêm người và TRƯỚC khi
/// kiểm chỗ, nếu không email đó tính hai chỗ. Lời mời còn hiệu lực của người ngoài phạm vi ⇒ 409 như khi mời.
pub async fn revoke_pending_invitations_for_email(tx: &mut TenantTx, email: &str, owners: &OwnerIds) -> Res<()> {
    let company = tx.company();
    lock_user_slots(tx, company)
        .await
        .map_err(|e| fail_sql("khoá chỗ", e))?;
    let now = Utc::now();
    let open: Vec<(i32, Option<i32>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, created_by, expires_at FROM user_invitations WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
    )
    .bind(email.trim().to_lowercase())
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| fail_sql("lời mời", e))?;
    if open.iter().any(|(_, by, exp)| *exp > now && !owner_allows(owners, *by)) {
        return Err(conflict(
            "Email này đang có lời mời do người khác tạo. Nhờ người đó huỷ lời mời trước.",
        ));
    }
    if !open.is_empty() {
        let ids: Vec<i32> = open.iter().map(|o| o.0).collect();
        sqlx::query("UPDATE user_invitations SET revoked_at = $2 WHERE id = ANY($1) AND accepted_at IS NULL AND revoked_at IS NULL")
            .bind(ids)
            .bind(now)
            .execute(&mut **tx)
            .await
            .map_err(|e| fail_sql("huỷ lời mời", e))?;
    }
    Ok(())
}

/// Người mời bị khoá/xoá: các lời mời còn chờ của họ chết cùng. Khoá advisory trước, dòng lời mời sau.
pub async fn revoke_pending_invitations_by(tx: &mut TenantTx, user_id: i32) -> Res<()> {
    let company = tx.company();
    lock_user_slots(tx, company)
        .await
        .map_err(|e| fail_sql("khoá chỗ", e))?;
    sqlx::query("UPDATE user_invitations SET revoked_at = now() WHERE created_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| fail_sql("huỷ lời mời", e))?;
    Ok(())
}

/// Vai trò bị xoá: lời mời vào vai trò đó không nhận được nữa, huỷ cùng giao dịch xoá.
pub async fn revoke_pending_invitations_for_role(tx: &mut TenantTx, role_id: i32) -> Res<()> {
    let company = tx.company();
    lock_user_slots(tx, company)
        .await
        .map_err(|e| fail_sql("khoá chỗ", e))?;
    sqlx::query("UPDATE user_invitations SET revoked_at = now() WHERE role_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL")
        .bind(role_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| fail_sql("huỷ lời mời", e))?;
    Ok(())
}

impl<G: GrantsSource> AuthService<G> {
    async fn tenant_tx(&self, company: CompanyRef) -> Res<TenantTx> {
        self.db
            .tenant(company)
            .await
            .map_err(|e| internal("tenant", e))?
            .begin()
            .await
            .map_err(|e| internal("begin", e))
    }

    /// `assertEmailAvailableForCurrentCompany`: email không được thuộc công ty khác (đa công ty).
    async fn assert_email_available(&self, company: CompanyRef, email: &str) -> Res<()> {
        if !self.platform.multi_tenant() {
            return Ok(());
        }
        let owner = self
            .platform
            .company_for_email(email)
            .await
            .map_err(|e| internal("công ty theo email", e))?;
        if owner.is_some_and(|o| o != company.id()) {
            return Err(conflict("Email này đã được dùng cho một công ty khác trên Trinity"));
        }
        Ok(())
    }

    /// Gắn request vào công ty của token (`enterTokenCompany`); công ty lạ hoặc ngưng hoạt động ⇒ `None`.
    async fn token_company(&self, raw: &str) -> Res<Option<CompanyRef>> {
        self.platform
            .active_company(company_id_of_token(raw))
            .await
            .map_err(|e| internal("công ty của token", e))
    }

    /// `POST /auth/invitations`: tạo lời mời; token gốc chỉ có ở lần này (DB không giữ).
    pub async fn create_invitation(&self, actor: &Actor, email: &str, role_id: i32, owners: &OwnerIds) -> Res<Value> {
        let company = actor.company;
        let email = email.trim().to_lowercase();
        let role = {
            let mut c = self.conn(company).await?;
            assert_can_invite_to_role(&mut c, actor, role_id).await?
        };
        // Email đã thuộc công ty khác ⇒ báo rõ ngay, đừng đợi tới lúc người ta mở link.
        self.assert_email_available(company, &email).await?;
        {
            let mut c = self.conn(company).await?;
            if email_taken(&mut c, &email)
                .await
                .map_err(|e| fail_sql("tìm email", e))?
                .is_some()
            {
                return Err(conflict("Email này đã có tài khoản trong công ty của bạn"));
            }
        }
        let token = new_invite_token(if self.platform.multi_tenant() { company.id() } else { 1 })
            .map_err(|e| internal("token", e))?;
        let now = Utc::now();
        let mut tx = self.tenant_tx(company).await?;
        // Khoá TRƯỚC khi đụng lời mời: hai lượt mời cùng email đồng thời không cùng thấy "chưa có lời mời".
        lock_user_slots(&mut tx, company)
            .await
            .map_err(|e| fail_sql("khoá chỗ", e))?;
        let old: Vec<(i32, Option<i32>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, created_by, expires_at FROM user_invitations WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
        )
        .bind(&email)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| fail_sql("lời mời cũ", e))?;
        // Mời lại cùng email = thay lời mời cũ (link cũ chết), nhưng chỉ thay được lời mời còn hiệu lực do người trong phạm vi
        // của mình tạo; của người ngoài phạm vi thì 409 (không huỷ lời mời mình không thấy).
        if old.iter().any(|(_, by, exp)| *exp > now && !owner_allows(owners, *by)) {
            return Err(conflict(
                "Email này đã có lời mời do người khác tạo. Nhờ người đó huỷ lời mời trước khi mời lại.",
            ));
        }
        // Dưới khoá: kiểm lại email chưa có user (accept đồng thời có thể vừa tạo xong).
        if email_taken(&mut tx, &email)
            .await
            .map_err(|e| fail_sql("tìm email", e))?
            .is_some()
        {
            return Err(conflict("Email này đã có tài khoản trong công ty của bạn"));
        }
        if !old.is_empty() {
            let ids: Vec<i32> = old.iter().map(|o| o.0).collect();
            sqlx::query("UPDATE user_invitations SET revoked_at = $2 WHERE id = ANY($1) AND accepted_at IS NULL AND revoked_at IS NULL")
                .bind(ids)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|e| fail_sql("huỷ lời mời cũ", e))?;
        }
        // Đếm người active + lời mời đang chờ dưới khoá advisory của công ty (cùng luật với mọi đường thêm người).
        assert_user_slot_available(&mut tx, company, self.platform.multi_tenant()).await?;
        let expires = now + TimeDelta::days(INVITE_TTL_DAYS);
        let (id, created_at): (i32, DateTime<Utc>) = sqlx::query_as(
            "INSERT INTO user_invitations (email, role_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4, $5)
             RETURNING id, created_at",
        )
        .bind(&email)
        .bind(role.id)
        .bind(hash_invite_token(&token))
        .bind(expires)
        .bind(actor.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| fail_sql("tạo lời mời", e))?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        Ok(json!({
            "id": id,
            "email": email,
            "role_id": role.id,
            "role_name": role.name,
            "status": "pending",
            "expires_at": iso(expires),
            "created_at": iso(created_at),
            "token": token,
            "path": invite_path(&token),
        }))
    }

    /// `GET /auth/invitations`: mới nhất trước; `pending_only` = chỉ cái còn hiệu lực.
    pub async fn list_invitations(
        &self,
        company: CompanyRef,
        pending_only: bool,
        limit: Option<i64>,
        owners: &OwnerIds,
    ) -> Res<Value> {
        let now = Utc::now();
        let mut c = self.conn(company).await?;
        let limit = limit.unwrap_or(100).clamp(1, 200);
        let (scope_sql, ids): (&str, Vec<i32>) = match owners {
            OwnerIds::All => ("TRUE", Vec::new()),
            OwnerIds::Ids(ids) => ("created_by = ANY($2)", ids.clone()),
        };
        let rows: Vec<InvRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {INV_COLS} FROM user_invitations
             WHERE (NOT $1 OR (accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())) AND {scope_sql}
             ORDER BY id DESC LIMIT {limit}"
        )))
        .bind(pending_only)
        .bind_if(matches!(owners, OwnerIds::Ids(_)), ids)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| fail_sql("danh sách lời mời", e))?;
        let role_ids: Vec<i32> = {
            let mut v: Vec<i32> = rows.iter().filter_map(|r| r.role_id).collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let names: std::collections::HashMap<i32, String> = if role_ids.is_empty() {
            Default::default()
        } else {
            sqlx::query_as::<_, (i32, String)>("SELECT id, name FROM roles WHERE id = ANY($1)")
                .bind(&role_ids)
                .fetch_all(&mut *c)
                .await
                .map_err(|e| fail_sql("vai trò", e))?
                .into_iter()
                .collect()
        };
        let pending_ids: Vec<i32> = rows
            .iter()
            .filter(|r| invitation_status(r.accepted_at, r.revoked_at, r.expires_at, now) == InvitationStatus::Pending)
            .map(|r| r.id)
            .collect();
        let usable: std::collections::HashSet<i32> = if pending_ids.is_empty() {
            Default::default()
        } else {
            sqlx::query_scalar::<_, i32>(AssertSqlSafe(format!(
                "SELECT i.id FROM user_invitations i WHERE i.id = ANY($1::int[]) AND {USABLE_INVITATION_SQL}"
            )))
            .bind(&pending_ids)
            .fetch_all(&mut *c)
            .await
            .map_err(|e| fail_sql("lời mời nhận được", e))?
            .into_iter()
            .collect()
        };
        let data: Vec<Value> = rows
            .iter()
            .map(|r| {
                let mut st = invitation_status(r.accepted_at, r.revoked_at, r.expires_at, now);
                if st == InvitationStatus::Pending && !usable.contains(&r.id) {
                    st = InvitationStatus::Unusable;
                }
                json!({
                    "id": r.id,
                    "email": r.email,
                    "role_id": r.role_id,
                    "role_name": r.role_id.and_then(|id| names.get(&id)),
                    "status": st.as_str(),
                    "expires_at": iso(r.expires_at),
                    "created_at": iso(r.created_at),
                })
            })
            .collect();
        Ok(json!({ "data": data }))
    }

    /// `POST /auth/invitations/:id/revoke`: huỷ lời mời còn hiệu lực (link chết ngay).
    pub async fn revoke_invitation(&self, company: CompanyRef, id: i32, owners: &OwnerIds) -> Res<Value> {
        let mut tx = self.tenant_tx(company).await?;
        lock_user_slots(&mut tx, company)
            .await
            .map_err(|e| fail_sql("khoá chỗ", e))?;
        let row: Option<InvRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {INV_COLS} FROM user_invitations WHERE id = $1"
        )))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| fail_sql("lời mời", e))?;
        // Ngoài phạm vi users.manage của người huỷ ⇒ 404 như chưa từng có.
        let Some(row) = row.filter(|r| owner_allows(owners, r.created_by)) else {
            return Err(HttpError::not_found("Không tìm thấy lời mời").into());
        };
        let now = Utc::now();
        if invitation_status(row.accepted_at, row.revoked_at, row.expires_at, now) != InvitationStatus::Pending {
            return Err(conflict("Lời mời này không còn hiệu lực để huỷ"));
        }
        sqlx::query(
            "UPDATE user_invitations SET revoked_at = $2 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
        )
        .bind(id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| fail_sql("huỷ lời mời", e))?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        Ok(json!({ "message": "Đã huỷ lời mời" }))
    }

    /// Tìm lời mời còn hiệu lực theo token gốc; không có hoặc không còn hiệu lực ⇒ 410.
    async fn find_pending_invitation(&self, company: CompanyRef, raw: &str) -> Res<InvRow> {
        let mut c = self.conn(company).await?;
        let row: Option<InvRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {INV_COLS} FROM user_invitations WHERE token_hash = $1"
        )))
        .bind(hash_invite_token(raw))
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| fail_sql("lời mời", e))?;
        row.filter(|r| {
            invitation_status(r.accepted_at, r.revoked_at, r.expires_at, Utc::now()) == InvitationStatus::Pending
        })
        .ok_or_else(gone)
    }

    /// `POST /auth/invitations/preview` (công khai): tên công ty, email, vai trò. Token sai, hết hạn, đã dùng hay đã huỷ đều
    /// trả cùng một câu 410: không để dò token.
    pub async fn preview_invitation(&self, raw_token: &str) -> Res<Value> {
        let token = raw_token.trim();
        let Some(company) = self.token_company(token).await? else {
            return Err(gone());
        };
        let inv = self.find_pending_invitation(company, token).await?;
        let role_name: Option<String> = match inv.role_id {
            Some(id) => {
                let mut c = self.conn(company).await?;
                sqlx::query_scalar("SELECT name FROM roles WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(|e| fail_sql("vai trò", e))?
            }
            None => None,
        };
        let company_name = self
            .platform
            .company(company.id())
            .await
            .map_err(|e| internal("công ty", e))?
            .map(|r| r.name)
            .unwrap_or_default();
        Ok(json!({
            "company_name": company_name,
            "email": inv.email,
            "role_name": role_name,
            "expires_at": iso(inv.expires_at),
        }))
    }

    /// `POST /auth/invitations/accept` (công khai): tạo user trong ĐÚNG công ty của lời mời (công ty đọc từ tiền tố token), gán vai
    /// trò chủ chọn lúc mời, đăng nhập luôn. Dùng một lần: đánh dấu bằng UPDATE có điều kiện nên hai lần bấm cùng lúc chỉ một lần thắng.
    pub async fn accept_invitation(
        &self,
        token: &str,
        full_name: &str,
        password_in: &str,
        ip: Option<&str>,
        ip_trusted: bool,
    ) -> Res<Value> {
        // IP không tin được: không gộp mọi người vào một xô IP peer; khoá theo token (băm) + một trần chung cao hơn.
        let token = token.trim();
        let token_key: String = hash_invite_token(token).chars().take(24).collect();
        let keys: Vec<String> = if ip_trusted {
            vec![format!("invite:{}", ip.unwrap_or("unknown"))]
        } else {
            vec![
                format!("invite-untrusted:{token_key}"),
                "invite-untrusted-all".to_owned(),
            ]
        };
        if keys.iter().any(|k| self.enforce_rate_limit(k).is_some()) {
            return Err(HttpError::new(429, "Quá nhiều lần thử, vui lòng thử lại sau").into());
        }
        let record_failure = |this: &Self| {
            let now = Self::now();
            let mut l = this.limiter();
            for k in &keys {
                l.record_attempt(k, now);
            }
        };
        let Some(company) = self.token_company(token).await? else {
            record_failure(self);
            return Err(gone());
        };
        let inv = match self.find_pending_invitation(company, token).await {
            Ok(i) => i,
            Err(e) => {
                record_failure(self);
                return Err(e);
            }
        };
        self.assert_email_available(company, &inv.email).await?;
        let password_hash = password::hash(password_in.to_owned())
            .await
            .map_err(|e| internal("băm mật khẩu", e))?;
        let user_id = match self.accept_tx(company, &inv, full_name, &password_hash).await {
            Ok(id) => id,
            Err(e) => {
                if e.error().status() == 410 {
                    record_failure(self);
                }
                return Err(e);
            }
        };
        // Nhật ký đổi mật khẩu: người thực hiện là người mời; lỗi ghi chỉ ghi log.
        let _ = self.log_user_create(company, inv.created_by, user_id, ip).await;
        let user = self
            .find_by_id(company, user_id)
            .await?
            .ok_or_else(|| HttpError::nest(500, Some("Chưa tạo được tài khoản, vui lòng thử lại".into())))?;
        // Cùng cổng với login(): kiểm Wi-Fi văn phòng (tài khoản đã tạo; chặn thì đăng nhập sau từ văn phòng) và "1 tài khoản 1 phiên".
        if self.login_wifi_active(company).await {
            let grants = self.grants_of(company, user.id).await?;
            let (allowed, _reason) = self.check_login_wifi(company, &user, &grants, ip, ip_trusted).await;
            if !allowed {
                self.log_login(company, Some(user.id), &user.email, false, ip, LoginReason::WifiBlocked)
                    .await?;
                return Err(HttpError::unauthorized(
                    "Tài khoản đã được tạo, nhưng bạn đang không kết nối wifi của văn phòng công ty. Hãy kết nối wifi tại một văn phòng rồi đăng nhập.",
                )
                .into());
            }
        }
        self.log_login(company, Some(user.id), &user.email, true, ip, LoginReason::Ok)
            .await?;
        self.security.remove_user(company.id(), user.id).await;
        let sid = if self.single_session_active(company).await {
            Some(self.security.start_session(company.id(), user.id).await)
        } else {
            None
        };
        self.token_response(company, &user, sid, uuid::Uuid::new_v4().to_string())
            .await
    }

    async fn accept_tx(&self, company: CompanyRef, inv: &InvRow, full_name: &str, password_hash: &str) -> Res<i32> {
        let mut tx = self.tenant_tx(company).await?;
        // Khoá advisory của công ty là câu ĐẦU của giao dịch: cùng thứ tự với tạo/huỷ/mời lại nên không khoá chéo nhau.
        lock_user_slots(&mut tx, company)
            .await
            .map_err(|e| fail_sql("khoá chỗ", e))?;
        let now = Utc::now();
        // Giành lời mời (một lần; từ đây không còn tính là lời mời đang chờ). Lùi cả giao dịch nếu bước sau lỗi: link còn dùng được.
        let claimed = sqlx::query(
            "UPDATE user_invitations SET accepted_at = $2 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2",
        )
        .bind(inv.id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| fail_sql("giành lời mời", e))?
        .rows_affected();
        if claimed != 1 {
            return Err(gone());
        }
        // Người mời phải còn hoạt động, còn users.manage, và vai trò được mời không vượt quyền của họ (như lúc tạo).
        let inviter: Option<(i32, Option<i32>)> = match inv.created_by {
            None => None,
            Some(id) => sqlx::query_as(
                "SELECT id, team_id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| fail_sql("người mời", e))?,
        };
        let inviter_grants: Option<UserGrants> = match inviter {
            Some((id, _)) => Some(self.grants_of(company, id).await?),
            None => None,
        };
        let (Some((inviter_id, inviter_team)), Some(ig)) = (inviter, inviter_grants) else {
            return Err(gone());
        };
        if !(ig.is_admin || ig.can("users.manage")) {
            return Err(gone());
        }
        let role = match inv.role_id {
            None => None,
            Some(id) => load_role(&mut tx, id).await.map_err(|e| fail_sql("vai trò", e))?,
        };
        let Some(role) = role else {
            return Err(conflict(
                "Vai trò của lời mời này đã bị xoá. Hãy nhờ chủ công ty mời lại.",
            ));
        };
        let inviter_g: Grants = trinity_rbac::grants::grants_from_json(&Value::Object(ig.grants.clone()));
        if !ig.is_admin && (role.is_system || !is_subset(&grants_of_roles(&[&role]), &inviter_g)) {
            return Err(gone());
        }
        let existing: Option<i32> =
            sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1")
                .bind(&inv.email)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| fail_sql("tìm email", e))?;
        if existing.is_some() {
            return Err(conflict("Email này đã có tài khoản trong công ty — hãy đăng nhập"));
        }
        assert_user_slot_available(&mut tx, company, self.platform.multi_tenant()).await?;
        // Người mời có phạm vi hẹp (own/team/subtree): gắn người mới dưới người mời để họ quản lý được người họ mời.
        let manage = ig.grants.get("users.manage");
        let narrow =
            !ig.is_admin && !matches!(manage, Some(Value::Bool(true)) | Some(Value::String(_)) if is_full(manage));
        let team_id = if narrow && manage.and_then(Value::as_str) == Some("team") {
            inviter_team
        } else {
            None
        };
        // Người dùng đã xoá mềm giữ email gốc ⇒ đổi tên để nhường chỗ (cùng cách users.service.create).
        let old: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NOT NULL LIMIT 1",
        )
        .bind(&inv.email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| fail_sql("tài khoản đã xoá", e))?;
        if let Some(old) = old {
            sqlx::query("UPDATE users SET email = $2, updated_at = now() WHERE id = $1")
                .bind(old)
                .bind(format!("deleted_{old}_{}@removed.invalid", now.timestamp_millis()))
                .execute(&mut *tx)
                .await
                .map_err(|e| fail_sql("đổi tên tài khoản đã xoá", e))?;
        }
        let user_id: i32 = sqlx::query_scalar(
            "INSERT INTO users (email, full_name, password_hash, password_updated_at, status, manager_id, team_id, updated_at)
             VALUES ($1, $2, $3, $4, 'active', $5, $6, now()) RETURNING id",
        )
        .bind(&inv.email)
        .bind(full_name.trim())
        .bind(password_hash)
        .bind(now)
        .bind(narrow.then_some(inviter_id))
        .bind(team_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| fail_sql("tạo người dùng", e))?;
        sqlx::query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)")
            .bind(user_id)
            .bind(role.id)
            .execute(&mut *tx)
            .await
            .map_err(|e| fail_sql("gán vai trò", e))?;
        // Mọi tài khoản CRM đồng thời là một nhân viên (cùng users.service.create).
        sqlx::query("INSERT INTO employees (user_id, position, status) VALUES ($1, 'Chưa phân loại', 'active') ON CONFLICT (user_id) DO NOTHING")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| fail_sql("tạo nhân viên", e))?;
        sqlx::query("UPDATE user_invitations SET accepted_user_id = $2 WHERE id = $1")
            .bind(inv.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| fail_sql("ghi người nhận", e))?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        Ok(user_id)
    }

    async fn log_user_create(&self, company: CompanyRef, actor: Option<i32>, target: i32, ip: Option<&str>) -> Res<()> {
        let mut c = self.conn(company).await?;
        let res = sqlx::query(
            "INSERT INTO audit_logs (user_id, action, resource, resource_id, ip_address, metadata)
             VALUES ($1, 'password_change', 'users', $2, $3, $4)",
        )
        .bind(actor)
        .bind(target)
        .bind(ip)
        .bind(json!({ "method": "user_create", "actor_role": null, "target_user_id": target }))
        .execute(&mut *c)
        .await;
        if let Err(e) = res {
            tracing::error!("[auth] không ghi được nhật ký đổi mật khẩu [method=user_create target={target}]: {e}");
        }
        Ok(())
    }

    /// `POST /auth/register`: đăng ký tự phục vụ. Công ty mới (schema riêng, CRM trống) có đúng một người dùng là chủ, rồi trả
    /// phản hồi token như đăng nhập, ký trong công ty mới. Công ty dựng bằng migrator Rust (K07/K09).
    pub async fn register(
        &self,
        company_name: &str,
        email: &str,
        password_in: &str,
        full_name: &str,
        ip: Option<&str>,
        ip_trusted: bool,
    ) -> Res<Value> {
        if !self.signup_enabled() {
            return Err(HttpError::not_found("Bản cài đặt này không mở đăng ký").into());
        }
        // IP không tin được: khoá theo email + trần chung, CHỈ đếm lần thất bại (đăng ký thành công của người này không làm hết
        // lượt của người khác).
        let norm = Self::norm_email(email);
        let keys: Vec<String> = if ip_trusted {
            vec![format!("register:{}", ip.unwrap_or("unknown"))]
        } else {
            vec![
                format!("register-untrusted:{norm}"),
                "register-untrusted-all".to_owned(),
            ]
        };
        if keys.iter().any(|k| self.enforce_rate_limit(k).is_some()) {
            return Err(HttpError::new(429, "Quá nhiều lần đăng ký, vui lòng thử lại sau").into());
        }
        let record = |this: &Self| {
            let now = Self::now();
            let mut l = this.limiter();
            for k in &keys {
                l.record_attempt(k, now);
            }
        };
        if ip_trusted {
            record(self);
        }
        let migrations = trinity_db::migrate::embedded_migrations();
        let input = ProvisionInput {
            company_name: company_name.to_owned(),
            admin_email: email.to_owned(),
            admin_password: password_in.to_owned(),
            admin_name: full_name.to_owned(),
        };
        let result = match provision_company(&self.db, &self.platform, &migrations, LATEST_MIGRATION, &input).await {
            Ok(r) => r,
            Err(e) => {
                if !ip_trusted {
                    record(self);
                }
                return Err(match e {
                    ProvisionError::EmailTaken => HttpError::new(409, "Email này đã được dùng — hãy đăng nhập").into(),
                    other => {
                        tracing::error!("register failed: {other}");
                        HttpError::nest(500, Some("Chưa tạo được công ty, vui lòng thử lại".into())).into()
                    }
                });
            }
        };
        let company = result.company;
        let user = self.find_by_email(company, email).await?.ok_or_else(|| {
            AuthFail::from(HttpError::nest(
                500,
                Some("Chưa tạo được công ty, vui lòng thử lại".into()),
            ))
        })?;
        self.log_login(company, Some(user.id), email, true, ip, LoginReason::Ok)
            .await?;
        self.token_response(company, &user, None, uuid::Uuid::new_v4().to_string())
            .await
    }
}

/// `users.manage` đủ rộng để không cần gắn người mới dưới người mời: `true` hoặc phạm vi `all`.
fn is_full(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true))) || v.and_then(Value::as_str) == Some("all")
}

trait BindIf<'q>: Sized {
    fn bind_if<T: 'q + sqlx::Encode<'q, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send>(
        self,
        cond: bool,
        v: T,
    ) -> Self;
}

impl<'q, O> BindIf<'q> for sqlx::query::QueryAs<'q, sqlx::Postgres, O, <sqlx::Postgres as sqlx::Database>::Arguments> {
    fn bind_if<T: 'q + sqlx::Encode<'q, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send>(
        self,
        cond: bool,
        v: T,
    ) -> Self {
        if cond { self.bind(v) } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_company_va_hash() {
        assert_eq!(company_id_of_token("abc"), 1);
        assert_eq!(company_id_of_token("c2.abc"), 2);
        assert_eq!(company_id_of_token("c0.abc"), 1);
        assert_eq!(company_id_of_token("c02.abc"), 1);
        assert_eq!(company_id_of_token("c12345678901.abc"), 1, "tối đa 10 chữ số");
        assert_eq!(company_id_of_token("c3."), 1, "thiếu phần bí mật");
        assert_eq!(company_id_of_token("c3.a\nb"), 3, "dotall");
        assert_eq!(company_token_prefix(1), "");
        assert_eq!(company_token_prefix(7), "c7.");
        assert_eq!(
            hash_invite_token("a"),
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
        );
        let t = new_invite_token(5).unwrap();
        assert!(t.starts_with("c5.") && t.len() == 3 + 43);
        assert!(!new_invite_token(1).unwrap().contains('.'));
    }

    #[test]
    fn trang_thai_loi_moi() {
        let now = Utc::now();
        let future = now + TimeDelta::days(1);
        let past = now - TimeDelta::days(1);
        assert_eq!(invitation_status(None, None, future, now), InvitationStatus::Pending);
        assert_eq!(invitation_status(None, None, past, now), InvitationStatus::Expired);
        assert_eq!(
            invitation_status(None, Some(past), future, now),
            InvitationStatus::Revoked
        );
        assert_eq!(
            invitation_status(Some(past), Some(past), future, now),
            InvitationStatus::Accepted
        );
    }

    #[test]
    fn goi_giai_duoc_nhu_ban_ts() {
        let me = CompanyRef::new(2).unwrap();
        // Công ty 1 / một công ty: `custom` (không giới hạn); công ty ≥ 2 đa công ty: gói đăng ký mặc định (10 người).
        assert_eq!(plan_max_users(None, CompanyRef::DEFAULT, true), None);
        assert_eq!(plan_max_users(None, me, false), None);
        assert_eq!(plan_max_users(None, me, true), Some(10));
        assert_eq!(plan_max_users(Some("rác"), me, true), Some(10));
        assert_eq!(plan_max_users(Some(" tro_ly_kinh_doanh "), me, true), Some(30));
        assert_eq!(plan_max_users(Some("custom"), me, true), None);
    }

    #[test]
    fn full_scope() {
        assert!(is_full(Some(&Value::Bool(true))) && is_full(Some(&json!("all"))));
        assert!(!is_full(Some(&json!("team"))) && !is_full(None));
    }
}
