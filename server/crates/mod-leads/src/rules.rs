//! Quy tắc chấm điểm lead (`lead-scoring.rules.ts`) — HÀM THUẦN, không đụng DB. Tổng tối đa 100 điểm: độ mới 25 + tương
//! tác 20 + giai đoạn 20 + phản hồi gần nhất 15 + nguồn 10 + hồ sơ (SĐT/nhu cầu) 10, cộng điểm "ý định mua" do agent AI của
//! khách chấm qua MCP rồi chặn trần 100. Cấu hình lưu ở `settings.lead_scoring_rules` (JSON một phần); thiếu/rác ⇒ mặc định.
//!
//! Khoá của `stage.points`/`source.points` ra JSON theo thứ tự chữ cái (bản TS theo thứ tự chèn); số nguyên ra không có `.0`.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Serialize, Serializer};
use serde_json::Value;
use trinity_kernel::vi::trim_js;

const DAY_MS: f64 = 86_400_000.0;
/// Trần của `interactions.window_days` (10 năm): số lớn hơn làm tràn phép trừ thời gian.
pub const MAX_WINDOW_DAYS: f64 = 3650.0;

/// Số JS: nguyên thì ra số nguyên, còn lại giữ số thực.
fn num_out<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

fn map_out<S: Serializer>(m: &BTreeMap<String, f64>, s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut map = s.serialize_map(Some(m.len()))?;
    for (k, v) in m {
        map.serialize_entry(k, &Num(*v))?;
    }
    map.end()
}

