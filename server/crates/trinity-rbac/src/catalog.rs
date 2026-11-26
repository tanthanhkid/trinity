//! Catalog quyền từ `server/contracts/rbac.json`, nhúng lúc biên dịch (web tiếp tục import gói TS `@trinity/rbac`; CI
//! kiểm JSON khớp gói TS ở C04).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct PermissionDef {
    pub key: String,
    pub group: String,
    pub label: String,
    /// Quyền có phạm vi own/team/subtree/all; không thì chỉ có/không.
    pub scoped: bool,
    #[serde(default)]
    pub sensitive: bool,
}

#[derive(Debug, Deserialize)]
struct Raw {
    scope_order: Vec<String>,
    retired_permissions: Vec<String>,
    permissions: Vec<PermissionDef>,
}

#[derive(Debug)]
pub struct Catalog {
    permissions: Vec<PermissionDef>,
    index: HashMap<String, usize>,
    pub scope_order: Vec<String>,
    pub retired: Vec<String>,
}

impl Catalog {
    pub fn permissions(&self) -> &[PermissionDef] {
        &self.permissions
    }

    pub fn get(&self, key: &str) -> Option<&PermissionDef> {
        self.index.get(key).map(|i| &self.permissions[*i])
    }

    pub fn is_permission(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    // Tệp nhúng sai là lỗi dựng, không phải lỗi chạy: test `catalog_nap_duoc` bắt ở CI cục bộ.
    let raw: Raw = serde_json::from_str(include_str!("../../../contracts/rbac.json")).unwrap_or_else(|e| {
        tracing::error!("rbac.json nhúng hỏng: {e}");
        Raw {
            scope_order: vec![],
            retired_permissions: vec![],
            permissions: vec![],
        }
    });
    let index = raw
        .permissions
        .iter()
        .enumerate()
        .map(|(i, p)| (p.key.clone(), i))
        .collect();
    Catalog {
        permissions: raw.permissions,
        index,
        scope_order: raw.scope_order,
        retired: raw.retired_permissions,
    }
});

pub fn catalog() -> &'static Catalog {
    &CATALOG
}
