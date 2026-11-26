//! Tạo công ty mới (K09, PLAN 4.5): `provisionCompany` và dọn đăng ký bỏ dở của `packages/prisma/src/tenant/provision.ts`.
//!
//! Chuyển nguyên SQL và giữ nguyên số advisory lock ([`SIGNUP_LOCK`], khoá theo email như bản Node):
//! 1. giữ chỗ id + email trong một giao dịch ngắn (khoá `SIGNUP_LOCK` + `hashtext(email)`: hai đăng ký cùng email
//!    đồng thời thì bên sau chờ rồi thấy dòng của bên trước và nhận [`ProvisionError::EmailTaken`]), tạo schema trống;
//! 2. migrate schema mới bằng migrator K07 (ghi `_prisma_migrations` và `platform.companies.migrated_to`);
//! 3. cài trigger đồng bộ (K08);
//! 4. một giao dịch dựng dữ liệu đầu: vai trò hệ thống "Quản trị", tuỳ chọn mặc định, quản trị viên, bảng việc mặc
//!    định, `company_name`, `org_plan` (bản Node làm từng lệnh rời; một giao dịch thì lỗi giữa chừng không để lại
//!    nửa dữ liệu);
//! 5. `status = 'active'`.
//!
//! Lỗi ở bước 2–5 thì xoá sạch (schema, dòng định tuyến, dòng công ty) để id và email trống lại. Tiến trình chết
//! giữa chừng thì [`reap_stale_provisioning`] dọn sau [`STALE_PROVISIONING_MINUTES`] phút (chạy ở đầu mỗi lần tạo).

use sqlx::{AssertSqlSafe, PgConnection, PgPool};

use crate::migrate;
use crate::platform::{Platform, SIGNUP_LOCK, install_sync_triggers};
use crate::prisma_migrate::{MigrateError, Migration};
use crate::{CompanyRef, Db, DbError};

/// Đăng ký bỏ dở (tiến trình chết lúc migrate) cũ hơn mức này bị xoá, nhả email.
pub const STALE_PROVISIONING_MINUTES: i64 = 15;

/// Tên vai trò hệ thống của quản trị viên đầu tiên.
pub const ADMIN_ROLE_NAME: &str = "Quản trị";

/// Gói mặc định của đăng ký mới (`DEFAULT_SIGNUP_PLAN` của `@trinity/rbac`).
pub const DEFAULT_SIGNUP_PLAN: &str = "mac_dinh";

/// Khoảng cách vị trí cột bảng việc (`POSITION_GAP` của `kanban-default.seed.ts`).
const KANBAN_POSITION_GAP: f64 = 1024.0;

/// (group_key, value, label, sort_order, is_system) của `ALL_SETTING_OPTIONS` (`setting-options.seed.ts`).
const SETTING_OPTIONS: &[(&str, &str, &str, i32, bool)] = &[
    ("contact_source", "website", "Website", 1, true),
    ("contact_source", "facebook", "Facebook", 2, true),
    ("contact_source", "zalo", "Zalo", 3, true),
    ("contact_source", "referral", "Giới thiệu", 4, true),
    ("contact_source", "partner_referral", "Đối tác giới thiệu", 5, true),
    ("contact_source", "ads", "Quảng cáo", 6, true),
    ("contact_source", "other", "Khác", 7, true),
    ("contact_stage", "new", "Mới", 1, true),
    ("contact_stage", "follow_up_1", "Đang tư vấn", 2, true),
    ("contact_stage", "follow_up_2", "Đã báo giá", 3, true),
    ("contact_stage", "follow_up_3", "Sắp chốt", 4, true),
    ("contact_detail_status", "follow_up_later", "Hẹn liên hệ lại", 1, false),
    ("contact_detail_status", "not_contacted", "Chưa tiếp cận", 5, false),
    ("contact_detail_status", "other", "Khác", 6, false),
];

/// Cột bảng việc mặc định (tên, is_done).
const KANBAN_COLUMNS: &[(&str, bool)] = &[("Cần làm", false), ("Đang làm", false), ("Xong", true)];

/// Lỗi tạo công ty.
#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    /// Email đã dùng ở công ty khác (409 như `EmailTakenError` của bản Node).
    #[error("Email này đã được dùng trên Trinity")]
    EmailTaken,
    #[error("provision_company cần MULTI_TENANT=true")]
    SingleTenant,
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Migrate(#[from] MigrateError),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("băm mật khẩu lỗi: {0}")]
    Hash(String),
}

