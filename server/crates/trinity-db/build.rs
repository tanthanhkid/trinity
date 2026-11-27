//! Lúc biên dịch, từ thư mục migration của Prisma:
//! - ghi tên migration mới nhất vào `TRINITY_LATEST_MIGRATION`: binary chỉ phục vụ công ty đã migrate tới bản này
//!   (PLAN 4.3);
//! - sinh `$OUT_DIR/embedded_migrations.rs` nhúng nguyên văn mọi `migration.sql` (`include_str!`, giữ từng byte nên
//!   checksum không đổi): `trinity migrate` chạy được ở máy chủ không có mã nguồn (PLAN 4.5, K07).

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    // Đọc lúc CHẠY script, không `env!` lúc biên dịch script: thư mục build dùng chung giữa các worktree nên binary script
    // có thể là bản đã dựng ở worktree khác, và đường dẫn nướng sẵn trong đó sẽ nhúng nhầm migration của worktree kia.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let dir = Path::new(&manifest)
        .join("../../prisma/migrations")
        .canonicalize()
        .expect("có thư mục server/prisma/migrations");
    println!("cargo::rerun-if-changed={}", dir.display());
    println!("cargo::rerun-if-changed=build.rs");
    // Đường dẫn tuyệt đối vào môi trường của crate: đổi worktree thì giá trị đổi.
    println!("cargo::rustc-env=TRINITY_MIGRATIONS_DIR={}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("không đọc được {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .filter(|e| e.path().join("migration.sql").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    // Thứ tự byte của tên, như Prisma sắp thư mục migration.
    names.sort();
    let latest = names.last().expect("thư mục migration rỗng");
    println!("cargo::rustc-env=TRINITY_LATEST_MIGRATION={latest}");

    let mut src = String::from("/// (tên thư mục, nội dung `migration.sql`) theo thứ tự tên.\n");
    let _ = writeln!(src, "pub(crate) static EMBEDDED: [(&str, &str); {}] = [", names.len());
    for n in &names {
        let file = dir.join(n).join("migration.sql");
        println!("cargo::rerun-if-changed={}", file.display());
        let _ = writeln!(src, "    ({n:?}, include_str!({:?})),", file.display().to_string());
    }
    src.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("embedded_migrations.rs");
    std::fs::write(out, src).expect("ghi embedded_migrations.rs");
}
