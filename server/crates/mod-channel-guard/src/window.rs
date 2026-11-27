//! Phần thuần của ChannelGuard: ngưỡng từ biến môi trường, cửa sổ lời gọi Graph → có nên tạm dừng, khung đếm hạn mức.

use std::collections::BTreeMap;

use crate::graph::GRAPH_POLICY_CODE;

pub(crate) const HOUR_MS: i64 = 3_600_000;
pub(crate) const DAY_MS: i64 = 86_400_000;
const VN_OFFSET_MS: i64 = 7 * HOUR_MS;

#[derive(Debug, Clone, PartialEq)]
pub struct GraphGuardConfig {
    pub window_ms: i64,
    /// Ít nhất chừng này lời gọi trong cửa sổ mới xét tỉ lệ.
    pub min_calls: usize,
    /// Ít nhất chừng này lỗi chặn mới tạm dừng.
    pub min_blocks: usize,
    /// Tỉ lệ lỗi chặn / tổng lời gọi vượt mức này ⇒ tạm dừng.
    pub max_block_rate: f64,
    /// Số lần gặp `#368` trong cửa sổ ⇒ tạm dừng ngay.
    pub policy_blocks: usize,
    pub pause_ms: i64,
    /// Lùi gửi tự động toàn app khi Facebook báo giới hạn cấp app.
    pub app_backoff_ms: i64,
    /// Cần ít nhất chừng này lần bị giới hạn cấp app trong `app_hit_window_ms` mới lùi toàn app.
    pub app_backoff_hits: usize,
    pub app_hit_window_ms: i64,
}

