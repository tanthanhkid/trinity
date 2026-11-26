//! Tính năng của tổ chức, gói dịch vụ, cổng tính năng (`@RequireOrgFeature`) và hạn mức người dùng (`maxUsers`) —
//! bản Rust của `packages/rbac/src/org-features.ts`, `services/crm/src/usage/org-feature.guard.ts` và
//! `packages/rbac-nest/src/plan-limits.ts` (K25). Hàm thuần: đọc `settings` (`org_features`, `org_plan`) và đếm
//! người nằm ở tầng gọi. Bảng khoá, nhãn, gói nhúng ở đây được kiểm với bản TS bằng bảng ca dùng chung
//! `server/contracts/cases/plan.json` (test `tests/plan_cases.rs`), nên lệch nhãn hay hạn mức là test đỏ.

use std::collections::BTreeMap;

use serde_json::Value;

/// `(khoá, nhãn, nhóm)` theo thứ tự của `ORG_FEATURES`.
pub const ORG_FEATURES: [(&str, &str, &str); 19] = [
    ("dashboard", "Tổng quan", "core"),
    ("contacts", "Khách hàng", "core"),
    ("kanban", "Công việc", "core"),
    ("reports", "Báo cáo", "core"),
    ("inbox", "Hộp thư", "channels"),
    ("facebook_page", "Fanpage Facebook", "channels"),
    ("zalo_oa", "Zalo OA", "channels"),
    ("social_posting", "Đăng đa kênh", "channels"),
    ("products", "Sản phẩm", "sales"),
    ("pos", "Bán hàng (POS)", "sales"),
    ("online_store", "Trang bán hàng", "sales"),
    ("management", "Quản lý nhân sự", "people"),
    ("attendance", "Chấm công", "people"),
    ("payroll", "Lương", "people"),
    ("newsfeed", "Bảng tin", "people"),
    ("integrations", "Kết nối & AI", "advanced"),
    ("ai_briefing", "Bản tin sáng/chiều", "advanced"),
    ("lead_scoring", "Chấm điểm khách tiềm năng", "advanced"),
    ("stale_reminders", "Nhắc việc treo", "advanced"),
];

/// Khoá mới cần bật tay: khoá vắng = TẮT (`DEFAULT_OFF_FEATURES`).
pub const DEFAULT_OFF_FEATURES: [&str; 1] = ["online_store"];

/// Cờ do gói quyết định (`PLAN_GATED_FEATURES`).
pub const PLAN_GATED_FEATURES: [&str; 5] = [
    "ai_briefing",
    "zalo_oa",
    "lead_scoring",
    "stale_reminders",
    "facebook_page",
];

/// Khoá công tắc của tính năng đã gỡ: nhận rồi bỏ qua.
pub const RETIRED_ORG_FEATURE_KEYS: [&str; 3] = ["google_sheets", "commerce_connectors", "payments"];

pub fn is_org_feature_key(k: &str) -> bool {
    ORG_FEATURES.iter().any(|(key, _, _)| *key == k)
}

pub fn feature_label(k: &str) -> Option<&'static str> {
    ORG_FEATURES.iter().find(|(key, _, _)| *key == k).map(|(_, l, _)| *l)
}

/// Đủ khoá, mỗi khoá một boolean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgFeatures(BTreeMap<&'static str, bool>);

