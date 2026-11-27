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

/// Công tắc tính năng của tổ chức (`org_features` trong `rbac.json`).
#[derive(Debug, Clone, Deserialize)]
pub struct OrgFeatureDef {
    pub key: String,
    pub label: String,
}

/// Gói (`plans` trong `rbac.json`): chỉ phần Rust cần tới. `max_users = None` ⇒ không giới hạn.
#[derive(Debug, Clone, Deserialize)]
pub struct PlanDef {
    #[serde(rename = "maxUsers")]
    pub max_users: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct Raw {
    plans: HashMap<String, PlanDef>,
    default_plan: String,
    default_signup_plan: String,
    org_features: Vec<OrgFeatureDef>,
    scope_order: Vec<String>,
    permission_groups: Vec<String>,
    retired_permissions: Vec<String>,
    permissions: Vec<PermissionDef>,
}

#[derive(Debug)]
pub struct Catalog {
    permissions: Vec<PermissionDef>,
    org_features: Vec<OrgFeatureDef>,
    index: HashMap<String, usize>,
    pub scope_order: Vec<String>,
    pub permission_groups: Vec<String>,
    pub retired: Vec<String>,
    plans: HashMap<String, PlanDef>,
    default_plan: String,
    default_signup_plan: String,
}

impl Catalog {
    pub fn permissions(&self) -> &[PermissionDef] {
        &self.permissions
    }

    pub fn org_feature(&self, key: &str) -> Option<&OrgFeatureDef> {
        self.org_features.iter().find(|f| f.key == key)
    }

    pub fn get(&self, key: &str) -> Option<&PermissionDef> {
        self.index.get(key).map(|i| &self.permissions[*i])
    }

    pub fn is_permission(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    pub fn plan(&self, key: &str) -> Option<&PlanDef> {
        self.plans.get(key)
    }

    /// `resolvePlanForCompany`: dòng gói hợp lệ thì theo dòng đó; thiếu hoặc rác: công ty ≥ 2 của chế độ đa công ty = gói đăng
    /// ký mặc định (có giới hạn), còn lại (công ty 1, một công ty) = gói mặc định (`custom`, không giới hạn).
    /// `company = None` là bản một công ty.
    pub fn resolve_plan_for_company(&self, raw: Option<&str>, company: Option<i32>) -> &str {
        if let Some(k) = raw.filter(|k| self.plans.contains_key(*k)) {
            // Trả về khoá nằm trong catalog (không phải `raw`) để thời gian sống gắn với `self`.
            if let Some((key, _)) = self.plans.get_key_value(k) {
                return key;
            }
        }
        if company.is_some_and(|c| c != 1) {
            &self.default_signup_plan
        } else {
            &self.default_plan
        }
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
        org_features: raw.org_features,
        index,
        scope_order: raw.scope_order,
        permission_groups: raw.permission_groups,
        retired: raw.retired_permissions,
        plans: raw.plans,
        default_plan: raw.default_plan,
        default_signup_plan: raw.default_signup_plan,
    }
});

pub fn catalog() -> &'static Catalog {
    &CATALOG
}
