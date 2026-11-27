//! So bảng route Rust đã khai với `server/contracts/routes.json` (PLAN 6.1: Rust phải khớp mọi cột). Dùng lúc khởi động
//! (`trinity check-routes`, boot) và trong CI (`cargo xtask check-routes`).
//!
//! Cột được so cho mỗi route đã khai: có trong hợp đồng và không `deprecated`, `access`, `permissions` (như tập),
//! `permission_mode`, `status_ok`, `org_feature`, `guards`,
//! `param_pipes`. Hợp đồng cũng được kiểm chính nó ([`validate_contract`]): quyền phải có trong catalog, `org_feature`
//! phải là công tắc có thật. Route trong hợp đồng mà Rust chưa khai không phải lỗi (chuyển dần theo đợt) trừ khi đòi
//! `require_all` (cổng cuối X06).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use trinity_rbac::catalog;

use super::RouteSpec;
use crate::validate::{Mode, mode_for_path};

/// Route chỉ có ở Rust, không có trong `routes.json` (hợp đồng đóng băng từ bản TS). Phải công khai (`Access::Public`) và
/// khai trong bảng; thêm route vào đây là quyết định có chủ ý (cần issue nói rõ vì sao bản TS không có).
pub const RUST_ONLY_ROUTES: &[&str] = &["GET /api/v1/site-config", "POST /api/fe-logging"];

/// Route chỉ có ở Rust và cần đăng nhập + quyền (`access: can`): tải video theo phần của đăng bài (X15a, `mod-social`).
pub const RUST_ONLY_AUTHED_ROUTES: &[&str] = &[
    "POST /api/v1/social/media/uploads",
    "GET /api/v1/social/media/uploads/:id",
    "PUT /api/v1/social/media/uploads/:id/parts/:index",
    "POST /api/v1/social/media/uploads/:id/complete",
    "DELETE /api/v1/social/media/uploads/:id",
    // Trung tâm điều hành của trang Tổng quan (#606): phễu, nhiệt theo giờ, xếp hạng, tỉ lệ thắng; cần `reports.overview`.
    "GET /api/v1/reports/dashboard-command-center",
];

/// Route chỉ có ở Rust, chỉ cần đăng nhập (`access: auth`): `GET /bootstrap` gộp các lời gọi layout của web thành một lượt
/// (đợt cắt số round trip, 27/11). Không có tool MCP: chỉ là tối ưu truyền tải cho các endpoint đã có.
pub const RUST_ONLY_AUTH_ROUTES: &[&str] = &["GET /api/v1/bootstrap"];

/// Hợp đồng nhúng trong binary.
/// Route Node đã gỡ có chủ đích khỏi bản Rust nhưng còn trong `routes.json` (hợp đồng đóng băng). Không tính vào "chưa khai"
/// của `--require-all` và không tính vào tổng route phải khai; Rust mà khai lại thì là lỗi.
/// (Hiện không còn route nào: `POST /social/media/upload-token` đã khai lại ở mod-social, #612.)
pub const RUST_REMOVED_ROUTES: &[&str] = &[];

pub const CONTRACT: &str = include_str!("../../../../contracts/routes.json");

