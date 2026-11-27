use super::*;

const SAMPLE: &str = include_str!("../../tests/fixtures/ownership-sample.json");
const ROUTES_SAMPLE: &str = include_str!("../../tests/fixtures/routes-sample.json");

fn sample() -> Ownership {
    Ownership::parse(SAMPLE, "ownership-sample.json").expect("tệp mẫu hợp lệ")
}

#[derive(serde::Deserialize)]
struct Route {
    method: String,
    path: String,
}

/// Route để kiểm "đúng một chủ": `server/contracts/routes.json` (C02) khi đã có, không thì bảng mẫu.
fn routes() -> (Vec<Route>, &'static str) {
    let contract = format!("{}/../../contracts/routes.json", manifest_dir());
    match std::fs::read_to_string(contract) {
        Ok(text) => {
            let v: serde_json::Value = serde_json::from_str(&text).expect("routes.json là JSON");
            let arr = v.get("routes").cloned().unwrap_or(v);
            (
                serde_json::from_value(arr).expect("routes.json: mảng {method, path}"),
                "contracts/routes.json",
            )
        }
        Err(_) => (
            serde_json::from_str(ROUTES_SAMPLE).expect("bảng mẫu"),
            "routes-sample.json",
        ),
    }
}

#[test]
fn bang_moi_route_dung_mot_chu() {
    let own = sample();
    let (routes, origin) = routes();
    assert!(!routes.is_empty(), "{origin} rỗng");
    for r in &routes {
        let path = r.path.split('?').next().unwrap_or_default();
        let top = own.top_matches(&r.method, path);
        assert!(
            top.len() <= 1,
            "{origin}: {} {} có {} chủ: {top:?}",
            r.method,
            r.path,
            top.len()
        );
        let m = own.route(&r.method, path);
        assert_eq!(m.rule, top.first().copied(), "{} {}", r.method, r.path);
    }
}

#[test]
fn tien_to_dai_nhat_va_phuong_thuc() {
    let own = sample();
    let o = |m: &str, p: &str| own.route(m, p).owner;
    // Tiền tố lồng nhau thuộc hai đợt.
    assert_eq!(o("GET", "/api/v1/settings"), Owner::Rust);
    assert_eq!(o("GET", "/api/v1/settings/options"), Owner::Rust);
    assert_eq!(o("GET", "/api/v1/settings/channel-guard"), Owner::Node);
    assert_eq!(o("PUT", "/api/v1/settings/channel-guard/7"), Owner::Node);
    assert_eq!(o("POST", "/api/v1/public/auth/login"), Owner::Rust);
    assert_eq!(o("POST", "/api/v1/public/contacts"), Owner::Node);
    // Phương thức: cùng tiền tố, dòng cụ thể thắng dòng mọi phương thức.
    assert_eq!(o("GET", "/api/v1/contacts/5"), Owner::Rust);
    assert_eq!(o("HEAD", "/api/v1/contacts"), Owner::Rust);
    assert_eq!(o("POST", "/api/v1/contacts"), Owner::Node);
    assert_eq!(o("GET", "/api/v1/auth/teams"), Owner::Rust);
    assert_eq!(o("POST", "/api/v1/auth/teams"), Owner::Node);
    // Ranh giới đoạn, không khớp nửa chừng.
    assert_eq!(own.route("GET", "/api/v1/contacts-export").rule, None);
    assert_eq!(own.route("GET", "/api/v1/settingsx").rule, None);
    // Không dòng nào khớp ⇒ Node.
    assert_eq!(o("POST", "/api/v1/hooks/in/abc"), Owner::Node);
}

