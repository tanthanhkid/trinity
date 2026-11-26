//! `trinity seed` (K32): dữ liệu khởi tạo, thay `packages/prisma/prisma/seed.ts`. **Chạy lặp lại không đổi dữ liệu**: mọi bước là
//! "tạo nếu chưa có" hoặc chỉ ghi khi giá trị khác (kể cả `updated_at`), trong một giao dịch.
//!
//! Gồm: vai trò hệ thống "Quản trị"; nhóm tuỳ chọn cấu hình (nguồn khách, giai đoạn, trạng thái; không ghi đè `is_active` khi
//! seed lại để tôn trọng thao tác của quản trị); tài khoản Quản trị đầu tiên (`SEED_ADMIN_EMAIL`, mật khẩu `SEED_ADMIN_PASSWORD`
//! hoặc ngẫu nhiên, in MỘT lần khi tạo mới; seed lại KHÔNG đổi mật khẩu); bảng công việc mặc định (chỉ khi chưa từng có bảng nào);
//! dữ liệu mẫu khi `SEED_DEMO_DATA=true`.

use std::io::Write;
use std::process::ExitCode;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use clap::Args;
use trinity_db::{CompanyRef, Db, DbConfig, TenantTx};

const ADMIN_ROLE_NAME: &str = "Quản trị";

#[derive(Debug, Args)]
pub struct SeedArgs {
    /// Công ty cần seed (mặc định 1 = schema `public`); công ty khác cần MULTI_TENANT=true.
    #[arg(long, default_value_t = 1)]
    company: i64,
}

struct Opt {
    group: &'static str,
    value: &'static str,
    label: &'static str,
    sort: i32,
    system: bool,
}

const fn o(group: &'static str, value: &'static str, label: &'static str, sort: i32, system: bool) -> Opt {
    Opt {
        group,
        value,
        label,
        sort,
        system,
    }
}

/// Nguồn khách, giai đoạn danh bạ (`is_system` ⇒ không xoá được) và trạng thái chi tiết (cho sửa/thêm). Mã `value` được mã nguồn
/// tham chiếu trực tiếp: đổi nhãn thoải mái nhưng đừng đổi `value`.
const OPTIONS: [Opt; 14] = [
    o("contact_source", "website", "Website", 1, true),
    o("contact_source", "facebook", "Facebook", 2, true),
    o("contact_source", "zalo", "Zalo", 3, true),
    o("contact_source", "referral", "Giới thiệu", 4, true),
    o("contact_source", "partner_referral", "Đối tác giới thiệu", 5, true),
    o("contact_source", "ads", "Quảng cáo", 6, true),
    o("contact_source", "other", "Khác", 7, true),
    o("contact_stage", "new", "Mới", 1, true),
    o("contact_stage", "follow_up_1", "Đang tư vấn", 2, true),
    o("contact_stage", "follow_up_2", "Đã báo giá", 3, true),
    o("contact_stage", "follow_up_3", "Sắp chốt", 4, true),
    o("contact_detail_status", "follow_up_later", "Hẹn liên hệ lại", 1, false),
    o("contact_detail_status", "not_contacted", "Chưa tiếp cận", 5, false),
    o("contact_detail_status", "other", "Khác", 6, false),
];

/// Bảng công việc mặc định (`kanban-default.seed.ts`); khoảng cách vị trí cột 1024.
const BOARD_NAME: &str = "Việc của tôi";
const BOARD_DESC: &str = "Bảng công việc mặc định: Cần làm → Đang làm → Xong.";
const BOARD_COLUMNS: [(&str, bool); 3] = [("Cần làm", false), ("Đang làm", false), ("Xong", true)];
const POSITION_GAP: f64 = 1024.0;

