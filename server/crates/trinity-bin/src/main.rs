//! Binary `trinity`. Có `check-config`, `migrate` (K07); `serve`, `seed`, `channel-lock`, `healthcheck` thêm ở các
//! issue sau (docs/rust/PLAN.md mục 4.1).

mod migrate;

use std::io::Write;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
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
}

fn main() -> ExitCode {
    match Cli::parse().command {
        None => ExitCode::SUCCESS,
        Some(Command::CheckConfig) => check_config(),
        Some(Command::Migrate(args)) => migrate::run(args),
    }
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
