//! Binary `trinity`. Lệnh `serve`, `migrate`, `seed`, `channel-lock`, `healthcheck` thêm ở các issue sau
//! (docs/rust/PLAN.md mục 4.1).

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
}

fn main() -> ExitCode {
    match Cli::parse().command {
        None => ExitCode::SUCCESS,
        Some(Command::CheckConfig) => check_config(),
    }
}

/// Log JSON (K04) chưa có: cảnh báo và lỗi ghi thẳng ra stderr.
fn check_config() -> ExitCode {
    let mut err = std::io::stderr().lock();
    let loaded = match Config::from_env(&process_env()) {
        Ok(l) => l,
        Err(e) => {
            let _ = writeln!(err, "{e}");
            return ExitCode::FAILURE;
        }
    };
    for w in &loaded.warnings {
        let _ = writeln!(err, "cảnh báo: {w}");
    }
    if let Some(path) = &loaded.config.ownership_file
        && let Err(e) = Ownership::load(path)
    {
        let _ = writeln!(err, "{e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
