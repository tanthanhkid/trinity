//! `cargo xtask <lệnh>` (alias trong `.cargo/config.toml`).
//!
//! - `lint`: luật SQL và giữ kết nối của PLAN 4.3 (`src/lint.rs`) trên mọi tệp dưới `crates/`.

mod lint;

use std::path::Path;
use std::process::ExitCode;

#[allow(clippy::print_stderr, clippy::print_stdout)]
fn main() -> ExitCode {
    let cmd = std::env::args().nth(1);
    match cmd.as_deref() {
        None | Some("help" | "--help" | "-h") => {
            eprintln!(
                "cargo xtask <lệnh>\n\n  lint   cấm `SELECT *`/`RETURNING *`, cấm gọi HTTP khi đang giữ kết nối DB (PLAN 4.3)"
            );
            ExitCode::SUCCESS
        }
        Some("lint") => {
            let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates");
            match lint::lint_dir(&crates) {
                Ok(findings) if findings.is_empty() => {
                    println!("xtask lint: sạch");
                    ExitCode::SUCCESS
                }
                Ok(findings) => {
                    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
                    let base = base.canonicalize().unwrap_or(base);
                    for f in &findings {
                        let file = f.file.canonicalize().unwrap_or_else(|_| f.file.clone());
                        let shown = file.strip_prefix(&base).unwrap_or(&file);
                        eprintln!("{}:{}: [{}] {}", shown.display(), f.line, f.rule, f.detail);
                    }
                    eprintln!("xtask lint: {} lỗi", findings.len());
                    ExitCode::FAILURE
                }
                Err(e) => {
                    eprintln!("xtask lint: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some(other) => {
            eprintln!("xtask: không có lệnh `{other}`");
            ExitCode::FAILURE
        }
    }
}