impl GraphGuardConfig {
    /// Đọc `CHANNEL_GUARD_*`; giá trị rác hoặc dưới mức tối thiểu rơi về mặc định (như `graphGuardConfig`).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let num = |k: &str, d: f64, min: f64| -> f64 {
            // `Number(env[k])` của JS: rỗng là 0 (< min ⇒ mặc định), chữ là NaN.
            get(k)
                .and_then(|s| {
                    let t = s.trim();
                    if t.is_empty() { Some(0.0) } else { t.parse::<f64>().ok() }
                })
                .filter(|n| n.is_finite() && *n >= min)
                .unwrap_or(d)
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let count = |k: &str, d: f64| num(k, d, 1.0).ceil() as usize;
        #[allow(clippy::cast_possible_truncation)]
        let ms = |k: &str, d: f64, unit: i64| (num(k, d, 1.0) * unit as f64) as i64;
        Self {
            window_ms: ms("CHANNEL_GUARD_WINDOW_MIN", 60.0, 60_000),
            min_calls: count("CHANNEL_GUARD_MIN_CALLS", 20.0),
            min_blocks: count("CHANNEL_GUARD_MIN_BLOCKS", 10.0),
            max_block_rate: num("CHANNEL_GUARD_MAX_BLOCK_RATE", 0.3, 0.01).min(1.0),
            policy_blocks: count("CHANNEL_GUARD_POLICY_BLOCKS", 2.0),
            pause_ms: ms("CHANNEL_GUARD_PAUSE_HOURS", 6.0, HOUR_MS),
            app_backoff_ms: ms("CHANNEL_GUARD_APP_BACKOFF_MIN", 5.0, 60_000),
            app_backoff_hits: count("CHANNEL_GUARD_APP_BACKOFF_HITS", 3.0),
            app_hit_window_ms: 60_000,
        }
    }

    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraphWindowEvent {
    /// Mốc thời gian, mili giây từ epoch.
    pub t: i64,
    pub block: bool,
    pub code: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphVerdict {
    pub trip: bool,
    pub reason: String,
    pub calls: usize,
    pub blocks: usize,
    pub codes: BTreeMap<String, usize>,
}

/// Cửa sổ lời gọi Graph → có nên tạm dừng không.
pub fn evaluate_graph_window(events: &[GraphWindowEvent], now: i64, cfg: &GraphGuardConfig) -> GraphVerdict {
    let in_win: Vec<_> = events.iter().filter(|e| now - e.t <= cfg.window_ms).collect();
    let blocked: Vec<_> = in_win.iter().filter(|e| e.block).collect();
    let mut codes = BTreeMap::new();
    for e in &blocked {
        *codes
            .entry(e.code.map_or_else(|| "http".to_owned(), |c| c.to_string()))
            .or_insert(0) += 1;
    }
    let minutes = cfg.window_ms / 60_000;
    let policy = blocked.iter().filter(|e| e.code == Some(GRAPH_POLICY_CODE)).count();
    let mut v = GraphVerdict {
        trip: false,
        reason: String::new(),
        calls: in_win.len(),
        blocks: blocked.len(),
        codes,
    };
    if policy >= cfg.policy_blocks {
        v.trip = true;
        v.reason =
            format!("Facebook báo vi phạm chính sách/spam (#{GRAPH_POLICY_CODE}) {policy} lần trong {minutes} phút");
    } else if in_win.len() >= cfg.min_calls
        && blocked.len() >= cfg.min_blocks
        && blocked.len() as f64 / in_win.len() as f64 >= cfg.max_block_rate
    {
        v.trip = true;
        v.reason = format!(
            "{}/{} lời gọi Facebook bị chặn hoặc giới hạn trong {minutes} phút",
            blocked.len(),
            in_win.len()
        );
    }
    v
}

/// Đầu khung giờ (UTC) chứa `now` (ms).
pub fn hour_bucket(now: i64) -> i64 {
    now.div_euclid(HOUR_MS) * HOUR_MS
}

/// Đầu ngày theo giờ Việt Nam chứa `now` (ms).
pub fn day_bucket(now: i64) -> i64 {
    (now + VN_OFFSET_MS).div_euclid(DAY_MS) * DAY_MS - VN_OFFSET_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    // 26/11/2026 03:30 UTC.
    const NOW: i64 = 1_795_663_800_000;

    fn cfg() -> GraphGuardConfig {
        GraphGuardConfig::from_lookup(|_| None)
    }

    fn ev(min_ago: i64, code: Option<i64>, block: bool) -> GraphWindowEvent {
        GraphWindowEvent {
            t: NOW - min_ago * 60_000,
            block,
            code,
        }
    }

    #[test]
    fn hai_loi_368_tam_dung_ngay() {
        let v = evaluate_graph_window(&[ev(5, Some(368), true), ev(1, Some(368), true)], NOW, &cfg());
        assert!(v.trip);
        assert!(v.reason.contains("#368"));
        assert_eq!(v.codes.get("368"), Some(&2));
        assert!(!evaluate_graph_window(&[ev(1, Some(368), true)], NOW, &cfg()).trip);
    }

    #[test]
    fn ti_le_loi_chan_tu_30_phan_tram() {
        let mut v: Vec<_> = (0..10)
            .map(|i| ev(i + 1, Some(if i % 2 == 1 { 17 } else { 551 }), true))
            .collect();
        v.extend((0..20).map(|i| ev(i + 1, None, false)));
        let r = evaluate_graph_window(&v, NOW, &cfg());
        assert!(r.trip);
        assert_eq!((r.calls, r.blocks), (30, 10));
    }

    #[test]
    fn ti_le_thap_hoac_it_loi_khong_tam_dung() {
        let mut v: Vec<_> = (0..80).map(|i| ev(i % 50, None, false)).collect();
        v.extend((0..9).map(|i| ev(i + 1, Some(4), true)));
        assert!(!evaluate_graph_window(&v, NOW, &cfg()).trip);
        let mut v: Vec<_> = (0..10).map(|i| ev(i + 1, Some(4), true)).collect();
        v.extend((0..100).map(|_| ev(2, None, false)));
        assert!(!evaluate_graph_window(&v, NOW, &cfg()).trip);
    }

    #[test]
    fn ngoai_cua_so_khong_tinh() {
        assert!(!evaluate_graph_window(&[ev(90, Some(368), true), ev(80, Some(368), true)], NOW, &cfg()).trip);
    }

    #[test]
    fn nguong_tu_bien_moi_truong_rac_ve_mac_dinh() {
        let c = GraphGuardConfig::from_lookup(|k| match k {
            "CHANNEL_GUARD_PAUSE_HOURS" => Some("2".into()),
            "CHANNEL_GUARD_MAX_BLOCK_RATE" => Some("x".into()),
            _ => None,
        });
        assert_eq!(c.pause_ms, 2 * HOUR_MS);
        assert!((c.max_block_rate - 0.3).abs() < f64::EPSILON);
        assert_eq!(c.window_ms, 60 * 60_000);
        // Ngưỡng đếm làm tròn lên: 2.5 lần ⇒ 3, không cắt xuống 2.
        let c = GraphGuardConfig::from_lookup(|k| (k == "CHANNEL_GUARD_POLICY_BLOCKS").then(|| "2.5".to_owned()));
        assert_eq!(c.policy_blocks, 3);
    }

    #[test]
    fn khung_gio_va_ngay_viet_nam() {
        // 03:30 UTC = 10:30 VN: đầu ngày VN là 17:00 UTC hôm trước.
        assert_eq!(day_bucket(NOW), NOW - (3 * HOUR_MS + 30 * 60_000) - 7 * HOUR_MS);
        assert_eq!(hour_bucket(NOW), NOW - 30 * 60_000);
        // 16:59 UTC và 17:00 UTC rơi vào hai ngày VN khác nhau.
        let edge = day_bucket(NOW) + DAY_MS;
        assert_eq!(day_bucket(edge - 1), day_bucket(NOW));
        assert_eq!(day_bucket(edge), edge);
    }
}
