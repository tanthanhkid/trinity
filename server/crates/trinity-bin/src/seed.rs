//! `trinity seed` (K32): dữ liệu khởi tạo, thay `server/prisma/seed.ts`. **Chạy lặp lại không đổi dữ liệu**: mọi bước là
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
use trinity_db::platform::conflict_from_trigger;
use trinity_db::{CompanyRef, Db, DbConfig, TenantTx};

const ADMIN_ROLE_NAME: &str = "Quản trị";

#[derive(Debug, Args)]
pub struct SeedArgs {
    /// Công ty cần seed (mặc định 1 = schema `public`); công ty khác cần MULTI_TENANT=true.
    #[arg(long, default_value_t = 1)]
    company: i64,
    /// Thêm bộ dữ liệu mẫu để chạy thử trên localhost (tài khoản Trưởng nhóm/Sale, khách, cơ hội, thẻ việc, nhân sự, sản phẩm).
    /// Chạy lặp lại không nhân đôi; mật khẩu tài khoản mẫu: `SAMPLE_PASSWORD` hoặc [`SAMPLE_PASSWORD_DEFAULT`].
    #[arg(long, alias = "demo")]
    sample: bool,
}

/// Mật khẩu mặc định của tài khoản mẫu (chỉ dùng trên máy cục bộ; không dùng cho dữ liệu thật).
pub const SAMPLE_PASSWORD_DEFAULT: &str = "Demo@12345";
const LEAD_ROLE_NAME: &str = "Trưởng nhóm";
const SALE_ROLE_NAME: &str = "Sale";

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
    let sample = args.sample;
    let result = seed(&db, company, &|k| {
        if sample && k == "SEED_SAMPLE_DATA" {
            Some("true".to_owned())
        } else {
            std::env::var(k).ok()
        }
    })
    .await;
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

/// Lỗi SQL ra chữ cho người chạy lệnh. Trigger đồng bộ ném `TRINITY_EMAIL_TAKEN` khi email admin đã thuộc một công ty
/// khác (`--company` N dùng chung `SEED_ADMIN_EMAIL`): in câu 409 dễ hiểu thay vì lỗi thô của Postgres.
fn sql(e: sqlx::Error) -> String {
    match conflict_from_trigger(&e) {
        Some(msg) => format!("{msg} (đổi SEED_ADMIN_EMAIL hoặc email tài khoản mẫu rồi chạy lại)"),
        None => e.to_string(),
    }
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

    // 6. Bộ dữ liệu mẫu cho localhost (`--sample`).
    if get("SEED_SAMPLE_DATA").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        let password = get("SAMPLE_PASSWORD")
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| SAMPLE_PASSWORD_DEFAULT.to_owned());
        log.extend(sample_data(&mut tx, admin_id, &password).await?);
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

/// (quyền, phạm vi) của vai trò mẫu; `None` = quyền không có phạm vi.
type Grant = (&'static str, Option<&'static str>);

const LEAD_GRANTS: [Grant; 11] = [
    ("contacts.view", Some("team")),
    ("contacts.create", None),
    ("contacts.update", Some("team")),
    ("contacts.transfer", Some("team")),
    ("deals.view", Some("team")),
    ("deals.manage", Some("team")),
    ("kanban.view", Some("team")),
    ("kanban.manage", Some("team")),
    ("reports.overview", Some("team")),
    ("employees.view", Some("team")),
    ("users.view", Some("team")),
];

const SALE_GRANTS: [Grant; 7] = [
    ("contacts.view", Some("own")),
    ("contacts.create", None),
    ("contacts.update", Some("own")),
    ("deals.view", Some("own")),
    ("deals.manage", Some("own")),
    ("kanban.view", Some("own")),
    ("kanban.manage", Some("own")),
];

/// Tạo vai trò (nếu chưa có) và bổ sung quyền còn thiếu; không xoá quyền người dùng đã chỉnh. Trả về id vai trò.
async fn ensure_role(tx: &mut TenantTx, name: &str, description: &str, grants: &[Grant]) -> Result<i32, String> {
    sqlx::query("INSERT INTO roles (name, description, is_system, updated_at) VALUES ($1, $2, false, now()) ON CONFLICT (name) DO NOTHING")
        .bind(name)
        .bind(description)
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
    let role_id: i32 = sqlx::query_scalar("SELECT id FROM roles WHERE name = $1")
        .bind(name)
        .fetch_one(&mut **tx)
        .await
        .map_err(sql)?;
    for (permission, scope) in grants {
        sqlx::query(
            "INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1, $2, $3) ON CONFLICT (role_id, permission) DO NOTHING",
        )
        .bind(role_id)
        .bind(*permission)
        .bind(*scope)
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
    }
    Ok(role_id)
}