impl OrgFeatures {
    pub fn get(&self, key: &str) -> Option<bool> {
        self.0.get(key).copied()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'static str, bool)> + '_ {
        ORG_FEATURES.iter().map(|(k, _, _)| (*k, self.0[k]))
    }

    /// `{khoá: bool}` theo thứ tự `ORG_FEATURES`.
    pub fn to_json(&self) -> Value {
        Value::Object(self.iter().map(|(k, v)| (k.to_owned(), Value::Bool(v))).collect())
    }
}

/// `BLANK_SYSTEM_FEATURES`: hệ thống chưa dựng quy trình, chỉ giữ `integrations`.
pub fn blank_system_features() -> OrgFeatures {
    OrgFeatures(
        ORG_FEATURES
            .iter()
            .map(|(k, _, _)| (*k, *k == "integrations"))
            .collect(),
    )
}

/// `resolveOrgFeatures`: cấu hình thô (JSON đã lưu, có thể thiếu khoá/rác) → đủ khoá. Khoá thiếu hoặc không phải
/// boolean lấy theo `defaults`, rồi theo [`DEFAULT_OFF_FEATURES`] (không có = BẬT, fail-open).
pub fn resolve_org_features(raw: &Value, defaults: Option<&OrgFeatures>) -> OrgFeatures {
    OrgFeatures(
        ORG_FEATURES
            .iter()
            .map(|(k, _, _)| {
                let v = match raw.get(*k) {
                    Some(Value::Bool(b)) => *b,
                    _ => defaults
                        .and_then(|d| d.get(k))
                        .unwrap_or(!DEFAULT_OFF_FEATURES.contains(k)),
                };
                (*k, v)
            })
            .collect(),
    )
}

/// Hạn mức kênh gửi ra ngoài theo công ty (`ChannelLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelLimits {
    pub bulk_messages_per_day: u32,
    pub recipients_per_campaign: u32,
    pub posts_per_day: u32,
    pub auto_comment_replies_per_hour: u32,
}

/// Khoá gói bán.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlanKey {
    MacDinh,
    KetNoi,
    TroLyGiamDoc,
    TroLyKinhDoanh,
    TroLyVanHanh,
    Custom,
}

pub const PLAN_KEYS: [PlanKey; 6] = [
    PlanKey::MacDinh,
    PlanKey::KetNoi,
    PlanKey::TroLyGiamDoc,
    PlanKey::TroLyKinhDoanh,
    PlanKey::TroLyVanHanh,
    PlanKey::Custom,
];

/// Một gói (`PlanDefinition`).
#[derive(Debug, Clone, Copy)]
pub struct PlanDef {
    pub label: &'static str,
    pub features: &'static [&'static str],
    /// `None` = không giới hạn.
    pub max_users: Option<u32>,
    pub channel_limits: ChannelLimits,
}

const fn limits(a: u32, b: u32, c: u32, d: u32) -> ChannelLimits {
    ChannelLimits {
        bulk_messages_per_day: a,
        recipients_per_campaign: b,
        posts_per_day: c,
        auto_comment_replies_per_hour: d,
    }
}

impl PlanKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MacDinh => "mac_dinh",
            Self::KetNoi => "ket_noi",
            Self::TroLyGiamDoc => "tro_ly_giam_doc",
            Self::TroLyKinhDoanh => "tro_ly_kinh_doanh",
            Self::TroLyVanHanh => "tro_ly_van_hanh",
            Self::Custom => "custom",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        PLAN_KEYS.into_iter().find(|p| p.as_str() == s)
    }

    pub fn def(self) -> PlanDef {
        match self {
            Self::MacDinh => PlanDef {
                label: "Mặc định",
                features: &PLAN_GATED_FEATURES,
                max_users: Some(10),
                channel_limits: limits(200, 200, 10, 60),
            },
            Self::KetNoi => PlanDef {
                label: "Kết nối",
                features: &[],
                max_users: Some(10),
                channel_limits: limits(200, 200, 10, 60),
            },
            Self::TroLyGiamDoc => PlanDef {
                label: "Trợ lý Giám đốc",
                features: &["ai_briefing"],
                max_users: Some(10),
                channel_limits: limits(300, 300, 15, 60),
            },
            Self::TroLyKinhDoanh => PlanDef {
                label: "Trợ lý Kinh doanh",
                features: &[
                    "ai_briefing",
                    "zalo_oa",
                    "lead_scoring",
                    "stale_reminders",
                    "facebook_page",
                ],
                max_users: Some(30),
                channel_limits: limits(1000, 1000, 40, 200),
            },
            Self::TroLyVanHanh => PlanDef {
                label: "Trợ lý Vận hành",
                features: &[
                    "ai_briefing",
                    "zalo_oa",
                    "lead_scoring",
                    "stale_reminders",
                    "facebook_page",
                ],
                max_users: Some(60),
                channel_limits: limits(3000, 2000, 100, 500),
            },
            Self::Custom => PlanDef {
                label: "Tuỳ biến",
                features: &PLAN_GATED_FEATURES,
                max_users: None,
                channel_limits: limits(5000, 2000, 200, 1000),
            },
        }
    }
}