fn out(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

pub fn run(args: &SeedArgs) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "trinity seed: không tạo được runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run_async(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "trinity seed: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run_async(args: &SeedArgs) -> Result<(), String> {
    let mut cfg = DbConfig::from_env().map_err(|e| e.to_string())?;
    cfg.pool_size = 2;
    if args.company != 1 && !cfg.multi_tenant {
        return Err("--company khác 1 chỉ dùng khi MULTI_TENANT=true".to_owned());
    }
    let company = CompanyRef::new(args.company).map_err(|e| e.to_string())?;
    let db = Db::connect(&cfg).await.map_err(|e| e.to_string())?;
    let result = seed(&db, company, &|k| std::env::var(k).ok()).await;
    db.close().await;
    result
}

/// Mật khẩu admin lần đầu: `SEED_ADMIN_PASSWORD` nếu đặt, không thì sinh ngẫu nhiên 12 byte (base64url). Không có mật khẩu mặc định
/// cố định trong mã nguồn.
fn resolve_admin_password(get: &dyn Fn(&str) -> Option<String>) -> Result<(String, bool), String> {
    if let Some(p) = get("SEED_ADMIN_PASSWORD")
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
    {
        return Ok((p, false));
    }
    let mut b = [0u8; 12];
    getrandom::fill(&mut b).map_err(|e| format!("không đọc được nguồn ngẫu nhiên của hệ điều hành: {e}"))?;
    Ok((URL_SAFE_NO_PAD.encode(b), true))
}

fn sql(e: sqlx::Error) -> String {
    e.to_string()
}

/// Seed một công ty trong MỘT giao dịch (lỗi giữa chừng không để lại nửa vời). `get` tra biến môi trường.
pub async fn seed(db: &Db, company: CompanyRef, get: &dyn Fn(&str) -> Option<String>) -> Result<(), String> {
    let mut tx = db
        .tenant(company)
        .await
        .map_err(|e| e.to_string())?
        .begin()
        .await
        .map_err(|e| e.to_string())?;
    let mut log: Vec<String> = Vec::new();

    // 1. Vai trò hệ thống duy nhất: mọi quyền phạm vi `all` do PermissionService suy ra, không cần dòng role_permissions.
    sqlx::query("INSERT INTO roles (name, description, is_system, updated_at) VALUES ($1, $2, true, now()) ON CONFLICT (name) DO NOTHING")
        .bind(ADMIN_ROLE_NAME)
        .bind("Toàn quyền hệ thống — không sửa/xoá được")
        .execute(&mut *tx)
        .await
        .map_err(sql)?;
    sqlx::query("UPDATE roles SET is_system = true, updated_at = now() WHERE name = $1 AND NOT is_system")
        .bind(ADMIN_ROLE_NAME)
        .execute(&mut *tx)
        .await
        .map_err(sql)?;
    let role_id: i32 = sqlx::query_scalar("SELECT id FROM roles WHERE name = $1")
        .bind(ADMIN_ROLE_NAME)
        .fetch_one(&mut *tx)
        .await
        .map_err(sql)?;
    log.push(format!("Seeded role: {ADMIN_ROLE_NAME} (is_system)"));

    // 2. Nhóm tuỳ chọn. KHÔNG ghi đè is_active; chỉ ghi khi nhãn/thứ tự/is_system khác (seed lại không đổi gì).
    for opt in &OPTIONS {
        sqlx::query(
            "INSERT INTO setting_options (group_key, value, label, sort_order, is_active, is_system, metadata, updated_at)
             VALUES ($1, $2, $3, $4, true, $5, 'null'::jsonb, now())
             ON CONFLICT (group_key, value) DO UPDATE
                SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order, is_system = EXCLUDED.is_system,
                    metadata = EXCLUDED.metadata, updated_at = now()
              WHERE (setting_options.label, setting_options.sort_order, setting_options.is_system, setting_options.metadata)
                    IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.sort_order, EXCLUDED.is_system, EXCLUDED.metadata)",
        )
        .bind(opt.group)
        .bind(opt.value)
        .bind(opt.label)
        .bind(opt.sort)
        .bind(opt.system)
        .execute(&mut *tx)
        .await
        .map_err(sql)?;
    }
    let mut groups: Vec<(&str, usize)> = Vec::new();
    for opt in &OPTIONS {
        match groups.iter_mut().find(|(g, _)| *g == opt.group) {
            Some((_, n)) => *n += 1,
            None => groups.push((opt.group, 1)),
        }
    }
    log.push(format!(
        "Seeded {} setting options: {}",
        OPTIONS.len(),
        groups
            .iter()
            .map(|(g, n)| format!("{g}={n}"))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    // 3. Tài khoản Quản trị đầu tiên.
    let email = get("SEED_ADMIN_EMAIL")
        .map(|e| e.trim().to_owned())
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "admin@example.com".to_owned())
        .to_lowercase();
    let existing: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(sql)?;
    let admin_id = if let Some(id) = existing {
        log.push(format!("Admin user {email} already exists — password left unchanged."));
        id
    } else {
        let (password, generated) = resolve_admin_password(get)?;
        let hash = trinity_auth::password::hash(password.clone())
            .await
            .map_err(|e| e.to_string())?;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ($1, $2, 'Quản trị viên', 'active', now()) RETURNING id",
        )
        .bind(&email)
        .bind(hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(sql)?;
        log.push("==================================================================".to_owned());
        log.push(format!("Admin account created: {email}"));
        log.push(if generated {
            format!("Generated password (shown ONCE, change it after login): {password}")
        } else {
            "Password taken from SEED_ADMIN_PASSWORD.".to_owned()
        });
        log.push("==================================================================".to_owned());
        id
    };
    sqlx::query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING")
        .bind(admin_id)
        .bind(role_id)
        .execute(&mut *tx)
        .await
        .map_err(sql)?;
    log.push(format!("Seeded user: {email} ({ADMIN_ROLE_NAME})"));

    // 4. Bảng công việc mặc định: chỉ khi chưa từng có bảng nào (đếm cả bảng đã xoá mềm).
    if default_board(&mut tx, admin_id).await? {
        log.push("Seeded default kanban board".to_owned());
    }

    // 5. Dữ liệu mẫu.
    if get("SEED_DEMO_DATA").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        log.push(demo_data(&mut tx, admin_id).await?);
    }

    tx.commit().await.map_err(|e| e.to_string())?;
    // Chỉ in sau khi commit: mật khẩu hiện ra là mật khẩu đã thật sự được lưu.
    for line in &log {
        out(line);
    }
    out("Seed completed!");
    Ok(())
}