/// Tạo tài khoản mẫu nếu email chưa có (mật khẩu chỉ ghi lúc tạo), gán vai trò. Trả về (id, có tạo mới không).
async fn ensure_user(
    tx: &mut TenantTx,
    email: &str,
    full_name: &str,
    role_id: i32,
    team_id: Option<i32>,
    password: &str,
) -> Result<(i32, bool), String> {
    let existing: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&mut **tx)
        .await
        .map_err(sql)?;
    let (id, created) = if let Some(id) = existing {
        (id, false)
    } else {
        let hash = trinity_auth::password::hash(password.to_owned())
            .await
            .map_err(|e| e.to_string())?;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO users (email, password_hash, full_name, status, team_id, updated_at) VALUES ($1, $2, $3, 'active', $4, now()) RETURNING id",
        )
        .bind(email)
        .bind(hash)
        .bind(full_name)
        .bind(team_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(sql)?;
        (id, true)
    };
    sqlx::query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING")
        .bind(id)
        .bind(role_id)
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
    Ok((id, created))
}

/// Dữ liệu mẫu cho localhost: 2 nhóm, 3 tài khoản (Trưởng nhóm, 2 Sale) + nhân sự, 8 khách, 4 cơ hội, 5 thẻ việc, 2 sản phẩm.
/// Mỗi bản ghi có khoá tự nhiên (email, SĐT, tiêu đề, mã) nên chạy lại không nhân đôi. Trả về các dòng log.
async fn sample_data(tx: &mut TenantTx, admin_id: i32, password: &str) -> Result<Vec<String>, String> {
    let mut log: Vec<String> = Vec::new();

    // Nhóm.
    for (name, department) in [("Kinh doanh 1", "Kinh doanh"), ("Kinh doanh 2", "Kinh doanh")] {
        sqlx::query("INSERT INTO teams (name, department) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING")
            .bind(name)
            .bind(department)
            .execute(&mut **tx)
            .await
            .map_err(sql)?;
    }
    let team1: i32 = sqlx::query_scalar("SELECT id FROM teams WHERE name = 'Kinh doanh 1'")
        .fetch_one(&mut **tx)
        .await
        .map_err(sql)?;
    let team2: i32 = sqlx::query_scalar("SELECT id FROM teams WHERE name = 'Kinh doanh 2'")
        .fetch_one(&mut **tx)
        .await
        .map_err(sql)?;

    // Vai trò + tài khoản.
    let lead_role = ensure_role(
        tx,
        LEAD_ROLE_NAME,
        "Quản lý nhóm kinh doanh (xem/sửa dữ liệu trong nhóm)",
        &LEAD_GRANTS,
    )
    .await?;
    let sale_role = ensure_role(
        tx,
        SALE_ROLE_NAME,
        "Nhân viên kinh doanh (chỉ dữ liệu của mình)",
        &SALE_GRANTS,
    )
    .await?;
    let (lead_id, c1) = ensure_user(
        tx,
        "truongnhom@demo.local",
        "Đặng Minh Quân",
        lead_role,
        Some(team1),
        password,
    )
    .await?;
    let (sale1_id, c2) = ensure_user(tx, "sale1@demo.local", "Vũ Thu Hà", sale_role, Some(team1), password).await?;
    let (sale2_id, c3) = ensure_user(tx, "sale2@demo.local", "Bùi Quốc Bảo", sale_role, Some(team2), password).await?;
    sqlx::query("UPDATE teams SET team_lead_id = $1 WHERE id = $2 AND team_lead_id IS NULL")
        .bind(lead_id)
        .bind(team1)
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
    let new_users = [c1, c2, c3].iter().filter(|c| **c).count();

    // Nhân sự (một hồ sơ cho mỗi tài khoản; `employees.user_id` duy nhất).
    for (user_id, position, team) in [
        (lead_id, "Trưởng nhóm kinh doanh", team1),
        (sale1_id, "Nhân viên kinh doanh", team1),
        (sale2_id, "Nhân viên kinh doanh", team2),
    ] {
        sqlx::query(
            r#"INSERT INTO employees (user_id, "position", department, team_id, status) VALUES ($1, $2, 'Kinh doanh', $3, 'active')
               ON CONFLICT (user_id) DO NOTHING"#,
        )
        .bind(user_id)
        .bind(position)
        .bind(team)
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
    }

    // Khách hàng: (SĐT, tên, nguồn, giai đoạn, người phụ trách). SĐT là khoá tự nhiên.
    let customers: [(&str, &str, &str, &str, i32); 8] = [
        ("0911000001", "Nguyễn Hoàng Anh", "website", "new", sale1_id),
        ("0911000002", "Trần Minh Châu", "facebook", "follow_up_1", sale1_id),
        ("0911000003", "Lê Quỳnh Dao", "zalo", "follow_up_2", sale1_id),
        ("0911000004", "Phạm Gia Huy", "referral", "follow_up_3", sale1_id),
        ("0911000005", "Hoàng Thanh Lam", "ads", "new", sale2_id),
        ("0911000006", "Đỗ Khánh Linh", "website", "follow_up_1", sale2_id),
        ("0911000007", "Ngô Đức Mạnh", "facebook", "follow_up_2", sale2_id),
        ("0911000008", "Phan Bảo Ngọc", "other", "new", lead_id),
    ];
    let mut contact_ids: Vec<i32> = Vec::new();
    let mut new_contacts = 0;
    for (phone, full_name, source, stage, owner) in customers {
        let existing: Option<i32> =
            sqlx::query_scalar("SELECT id FROM contacts WHERE phone = $1 AND deleted_at IS NULL LIMIT 1")
                .bind(phone)
                .fetch_optional(&mut **tx)
                .await
                .map_err(sql)?;
        if let Some(id) = existing {
            contact_ids.push(id);
            continue;
        }
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO contacts (phone, full_name, email, source_id, stage_id, assigned_to, created_by_id, updated_at)
             VALUES ($1, $2, $3, (SELECT id FROM setting_options WHERE group_key = 'contact_source' AND value = $4),
                     (SELECT id FROM setting_options WHERE group_key = 'contact_stage' AND value = $5), $6, $6, now())
             RETURNING id",
        )
        .bind(phone)
        .bind(full_name)
        .bind(format!("kh{}@example.com", &phone[phone.len() - 3..]))
        .bind(source)
        .bind(stage)
        .bind(owner)
        .fetch_one(&mut **tx)
        .await
        .map_err(sql)?;
        contact_ids.push(id);
        new_contacts += 1;
    }

    // Cơ hội: (tiêu đề, giá trị, trạng thái, khách (chỉ số), người phụ trách). Tiêu đề là khoá tự nhiên.
    let deals: [(&str, i64, &str, usize, i32); 4] = [
        ("Gói tư vấn CRM - Nguyễn Hoàng Anh", 15_000_000, "open", 0, sale1_id),
        (
            "Triển khai quy trình bán hàng - Lê Quỳnh Dao",
            42_000_000,
            "open",
            2,
            sale1_id,
        ),
        ("Hợp đồng năm - Phạm Gia Huy", 80_000_000, "won", 3, sale1_id),
        ("Đào tạo đội sale - Ngô Đức Mạnh", 25_000_000, "open", 6, sale2_id),
    ];
    let mut new_deals = 0;
    for (title, value, status, contact_idx, owner) in deals {
        let exists: Option<i32> = sqlx::query_scalar("SELECT id FROM deals WHERE title = $1 LIMIT 1")
            .bind(title)
            .fetch_optional(&mut **tx)
            .await
            .map_err(sql)?;
        if exists.is_some() {
            continue;
        }
        sqlx::query(
            "INSERT INTO deals (title, value, status, assigned_to, created_by, contact_id, updated_at, won_at)
             VALUES ($1, $2, $3, $4, $5, $6, now(), CASE WHEN $3::text = 'won' THEN now() END)",
        )
        .bind(title)
        .bind(value)
        .bind(status)
        .bind(owner)
        .bind(admin_id)
        .bind(contact_ids.get(contact_idx).copied())
        .execute(&mut **tx)
        .await
        .map_err(sql)?;
        new_deals += 1;
    }

    // Thẻ việc trên bảng mặc định (bỏ qua nếu bảng đã bị đổi tên/xoá): (tiêu đề, cột, người nhận).
    let mut new_cards = 0;
    let board: Option<i32> =
        sqlx::query_scalar("SELECT id FROM kanban_boards WHERE name = $1 AND deleted_at IS NULL LIMIT 1")
            .bind(BOARD_NAME)
            .fetch_optional(&mut **tx)
            .await
            .map_err(sql)?;
    if let Some(board) = board {
        let cards: [(&str, &str, i32); 5] = [
            ("Gọi lại khách Nguyễn Hoàng Anh", "Cần làm", sale1_id),
            ("Gửi báo giá cho Lê Quỳnh Dao", "Cần làm", sale1_id),
            ("Chuẩn bị tài liệu demo sản phẩm", "Đang làm", lead_id),
            ("Họp nhóm đầu tuần", "Đang làm", lead_id),
            ("Chốt hợp đồng Phạm Gia Huy", "Xong", sale1_id),
        ];
        for (i, (title, column, assignee)) in cards.iter().enumerate() {
            let exists: Option<i32> = sqlx::query_scalar(
                "SELECT id FROM kanban_cards WHERE board_id = $1 AND title = $2 AND deleted_at IS NULL LIMIT 1",
            )
            .bind(board)
            .bind(*title)
            .fetch_optional(&mut **tx)
            .await
            .map_err(sql)?;
            if exists.is_some() {
                continue;
            }
            let column_id: Option<i32> =
                sqlx::query_scalar("SELECT id FROM kanban_columns WHERE board_id = $1 AND name = $2 LIMIT 1")
                    .bind(board)
                    .bind(*column)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(sql)?;
            let Some(column_id) = column_id else { continue };
            sqlx::query(
                "INSERT INTO kanban_cards (board_id, column_id, position, title, assignee_id, created_by, priority)
                 VALUES ($1, $2, $3, $4, $5, $6, 'normal')",
            )
            .bind(board)
            .bind(column_id)
            .bind((i as f64 + 1.0) * POSITION_GAP)
            .bind(*title)
            .bind(*assignee)
            .bind(admin_id)
            .execute(&mut **tx)
            .await
            .map_err(sql)?;
            new_cards += 1;
        }
    }

    // Sản phẩm (cửa hàng); `code` duy nhất.
    for (code, name, price) in [
        ("SP-DEMO-01", "Gói CRM Cơ bản", 5_000_000_i64),
        ("SP-DEMO-02", "Gói CRM Nâng cao", 12_000_000_i64),
    ] {
        sqlx::query("INSERT INTO products (code, name, price, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING")
            .bind(code)
            .bind(name)
            .bind(price)
            .bind(admin_id)
            .execute(&mut **tx)
            .await
            .map_err(sql)?;
    }

    // Có dữ liệu mẫu ⇒ coi như đã dựng quy trình (menu đầy đủ), như `SEED_DEMO_DATA`.
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES ('setup_status', 'da_dung', now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value IS DISTINCT FROM EXCLUDED.value",
    )
    .execute(&mut **tx)
    .await
    .map_err(sql)?;

    log.push(format!(
        "Seeded sample data: {new_users} users, {new_contacts} contacts, {new_deals} deals, {new_cards} cards (mật khẩu tài khoản mới: SAMPLE_PASSWORD hoặc mặc định)"
    ));
    Ok(log)
}

#[cfg(test)]
mod sample_tests {
    use super::*;

    #[test]
    fn sample_grants_khong_trung_khoa() {
        // Khoá chính role_permissions là (role_id, permission): không được trùng trong một vai trò.
        for grants in [&LEAD_GRANTS[..], &SALE_GRANTS[..]] {
            let mut keys: Vec<&str> = grants.iter().map(|(k, _)| *k).collect();
            keys.sort_unstable();
            keys.dedup();
            assert_eq!(keys.len(), grants.len());
        }
    }

    #[test]
    fn mat_khau_mau_du_dai() {
        assert!(SAMPLE_PASSWORD_DEFAULT.len() >= 8);
    }

    #[test]
    fn email_da_thuoc_cong_ty_khac_ra_cau_de_hieu() {
        let e = sqlx::Error::Protocol("TRINITY_EMAIL_TAKEN".to_owned());
        let msg = sql(e);
        assert!(msg.starts_with("Email này đã được dùng cho một công ty khác"), "{msg}");
        assert!(msg.contains("SEED_ADMIN_EMAIL"));
        assert_eq!(sql(sqlx::Error::RowNotFound), sqlx::Error::RowNotFound.to_string());
    }
}
