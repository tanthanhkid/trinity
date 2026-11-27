//! Ngành → phân hệ gợi ý + mẫu bảng (`packages/rbac/src/industry-presets.ts`): nguồn duy nhất cho wizard và việc kiểm đầu vào
//! của "Dựng hệ thống".

use trinity_rbac::plan::{ORG_FEATURES, is_org_feature_key};

use crate::catalog::{Industry, catalog};

pub fn industry_keys() -> Vec<&'static str> {
    catalog().industries.iter().map(|i| i.key.as_str()).collect()
}

pub fn find(key: &str) -> Option<&'static Industry> {
    catalog().industries.iter().find(|i| i.key == key)
}

/// Bộ cơ bản của wizard: luôn bật, không tắt được.
pub fn is_locked(feature: &str) -> bool {
    catalog().locked_features.iter().any(|f| f == feature)
}

/// `resolveBuildFeatures`: danh sách người dùng chọn (khoá lạ bị bỏ) + bộ cơ bản; `chosen` vắng = bộ gợi ý của ngành. Trả theo
/// thứ tự `ORG_FEATURE_KEYS`.
pub fn resolve_build_features(industry: &Industry, chosen: Option<&[String]>) -> Vec<&'static str> {
    let picked: Vec<&str> = match chosen {
        Some(c) => c.iter().map(String::as_str).filter(|k| is_org_feature_key(k)).collect(),
        None => industry.features.iter().map(String::as_str).collect(),
    };
    ORG_FEATURES
        .iter()
        .map(|(k, _, _)| *k)
        .filter(|k| is_locked(k) || picked.contains(k))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phan_he_theo_nganh() {
        let c = catalog();
        assert_eq!(
            industry_keys(),
            ["education_center", "retail_service", "clinic", "real_estate", "other"]
        );
        assert_eq!(c.max_build_features, ORG_FEATURES.len());
        let other = find("other").unwrap();
        // Vắng ⇒ bộ gợi ý của ngành.
        let mut got = resolve_build_features(other, None);
        got.sort_unstable();
        assert_eq!(
            got,
            ["contacts", "dashboard", "inbox", "integrations", "kanban", "reports"]
        );
        // Khoá lạ bỏ, bộ cơ bản luôn có, trả theo thứ tự cố định.
        let got = resolve_build_features(other, Some(&["pos".to_owned(), "khong-co".to_owned()]));
        assert!(
            ["dashboard", "contacts", "kanban", "reports", "pos"]
                .iter()
                .all(|k| got.contains(k))
        );
        assert!(!got.contains(&"inbox") && !got.contains(&"khong-co"));
        let idx = |k: &str| ORG_FEATURES.iter().position(|(f, _, _)| *f == k).unwrap();
        assert!(got.windows(2).all(|w| idx(w[0]) < idx(w[1])));
    }
}