/// Dữ liệu đăng ký.
#[derive(Debug, Clone)]
pub struct ProvisionInput {
    pub company_name: String,
    pub admin_email: String,
    pub admin_password: String,
    pub admin_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProvisionResult {
    pub company: CompanyRef,
    pub admin_user_id: i32,
}

/// Kiểm mật khẩu với băm bcrypt (cho test và đăng nhập sau này).
pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

/// `str.slice(0, n)` của JS (đơn vị UTF-16, không cắt đôi ký tự).
fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// `String.prototype.trim` của JS (không gồm U+0085, có BOM).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Xoá đăng ký bỏ dở quá [`STALE_PROVISIONING_MINUTES`] phút (`reapStaleProvisioning`). Trả số công ty đã dọn.
pub async fn reap_stale_provisioning(pool: &PgPool) -> Result<usize, ProvisionError> {
    let stale: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, schema_name FROM platform.companies
          WHERE status = 'provisioning' AND created_at < now() - ($1 || ' minutes')::interval",
    )
    .bind(STALE_PROVISIONING_MINUTES.to_string())
    .fetch_all(pool)
    .await?;
    let mut n = 0;
    for (id, schema) in stale {
        // Chỉ schema đúng dạng `c_<id>`: không tin tên trong bảng.
        if migrate::check_company_schema(id, &schema).is_err() {
            continue;
        }
        match remove_company(pool, id, &schema).await {
            Ok(()) => n += 1,
            Err(e) => tracing::warn!("provision: dọn đăng ký bỏ dở của công ty {id} lỗi: {e}"),
        }
    }
    Ok(n)
}

