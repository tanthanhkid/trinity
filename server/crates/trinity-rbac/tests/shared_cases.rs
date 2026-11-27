//! Bảng ca dùng chung TS ↔ Rust (K12): `server/contracts/cases/rbac.json`, cột kết quả do `packages/rbac/src/grants-cases.spec.ts`
//! sinh từ `grants.ts`. Test này chạy cùng đầu vào qua hàm Rust và so từng ca.

use serde_json::{Value, json};
use trinity_rbac::grants::{grants_from_json, grants_to_json};
use trinity_rbac::{Grant, Scope, admin_grants, can, catalog, is_subset, merge_grants, normalize_grant, scope_of};

fn table() -> Value {
    let path = format!("{}/../../contracts/cases/rbac.json", manifest_dir());
    serde_json::from_str(&std::fs::read_to_string(path).expect("đọc rbac.json")).expect("rbac.json hợp lệ")
}

fn check(t: &Value, key: &str, f: impl Fn(&Value) -> Value) -> usize {
    let rows = t[key].as_array().unwrap_or_else(|| panic!("thiếu nhóm {key}"));
    let bad: Vec<String> = rows
        .iter()
        .filter(|r| f(r) != r["out"])
        .map(|r| format!("{r} → Rust {}", f(r)))
        .collect();
    assert!(bad.is_empty(), "{key}: {} ca lệch\n{}", bad.len(), bad.join("\n"));
    rows.len()
}

fn min_of(v: &Value) -> Option<Scope> {
    v.as_str().and_then(Scope::parse)
}

#[test]
fn bang_ca_khop_ban_ts() {
    let t = table();
    let mut n = 0;
    n += check(&t, "normalize", |r| {
        normalize_grant(r["perm"].as_str().unwrap(), r["raw"].as_str()).map_or(Value::Null, Grant::to_json)
    });
    n += check(&t, "merge", |r| {
        let list: Vec<_> = r["in"].as_array().unwrap().iter().map(grants_from_json).collect();
        grants_to_json(&merge_grants(&list))
    });
    n += check(&t, "can", |r| {
        json!(can(
            &grants_from_json(&r["grants"]),
            r["perm"].as_str().unwrap(),
            min_of(&r["min"])
        ))
    });
    n += check(&t, "scope_of", |r| {
        scope_of(&grants_from_json(&r["grants"]), r["perm"].as_str().unwrap())
            .map_or(Value::Null, |s| json!(s.as_str()))
    });
    n += check(&t, "is_subset", |r| {
        json!(is_subset(
            &grants_from_json(&r["child"]),
            &grants_from_json(&r["parent"])
        ))
    });
    n += check(&t, "admin", |_| {
        let a = admin_grants();
        json!({
            "permissions": a.len(),
            "scoped": a.values().filter(|g| **g == Grant::Scope(Scope::All)).count(),
        })
    });
    assert!(n >= 300, "{n} ca");
}

#[test]
fn catalog_nap_duoc() {
    let c = catalog();
    assert_eq!(c.permissions().len(), 61);
    assert_eq!(c.scope_order, ["own", "team", "subtree", "all"]);
    assert!(c.retired.iter().all(|r| !c.is_permission(r)));
    assert!(c.get("contacts.view").is_some_and(|p| p.scoped) && c.get("contacts.create").is_some_and(|p| !p.scoped));
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
