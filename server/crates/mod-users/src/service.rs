//! Quản lý người dùng (M03): chuyển từ `services/auth/src/users/users.service.ts` và `setUserRoles` của `roles.service.ts`.
//! Mỗi hàm nhận [`Ctx`] (kết nối, quyền, phạm vi, phiên) và [`Actor`] do guard của router điền.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use serde_json::{Map, Value, json};
use sqlx::{FromRow, PgConnection, Postgres, QueryBuilder};
use trinity_auth::{Security, password};
use trinity_db::platform::{Platform, PlatformError, conflict_from_trigger};
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, Db, TenantTx};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{Grants, OwnerIds, PermissionService, PhoneMasker, RbacCache, ScopeService, is_subset, push_scope};

use crate::guards::{
    Actor, R, assert_can_manage_user, assert_not_last_admin, assert_user_slot_available, db, lock_admin_mutation,
    revoke_pending_by, revoke_pending_for_email, scope_err, sync_employee_resignation,
};

/// Phụ thuộc của module: dựng một lần ở `serve` rồi chia sẻ.
pub struct Ctx {
    pub db: Db,
    pub platform: Platform,
    pub security: Arc<Security>,
    pub scopes: ScopeService,
    pub perms: PermissionService,
    pub cache: Arc<RbacCache>,
}

impl Ctx {
    pub async fn conn(&self, company: CompanyRef) -> R<trinity_db::TenantConn> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.acquire().await.map_err(AppError::internal)
    }

    pub async fn begin(&self, company: CompanyRef) -> R<TenantTx> {
        let t = self.db.tenant(company).await.map_err(AppError::internal)?;
        t.begin().await.map_err(AppError::internal)
    }

    fn multi_tenant(&self) -> bool {
        self.platform.multi_tenant()
    }

    /// Mọi cây quản lý/khoá đều có thể đổi tập phạm vi của tổ tiên: vô hiệu hết, rẻ (cache RAM, TTL ngắn).
    async fn invalidate_all(&self, company: CompanyRef) {
        self.cache
            .invalidate_users(company.id(), trinity_rbac::cache::Users::All)
            .await;
    }
}

/// Lỗi ghi `users`: lỗi trigger email/route giữa các công ty thành 409 đúng câu.
fn wr(e: sqlx::Error) -> AppError {
    match conflict_from_trigger(&e) {
        Some(m) => HttpError::conflict(m).into(),
        None => db(e),
    }
}

fn scoped(actor: &Actor, e: trinity_rbac::ScopeError) -> AppError {
    let _ = actor;
    scope_err(e)
}

fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        None => "***".to_owned(),
        Some((local, domain)) => match local.chars().next() {
            Some(c) if local.chars().count() > 1 => format!("{c}***@{domain}"),
            _ => format!("*@{domain}"),
        },
    }
}

/// Trường PATCH: không gửi (giữ), gửi `null` (xoá), gửi giá trị (đặt).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Patch<T> {
    Keep,
    Clear,
    Set(T),
}

fn patch_of<T>(v: &Value, key: &str, get: impl Fn(&Value) -> Option<T>) -> Patch<T> {
    match v.get(key) {
        None => Patch::Keep,
        Some(Value::Null) => Patch::Clear,
        Some(x) => get(x).map_or(Patch::Keep, Patch::Set),
    }
}

fn int4(v: &Value) -> Option<i32> {
    v.as_i64().and_then(|n| i32::try_from(n).ok())
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

// ---------------------------------------------------------------- danh sách

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagerFilter {
    Any,
    /// `manager_id=none`: người chưa có quản lý.
    Nobody,
    Is(i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    Email,
    FullName,
    Status,
    CreatedAt,
}

impl SortBy {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "email" => Self::Email,
            "full_name" => Self::FullName,
            "status" => Self::Status,
            "created_at" => Self::CreatedAt,
            _ => return None,
        })
    }

    fn column(self) -> &'static str {
        match self {
            Self::Email => "u.email",
            Self::FullName => "u.full_name",
            Self::Status => "u.status",
            Self::CreatedAt => "u.created_at",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ListParams {
    pub page: i64,
    pub limit: i64,
    pub team_id: Option<i32>,
    pub role: Option<String>,
    pub roles: Option<Vec<String>>,
    pub manager: ManagerFilter,
    pub search: Option<String>,
    pub status: Option<String>,
    pub sort_by: Option<SortBy>,
    pub desc: Option<bool>,
}

impl Default for ListParams {
    fn default() -> Self {
        Self {
            page: 1,
            limit: 20,
            team_id: None,
            role: None,
            roles: None,
            manager: ManagerFilter::Any,
            search: None,
            status: None,
            sort_by: None,
            desc: None,
        }
    }
}

#[derive(FromRow)]
struct ListRow {
    id: i32,
    email: String,
    full_name: String,
    phone: Option<String>,
    avatar_url: Option<String>,
    team_id: Option<i32>,
    manager_id: Option<i32>,
    status: String,
    created_at: Timestamp,
    team_name: Option<String>,
    manager_full_name: Option<String>,
}

async fn roles_by_user(conn: &mut PgConnection, ids: &[i32]) -> R<std::collections::BTreeMap<i32, Vec<String>>> {
    let rows: Vec<(i32, String)> = sqlx::query_as(
        "SELECT ur.user_id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ANY($1) ORDER BY ur.id",
    )
    .bind(ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut out: std::collections::BTreeMap<i32, Vec<String>> = std::collections::BTreeMap::new();
    for (u, name) in rows {
        out.entry(u).or_default().push(name);
    }
    Ok(out)
}

async fn masker(ctx: &Ctx, actor: &Actor) -> R<PhoneMasker> {
    let allowed = ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "users.phone_full")
        .await
        .map_err(AppError::internal)?;
    Ok(PhoneMasker::new(allowed))
}

fn push_filters(qb: &mut QueryBuilder<Postgres>, p: &ListParams) {
    if let Some(t) = p.team_id {
        qb.push(" AND u.team_id = ").push_bind(t);
    }
    match &p.manager {
        ManagerFilter::Any => {}
        ManagerFilter::Nobody => {
            qb.push(" AND u.manager_id IS NULL");
        }
        ManagerFilter::Is(m) => {
            qb.push(" AND u.manager_id = ").push_bind(*m);
        }
    }
    if let Some(s) = p.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND u.status = ").push_bind(s.to_owned());
    }
    if let Some(s) = p.search.as_deref().filter(|s| !s.is_empty()) {
        // Như Prisma `contains` + `mode: 'insensitive'`: `ILIKE '%q%'` không thoát `%`/`_`.
        let pat = format!("%{s}%");
        qb.push(" AND (u.full_name ILIKE ")
            .push_bind(pat.clone())
            .push(" OR u.email ILIKE ")
            .push_bind(pat)
            .push(")");
    }
    let names: Vec<String> = match (&p.roles, &p.role) {
        (Some(r), _) if !r.is_empty() => r.clone(),
        (_, Some(r)) if !r.is_empty() => vec![r.clone()],
        _ => Vec::new(),
    };
    if !names.is_empty() {
        qb.push(" AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.name = ANY(")
            .push_bind(names)
            .push("))");
    }
}

