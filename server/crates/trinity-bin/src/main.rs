//! Binary `trinity`. Có `check-config`, `migrate` (K07); `seed`, `channel-lock` (K32); `serve`, `healthcheck` (docs/rust/PLAN.md
//! mục 4.1).

mod channel_lock;
mod feature_gate;
mod migrate;
mod routes;

// K34: `serve` gọi `trinity_testhooks::TestHooks::router` khi build với `--features test-hooks`.
#[cfg(feature = "test-hooks")]
use trinity_testhooks as _;
mod seed;
mod serve;
mod shadow_report;

use std::io::Write;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use trinity_http::edge::client_ip;
use trinity_kernel::config::{Config, process_env};
use trinity_kernel::ownership::Ownership;

/// Trinity: CRM, nhân sự, bán hàng trong một binary.
#[derive(Debug, Parser)]
#[command(name = "trinity", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Kiểm cấu hình từ biến môi trường (và tệp sở hữu nếu đặt TRINITY_OWNERSHIP_FILE) rồi thoát:
    /// mã 0 khi dùng được, mã 1 khi binary sẽ từ chối khởi động.
    CheckConfig,
    /// Chạy migration (bộ nhúng trong binary, tương thích `prisma migrate deploy` và bảng `_prisma_migrations`).
    /// Mặc định: schema `public` (công ty 1), như bước deploy của bản Node. Thoát mã 1 nếu có lỗi hoặc (với
    /// `--status`) còn migration chưa chạy.
    Migrate(migrate::MigrateArgs),
    /// So bảng route Rust đã khai với `contracts/routes.json` (K14): mã 0 khớp, mã 1 có chỗ lệch. `--require-all` đòi
    /// khai đủ mọi route của hợp đồng (cổng cuối trước khi bỏ Node).
    CheckRoutes {
        #[arg(long)]
        require_all: bool,
    },
    /// Bộ kiểm bất biến dữ liệu (X11, chỉ đọc DB): mã 0 sạch, mã 1 có vi phạm, mã 2 lỗi chạy.
    /// Chạy theo lịch mỗi giờ: docs/rust/invariants.md.
    CheckInvariants(InvariantsArgs),
    /// Dữ liệu khởi tạo (vai trò Quản trị, tuỳ chọn cấu hình, tài khoản admin, bảng việc mặc định); chạy lặp lại không đổi dữ liệu.
    Seed(seed::SeedArgs),
    /// Công tắc khoá kênh gửi ra ngoài của một công ty (chủ nền tảng): list | lock | unlock | resume.
    ChannelLock(channel_lock::ChannelLockArgs),
    /// Chạy máy chủ HTTP: router mọi module đã chuyển, strangler sang Node cho phần còn lại, `/notif-ws`, scheduler. Ctrl+C hoặc SIGTERM để dừng êm.
    Serve(serve::ServeArgs),
    /// GET `/api/v1/health` trên loopback (cổng `TRINITY_HTTP_PORT`): mã 0 khi 200, mã 1 nếu không.
    Healthcheck,
    /// Báo cáo shadow K28 từ tệp `serve` ghi (số mẫu theo route so với `min_samples`, đường dẫn khác biệt; không có giá trị dữ liệu): mã 0 khi mọi route đạt, 1 khi còn route chưa đạt, 2 khi không đọc được.
    ShadowReport(shadow_report::ShadowReportArgs),
}

#[derive(Debug, clap::Args)]
struct InvariantsArgs {
    /// Tệp trạng thái lần chạy sạch trước (số dòng, max updated_at). Không đặt thì bỏ hai kiểm so với lần trước.
    #[arg(long)]
    state: Option<std::path::PathBuf>,
    /// Ghi mốc mới dù có vi phạm (sau khi người vận hành xác nhận thay đổi là chủ ý, vd xoá cứng có chủ đích).
    #[arg(long)]
    accept: bool,
    /// Chỉ kiểm schema này (lặp được); mặc định mọi schema công ty.
    #[arg(long = "schema")]
    schemas: Vec<String>,
    /// Báo cáo JSON ra stdout thay vì chữ.
    #[arg(long)]
    json: bool,
    /// Số dòng sụt tối thiểu để báo (kèm `--drop-pct`).
    #[arg(long, default_value_t = 10)]
    min_drop_rows: i64,
    /// Phần trăm sụt tối thiểu để báo.
    #[arg(long, default_value_t = 20)]
    drop_pct: i64,
}

fn main() -> ExitCode {
    // reqwest (rustls-no-provider) cần provider đã cài trước khi dựng Client; cùng `ring` với sqlx.
    let _ = rustls::crypto::ring::default_provider().install_default();
    match Cli::parse().command {
        None => ExitCode::SUCCESS,
        Some(Command::CheckConfig) => check_config(),
        Some(Command::Migrate(args)) => migrate::run(args),
        Some(Command::CheckRoutes { require_all }) => check_routes(require_all),
        Some(Command::CheckInvariants(args)) => check_invariants(&args),
        Some(Command::Seed(args)) => seed::run(&args),
        Some(Command::ChannelLock(args)) => channel_lock::run(args),
        Some(Command::Serve(args)) => serve::run(args),
        Some(Command::Healthcheck) => serve::healthcheck(),
        Some(Command::ShadowReport(args)) => shadow_report::run(args),
    }
}