async fn default_board(tx: &mut TenantTx, admin_id: i32) -> Result<bool, String> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM kanban_boards")
        .fetch_one(&mut **tx)
        .await
        .map_err(sql)?;
    if n > 0 {
        return Ok(false);
    }
    let board: i32 = sqlx::query_scalar(
        "INSERT INTO kanban_boards (name, description, created_by) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(BOARD_NAME)
    .bind(BOARD_DESC)
    .bind(admin_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(sql)?;
    for (i, (name, done)) in BOARD_COLUMNS.iter().enumerate() {
        sqlx::query("INSERT INTO kanban_columns (board_id, name, position, is_done) VALUES ($1, $2, $3, $4)")
            .bind(board)
            .bind(*name)
            .bind((i as f64 + 1.0) * POSITION_GAP)
            .bind(*done)
            .execute(&mut **tx)
            .await
            .map_err(sql)?;
    }
    Ok(true)
}

async fn demo_data(tx: &mut TenantTx, admin_id: i32) -> Result<String, String> {
    let teams = ["Team A", "Team B"];
    for name in teams {
        sqlx::query("INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING")
            .bind(name)
            .execute(&mut **tx)
            .await
            .map_err(sql)?;
    }
    let source: Option<i32> =
        sqlx::query_scalar("SELECT id FROM setting_options WHERE group_key = 'contact_source' AND value = 'website'")
            .fetch_optional(&mut **tx)
            .await
            .map_err(sql)?;
    let names = ["Nguyễn Văn A", "Trần Thị B", "Lê Văn C", "Phạm Thị D", "Hoàng Văn E"];
    let mut created = 0;
    for (i, full_name) in names.iter().enumerate() {
        let phone = format!("090000000{}", i + 1);
        let exists: Option<i32> = sqlx::query_scalar("SELECT id FROM contacts WHERE phone = $1 LIMIT 1")
            .bind(&phone)
            .fetch_optional(&mut **tx)
            .await
            .map_err(sql)?;
        if exists.is_some() {
            continue;
        }
        sqlx::query(
            "INSERT INTO contacts (phone, full_name, email, source_id, assigned_to, created_by_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5, now())",
        )
        .bind(&phone)
        .bind(*full_name)
        .bind(format!("demo{}@example.com", i + 1))
        .bind(source)
        .bind(admin_id)
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
        created += 1;
    }
    // Có dữ liệu mẫu ⇒ coi như đã dựng quy trình (menu đầy đủ).
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES ('setup_status', 'da_dung', now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value IS DISTINCT FROM EXCLUDED.value",
    )
    .execute(&mut **tx)
    .await
    .map_err(sql)?;
    Ok(format!("Seeded demo data: {} teams, {created} contacts", teams.len()))
}