struct Num(f64);

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        num_out(&self.0, s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LeadLabel {
    Hot,
    Warm,
    Cold,
}

impl LeadLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hot => "hot",
            Self::Warm => "warm",
            Self::Cold => "cold",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DayTier {
    #[serde(serialize_with = "num_out")]
    pub max_days: f64,
    #[serde(serialize_with = "num_out")]
    pub points: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recency {
    pub tiers: Vec<DayTier>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Interactions {
    #[serde(serialize_with = "num_out")]
    pub window_days: f64,
    #[serde(serialize_with = "num_out")]
    pub per_interaction: f64,
    #[serde(serialize_with = "num_out")]
    pub max_points: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PointMap {
    #[serde(serialize_with = "map_out")]
    pub points: BTreeMap<String, f64>,
    #[serde(serialize_with = "num_out")]
    pub default_points: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Response {
    pub actions: Vec<String>,
    pub tiers: Vec<DayTier>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Profile {
    #[serde(serialize_with = "num_out")]
    pub phone_points: f64,
    #[serde(serialize_with = "num_out")]
    pub demand_points: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiIntent {
    pub enabled: bool,
    #[serde(serialize_with = "num_out")]
    pub max_points: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Thresholds {
    #[serde(serialize_with = "num_out")]
    pub hot: f64,
    #[serde(serialize_with = "num_out")]
    pub warm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LeadScoringRules {
    pub recency: Recency,
    pub interactions: Interactions,
    pub stage: PointMap,
    pub response: Response,
    pub source: PointMap,
    pub profile: Profile,
    pub ai_intent: AiIntent,
    pub thresholds: Thresholds,
}

fn tier(max_days: f64, points: f64) -> DayTier {
    DayTier { max_days, points }
}

fn map(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
}

/// `DEFAULT_LEAD_RULES`.
pub fn default_rules() -> LeadScoringRules {
    LeadScoringRules {
        recency: Recency {
            tiers: vec![
                tier(1.0, 25.0),
                tier(3.0, 20.0),
                tier(7.0, 15.0),
                tier(14.0, 8.0),
                tier(30.0, 3.0),
            ],
        },
        interactions: Interactions {
            window_days: 30.0,
            per_interaction: 4.0,
            max_points: 20.0,
        },
        stage: PointMap {
            points: map(&[
                ("new", 5.0),
                ("follow_up_1", 10.0),
                ("follow_up_2", 15.0),
                ("follow_up_3", 20.0),
            ]),
            default_points: 5.0,
        },
        response: Response {
            actions: vec!["receive".to_owned()],
            tiers: vec![tier(3.0, 15.0), tier(7.0, 10.0), tier(14.0, 5.0)],
        },
        source: PointMap {
            points: map(&[
                ("referral", 10.0),
                ("partner_referral", 8.0),
                ("zalo", 8.0),
                ("ads", 6.0),
            ]),
            default_points: 4.0,
        },
        profile: Profile {
            phone_points: 5.0,
            demand_points: 5.0,
        },
        ai_intent: AiIntent {
            enabled: true,
            max_points: 10.0,
        },
        thresholds: Thresholds { hot: 70.0, warm: 40.0 },
    }
}

/// `typeof v === 'number' && isFinite && v >= 0 ? v : fallback`.
fn num(v: Option<&Value>, fallback: f64) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(fallback)
}

/// `r.<a>?.<b>`: chỉ đọc khi `a` là object (mảng/chuỗi/số cho `undefined`).
fn at<'a>(raw: &'a Value, a: &str, b: &str) -> Option<&'a Value> {
    raw.as_object()?.get(a)?.as_object()?.get(b)
}

fn tiers(raw: Option<&Value>, fallback: &[DayTier]) -> Vec<DayTier> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        return fallback.to_vec();
    };
    let mut out: Vec<DayTier> = arr
        .iter()
        .filter_map(Value::as_object)
        .map(|t| tier(num(t.get("max_days"), -1.0), num(t.get("points"), -1.0)))
        .filter(|t| t.max_days >= 0.0 && t.points >= 0.0)
        .collect();
    out.sort_by(|a, b| a.max_days.total_cmp(&b.max_days));
    if out.is_empty() { fallback.to_vec() } else { out }
}

fn point_map(raw: Option<&Value>, fallback: &BTreeMap<String, f64>) -> BTreeMap<String, f64> {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return fallback.clone();
    };
    let out: BTreeMap<String, f64> = obj
        .iter()
        .filter_map(|(k, v)| v.as_f64().filter(|n| *n >= 0.0).map(|n| (k.clone(), n)))
        .collect();
    if out.is_empty() { fallback.clone() } else { out }
}

/// Cấu hình thô (một phần/rác) ⇒ đủ trường, giá trị sai rơi về mặc định (`normalizeRules`).
pub fn normalize_rules(raw: &Value) -> LeadScoringRules {
    let d = default_rules();
    let g = |a: &str, b: &str| at(raw, a, b);
    let actions = g("response", "actions")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.iter().all(Value::is_string))
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        });
    let hot = num(g("thresholds", "hot"), d.thresholds.hot);
    let warm = num(g("thresholds", "warm"), d.thresholds.warm);
    let window = num(g("interactions", "window_days"), d.interactions.window_days);
    LeadScoringRules {
        recency: Recency {
            tiers: tiers(g("recency", "tiers"), &d.recency.tiers),
        },
        interactions: Interactions {
            window_days: if window == 0.0 {
                d.interactions.window_days
            } else {
                window.min(MAX_WINDOW_DAYS)
            },
            per_interaction: num(g("interactions", "per_interaction"), d.interactions.per_interaction),
            max_points: num(g("interactions", "max_points"), d.interactions.max_points),
        },
        stage: PointMap {
            points: point_map(g("stage", "points"), &d.stage.points),
            default_points: num(g("stage", "default_points"), d.stage.default_points),
        },
        response: Response {
            actions: actions.unwrap_or_else(|| d.response.actions.clone()),
            tiers: tiers(g("response", "tiers"), &d.response.tiers),
        },
        source: PointMap {
            points: point_map(g("source", "points"), &d.source.points),
            default_points: num(g("source", "default_points"), d.source.default_points),
        },
        profile: Profile {
            phone_points: num(g("profile", "phone_points"), d.profile.phone_points),
            demand_points: num(g("profile", "demand_points"), d.profile.demand_points),
        },
        ai_intent: AiIntent {
            enabled: g("ai_intent", "enabled")
                .and_then(Value::as_bool)
                .unwrap_or(d.ai_intent.enabled),
            max_points: num(g("ai_intent", "max_points"), d.ai_intent.max_points),
        },
        // Ngưỡng sai thứ tự (warm > hot) ⇒ về mặc định để nhãn vẫn đơn điệu.
        thresholds: if warm <= hot {
            Thresholds { hot, warm }
        } else {
            d.thresholds
        },
    }
}

