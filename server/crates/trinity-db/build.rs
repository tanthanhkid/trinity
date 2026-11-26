//! Ghi tên migration mới nhất của thư mục Prisma vào `TRINITY_LATEST_MIGRATION` lúc biên dịch: binary chỉ phục vụ
//! công ty đã migrate tới bản này (PLAN 4.3).

use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/prisma/prisma/migrations");
    println!("cargo::rerun-if-changed={}", dir.display());
    let latest = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("không đọc được {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .filter(|e| e.path().join("migration.sql").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .max()
        .expect("thư mục migration rỗng");
    println!("cargo::rustc-env=TRINITY_LATEST_MIGRATION={latest}");
}
