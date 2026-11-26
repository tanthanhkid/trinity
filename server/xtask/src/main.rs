//! `cargo xtask <lệnh>` (alias trong `.cargo/config.toml`). K01 chưa có lệnh nào; `gen-models`, `check-routes`,
//! lint SQL… thêm ở các issue sau.

use std::process::ExitCode;

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1);
    #[allow(clippy::print_stderr)]
    {
        match cmd.as_deref() {
            None | Some("help" | "--help" | "-h") => {
                eprintln!("cargo xtask <lệnh>\n\nChưa có lệnh nào (K01). Xem docs/rust/PLAN.md mục 4.1.");
                ExitCode::SUCCESS
            }
            Some(other) => {
                eprintln!("xtask: không có lệnh `{other}`");
                ExitCode::FAILURE
            }
        }
    }
}