/// Xoá dòng định tuyến, schema và dòng công ty còn `provisioning`, trong một giao dịch.
/// Khoá dòng công ty và kiểm lại `status = 'provisioning'`; không còn như vậy (đã active hoặc đã bị dọn) thì không
/// làm gì: không bao giờ xoá công ty đang hoạt động.
async fn remove_company(pool: &PgPool, id: i32, schema: &str) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let still: Option<(i32,)> =
        sqlx::query_as("SELECT id FROM platform.companies WHERE id = $1 AND status = 'provisioning' FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if still.is_none() {
        return tx.rollback().await;
    }
    sqlx::query("DELETE FROM platform.company_logins WHERE company_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM platform.company_routes WHERE company_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // `schema` đã qua `check_company_schema` (c_<số>).
    sqlx::raw_sql(AssertSqlSafe(format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM platform.companies WHERE id = $1 AND status = 'provisioning'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// Tạo công ty mới. `migrations` là bộ migration (thường [`migrate::embedded_migrations`]), `latest` là tên bản mới
/// nhất của nó.
///
/// Phần việc chạy trong một task riêng (`tokio::spawn`) và được chờ ở đây: handler HTTP bị huỷ giữa chừng (khách
/// ngắt kết nối) thì việc dựng và dọn dẹp vẫn chạy tới cùng, email không bị khoá tới lúc dọn bỏ dở (15 phút).
pub async fn provision_company(
    db: &Db,
    platform: &Platform,
    migrations: &[Migration],
    latest: &str,
    input: &ProvisionInput,
) -> Result<ProvisionResult, ProvisionError> {
    if !db.multi_tenant() {
        return Err(ProvisionError::SingleTenant);
    }
    let (db, platform, migrations, latest, input) = (
        db.clone(),
        platform.clone(),
        migrations.to_vec(),
        latest.to_owned(),
        input.clone(),
    );
    tokio::spawn(async move { provision_inner(&db, &platform, &migrations, &latest, &input).await })
        .await
        .map_err(|e| ProvisionError::Hash(format!("tác vụ tạo công ty dừng bất thường: {e}")))?
}

async fn provision_inner(
    db: &Db,
    platform: &Platform,
    migrations: &[Migration],
    latest: &str,
    input: &ProvisionInput,
) -> Result<ProvisionResult, ProvisionError> {
    platform.ensure().await?;
    let pool = db.raw_pool();
    let email = js_trim(&input.admin_email).to_lowercase();
    let company_name = js_slice(js_trim(&input.company_name), 200).to_owned();
    let admin_name = {
        let n = js_slice(js_trim(&input.admin_name), 200);
        if n.is_empty() { "Quản trị viên" } else { n }.to_owned()
    };
    // Dọn lỗi không được chặn đăng ký.
    if let Err(e) = reap_stale_provisioning(pool).await {
        tracing::warn!("provision: dọn đăng ký bỏ dở lỗi: {e}");
    }

    // Giữ id và email trước, để hai đăng ký cùng email không cùng qua được.
    let company = {
        let mut tx = pool.begin().await?;
        // Nối tiếp đăng ký cùng email (bấm đúp, hai tab): bên sau chờ rồi thấy dòng của bên trước.
        sqlx::query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))")
            .bind(SIGNUP_LOCK)
            .bind(&email)
            .execute(&mut *tx)
            .await?;
        let taken: Option<(i32,)> = sqlx::query_as("SELECT company_id FROM platform.company_logins WHERE email = $1")
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await?;
        if taken.is_some() {
            return Err(ProvisionError::EmailTaken);
        }
        let (id,): (i32,) = sqlx::query_as("SELECT nextval(pg_get_serial_sequence('platform.companies', 'id'))::int")
            .fetch_one(&mut *tx)
            .await?;
        let company = CompanyRef::new(i64::from(id))?;
        let schema = company.schema();
        sqlx::query(
            "INSERT INTO platform.companies (id, name, schema_name, status) VALUES ($1, $2, $3, 'provisioning')",
        )
        .bind(id)
        .bind(&company_name)
        .bind(&schema)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO platform.company_logins (email, company_id) VALUES ($1, $2)")
            .bind(&email)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::raw_sql(AssertSqlSafe(format!("CREATE SCHEMA \"{schema}\"")))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        company
    };

    let built = build(
        pool,
        migrations,
        latest,
        company,
        &email,
        &input.admin_password,
        &company_name,
        &admin_name,
    )
    .await;
    match built {
        Ok(admin_user_id) => {
            platform.forget_company(Some(company.id()));
            Ok(ProvisionResult { company, admin_user_id })
        }
        Err(e) => {
            // Không để lại nửa chừng: email và id trống lại.
            if let Err(clean) = remove_company(pool, company.id(), &company.schema()).await {
                tracing::warn!("provision: dọn công ty {} lỗi: {clean}", company.id());
            }
            platform.forget_company(Some(company.id()));
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn build(
    pool: &PgPool,
    migrations: &[Migration],
    latest: &str,
    company: CompanyRef,
    email: &str,
    password: &str,
    company_name: &str,
    admin_name: &str,
) -> Result<i32, ProvisionError> {
    // Đã giữ chỗ rồi mới băm (chậm, CPU): ca bỏ ngang vì email trùng không tốn băm.
    let pw = password.to_owned();
    let password_hash = tokio::task::spawn_blocking(move || bcrypt::hash(pw, 10))
        .await
        .map_err(|e| ProvisionError::Hash(e.to_string()))?
        .map_err(|e| ProvisionError::Hash(e.to_string()))?;
    let schema = company.schema();
    migrate::migrate_company(pool, company.id(), &schema, migrations, latest).await?;

    let mut tx = pool.begin().await?;
    install_sync_triggers(&mut tx, company).await?;
    // Chỉ trong giao dịch này (is_local): kết nối trả về pool không mang search_path của công ty.
    sqlx::query("SELECT set_config('search_path', $1, true)")
        .bind(format!("\"{schema}\""))
        .execute(&mut *tx)
        .await?;
    let admin_id = seed(&mut tx, email, &password_hash, company_name, admin_name).await?;
    sqlx::query("UPDATE platform.companies SET status = 'active' WHERE id = $1")
        .bind(company.id())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(admin_id)
}

/// Dữ liệu đầu của công ty mới, trên kết nối đã đặt `search_path`.
async fn seed(
    conn: &mut PgConnection,
    email: &str,
    password_hash: &str,
    company_name: &str,
    admin_name: &str,
) -> Result<i32, sqlx::Error> {
    let (role_id,): (i32,) =
        sqlx::query_as("INSERT INTO roles (name, description, is_system) VALUES ($1, $2, true) RETURNING id")
            .bind(ADMIN_ROLE_NAME)
            .bind("Toàn quyền hệ thống — không sửa/xoá được")
            .fetch_one(&mut *conn)
            .await?;
    for (group, value, label, order, is_system) in SETTING_OPTIONS {
        sqlx::query(
            "INSERT INTO setting_options (group_key, value, label, sort_order, is_active, is_system, updated_at)
             VALUES ($1, $2, $3, $4, true, $5, now())",
        )
        .bind(group)
        .bind(value)
        .bind(label)
        .bind(order)
        .bind(is_system)
        .execute(&mut *conn)
        .await?;
    }
    let (user_id,): (i32,) = sqlx::query_as(
        "INSERT INTO users (email, password_hash, password_updated_at, full_name, status, updated_at)
         VALUES ($1, $2, now(), $3, 'active', now()) RETURNING id",
    )
    .bind(email)
    .bind(password_hash)
    .bind(admin_name)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)")
        .bind(user_id)
        .bind(role_id)
        .execute(&mut *conn)
        .await?;
    // Bảng việc mặc định (`seedDefaultKanbanBoard`: schema mới chưa từng có bảng nào).
    let (board_id,): (i32,) = sqlx::query_as(
        "INSERT INTO kanban_boards (name, description, created_by, updated_at) VALUES ($1, $2, $3, now()) RETURNING id",
    )
    .bind("Việc của tôi")
    .bind("Bảng công việc mặc định: Cần làm → Đang làm → Xong.")
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await?;
    for (i, (name, is_done)) in KANBAN_COLUMNS.iter().enumerate() {
        sqlx::query(
            "INSERT INTO kanban_columns (board_id, name, position, is_done, updated_at) VALUES ($1, $2, $3, $4, now())",
        )
        .bind(board_id)
        .bind(name)
        .bind(KANBAN_POSITION_GAP * (i as f64 + 1.0))
        .bind(is_done)
        .execute(&mut *conn)
        .await?;
    }
    for (key, value) in [("company_name", company_name), ("org_plan", DEFAULT_SIGNUP_PLAN)] {
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await?;
    }
    Ok(user_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cat_nhu_js() {
        assert_eq!(js_slice("abc", 2), "ab");
        assert_eq!(js_slice("😀😀", 2), "😀");
        assert_eq!(js_trim("\u{feff} x \n"), "x");
    }
}