/// Dữ kiện đã gom cho một khách — đầu vào của [`score_lead`].
#[derive(Debug, Clone)]
pub struct LeadSignals {
    pub phone: Option<String>,
    pub has_demand: bool,
    pub stage_value: Option<String>,
    pub source_value: Option<String>,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub last_response_at: Option<DateTime<Utc>>,
    pub interactions_in_window: i64,
    /// 0–1 do agent AI của khách chấm qua MCP (`None` = chưa chấm).
    pub ai_intent: Option<f64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LeadReason {
    pub key: &'static str,
    pub label: &'static str,
    #[serde(serialize_with = "num_out")]
    pub points: f64,
    #[serde(serialize_with = "num_out")]
    pub max: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LeadScoreResult {
    pub score: i32,
    pub label: LeadLabel,
    pub reasons: Vec<LeadReason>,
}

fn tier_points(at: Option<DateTime<Utc>>, now: DateTime<Utc>, list: &[DayTier]) -> f64 {
    let Some(at) = at else { return 0.0 };
    let days = ((now - at).num_milliseconds() as f64 / DAY_MS).max(0.0);
    list.iter().find(|t| days <= t.max_days).map_or(0.0, |t| t.points)
}

fn max_tier(list: &[DayTier]) -> f64 {
    list.iter().map(|t| t.points).fold(0.0, f64::max)
}

fn max_of(m: &BTreeMap<String, f64>, def: f64) -> f64 {
    m.values().copied().fold(def, f64::max)
}

fn lookup(m: &BTreeMap<String, f64>, key: Option<&str>, def: f64) -> f64 {
    key.and_then(|k| m.get(k)).copied().unwrap_or(def)
}

pub fn label_for(score: f64, th: &Thresholds) -> LeadLabel {
    if score >= th.hot {
        LeadLabel::Hot
    } else if score >= th.warm {
        LeadLabel::Warm
    } else {
        LeadLabel::Cold
    }
}

/// Chấm điểm một khách. Không có hoạt động nào ⇒ độ mới tính từ ngày tạo khách.
pub fn score_lead(s: &LeadSignals, rules: &LeadScoringRules, now: DateTime<Utc>) -> LeadScoreResult {
    let last_touch = s.last_activity_at.unwrap_or(s.created_at);
    let has_phone = s.phone.as_deref().is_some_and(|p| !trim_js(p).is_empty());
    let mut reasons = vec![
        LeadReason {
            key: "recency",
            label: "Độ mới liên hệ",
            points: tier_points(Some(last_touch), now, &rules.recency.tiers),
            max: max_tier(&rules.recency.tiers),
        },
        LeadReason {
            key: "interactions",
            label: "Số lần tương tác",
            points: rules
                .interactions
                .max_points
                .min(s.interactions_in_window as f64 * rules.interactions.per_interaction),
            max: rules.interactions.max_points,
        },
        LeadReason {
            key: "stage",
            label: "Giai đoạn",
            points: lookup(
                &rules.stage.points,
                s.stage_value.as_deref(),
                rules.stage.default_points,
            ),
            max: max_of(&rules.stage.points, rules.stage.default_points),
        },
        LeadReason {
            key: "response",
            label: "Phản hồi gần nhất",
            points: tier_points(s.last_response_at, now, &rules.response.tiers),
            max: max_tier(&rules.response.tiers),
        },
        LeadReason {
            key: "source",
            label: "Nguồn khách",
            points: lookup(
                &rules.source.points,
                s.source_value.as_deref(),
                rules.source.default_points,
            ),
            max: max_of(&rules.source.points, rules.source.default_points),
        },
        LeadReason {
            key: "profile",
            label: "Có SĐT / nhu cầu",
            points: (if has_phone { rules.profile.phone_points } else { 0.0 })
                + (if s.has_demand { rules.profile.demand_points } else { 0.0 }),
            max: rules.profile.phone_points + rules.profile.demand_points,
        },
    ];
    if rules.ai_intent.enabled
        && let Some(intent) = s.ai_intent.filter(|v| v.is_finite())
    {
        reasons.push(LeadReason {
            key: "ai_intent",
            label: "Agent AI đánh giá nhu cầu",
            points: (intent.clamp(0.0, 1.0) * rules.ai_intent.max_points).round(),
            max: rules.ai_intent.max_points,
        });
    }
    let total: f64 = reasons.iter().map(|r| r.points).sum();
    let score = total.round().min(100.0);
    LeadScoreResult {
        score: score as i32,
        label: label_for(score, &rules.thresholds),
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use serde_json::json;

    use super::*;

    fn signals(now: DateTime<Utc>) -> LeadSignals {
        LeadSignals {
            phone: Some("0900000000".into()),
            has_demand: true,
            stage_value: Some("follow_up_3".into()),
            source_value: Some("referral".into()),
            last_activity_at: Some(now - Duration::hours(2)),
            last_response_at: Some(now - Duration::days(1)),
            interactions_in_window: 10,
            ai_intent: None,
            created_at: now - Duration::days(40),
        }
    }

    #[test]
    fn diem_toi_da_la_100_va_nhan_nong() {
        let now = Utc::now();
        let r = score_lead(&signals(now), &default_rules(), now);
        assert_eq!(r.score, 100);
        assert_eq!(r.label, LeadLabel::Hot);
        assert_eq!(r.reasons.len(), 6);
    }

    #[test]
    fn y_dinh_ai_cong_them_va_tran_100() {
        let now = Utc::now();
        let mut s = signals(now);
        s.ai_intent = Some(0.5);
        s.stage_value = Some("new".into());
        let r = score_lead(&s, &default_rules(), now);
        assert_eq!(r.reasons.last().map(|x| (x.key, x.points)), Some(("ai_intent", 5.0)));
        assert_eq!(r.score, 90);
        s.stage_value = Some("follow_up_3".into());
        assert_eq!(score_lead(&s, &default_rules(), now).score, 100);
    }

    #[test]
    fn khong_hoat_dong_thi_tinh_tu_ngay_tao() {
        let now = Utc::now();
        let mut s = signals(now);
        s.last_activity_at = None;
        s.last_response_at = None;
        s.interactions_in_window = 0;
        s.phone = Some("  ".into());
        s.has_demand = false;
        s.stage_value = None;
        s.source_value = None;
        s.created_at = now - Duration::days(40);
        let r = score_lead(&s, &default_rules(), now);
        // recency 0 (quá 30 ngày) + 0 + stage mặc định 5 + 0 + nguồn mặc định 4 + 0
        assert_eq!(r.score, 9);
        assert_eq!(r.label, LeadLabel::Cold);
    }

    #[test]
    fn chuan_hoa_rac_ve_mac_dinh() {
        assert_eq!(normalize_rules(&json!(null)), default_rules());
        assert_eq!(normalize_rules(&json!("x")), default_rules());
        let n = normalize_rules(&json!({
            "thresholds": { "hot": 30, "warm": 60 },
            "recency": { "tiers": [{ "max_days": -1, "points": 3 }] },
            "response": { "actions": [1, 2] },
            "interactions": { "window_days": 0, "per_interaction": 2 },
            "stage": { "points": { "a": 3, "b": -1 } },
            "ai_intent": { "enabled": false, "max_points": 7 }
        }));
        let d = default_rules();
        assert_eq!(n.thresholds, d.thresholds);
        assert_eq!(n.recency, d.recency);
        assert_eq!(n.response.actions, d.response.actions);
        assert_eq!(n.interactions.window_days, 30.0);
        let big = normalize_rules(&json!({ "interactions": { "window_days": 1e18 } }));
        assert_eq!(big.interactions.window_days, MAX_WINDOW_DAYS);
        assert_eq!(n.interactions.per_interaction, 2.0);
        assert_eq!(n.stage.points, map(&[("a", 3.0)]));
        assert!(!n.ai_intent.enabled);
        assert_eq!(n.ai_intent.max_points, 7.0);
    }

    #[test]
    fn bac_duoc_sap_theo_so_ngay_va_json_so_nguyen() {
        let n = normalize_rules(
            &json!({ "recency": { "tiers": [{ "max_days": 9, "points": 2 }, { "max_days": 2, "points": 5 }] } }),
        );
        assert_eq!(
            n.recency.tiers.iter().map(|t| t.max_days).collect::<Vec<_>>(),
            [2.0, 9.0]
        );
        let text = serde_json::to_string(&n.recency).unwrap();
        assert_eq!(
            text,
            r#"{"tiers":[{"max_days":2,"points":5},{"max_days":9,"points":2}]}"#
        );
    }
}