/// `GET /users`: phạm vi `users.view` theo chính `id` của dòng, SĐT che theo `users.phone_full`.
pub async fn list(ctx: &Ctx, actor: &Actor, p: &ListParams) -> R<Value> {
    let owner = ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "users.view")
        .await
        .map_err(AppError::internal)?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let mut conn = ctx.conn(actor.company).await?;
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url, u.team_id, u.manager_id, u.status, u.created_at, \
         t.name AS team_name, m.full_name AS manager_full_name \
         FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN users m ON m.id = u.manager_id WHERE ",
    );
    push_scope(&mut qb, &owner, &["u.id"]);
    push_filters(&mut qb, p);
    qb.push(" AND u.deleted_at IS NULL ORDER BY ");
    match p.sort_by {
        Some(s) => {
            qb.push(s.column())
                .push(if p.desc == Some(true) { " DESC" } else { " ASC" })
                .push(", u.id ASC");
        }
        None => {
            qb.push("u.id ASC");
        }
    }
    let page = p.page.max(1);
    let limit = p.limit.clamp(0, 1000);
    qb.push(" LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind((page - 1) * limit);
    let rows: Vec<ListRow> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;

    let mut cq = QueryBuilder::<Postgres>::new("SELECT count(*) FROM users u WHERE ");
    push_scope(&mut cq, &owner, &["u.id"]);
    push_filters(&mut cq, p);
    cq.push(" AND u.deleted_at IS NULL");
    let total: i64 = cq.build_query_scalar().fetch_one(&mut *conn).await.map_err(db)?;

    let mask = masker(ctx, actor).await?;
    let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
    let mut roles = roles_by_user(&mut conn, &ids).await?;
    let data: Vec<Value> = rows
        .into_iter()
        .map(|u| {
            let phone = mask.mask(&[Some(u.id)], u.phone.as_deref());
            json!({
                "id": u.id, "email": u.email, "full_name": u.full_name, "phone": phone, "avatar_url": u.avatar_url,
                "team_id": u.team_id, "manager_id": u.manager_id, "status": u.status, "created_at": u.created_at,
                "team": u.team_name.map(|n| json!({ "name": n })),
                "manager": u.manager_id.zip(u.manager_full_name).map(|(id, n)| json!({ "id": id, "full_name": n })),
                "roles": roles.remove(&u.id).unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({ "data": data, "total": total, "page": p.page, "limit": p.limit }))
}

#[derive(FromRow)]
struct DetailRow {
    id: i32,
    email: String,
    full_name: String,
    phone: Option<String>,
    avatar_url: Option<String>,
    team_id: Option<i32>,
    manager_id: Option<i32>,
    status: String,
    deleted_at: Option<Timestamp>,
    created_at: Timestamp,
    updated_at: Timestamp,
    team_name: Option<String>,
}

/// `GET /users/:id`: ngoài phạm vi ⇒ 404 "Không tìm thấy"; đã xoá vĩnh viễn ⇒ 404 "Không tìm thấy người dùng".
pub async fn find_by_id(ctx: &Ctx, actor: &Actor, id: i32) -> R<Value> {
    ctx.scopes
        .assert_in_scope(actor.company, actor.user_id, &actor.grants, "users.view", &[Some(id)])
        .await
        .map_err(|e| scoped(actor, e))?;
    let mut conn = ctx.conn(actor.company).await?;
    let u: Option<DetailRow> = sqlx::query_as(
        "SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url, u.team_id, u.manager_id, u.status, u.deleted_at, \
         u.created_at, u.updated_at, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let u = u
        .filter(|u| u.deleted_at.is_none())
        .ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
    let mask = masker(ctx, actor).await?;
    let roles = roles_by_user(&mut conn, &[id]).await?.remove(&id).unwrap_or_default();
    Ok(json!({
        "id": u.id, "email": u.email, "full_name": u.full_name, "phone": mask.mask(&[Some(u.id)], u.phone.as_deref()),
        "avatar_url": u.avatar_url, "team_id": u.team_id, "manager_id": u.manager_id, "status": u.status,
        "deleted_at": u.deleted_at, "created_at": u.created_at, "updated_at": u.updated_at,
        "team": u.team_name.map(|n| json!({ "name": n })), "roles": roles,
    }))
}

/// Dòng cho xuất Excel: cùng bộ lọc và phạm vi với danh sách, sắp theo tên (A→Z) nếu không chọn khác.
pub async fn export_rows(ctx: &Ctx, actor: &Actor, p: &ListParams) -> R<Vec<(String, Vec<String>, String)>> {
    let q = ListParams {
        page: 1,
        limit: 100_000,
        sort_by: p.sort_by.or(Some(SortBy::FullName)),
        desc: p.desc.or(Some(false)),
        ..p.clone()
    };
    // `list` giới hạn 1000 dòng/trang như controller; xuất lấy từng trang cho tới hết.
    let mut out = Vec::new();
    let mut page = 1;
    loop {
        let r = list(
            ctx,
            actor,
            &ListParams {
                page,
                limit: 1000,
                ..q.clone()
            },
        )
        .await?;
        let rows = r["data"].as_array().cloned().unwrap_or_default();
        let n = rows.len();
        for u in rows {
            let roles = u["roles"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            out.push((
                u["full_name"].as_str().unwrap_or_default().to_owned(),
                roles,
                u["status"].as_str().unwrap_or_default().to_owned(),
            ));
        }
        if n < 1000 {
            break;
        }
        page += 1;
    }
    Ok(out)
}

// ---------------------------------------------------------------- ràng buộc quản lý

async fn assert_manager_active(conn: &mut PgConnection, manager: i32) -> R<()> {
    let m: Option<(String, Option<Timestamp>)> = sqlx::query_as("SELECT status, deleted_at FROM users WHERE id = $1")
        .bind(manager)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    match m {
        Some((status, None)) if status == "active" => Ok(()),
        Some((_, None)) => Err(HttpError::bad_request("Người quản lý phải đang hoạt động (active)").into()),
        _ => Err(HttpError::not_found("Không tìm thấy người quản lý").into()),
    }
}

const MAX_MANAGER_CHAIN_DEPTH: usize = 10;

/// Chặn vòng lặp: đi ngược chuỗi `manager_id` từ `new_manager`; gặp `user` ⇒ 400.
async fn assert_no_manager_cycle(conn: &mut PgConnection, user: i32, new_manager: i32) -> R<()> {
    let cycle = || HttpError::bad_request("Phát hiện vòng lặp trong cấu trúc quản lý");
    if new_manager == user {
        return Err(cycle().into());
    }
    let mut cursor = Some(new_manager);
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..MAX_MANAGER_CHAIN_DEPTH {
        let Some(c) = cursor else { return Ok(()) };
        if c == user {
            return Err(cycle().into());
        }
        if !seen.insert(c) {
            return Err(HttpError::bad_request("Phát hiện vòng lặp trong cấu trúc quản lý (DB dirty)").into());
        }
        let parent: Option<Option<i32>> = sqlx::query_scalar("SELECT manager_id FROM users WHERE id = $1")
            .bind(c)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
        match parent {
            None => return Ok(()),
            Some(p) => cursor = p,
        }
    }
    Err(HttpError::bad_request("Chain quản lý vượt quá độ sâu cho phép (có thể có vòng lặp)").into())
}

/// Chuyển cấp dưới của người bị khoá/xoá trong CÙNG giao dịch: sang `reassign_to` (hợp lệ, không tạo vòng) hoặc mồ côi.
async fn cascade_reassign(conn: &mut PgConnection, locked: i32, reassign_to: Option<i32>) -> R<()> {
    let Some(to) = reassign_to else {
        sqlx::query("UPDATE users SET manager_id = NULL, updated_at = now() WHERE manager_id = $1")
            .bind(locked)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        tracing::warn!("Locked user #{locked}: cấp dưới mồ côi (manager_id=null), không có reassign_to");
        return Ok(());
    };
    if to == locked {
        return Err(HttpError::bad_request("Không thể chuyển giao cho chính user đang bị khoá").into());
    }
    let nm: Option<(String, Option<Timestamp>, Option<i32>)> =
        sqlx::query_as("SELECT status, deleted_at, manager_id FROM users WHERE id = $1")
            .bind(to)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((status, deleted, to_manager)) = nm else {
        return Err(HttpError::not_found("Người quản lý mới không tồn tại").into());
    };
    if deleted.is_some() {
        return Err(HttpError::not_found("Người quản lý mới không tồn tại").into());
    }
    if status != "active" {
        return Err(HttpError::bad_request("Người quản lý mới phải đang active").into());
    }
    // `reassign_to` có thể là cấp dưới của người bị khoá ở BẤT KỲ độ sâu nào: đi ngược chuỗi của nó; gặp người bị khoá thì
    // nâng nó lên cấp trên của người bị khoá để không tạo vòng.
    let mut descendant = false;
    let mut cursor = to_manager;
    let mut seen = std::collections::BTreeSet::from([to]);
    while let Some(c) = cursor {
        if seen.contains(&c) {
            break;
        }
        if c == locked {
            descendant = true;
            break;
        }
        seen.insert(c);
        cursor = sqlx::query_scalar::<_, Option<i32>>("SELECT manager_id FROM users WHERE id = $1")
            .bind(c)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?
            .flatten();
    }
    if descendant {
        let up: Option<i32> = sqlx::query_scalar("SELECT manager_id FROM users WHERE id = $1")
            .bind(locked)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE users SET manager_id = $1, updated_at = now() WHERE id = $2")
            .bind(up)
            .bind(to)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    sqlx::query("UPDATE users SET manager_id = $1, updated_at = now() WHERE manager_id = $2 AND id <> $1")
        .bind(to)
        .bind(locked)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

// ---------------------------------------------------------------- nhật ký

async fn log_password_change(ctx: &Ctx, company: CompanyRef, actor: Option<i32>, target: i32, method: &str) {
    let res = async {
        let mut c = ctx.conn(company).await?;
        sqlx::query(
            "INSERT INTO audit_logs (user_id, action, resource, resource_id, ip_address, metadata) \
             VALUES ($1, 'password_change', 'users', $2, NULL, $3)",
        )
        .bind(actor)
        .bind(target)
        .bind(json!({ "method": method, "actor_role": null, "target_user_id": target }))
        .execute(&mut *c)
        .await
        .map_err(db)?;
        Ok::<(), AppError>(())
    }
    .await;
    if res.is_err() {
        tracing::error!("không ghi được nhật ký đổi mật khẩu [method={method} target={target}]");
    }
}

// ---------------------------------------------------------------- tạo, sửa

#[derive(Debug, Clone)]
pub struct CreateUser {
    pub email: String,
    pub full_name: String,
    pub password: String,
    pub team_id: Option<i32>,
    pub manager_id: Option<i32>,
}

impl CreateUser {
    /// Kiểm body như `CreateUserDto` (câu lỗi của class-validator, theo thứ tự trường).
    pub fn parse(body: &Value) -> Result<Self, HttpError> {
        let mut errors = Vec::new();
        let s = |k: &str| body.get(k).and_then(Value::as_str);
        let email = s("email");
        if email.is_none_or(|e| !valid_email(e)) {
            errors.push("Email không hợp lệ".to_owned());
        }
        if s("full_name").is_none() {
            errors.push("full_name must be a string".to_owned());
        }
        match s("password") {
            None => {
                errors.push("password must be a string".to_owned());
                errors.push("Mật khẩu tối thiểu 8 ký tự".to_owned());
            }
            Some(p) if p.chars().count() < 8 => errors.push("Mật khẩu tối thiểu 8 ký tự".to_owned()),
            Some(_) => {}
        }
        let opt_int = |k: &str, errors: &mut Vec<String>, label: &str| -> Option<i32> {
            match body.get(k) {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let n = int4(v).filter(|_| v.is_i64() || v.is_u64());
                    if n.is_none() {
                        errors.push(label.to_owned());
                    }
                    n
                }
            }
        };
        let team_id = opt_int("team_id", &mut errors, "team_id must be an integer number");
        let manager_id = opt_int("manager_id", &mut errors, "manager_id phải là số nguyên");
        if !errors.is_empty() {
            return Err(HttpError::validation(errors));
        }
        Ok(Self {
            email: email.unwrap_or_default().to_owned(),
            full_name: s("full_name").unwrap_or_default().to_owned(),
            password: s("password").unwrap_or_default().to_owned(),
            team_id,
            manager_id,
        })
    }
}

/// `isEmail` của class-validator, rút gọn: một `@`, phần trước và domain không rỗng, domain có dấu chấm, không khoảng trắng.
pub fn valid_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !e.contains(char::is_whitespace)
        && domain.contains('.')
        && !domain.starts_with(['.', '-'])
        && !domain.ends_with(['.', '-'])
        && !domain.contains("..")
        && !domain.contains('@')
        && local.len() <= 64
        && e.len() <= 254
}

fn taken(e: PlatformError) -> AppError {
    match e {
        PlatformError::Conflict(m) => HttpError::conflict(m).into(),
        other => AppError::internal(other),
    }
}

/// Phạm vi lời mời theo `users.manage`: `None` = mọi lời mời, danh sách = chỉ lời mời do người trong phạm vi tạo.
async fn invitation_owners(ctx: &Ctx, actor: &Actor) -> R<Option<Vec<i32>>> {
    let o = ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "users.manage")
        .await
        .map_err(AppError::internal)?;
    Ok(match o {
        Some(OwnerIds::All) => None,
        Some(OwnerIds::Ids(v)) => Some(v),
        None => Some(Vec::new()),
    })
}

/// `POST /users`.
pub async fn create(ctx: &Ctx, actor: &Actor, input: &CreateUser) -> R<Value> {
    // Email mới luôn chuẩn hoá lowercase; kiểm trùng không phân biệt hoa/thường.
    let email = input.email.trim().to_lowercase();
    ctx.platform
        .assert_email_available(&email, actor.company)
        .await
        .map_err(taken)?;
    {
        let mut conn = ctx.conn(actor.company).await?;
        let existing: Option<(i32, Option<Timestamp>)> =
            sqlx::query_as("SELECT id, deleted_at FROM users WHERE lower(email) = lower($1) ORDER BY id LIMIT 1")
                .bind(&email)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        if let Some((_, None)) = existing {
            return Err(HttpError::conflict("Email đã tồn tại").into());
        }
        if let Some(m) = input.manager_id {
            assert_manager_active(&mut conn, m).await?;
        }
    }
    let hash = password::hash(input.password.clone())
        .await
        .map_err(AppError::internal)?;
    let owners = invitation_owners(ctx, actor).await?;
    let mut tx = ctx.begin(actor.company).await?;
    // Người đã xoá vĩnh viễn còn giữ email gốc (dữ liệu cũ): đổi tên để nhường chỗ, kiểm lại trong giao dịch.
    let old: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NOT NULL ORDER BY id LIMIT 1",
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    if let Some(old) = old {
        sqlx::query("UPDATE users SET email = 'deleted_' || id || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint || '@removed.invalid', updated_at = now() WHERE id = $1")
            .bind(old)
            .execute(&mut *tx)
            .await
            .map_err(wr)?;
    }
    revoke_pending_for_email(&mut tx, actor.company, &email, owners.as_deref()).await?;
    assert_user_slot_available(&mut tx, actor.company, ctx.multi_tenant()).await?;
    let row: (i32, String, String, Option<i32>, Option<i32>, String) = sqlx::query_as(
        "INSERT INTO users (email, full_name, password_hash, password_updated_at, team_id, manager_id, updated_at) \
         VALUES ($1, $2, $3, now(), $4, $5, now()) RETURNING id, email, full_name, team_id, manager_id, status",
    )
    .bind(&email)
    .bind(&input.full_name)
    .bind(hash)
    .bind(input.team_id)
    .bind(input.manager_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(wr)?;
    tx.commit().await.map_err(AppError::internal)?;
    log_password_change(ctx, actor.company, Some(actor.user_id), row.0, "user_create").await;
    // Mọi tài khoản CRM đồng thời là một nhân viên: hồ sơ tối thiểu, idempotent.
    let mut conn = ctx.conn(actor.company).await?;
    sqlx::query("INSERT INTO employees (user_id, position, status) VALUES ($1, 'Chưa phân loại', 'active') ON CONFLICT (user_id) DO NOTHING")
        .bind(row.0)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    ctx.invalidate_all(actor.company).await;
    Ok(
        json!({ "id": row.0, "email": row.1, "full_name": row.2, "team_id": row.3, "manager_id": row.4, "status": row.5 }),
    )
}

#[derive(Debug, Clone)]
pub struct UpdateUser {
    pub email: Option<String>,
    pub full_name: Option<String>,
    pub phone: Patch<String>,
    pub team_id: Patch<i32>,
    pub manager_id: Patch<i32>,
    pub status: Option<String>,
    pub reassign_to: Option<i32>,
}

impl UpdateUser {
    /// Từ body đã qua K15 (`UpdateUserDto`, lenient): trường không gửi giữ nguyên, `null` ở cột nullable là xoá.
    pub fn from_validated(v: &Value) -> Self {
        Self {
            email: v.get("email").and_then(Value::as_str).map(|e| e.trim().to_owned()),
            full_name: v.get("full_name").and_then(Value::as_str).map(str::to_owned),
            phone: patch_of(v, "phone", text),
            team_id: patch_of(v, "team_id", int4),
            manager_id: patch_of(v, "manager_id", int4),
            status: v.get("status").and_then(Value::as_str).map(str::to_owned),
            reassign_to: v.get("reassign_to").and_then(int4),
        }
    }
}

#[derive(FromRow)]
struct TargetRow {
    email: String,
    status: String,
    deleted_at: Option<Timestamp>,
}

async fn target(conn: &mut PgConnection, id: i32) -> R<TargetRow> {
    sqlx::query_as::<_, TargetRow>("SELECT email, status, deleted_at FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .filter(|t| t.deleted_at.is_none())
        .ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng").into())
}

/// `PATCH /users/:id`.
pub async fn update(ctx: &Ctx, actor: &Actor, id: i32, dto: &UpdateUser) -> R<Value> {
    if actor.user_id == id {
        return Err(HttpError::forbidden("Không thể tự thay đổi thông tin tài khoản của mình").into());
    }
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let user = target(&mut conn, id).await?;
    // Chỉ GHI email khi thật sự đổi định danh (so không phân biệt hoa/thường); giữ nguyên casing ở mọi trường hợp khác.
    let new_email = dto
        .email
        .clone()
        .filter(|e| !e.is_empty() && e.to_lowercase() != user.email.to_lowercase());
    if let Some(e) = &new_email {
        ctx.platform
            .assert_email_available(e, actor.company)
            .await
            .map_err(taken)?;
        let other: Option<(i32, Option<Timestamp>)> = sqlx::query_as(
            "SELECT id, deleted_at FROM users WHERE lower(email) = lower($1) AND id <> $2 ORDER BY id LIMIT 1",
        )
        .bind(e)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if let Some((_, None)) = other {
            return Err(HttpError::conflict("Email đã tồn tại").into());
        }
    }
    if let Patch::Set(m) = dto.manager_id {
        assert_manager_active(&mut conn, m).await?;
        assert_no_manager_cycle(&mut conn, id, m).await?;
    }
    let locking = dto.status.as_deref() == Some("locked") && user.status != "locked";
    let unlocking = dto.status.as_deref() == Some("active") && user.status != "active";
    let mut cascaded: i64 = 0;
    if locking {
        assert_not_last_admin(&mut conn, id).await?;
        cascaded = sqlx::query_scalar("SELECT count(*) FROM users WHERE manager_id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
    }
    drop(conn);

    let mut tx = ctx.begin(actor.company).await?;
    if let Some(e) = &new_email {
        let old: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2 AND deleted_at IS NOT NULL ORDER BY id LIMIT 1")
            .bind(e)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        if let Some(old) = old {
            sqlx::query("UPDATE users SET email = 'deleted_' || id || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint || '@removed.invalid', updated_at = now() WHERE id = $1")
                .bind(old)
                .execute(&mut *tx)
                .await
                .map_err(wr)?;
        }
    }
    if unlocking {
        assert_user_slot_available(&mut tx, actor.company, ctx.multi_tenant()).await?;
    }
    if locking {
        lock_admin_mutation(&mut tx).await?;
        assert_not_last_admin(&mut tx, id).await?;
        revoke_pending_by(&mut tx, actor.company, id).await?;
        if cascaded > 0 {
            cascade_reassign(&mut tx, id, dto.reassign_to).await?;
        }
    }
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE users SET updated_at = now()");
    if let Some(e) = &new_email {
        qb.push(", email = ").push_bind(e.clone());
    }
    if let Some(n) = &dto.full_name {
        qb.push(", full_name = ").push_bind(n.clone());
    }
    for (col, patch) in [("team_id", &dto.team_id), ("manager_id", &dto.manager_id)] {
        match patch {
            Patch::Keep => {}
            Patch::Clear => {
                qb.push(", ").push(col).push(" = NULL");
            }
            Patch::Set(v) => {
                qb.push(", ").push(col).push(" = ").push_bind(*v);
            }
        }
    }
    match &dto.phone {
        Patch::Keep => {}
        Patch::Clear => {
            qb.push(", phone = NULL");
        }
        Patch::Set(p) => {
            qb.push(", phone = ").push_bind(p.clone());
        }
    }
    if let Some(s) = &dto.status {
        qb.push(", status = ").push_bind(s.clone());
    }
    if locking {
        // Thu hồi mọi refresh token cũ; mở khoá lại không làm chúng sống lại.
        qb.push(", tokens_valid_after = now()");
    }
    qb.push(" WHERE id = ").push_bind(id);
    qb.push(" RETURNING id, email, full_name, phone, team_id, manager_id, status");
    let u: (i32, String, String, Option<String>, Option<i32>, Option<i32>, String) =
        qb.build_query_as().fetch_one(&mut *tx).await.map_err(wr)?;
    if locking {
        sync_employee_resignation(&mut tx, id, true).await?;
    } else if dto.status.as_deref() == Some("active") && user.status == "locked" {
        sync_employee_resignation(&mut tx, id, false).await?;
    }
    tx.commit().await.map_err(AppError::internal)?;

    if dto.status.as_deref() == Some("locked") {
        ctx.security.blacklist_user(actor.company.id(), id).await;
    }
    if locking {
        tracing::warn!(
            "[user-lock] actor={} target={id} email={} reassign_to={:?} managed={cascaded}",
            actor.user_id,
            mask_email(&user.email),
            dto.reassign_to
        );
    }
    ctx.invalidate_all(actor.company).await;
    let mask = masker(ctx, actor).await?;
    let mut out = Map::new();
    out.insert("id".into(), json!(u.0));
    out.insert("email".into(), json!(u.1));
    out.insert("full_name".into(), json!(u.2));
    out.insert("phone".into(), json!(mask.mask(&[Some(u.0)], u.3.as_deref())));
    out.insert("team_id".into(), json!(u.4));
    out.insert("manager_id".into(), json!(u.5));
    out.insert("status".into(), json!(u.6));
    if cascaded > 0 {
        out.insert("reassigned".into(), json!(cascaded));
        out.insert("reassigned_to".into(), json!(dto.reassign_to));
    }
    Ok(Value::Object(out))
}

/// `PATCH /users/:id/reset-password`: admin tự nhập mật khẩu mới (không sinh, không trả lại), thu hồi mọi phiên.
pub async fn reset_password(ctx: &Ctx, actor: &Actor, id: i32, new_password: Option<&str>) -> R<Value> {
    if actor.user_id == id {
        return Err(HttpError::forbidden("Không thể tự reset mật khẩu của chính mình qua endpoint này").into());
    }
    // Leo thang chạy TRƯỚC kiểm mật khẩu bắt buộc: không có quyền phải nhận đúng 403, không lộ nhầm 400.
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let user = target(&mut conn, id).await?;
    let pw = new_password.filter(|p| !p.trim().is_empty());
    let Some(pw) = pw else {
        return Err(HttpError::bad_request("Vui lòng nhập mật khẩu mới").into());
    };
    let hash = password::hash(pw.to_owned()).await.map_err(AppError::internal)?;
    sqlx::query("UPDATE users SET password_hash = $1, password_updated_at = now(), tokens_valid_after = now(), updated_at = now() WHERE id = $2")
        .bind(hash)
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    drop(conn);
    ctx.security.blacklist_user(actor.company.id(), id).await;
    tracing::warn!(
        "[user-reset-password] actor={} target={id} email={}",
        actor.user_id,
        mask_email(&user.email)
    );
    log_password_change(ctx, actor.company, Some(actor.user_id), id, "admin_reset").await;
    Ok(json!({ "message": "Đã reset mật khẩu thành công" }))
}

/// `GET /users/:id/password-history`: ai/khi nào/qua đường nào (không bao giờ trả mật khẩu hay hash), 50 dòng mới nhất.
pub async fn password_history(ctx: &Ctx, actor: &Actor, id: i32) -> R<Value> {
    ctx.scopes
        .assert_in_scope(actor.company, actor.user_id, &actor.grants, "users.manage", &[Some(id)])
        .await
        .map_err(|e| scoped(actor, e))?;
    let mut conn = ctx.conn(actor.company).await?;
    #[derive(FromRow)]
    struct Log {
        id: i32,
        user_id: Option<i32>,
        metadata: Option<sqlx::types::Json<Value>>,
        ip_address: Option<String>,
        created_at: Timestamp,
    }
    let logs: Vec<Log> = sqlx::query_as(
        "SELECT id, user_id, metadata, ip_address, created_at FROM audit_logs \
         WHERE action = 'password_change' AND resource = 'users' AND resource_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let actor_ids: Vec<i32> = logs.iter().filter_map(|l| l.user_id).collect();
    let actors: Vec<(i32, String, String)> =
        sqlx::query_as("SELECT id, email, full_name FROM users WHERE id = ANY($1)")
            .bind(actor_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    Ok(Value::Array(
        logs.into_iter()
            .map(|l| {
                let a = l.user_id.and_then(|u| actors.iter().find(|x| x.0 == u));
                json!({
                    "id": l.id, "created_at": l.created_at,
                    "method": l.metadata.as_ref().and_then(|m| m.0.get("method")).cloned().unwrap_or(Value::Null),
                    "actor_id": l.user_id, "actor_email": a.map(|x| x.1.clone()), "actor_full_name": a.map(|x| x.2.clone()),
                    "ip_address": l.ip_address,
                })
            })
            .collect(),
    ))
}

/// `DELETE /users/:id`: khoá (soft delete) + chuyển giao cấp dưới trong cùng giao dịch.
pub async fn lock(ctx: &Ctx, actor: &Actor, id: i32, reassign_to: Option<i32>) -> R<Value> {
    if actor.user_id == id {
        return Err(HttpError::forbidden("Không thể tự khoá tài khoản của mình").into());
    }
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    let mut conn = ctx.conn(actor.company).await?;
    target(&mut conn, id).await?;
    assert_not_last_admin(&mut conn, id).await?;
    let managed: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE manager_id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    drop(conn);
    let mut tx = ctx.begin(actor.company).await?;
    lock_admin_mutation(&mut tx).await?;
    assert_not_last_admin(&mut tx, id).await?;
    if managed > 0 {
        cascade_reassign(&mut tx, id, reassign_to).await?;
    }
    sqlx::query("UPDATE users SET status = 'locked', tokens_valid_after = now(), updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(wr)?;
    revoke_pending_by(&mut tx, actor.company, id).await?;
    sync_employee_resignation(&mut tx, id, true).await?;
    tx.commit().await.map_err(AppError::internal)?;
    ctx.security.blacklist_user(actor.company.id(), id).await;
    ctx.invalidate_all(actor.company).await;
    Ok(json!({ "message": "Đã khoá tài khoản", "reassigned": managed, "reassigned_to": reassign_to }))
}

/// `DELETE /users/:id/permanent`: soft delete sâu (`deleted_at`, giải phóng email), không xoá cứng để giữ tham chiếu.
pub async fn permanent_delete(ctx: &Ctx, actor: &Actor, id: i32, reassign_to: Option<i32>) -> R<Value> {
    if actor.user_id == id {
        return Err(HttpError::forbidden("Không thể tự xoá vĩnh viễn tài khoản của mình").into());
    }
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    let mut tx = ctx.begin(actor.company).await?;
    let t = target(&mut tx, id).await?;
    lock_admin_mutation(&mut tx).await?;
    assert_not_last_admin(&mut tx, id).await?;
    let managed: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE manager_id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if managed > 0 {
        cascade_reassign(&mut tx, id, reassign_to).await?;
    }
    revoke_pending_by(&mut tx, actor.company, id).await?;
    sqlx::query(
        "UPDATE users SET status = 'locked', deleted_at = now(), tokens_valid_after = now(), updated_at = now(), \
         email = 'deleted_' || id || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint || '@removed.invalid' WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(wr)?;
    sync_employee_resignation(&mut tx, id, true).await?;
    tx.commit().await.map_err(AppError::internal)?;
    ctx.security.blacklist_user(actor.company.id(), id).await;
    tracing::warn!(
        "[user-soft-delete-permanent] actor={} target={id} email={} reassign_to={reassign_to:?} managed={managed}",
        actor.user_id,
        mask_email(&t.email)
    );
    ctx.invalidate_all(actor.company).await;
    Ok(json!({ "message": "Đã xoá vĩnh viễn tài khoản", "reassigned": managed, "reassigned_to": reassign_to }))
}

/// `PATCH /users/:id/team`.
pub async fn assign_team(ctx: &Ctx, actor: &Actor, id: i32, team_id: i32) -> R<Value> {
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let exists: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if exists.is_none() {
        return Err(HttpError::not_found("Không tìm thấy người dùng").into());
    }
    let team: Option<i32> = sqlx::query_scalar("SELECT id FROM teams WHERE id = $1")
        .bind(team_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if team.is_none() {
        return Err(HttpError::not_found("Không tìm thấy team").into());
    }
    let u: (i32, String, String, Option<i32>) = sqlx::query_as(
        "UPDATE users SET team_id = $1, updated_at = now() WHERE id = $2 RETURNING id, email, full_name, team_id",
    )
    .bind(team_id)
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .map_err(wr)?;
    drop(conn);
    ctx.security.blacklist_user(actor.company.id(), id).await;
    Ok(json!({ "id": u.0, "email": u.1, "full_name": u.2, "team_id": u.3 }))
}

// ---------------------------------------------------------------- vai trò của người dùng

fn grants_of_roles(rows: &[(i32, String, Option<String>)]) -> Grants {
    let per_role: Vec<Grants> = {
        let mut ids: Vec<i32> = rows.iter().map(|r| r.0).collect();
        ids.sort_unstable();
        ids.dedup();
        ids.iter()
            .map(|id| {
                rows.iter()
                    .filter(|r| r.0 == *id && !r.1.is_empty())
                    .filter_map(|r| trinity_rbac::normalize_grant(&r.1, r.2.as_deref()).map(|g| (r.1.clone(), g)))
                    .collect()
            })
            .collect()
    };
    trinity_rbac::merge_grants(per_role.iter())
}

/// Kiểm body `PUT /users/:id/roles` như `SetUserRolesDto`.
pub fn parse_role_ids(body: &Value) -> Result<Vec<i32>, HttpError> {
    let mut errors = Vec::new();
    let arr = body.get("roleIds").and_then(Value::as_array);
    let mut ids = Vec::new();
    match arr {
        None => errors.push("roleIds phải là mảng".to_owned()),
        Some(a) => {
            if a.len() > 50 {
                errors.push("Tối đa 50 vai trò".to_owned());
            }
            let uniq: std::collections::BTreeSet<String> = a.iter().map(Value::to_string).collect();
            if uniq.len() != a.len() {
                errors.push("roleIds bị trùng".to_owned());
            }
            match a
                .iter()
                .map(|v| if v.is_i64() || v.is_u64() { int4(v) } else { None })
                .collect::<Option<Vec<i32>>>()
            {
                Some(v) => ids = v,
                None => errors.push("roleIds phải là số nguyên".to_owned()),
            }
        }
    }
    if errors.is_empty() {
        Ok(ids)
    } else {
        Err(HttpError::validation(errors))
    }
}

/// `PUT /users/:id/roles`: thay toàn bộ vai trò, chống leo thang (luật 2, 4) và Quản trị cuối cùng.
pub async fn set_roles(ctx: &Ctx, actor: &Actor, id: i32, role_ids: &[i32]) -> R<Value> {
    assert_can_manage_user(&ctx.scopes, &ctx.perms, actor, id).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let t: Option<(i32, String)> = sqlx::query_as("SELECT id, status FROM users WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let (_, target_status) = t.ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
    // assertCanGrantRoles
    ctx.scopes
        .assert_in_scope(actor.company, actor.user_id, &actor.grants, "users.manage", &[Some(id)])
        .await
        .map_err(|e| scoped(actor, e))?;
    let role_rows: Vec<(i32, bool)> = sqlx::query_as("SELECT id, is_system FROM roles WHERE id = ANY($1)")
        .bind(role_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    if role_rows.len() != role_ids.len() {
        return Err(HttpError::not_found("Không tìm thấy vai trò").into());
    }
    let next_has_system = role_rows.iter().any(|r| r.1);
    if next_has_system && !actor.is_admin {
        return Err(HttpError::forbidden("Chỉ Quản trị mới được gán vai trò Quản trị").into());
    }
    let target_is_admin: Option<i32> = sqlx::query_scalar(
        "SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.is_system LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if !actor.is_admin && target_is_admin.is_some() {
        return Err(HttpError::forbidden("Chỉ Quản trị mới được gỡ vai trò Quản trị").into());
    }
    if !actor.is_admin {
        let perms: Vec<(i32, String, Option<String>)> =
            sqlx::query_as("SELECT role_id, permission, scope FROM role_permissions WHERE role_id = ANY($1)")
                .bind(role_ids)
                .fetch_all(&mut *conn)
                .await
                .map_err(db)?;
        let next = grants_of_roles(&perms);
        if !is_subset(&next, &actor.grants) {
            return Err(HttpError::forbidden("Không thể cấp quyền bạn không có").into());
        }
    }
    if id == actor.user_id && !actor.is_admin {
        return Err(HttpError::forbidden("Không thể tự đổi vai trò của mình").into());
    }
    if !next_has_system && target_is_admin.is_some() {
        let remaining: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM users u WHERE u.id <> $1 AND u.status = 'active' AND u.deleted_at IS NULL \
             AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_system)",
        )
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        if remaining == 0 {
            return Err(HttpError::conflict("Phải còn ít nhất 1 Quản trị").into());
        }
    }
    drop(conn);

    let mut tx = ctx.begin(actor.company).await?;
    lock_admin_mutation(&mut tx).await?;
    let prev: Vec<(i32, String, bool)> = sqlx::query_as(
        "SELECT ur.role_id, r.name, r.is_system FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY ur.id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db)?;
    let mut prev_ids: Vec<i32> = prev.iter().map(|p| p.0).collect();
    prev_ids.sort_unstable();
    let mut next_ids = role_ids.to_vec();
    next_ids.sort_unstable();
    if prev_ids != next_ids {
        sqlx::query("DELETE FROM user_roles WHERE user_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO user_roles (user_id, role_id) SELECT $1, x FROM unnest($2::int[]) AS x")
            .bind(id)
            .bind(&next_ids)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let next: Vec<(String, bool)> = sqlx::query_as("SELECT name, is_system FROM roles WHERE id = ANY($1)")
            .bind(&next_ids)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        if target_status == "active" && prev.iter().any(|p| p.2) && !next.iter().any(|r| r.1) {
            let remaining: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM users u WHERE u.status = 'active' AND u.deleted_at IS NULL \
                 AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.is_system)",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if remaining == 0 {
                return Err(HttpError::conflict("Phải còn ít nhất 1 Quản trị").into());
            }
        }
        sqlx::query(
            "INSERT INTO rbac_audit_log (actor_id, action, target_type, target_id, before, after) VALUES ($1, 'user.roles', 'user', $2, $3, $4)",
        )
        .bind(actor.user_id)
        .bind(id)
        .bind(json!({ "roleIds": prev_ids, "roles": prev.iter().map(|p| p.1.clone()).collect::<Vec<_>>() }))
        .bind(json!({ "roleIds": next_ids, "roles": next.iter().map(|r| r.0.clone()).collect::<Vec<_>>() }))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    tx.commit().await.map_err(AppError::internal)?;
    ctx.cache
        .invalidate_users(actor.company.id(), trinity_rbac::cache::Users::Ids(vec![id]))
        .await;
    let mut conn = ctx.conn(actor.company).await?;
    let rows: Vec<(i32, String, bool)> = sqlx::query_as(
        "SELECT r.id, r.name, r.is_system FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY ur.id",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(json!({
        "user_id": id,
        "roles": rows.into_iter().map(|(i, n, s)| json!({ "id": i, "name": n, "is_system": s })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_va_che_email() {
        for ok in ["a@b.co", "nguyen.van+x@mail.example.com"] {
            assert!(valid_email(ok), "{ok}");
        }
        for bad in ["", "a", "a@", "@b.co", "a@b", "a b@c.co", "a@b..co", "a@@b.co"] {
            assert!(!valid_email(bad), "{bad}");
        }
        assert_eq!(mask_email("abc@d.com"), "a***@d.com");
        assert_eq!(mask_email("a@d.com"), "*@d.com");
        assert_eq!(mask_email("khong"), "***");
    }

    #[test]
    fn kiem_body_tao_va_vai_tro() {
        let ok = CreateUser::parse(&json!({ "email": "a@b.co", "full_name": "A", "password": "12345678" })).unwrap();
        assert_eq!((ok.team_id, ok.manager_id), (None, None));
        let msgs = |v: Value| match CreateUser::parse(&v) {
            Err(e) => serde_json::from_str::<Value>(&serde_json::to_string(&e.body().message).unwrap()).unwrap(),
            Ok(_) => Value::Null,
        };
        assert_eq!(
            msgs(json!({ "email": "x", "full_name": 1, "password": "123", "team_id": "a", "manager_id": 1.5 })),
            json!([
                "Email không hợp lệ",
                "full_name must be a string",
                "Mật khẩu tối thiểu 8 ký tự",
                "team_id must be an integer number",
                "manager_id phải là số nguyên"
            ])
        );
        assert_eq!(parse_role_ids(&json!({ "roleIds": [1, 2] })).unwrap(), [1, 2]);
        assert!(parse_role_ids(&json!({})).is_err());
        assert!(parse_role_ids(&json!({ "roleIds": [1, 1] })).is_err());
        assert!(parse_role_ids(&json!({ "roleIds": ["a"] })).is_err());
        assert!(parse_role_ids(&json!({ "roleIds": (0..51).collect::<Vec<_>>() })).is_err());
    }

    #[test]
    fn patch_ba_trang_thai() {
        let v = json!({ "phone": null, "team_id": 3, "manager_id": "x" });
        assert_eq!(patch_of(&v, "phone", text), Patch::Clear);
        assert_eq!(patch_of(&v, "team_id", int4), Patch::Set(3));
        assert_eq!(patch_of(&v, "manager_id", int4), Patch::Keep);
        assert_eq!(patch_of(&v, "khong_co", int4), Patch::Keep);
    }
}
