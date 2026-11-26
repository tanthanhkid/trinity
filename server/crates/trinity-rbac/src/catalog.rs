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
    // Tệp nhúng hỏng là lỗi dựng: panic (test `catalog_nap_duoc` bắt ở bước kiểm cục bộ), không rơi về catalog rỗng
    // (rỗng = mọi quyền bị từ chối hoặc, tệ hơn, admin không có quyền nào được liệt kê).
    #[allow(clippy::expect_used)]
    let raw: Raw = serde_json::from_str(include_str!("../../../contracts/rbac.json")).expect("rbac.json nhúng hỏng");
    assert!(!raw.permissions.is_empty(), "rbac.json nhúng không có quyền nào");
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
