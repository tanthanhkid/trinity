//! Kiểm đăng nhập theo IP văn phòng (Wi-Fi). Luật FAIL-OPEN như bản TS (`login-wifi-check*.helper.ts`): mọi nhánh không
//! xác định được dữ liệu đều cho qua; chỉ chặn khi có đủ cả IP khách tin được lẫn IP văn phòng và không khớp văn phòng nào.

use std::collections::HashSet;

pub fn normalize_login_ip(raw: &str) -> String {
    let t = raw.trim();
    match t.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("::ffff:") => t[7..].to_owned(),
        _ => t.to_owned(),
    }
}

/// IP loopback/không xác định không phải "IP văn phòng sai" mà là dấu hiệu không lấy được IP thật.
pub fn is_unusable_login_ip(ip: Option<&str>) -> bool {
    let Some(ip) = ip else { return true };
    let n = normalize_login_ip(ip).to_lowercase();
    n.is_empty() || n == "::1" || n == "0.0.0.0" || n == "unknown" || n.starts_with("127.")
}

pub fn login_ip_matches_office(client_ip: &str, office_ips: &[String]) -> bool {
    let c = normalize_login_ip(client_ip);
    office_ips.iter().any(|o| normalize_login_ip(o) == c)
}

/// `LOGIN_WIFI_CHECK_BYPASS_EMAILS`: CSV email hoặc id người dùng, không phân biệt hoa/thường.
pub fn bypass_listed(csv: &str, user_id: i32, email: &str) -> bool {
    let list: Vec<String> = csv
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    list.contains(&email.to_lowercase()) || list.contains(&user_id.to_string())
}

#[derive(Debug, Default)]
pub struct TargetSets {
    pub users: HashSet<i32>,
    pub team_leads: HashSet<i32>,
    pub departments: HashSet<i32>,
}

pub fn group_targets(rows: &[(String, i32)]) -> TargetSets {
    let mut s = TargetSets::default();
    for (scope, id) in rows {
        match scope.as_str() {
            "user" => s.users.insert(*id),
            "team" => s.team_leads.insert(*id),
            "department" => s.departments.insert(*id),
            _ => false,
        };
    }
    s
}

/// Người dùng thuộc danh sách áp dụng: chính họ, hoặc quản lý trực tiếp là trưởng nhóm/trưởng phòng được chọn, hoặc quản
/// lý của quản lý là trưởng phòng được chọn.
pub fn is_targeted(user: i32, manager: Option<i32>, grand_manager: Option<i32>, s: &TargetSets) -> bool {
    if s.users.contains(&user) || s.team_leads.contains(&user) || s.departments.contains(&user) {
        return true;
    }
    if let Some(m) = manager
        && (s.team_leads.contains(&m) || s.departments.contains(&m))
    {
        return true;
    }
    grand_manager.is_some_and(|g| s.departments.contains(&g))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_chuan_hoa_va_khong_dung_duoc() {
        assert_eq!(normalize_login_ip(" ::FFFF:1.2.3.4 "), "1.2.3.4");
        assert!(is_unusable_login_ip(None));
        for ip in ["", "::1", "0.0.0.0", "UNKNOWN", "127.0.0.9", "::ffff:127.0.0.1"] {
            assert!(is_unusable_login_ip(Some(ip)), "{ip}");
        }
        assert!(!is_unusable_login_ip(Some("203.0.113.5")));
        assert!(login_ip_matches_office(
            "::ffff:203.0.113.5",
            &["203.0.113.5".to_owned()]
        ));
        assert!(!login_ip_matches_office("203.0.113.6", &["203.0.113.5".to_owned()]));
    }

    #[test]
    fn bypass_theo_email_hoac_id() {
        assert!(bypass_listed("A@x.com, 12", 5, "a@X.com"));
        assert!(bypass_listed("A@x.com, 12", 12, "z@x.com"));
        assert!(!bypass_listed("", 0, "a@x.com"));
        assert!(
            !bypass_listed(" , ", 0, "a@x.com"),
            "dấu phẩy rỗng không thành bypass toàn bộ"
        );
    }

    #[test]
    fn danh_sach_ap_dung() {
        let rows = vec![
            ("user".to_owned(), 1),
            ("team".to_owned(), 2),
            ("department".to_owned(), 3),
            ("lạ".to_owned(), 9),
        ];
        let s = group_targets(&rows);
        assert!(is_targeted(1, None, None, &s));
        assert!(is_targeted(2, None, None, &s));
        assert!(is_targeted(3, None, None, &s));
        assert!(is_targeted(10, Some(2), None, &s));
        assert!(is_targeted(10, Some(3), None, &s));
        assert!(is_targeted(10, Some(1), Some(3), &s));
        assert!(
            !is_targeted(10, Some(1), Some(2), &s),
            "trưởng nhóm ở cấp ông không tính"
        );
        assert!(!is_targeted(9, None, None, &s));
        assert!(!is_targeted(10, None, None, &TargetSets::default()));
    }
}
