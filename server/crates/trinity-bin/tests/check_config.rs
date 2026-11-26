//! Tiến trình thật: secret mẫu ở production làm binary thoát mã khác 0.

use std::process::Command;

fn run(envs: &[(&str, &str)]) -> (i32, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_trinity"))
        .arg("check-config")
        .env_clear()
        .envs(envs.iter().copied())
        .output()
        .expect("chạy được binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

const GOOD_JWT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn change_me_o_production_thoat_ma_khac_0() {
    let (code, err) = run(&[
        ("NODE_ENV", "production"),
        ("JWT_SECRET", "change-me-generate-with-openssl-rand-hex-32"),
        (
            "DATABASE_URL",
            "postgresql://trinity:change-me-db-password@localhost:5432/trinity",
        ),
    ]);
    assert_ne!(code, 0, "{err}");
    assert!(err.contains("JWT_SECRET vẫn là giá trị mẫu change-me-*"), "{err}");
    assert!(err.contains("Mật khẩu Postgres vẫn là giá trị mẫu"), "{err}");
    assert!(!err.contains("generate-with"), "lộ giá trị secret: {err}");
}

#[test]
fn cau_hinh_tot_thoat_0_va_canh_bao_bien_cu() {
    let (code, err) = run(&[
        ("NODE_ENV", "production"),
        ("JWT_SECRET", GOOD_JWT),
        ("DATABASE_URL", "postgresql://trinity:Xy9@db:5432/trinity"),
        ("REDIS_URL", "redis://x"),
    ]);
    assert_eq!(code, 0, "{err}");
    assert!(err.contains("cảnh báo: REDIS_URL không còn dùng"), "{err}");
}

#[test]
fn tep_so_huu_hong_thoat_ma_khac_0_va_chi_dong() {
    let dir = std::env::temp_dir().join(format!("trinity-k03-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ownership.json");
    std::fs::write(&path, "{\n  \"routes\": [\n    { \"prefix\": \"/a\", \"owner\": \"rust\" },\n    { \"prefix\": \"/a\", \"owner\": \"node\" }\n  ]\n}\n").unwrap();
    let p = path.to_str().unwrap();
    let (code, err) = run(&[("JWT_SECRET", GOOD_JWT), ("TRINITY_OWNERSHIP_FILE", p)]);
    std::fs::remove_dir_all(&dir).ok();
    assert_ne!(code, 0, "{err}");
    assert!(err.contains("hỏng ở dòng 4"), "{err}");
}

#[test]
fn production_thieu_database_url_thoat_ma_khac_0() {
    let (code, err) = run(&[("NODE_ENV", "production"), ("JWT_SECRET", GOOD_JWT)]);
    assert_ne!(code, 0, "{err}");
    assert!(err.contains("Thiếu DATABASE_URL"), "{err}");
}

#[cfg(unix)]
#[test]
fn bien_ten_khong_utf8_duoc_bao() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let out = Command::new(env!("CARGO_BIN_EXE_trinity"))
        .arg("check-config")
        .env_clear()
        .env("JWT_SECRET", GOOD_JWT)
        .env(OsStr::from_bytes(b"BAD_\xff_NAME"), "1")
        .output()
        .expect("chạy được binary");
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(0), "{err}");
    assert!(err.contains("không phải UTF-8"), "{err}");
}

fn base<'a>(extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut v = vec![
        ("NODE_ENV", "production"),
        ("JWT_SECRET", GOOD_JWT),
        ("DATABASE_URL", "postgresql://trinity:Xy9@db:5432/trinity"),
    ];
    v.extend_from_slice(extra);
    v
}

#[test]
fn trusted_proxy_sai_hoac_co_cu_khong_kem_trusted_proxy_khong_khoi_dong() {
    let (code, err) = run(&base(&[("TRUSTED_PROXY", "yes")]));
    assert_ne!(code, 0, "{err}");
    assert!(err.contains("TRUSTED_PROXY=\"yes\" không hợp lệ"), "{err}");
    let (code, err) = run(&base(&[("ATTENDANCE_TRUST_CF_IP", "true")]));
    assert_ne!(code, 0, "{err}");
    assert!(err.contains("Cờ cũ ATTENDANCE_TRUST_CF_IP"), "{err}");
    let (code, err) = run(&base(&[
        ("ATTENDANCE_TRUST_CF_IP", "true"),
        ("TRUSTED_PROXY", "cloudflare"),
    ]));
    assert_eq!(code, 0, "{err}");
}

#[test]
fn cloudflare_tunnel_dia_chi_nghe_khong_phai_loopback_khong_khoi_dong() {
    let (code, err) = run(&base(&[("TRUSTED_PROXY", "cloudflare-tunnel")]));
    assert_ne!(code, 0, "{err}");
    assert!(err.contains("không phải loopback"), "{err}");
    let (code, err) = run(&base(&[
        ("TRUSTED_PROXY", "cloudflare-tunnel"),
        ("LISTEN_HOST", "0.0.0.0"),
    ]));
    assert_ne!(code, 0, "{err}");
    let (code, err) = run(&base(&[
        ("TRUSTED_PROXY", "cloudflare-tunnel"),
        ("LISTEN_HOST", "127.0.0.1"),
    ]));
    assert_eq!(code, 0, "{err}");
}