#[test]
fn job_va_migrate() {
    let own = sample();
    assert_eq!(own.job("lead-scoring.run"), Owner::Rust);
    assert_eq!(own.job("stale-work.digest"), Owner::Node);
    assert_eq!(own.job("chua-co"), Owner::Node);
    assert_eq!(own.migrate(), Owner::Node);
    assert!(own.unknown_jobs().is_empty());
    let typo = Ownership::parse(r#"{"jobs": {"lead-scoring": "rust"}}"#, "x").unwrap();
    assert_eq!(typo.unknown_jobs(), ["lead-scoring"]);
    let empty = Ownership::parse("{}", "x").unwrap();
    assert_eq!(empty, Ownership::default());
    assert_eq!(empty.route("GET", "/api/v1/settings").owner, Owner::Node);
}

fn bad(text: &str) -> (usize, String) {
    match Ownership::parse(text, "own.json") {
        Err(OwnershipError::Invalid { line, message, .. }) => (line, message),
        other => panic!("phải lỗi Invalid, được {other:?}"),
    }
}

#[test]
fn tep_hong_bi_tu_choi_voi_loi_chi_dong() {
    // JSON hỏng.
    let (line, _) = bad("{\n  \"routes\": [\n    { \"prefix\": \"/a\", \"owner\": \"rust\" },\n  ]\n}");
    assert_eq!(line, 4);
    // Hai dòng cùng tiền tố, cùng mọi phương thức: lỗi ở dòng thứ hai.
    let text = r#"{
  "routes": [
    { "prefix": "/api/v1/deals", "owner": "rust" },
    { "prefix": "/api/v1/tasks", "owner": "rust" },
    { "prefix": "/api/v1/deals", "owner": "node" }
  ]
}"#;
    let (line, msg) = bad(text);
    assert_eq!(line, 5, "{msg}");
    assert!(msg.contains("/api/v1/deals") && msg.contains("một chủ"), "{msg}");
    // Cùng tiền tố, trùng một phương thức.
    let (line, msg) = bad(
        "{\"routes\": [\n{\"prefix\": \"/a\", \"methods\": [\"GET\", \"POST\"], \"owner\": \"rust\"},\n{\"prefix\": \"/a\", \"methods\": [\"POST\"], \"owner\": \"node\"}\n]}",
    );
    assert_eq!(line, 3);
    assert!(msg.contains("POST"), "{msg}");
    // Chủ lạ, phương thức lạ, tiền tố sai, trường lạ, job trùng.
    for (text, want_line, needle) in [
        (
            "{\"routes\": [\n{\"prefix\": \"/a\", \"owner\": \"go\"}]}",
            2,
            "unknown variant",
        ),
        (
            "{\"routes\": [\n{\"prefix\": \"/a\", \"methods\": [\"get\"], \"owner\": \"rust\"}]}",
            2,
            "phương thức \"get\"",
        ),
        (
            "{\"routes\": [\n\n{\"prefix\": \"api/v1/a\", \"owner\": \"rust\"}]}",
            3,
            "phải bắt đầu bằng /",
        ),
        (
            "{\"routes\": [{\"prefix\": \"/a/\", \"owner\": \"rust\"}]}",
            1,
            "/ cuối",
        ),
        (
            "{\"routes\": [{\"prefix\": \"/a/../b\", \"owner\": \"rust\"}]}",
            1,
            "không hợp lệ",
        ),
        (
            "{\"routes\": [{\"prefix\": \"/a\", \"methods\": [], \"owner\": \"rust\"}]}",
            1,
            "methods rỗng",
        ),
        ("{\n\"route\": []}", 2, "unknown field"),
        ("{\"jobs\": {\n\"a\": \"rust\",\n\"a\": \"node\"}}", 3, "ghi hai lần"),
        ("{\"jobs\": {\n\" a\": \"rust\"}}", 2, "khoảng trắng"),
        (
            "{\"routes\": [\n{\"prefix\": \"/a\", \"methods\": null, \"owner\": \"rust\"}]}",
            2,
            "invalid type: null",
        ),
        (
            "{\"routes\": [\n{\"prefix\": \"/a\", \"methods\": [\"GET\", \"HEAD\"], \"owner\": \"rust\"}]}",
            2,
            "GET đã gồm HEAD",
        ),
        (
            "{\"routes\": [{\"prefix\": \"/a\", \"methods\": [\"GET\"], \"owner\": \"rust\"},\n{\"prefix\": \"/a\", \"methods\": [\"HEAD\"], \"owner\": \"node\"}]}",
            2,
            "HEAD",
        ),
    ] {
        let (line, msg) = bad(text);
        assert_eq!(line, want_line, "{text}: {msg}");
        assert!(msg.contains(needle), "{text}: {msg}");
    }
}

#[test]
fn doc_tep_va_bao_duong_dan() {
    let p = format!("{}/tests/fixtures/ownership-sample.json", manifest_dir());
    assert_eq!(Ownership::load(Path::new(&p)).unwrap(), sample());
    let e = Ownership::load(Path::new("/khong/co/tep.json")).unwrap_err();
    assert!(e.to_string().contains("/khong/co/tep.json"), "{e}");
    let e = Ownership::parse("{\"migrate\": 1}", "own.json").unwrap_err();
    assert!(
        e.to_string().starts_with("tệp sở hữu own.json hỏng ở dòng 1, cột"),
        "{e}"
    );
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