/// Gói của bản cài một công ty và của công ty 1 (không ràng buộc).
pub const DEFAULT_PLAN: PlanKey = PlanKey::Custom;
/// Gói của công ty mới đăng ký (chế độ nhiều công ty).
pub const DEFAULT_SIGNUP_PLAN: PlanKey = PlanKey::MacDinh;

/// `resolvePlanForCompany`: `company_id` = số công ty ở chế độ nhiều công ty, `None` = bản cài một công ty. Dòng gói
/// hợp lệ thì theo dòng đó; thiếu/rác: công ty >= 2 ⇒ gói đăng ký mặc định, còn lại `custom`. Giá trị thô được cắt
/// khoảng trắng như `planFromSetting`.
pub fn resolve_plan_for_company(raw: Option<&str>, company_id: Option<i32>) -> PlanKey {
    if let Some(p) = raw.map(js_trim).and_then(PlanKey::parse) {
        return p;
    }
    match company_id {
        Some(c) if c != 1 => DEFAULT_SIGNUP_PLAN,
        _ => DEFAULT_PLAN,
    }
}

/// `String.prototype.trim` đủ cho khoá gói (khoảng trắng ASCII và Unicode thường gặp).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `applyPlanToFeatures`: cờ hiệu lực = (gói có cờ đó) VÀ (không bị admin tắt tay). Gói chỉ hạ cờ theo gói.
pub fn apply_plan_to_features(features: &OrgFeatures, plan: PlanKey) -> OrgFeatures {
    let allowed = plan.def().features;
    let mut out = features.clone();
    for k in PLAN_GATED_FEATURES {
        if !allowed.contains(&k) {
            out.0.insert(k, false);
        }
    }
    out
}

/// 403 của cổng tính năng.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Tính năng \"{label}\" chưa bật hoặc không có trong gói hiện tại.")]
pub struct FeatureDisabled {
    pub key: &'static str,
    pub label: &'static str,
}

/// `@RequireOrgFeature(key)`: `features` đã tính gói ([`apply_plan_to_features`]). Tắt ⇒ [`FeatureDisabled`] (HTTP 403,
/// câu tiếng Việt). Khoá không có trong danh mục thì cho qua (guard TS chỉ chặn khi `=== false`).
pub fn require_org_feature(features: &OrgFeatures, key: &str) -> Result<(), FeatureDisabled> {
    match (features.get(key), ORG_FEATURES.iter().find(|(k, _, _)| *k == key)) {
        (Some(false), Some((k, label, _))) => Err(FeatureDisabled { key: k, label }),
        _ => Ok(()),
    }
}

/// Câu báo khi hết chỗ (`userLimitMessage`); dùng chung cho tạo người dùng, mở khoá, tạo/nhận lời mời.
pub fn user_limit_message(max: u32) -> String {
    format!("Gói hiện tại tối đa {max} người, liên hệ để nâng gói.")
}

/// 409 khi đạt `maxUsers`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", user_limit_message(*max))]
pub struct UserLimitReached {
    pub max: u32,
}

/// `assertUserSlotAvailable` phần quyết định: còn chỗ khi `đang hoạt động + lời mời đang chờ < maxUsers`
/// (gói không giới hạn luôn còn chỗ). Tầng gọi phải đếm trong cùng giao dịch, sau khi lấy khoá advisory
/// ([`USER_SLOT_LOCK`]), và trước khi ghi người mới.
pub fn check_user_slot(plan: PlanKey, active: u32, pending: u32) -> Result<(), UserLimitReached> {
    match plan.def().max_users {
        Some(max) if u64::from(active) + u64::from(pending) >= u64::from(max) => Err(UserLimitReached { max }),
        _ => Ok(()),
    }
}

/// Khoá advisory tuần tự hoá "đếm chỗ rồi thêm người" (cùng số với `USER_SLOT_LOCK` của bản TS; khoá đôi với id công ty).
pub const USER_SLOT_LOCK: i32 = 726_354_004;