#[derive(Debug, Default)]
pub struct Report {
    /// Lỗi: mỗi dòng một chỗ lệch.
    pub problems: Vec<String>,
    pub declared: usize,
    pub contract_total: usize,
    /// Route trong hợp đồng (không `deprecated`) mà Rust chưa khai, dạng `GET /api/v1/x`.
    pub missing: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

fn key(method: &str, path: &str) -> String {
    format!("{method} {path}")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn rows(contract: &Value) -> Vec<&Value> {
    contract["routes"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// Kiểm riêng hợp đồng: quyền và tính năng có trong catalog, `validation` khớp bảng lenient/strict, không trùng route.
pub fn validate_contract(contract: &Value) -> Vec<String> {
    let c = catalog();
    let mut out = Vec::new();
    // Cùng (phương thức, đường dẫn) xuất hiện nhiều lần chỉ chấp nhận khi các dòng giống hệt (health/live/ready có một bản
    // ở mỗi service cũ, gộp lại thành một route ở Rust); khác nhau là hợp đồng mơ hồ.
    let mut seen: BTreeMap<String, &Value> = BTreeMap::new();
    for r in rows(contract) {
        let k = key(r["method"].as_str().unwrap_or("?"), r["path"].as_str().unwrap_or("?"));
        match seen.get(&k) {
            Some(first) if *first != r => out.push(format!("{k}: trùng trong routes.json với nội dung khác nhau")),
            Some(_) => {}
            None => {
                seen.insert(k.clone(), r);
            }
        }
        for p in strings(&r["permissions"]) {
            if !c.is_permission(&p) {
                out.push(format!("{k}: quyền {p} không có trong catalog"));
            }
        }
        if let Some(f) = r["org_feature"].as_str()
            && c.org_feature(f).is_none()
        {
            out.push(format!("{k}: org_feature {f} không có trong catalog"));
        }
        let want = if mode_for_path(r["path"].as_str().unwrap_or("")) == Mode::Lenient {
            "lenient"
        } else {
            "strict"
        };
        if r["validation"].as_str() != Some(want) {
            out.push(format!(
                "{k}: validation {} lệch bảng lenient/strict ({want})",
                r["validation"]
            ));
        }
        if !matches!(r["access"].as_str(), Some("can" | "auth" | "public" | "internal")) {
            out.push(format!("{k}: access {} lạ", r["access"]));
        }
    }
    out
}

/// So `table` với `contract`. `require_all`: mọi route không `deprecated` trong hợp đồng phải được khai.
pub fn check(table: &[RouteSpec], contract: &Value, require_all: bool) -> Report {
    let mut rep = Report::default();
    let all = rows(contract);
    rep.problems.extend(validate_contract(contract));
    let by_key: BTreeMap<String, &Value> = all
        .iter()
        .map(|r| {
            (
                key(r["method"].as_str().unwrap_or(""), r["path"].as_str().unwrap_or("")),
                *r,
            )
        })
        .collect();
    rep.contract_total = by_key
        .iter()
        .filter(|(k, r)| r["deprecated"].as_bool() != Some(true) && !RUST_REMOVED_ROUTES.contains(&k.as_str()))
        .count();

    let mut declared = BTreeSet::new();
    for spec in table {
        let k = key(spec.method.as_str(), spec.path);
        if !declared.insert(k.clone()) {
            rep.problems.push(format!("{k}: khai hai lần"));
            continue;
        }
        if RUST_REMOVED_ROUTES.contains(&k.as_str()) {
            rep.problems.push(format!(
                "{k}: route đã gỡ có chủ đích (RUST_REMOVED_ROUTES), Rust không được khai"
            ));
            continue;
        }
        let Some(row) = by_key.get(&k) else {
            if RUST_ONLY_ROUTES.contains(&k.as_str()) {
                if spec.access != super::Access::Public {
                    rep.problems.push(format!("{k}: route chỉ có ở Rust phải là Public"));
                }
            } else if RUST_ONLY_AUTH_ROUTES.contains(&k.as_str()) {
                if spec.access != super::Access::AuthOnly {
                    rep.problems.push(format!("{k}: route chỉ có ở Rust phải là AuthOnly"));
                }
            } else if RUST_ONLY_AUTHED_ROUTES.contains(&k.as_str()) {
                if spec.access.kind() != "can" {
                    rep.problems
                        .push(format!("{k}: route chỉ có ở Rust phải đòi quyền (can)"));
                }
            } else {
                rep.problems.push(format!("{k}: không có trong routes.json"));
            }
            continue;
        };
        // Route Rust đã khớp một dòng (không deprecated) của hợp đồng: đếm vào "đã khai", dù cột nào lệch thì vẫn là lỗi riêng.
        if row["deprecated"].as_bool() != Some(true) {
            rep.declared += 1;
        }
        let mut diff = |field: &str, rust: String, json: String| {
            if rust != json {
                rep.problems
                    .push(format!("{k}: {field} Rust {rust}, routes.json {json}"));
            }
        };
        if row["deprecated"].as_bool() == Some(true) {
            rep.problems
                .push(format!("{k}: routes.json ghi deprecated, Rust không được khai"));
            continue;
        }
        diff(
            "access",
            spec.access.kind().into(),
            row["access"].as_str().unwrap_or("").into(),
        );
        let sorted = |v: Vec<String>| {
            let mut v = v;
            v.sort();
            format!("{v:?}")
        };
        diff(
            "permissions",
            sorted(spec.access.permissions().iter().map(|s| (*s).to_owned()).collect()),
            sorted(strings(&row["permissions"])),
        );
        diff(
            "permission_mode",
            format!("{:?}", spec.access.mode()),
            format!("{:?}", row["permission_mode"].as_str()),
        );
        diff(
            "status_ok",
            format!("{:?}", spec.status_ok),
            format!("{:?}", row["status_ok"].as_u64().map(|n| n as u16)),
        );
        diff(
            "org_feature",
            format!("{:?}", spec.org_feature),
            format!("{:?}", row["org_feature"].as_str()),
        );
        diff(
            "guards",
            format!("{:?}", spec.guard_list()),
            format!("{:?}", strings(&row["guards"])),
        );
        diff(
            "param_pipes",
            format!("{:?}", spec.param_pipes),
            format!("{:?}", strings(&row["param_pipes"])),
        );
        if spec.org_feature.is_some() && matches!(spec.access, super::Access::Public | super::Access::Internal) {
            rep.problems.push(format!(
                "{k}: org_feature trên route {} chưa hỗ trợ",
                spec.access.kind()
            ));
        }
        for p in spec.access.permissions() {
            if !catalog().is_permission(p) {
                rep.problems.push(format!("{k}: quyền {p} không có trong catalog"));
            }
        }
        if let Some(f) = spec.org_feature
            && catalog().org_feature(f).is_none()
        {
            rep.problems
                .push(format!("{k}: org_feature {f} không có trong catalog"));
        }
    }
    rep.missing = by_key
        .iter()
        .filter(|(k, r)| {
            !declared.contains(*k)
                && r["deprecated"].as_bool() != Some(true)
                && !RUST_REMOVED_ROUTES.contains(&k.as_str())
        })
        .map(|(k, _)| k.clone())
        .collect();
    if require_all {
        let missing: Vec<String> = rep.missing.iter().map(|m| format!("{m}: chưa khai ở Rust")).collect();
        rep.problems.extend(missing);
    }
    rep
}

/// Kiểm với hợp đồng nhúng.
pub fn check_embedded(table: &[RouteSpec], require_all: bool) -> Report {
    match serde_json::from_str::<Value>(CONTRACT) {
        Ok(v) => check(table, &v, require_all),
        Err(e) => Report {
            problems: vec![format!("routes.json nhúng hỏng: {e}")],
            ..Report::default()
        },
    }
}