fn check_invariants(args: &InvariantsArgs) -> ExitCode {
    let mut err = std::io::stderr().lock();
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = writeln!(err, "không dựng được runtime: {e}");
            return ExitCode::from(2);
        }
    };
    match rt.block_on(run_invariants(args)) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(msg) => {
            let _ = writeln!(err, "{msg}");
            ExitCode::from(2)
        }
    }
}

async fn run_invariants(args: &InvariantsArgs) -> Result<bool, String> {
    use trinity_ops::{Options, Snapshot};
    let mut cfg = trinity_db::DbConfig::from_env().map_err(|e| e.to_string())?;
    cfg.pool_size = 1;
    // Như migrate: bảng lớn có thể đếm lâu hơn 30 giây mặc định.
    cfg.statement_timeout = std::time::Duration::ZERO;
    let db = trinity_db::Db::connect(&cfg).await.map_err(|e| e.to_string())?;
    let prev = match &args.state {
        Some(p) => Snapshot::load(p).map_err(|e| e.to_string())?,
        None => Snapshot::default(),
    };
    let opts = Options {
        min_drop_rows: args.min_drop_rows,
        drop_pct: args.drop_pct,
        schemas: args.schemas.clone(),
    };
    let (report, now) = trinity_ops::run(&db, &prev, &opts).await.map_err(|e| e.to_string())?;
    db.close().await;
    if let Some(p) = &args.state
        && (report.ok() || args.accept)
    {
        trinity_ops::Snapshot::next(&prev, now, !args.schemas.is_empty())
            .save(p)
            .map_err(|e| e.to_string())?;
    }
    let mut out = std::io::stdout().lock();
    if args.json {
        let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        writeln!(out, "{json}").map_err(|e| e.to_string())?;
    } else {
        writeln!(
            out,
            "{} schema, {} bảng, {} cột JSON, {} quy tắc soft-FK: {} vi phạm",
            report.schemas_checked.len(),
            report.tables_checked,
            report.json_columns_checked,
            report.orphan_rules_checked,
            report.violations.len()
        )
        .map_err(|e| e.to_string())?;
        for v in &report.violations {
            writeln!(
                out,
                "- {:?} {}.{}{} x{}: {}",
                v.kind,
                v.schema,
                v.table,
                v.column.as_deref().map(|c| format!(".{c}")).unwrap_or_default(),
                v.count,
                v.detail
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(report.ok())
}

fn check_routes(require_all: bool) -> ExitCode {
    let mut err = std::io::stderr().lock();
    let rep = routes::check(require_all);
    for p in &rep.problems {
        let _ = writeln!(err, "{p}");
    }
    let _ = writeln!(
        err,
        "check-routes: đã khai {}/{} route của hợp đồng, {} lỗi",
        rep.declared,
        rep.contract_total,
        rep.problems.len()
    );
    if rep.ok() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Log JSON (K04) chưa có: cảnh báo và lỗi ghi thẳng ra stderr.
fn check_config() -> ExitCode {
    let mut err = std::io::stderr().lock();
    let (env, dropped) = process_env();
    for name in &dropped {
        let _ = writeln!(
            err,
            "cảnh báo: biến {name} có tên hoặc giá trị không phải UTF-8, bỏ qua"
        );
    }
    let loaded = match Config::from_env(&env) {
        Ok(l) => l,
        Err(e) => {
            let _ = writeln!(err, "{e}");
            return ExitCode::FAILURE;
        }
    };
    for w in &loaded.warnings {
        let _ = writeln!(err, "cảnh báo: {w}");
    }
    // IP của khách (K16): `TRUSTED_PROXY` sai, cờ cũ `*_TRUST_*` mà chưa đặt `TRUSTED_PROXY`, hoặc `cloudflare-tunnel`
    // mà địa chỉ nghe (`LISTEN_HOST`, trống = mọi giao diện) không phải loopback ⇒ không khởi động.
    let mut ip_problems = client_ip::startup_problems(&env);
    let listen = env
        .get("LISTEN_HOST")
        .map(|h| h.trim())
        .filter(|h| !h.is_empty())
        .unwrap_or("::");
    ip_problems.extend(client_ip::tunnel_listen_problem(Some(listen), &env));
    if !ip_problems.is_empty() {
        let _ = writeln!(
            err,
            "Không khởi động: cấu hình IP của khách sai:\n- {}",
            ip_problems.join("\n- ")
        );
        return ExitCode::FAILURE;
    }
    if let Err(e) = routes::boot_check() {
        let _ = writeln!(err, "{e}");
        return ExitCode::FAILURE;
    }
    for w in client_ip::startup_warnings(&env) {
        let _ = writeln!(err, "cảnh báo: {w}");
    }
    if let Some(path) = &loaded.config.ownership_file {
        match Ownership::load(path) {
            Ok(own) => {
                for job in own.unknown_jobs() {
                    let _ = writeln!(
                        err,
                        "cảnh báo: tệp sở hữu ghi job \"{job}\" mà Trinity không có (gõ nhầm?)"
                    );
                }
            }
            Err(e) => {
                let _ = writeln!(err, "{e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}
