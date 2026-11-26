//! Gộp quyền và `can`, bản Rust của `packages/rbac/src/grants.ts`. Bảng ca dùng chung:
//! `server/contracts/cases/rbac.json` (tests/shared_cases.rs).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::catalog::catalog;

/// Phạm vi, từ hẹp tới rộng (thứ tự của `SCOPE_ORDER`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Scope {
    Own,
    Team,
    Subtree,
    All,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        Some(match s {
            "own" => Scope::Own,
            "team" => Scope::Team,
            "subtree" => Scope::Subtree,
            "all" => Scope::All,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Own => "own",
            Scope::Team => "team",
            Scope::Subtree => "subtree",
            Scope::All => "all",
        }
    }
}

/// `Scope | true` của bản TS: quyền không có phạm vi mang `Full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grant {
    Full,
    Scope(Scope),
}

impl Grant {
    /// `true` hoặc tên phạm vi (dạng JSON của bảng ca).
    pub fn from_json(v: &Value) -> Option<Grant> {
        match v {
            Value::Bool(true) => Some(Grant::Full),
            Value::String(s) => Scope::parse(s).map(Grant::Scope),
            _ => None,
        }
    }

    pub fn to_json(self) -> Value {
        match self {
            Grant::Full => Value::Bool(true),
            Grant::Scope(s) => Value::String(s.as_str().to_owned()),
        }
    }
}

/// Quyền đã gộp của một người dùng: khoá quyền → mức.
pub type Grants = BTreeMap<String, Grant>;

pub fn grants_from_json(v: &Value) -> Grants {
    v.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| Grant::from_json(v).map(|g| (k.clone(), g)))
                .collect()
        })
        .unwrap_or_default()
}

pub fn grants_to_json(g: &Grants) -> Value {
    Value::Object(g.iter().map(|(k, v)| (k.clone(), v.to_json())).collect())
}

/// Chuẩn hoá một dòng `role_permissions`. Khoá lạ (hoặc đã gỡ) ⇒ `None`; quyền không scoped ⇒ `Full`; quyền scoped
/// thiếu hoặc sai phạm vi ⇒ `own` (hẹp nhất, fail-closed).
pub fn normalize_grant(permission: &str, raw: Option<&str>) -> Option<Grant> {
    let def = catalog().get(permission)?;
    if !def.scoped {
        return Some(Grant::Full);
    }
    Some(Grant::Scope(raw.and_then(Scope::parse).unwrap_or(Scope::Own)))
}

fn wider(a: Option<Grant>, b: Grant) -> Grant {
    match (a, b) {
        (None, b) => b,
        (Some(Grant::Full), _) | (_, Grant::Full) => Grant::Full,
        (Some(Grant::Scope(x)), Grant::Scope(y)) => Grant::Scope(x.max(y)),
    }
}

/// Hợp quyền của nhiều vai trò; trùng quyền lấy phạm vi rộng nhất.
pub fn merge_grants<'a>(list: impl IntoIterator<Item = &'a Grants>) -> Grants {
    let mut out = Grants::new();
    for g in list {
        for (p, v) in g {
            let w = wider(out.get(p).copied(), *v);
            out.insert(p.clone(), w);
        }
    }
    out
}

/// Phạm vi của một quyền scoped; không có quyền hoặc quyền `Full` ⇒ `None`.
pub fn scope_of(g: &Grants, permission: &str) -> Option<Scope> {
    match g.get(permission)? {
        Grant::Full => None,
        Grant::Scope(s) => Some(*s),
    }
}

/// Có quyền, và (nếu đòi `min`) phạm vi không hẹp hơn `min`.
pub fn can(g: &Grants, permission: &str, min: Option<Scope>) -> bool {
    match (g.get(permission), min) {
        (None, _) => false,
        (Some(_), None) | (Some(Grant::Full), _) => true,
        (Some(Grant::Scope(v)), Some(m)) => *v >= m,
    }
}

/// `child ⊆ parent`: mọi quyền của child parent đều có, phạm vi không rộng hơn.
pub fn is_subset(child: &Grants, parent: &Grants) -> bool {
    child.iter().all(|(p, v)| match (parent.get(p), v) {
        (None, _) => false,
        (Some(Grant::Scope(pv)), Grant::Scope(cv)) => cv <= pv,
        _ => true,
    })
}
