//! `cargo xtask <lệnh>` (alias trong `.cargo/config.toml`).
//!
//! - `lint`: luật SQL và giữ kết nối của PLAN 4.3 (`src/lint.rs`) trên mọi tệp dưới `crates/`.
//! - `gen-models`: sinh `crates/trinity-db/src/models.rs` từ `schema.prisma` (`src/gen_models.rs`, PLAN 4.4).
//! - `check-routes [--require-all]`: so bảng route Rust với `contracts/routes.json` (K14; chạy `trinity check-routes`).
//! - `gen-dto <Dto>…`: in khung struct Rust của DTO từ `contracts/dto/schema.json` (`src/gen_dto.rs`, K15).

mod gen_dto;
mod gen_models;
mod lint;

use std::path::Path;
use std::process::ExitCode;

#[allow(clippy::print_stderr, clippy::print_stdout)]
fn main() -> ExitCode {
    let cmd = std::env::args().nth(1);
    match cmd.as_deref() {
        None | Some("help" | "--help" | "-h") => {
            eprintln!(
                "cargo xtask <lệnh>\n\n  lint   cấm `SELECT *`/`RETURNING *`, cấm gọi HTTP khi đang giữ kết nối DB (PLAN 4.3)\n  check-routes [--require-all]   so bảng route Rust với contracts/routes.json (K14)\n  gen-models   sinh crates/trinity-db/src/models.rs từ schema.prisma (PLAN 4.4)\n  gen-dto <Dto>…   in khung struct Rust của DTO từ contracts/dto/schema.json"
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
        Some("check-routes") => {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
            let status = std::process::Command::new(cargo)
                .args(["run", "-q", "-p", "trinity-bin", "--", "check-routes"])
                .args(std::env::args().skip(2))
                .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join(".."))
                .status();
            match status {
                Ok(s) if s.success() => ExitCode::SUCCESS,
                Ok(_) => ExitCode::FAILURE,
                Err(e) => {
                    eprintln!("xtask check-routes: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("gen-models") => {
            let (schema, out) = gen_models::paths(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").as_path());
            let result = std::fs::read_to_string(&schema)
                .map_err(|e| format!("đọc {}: {e}", schema.display()))
                .and_then(|text| gen_models::render(&text))
                .and_then(|code| std::fs::write(&out, code).map_err(|e| format!("ghi {}: {e}", out.display())));
            match result {
                Ok(()) => {
                    println!("xtask gen-models: đã ghi {}", out.display());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("xtask gen-models: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("gen-dto") => {
            let names: Vec<String> = std::env::args().skip(2).collect();
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/dto/schema.json");
            match std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|t| gen_dto::generate(&t, &names))
            {
                Ok(code) => {
                    print!("{code}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("xtask gen-dto: {e}");
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
