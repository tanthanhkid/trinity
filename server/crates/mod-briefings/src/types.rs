//! Kiểu dữ liệu bản tin (`briefing.types.ts`). JSON của [`BriefingData`] dùng khoá camelCase như bản Node (ghi vào cột `data`).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Morning,
    Evening,
}

impl Slot {
    pub fn as_str(self) -> &'static str {
        match self {
            Slot::Morning => "morning",
            Slot::Evening => "evening",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "morning" => Some(Slot::Morning),
            "evening" => Some(Slot::Evening),
            _ => None,
        }
    }
}

/// Số hiện tại và số cùng kỳ hôm trước.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Delta {
    pub value: i64,
    pub prev: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TopSeller {
    pub user_id: i32,
    pub name: String,
    pub won_count: i64,
    pub won_value: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub new_contacts: Delta,
    pub stage_changes: Delta,
    pub deals_created: Delta,
    pub deals_won: Delta,
    /// Doanh số = tổng giá trị deal chuyển sang `won` trong kỳ (VND).
    pub won_value: Delta,
    pub deals_lost: Delta,
    pub overdue_tasks: i64,
    pub callbacks: i64,
    pub top_sellers: Vec<TopSeller>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Company,
    Team,
    #[serde(rename = "self")]
    Own,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingData {
    pub slot: Slot,
    /// Ngày VN `YYYY-MM-DD` của lần gửi.
    pub day: String,
    pub period_label: String,
    pub reminder_label: String,
    pub scope: ScopeKind,
    pub people_count: i64,
    pub metrics: Metrics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Config {
    pub enabled: bool,
    pub morning_enabled: bool,
    pub evening_enabled: bool,
    /// `HH:mm` giờ VN.
    pub morning_time: String,
    pub evening_time: String,
    pub in_app: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            morning_enabled: true,
            evening_enabled: true,
            morning_time: "08:00".to_owned(),
            evening_time: "17:30".to_owned(),
            in_app: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Content {
    pub title: String,
    /// Văn bản thuần nhiều dòng.
    pub text: String,
}

/// Phạm vi dữ liệu của một người (kết quả `ScopeService.ownerIds(user, 'reports.overview')`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owners {
    /// Cả công ty.
    All,
    /// Nhóm hoặc chính mình; rỗng = không ai (không tự nới).
    Users(Vec<i32>),
}
