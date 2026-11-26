//! Mốc giờ Việt Nam của bản tin (`briefing-time.ts`).

use chrono::{DateTime, Duration, NaiveTime, Utc};
use trinity_kernel::vn_time::{vn_date, vn_to_utc};

use crate::types::Slot;

/// Quá giờ hẹn tối đa bao lâu thì vẫn bù gửi (job có thể chạy trễ hoặc thưa).
pub const SLOT_GRACE: Duration = Duration::hours(4);

/// Khoảng nửa mở `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// 00:00 hôm nay theo giờ VN, dạng instant UTC.
pub fn vn_day_start(now: DateTime<Utc>) -> DateTime<Utc> {
    vn_to_utc(vn_date(now), NaiveTime::MIN)
}

/// Ngày VN `YYYY-MM-DD`.
pub fn vn_day_key(now: DateTime<Utc>) -> String {
    vn_date(now).format("%Y-%m-%d").to_string()
}

/// `HH:mm` (00:00–23:59) ⇒ (giờ, phút).
pub fn parse_hhmm(v: &str) -> Option<(u32, u32)> {
    let b = v.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return None;
    }
    let h: u32 = v[0..2].parse().ok()?;
    let m: u32 = v[3..5].parse().ok()?;
    (h < 24 && m < 60).then_some((h, m))
}

/// Mốc gửi của slot trong ngày VN của `now`; `None` nếu giờ cấu hình sai.
pub fn slot_instant(time: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let (h, m) = parse_hhmm(time)?;
    Some(vn_day_start(now) + Duration::minutes(i64::from(h * 60 + m)))
}

fn in_window(at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    let diff = now - at;
    diff >= Duration::zero() && diff < SLOT_GRACE
}

/// Slot đã đến giờ gửi và còn trong thời gian bù (xét cả giờ hẹn của ngày VN hôm trước, xem [`due_reference`]).
pub fn is_slot_due(time: &str, now: DateTime<Utc>) -> bool {
    due_reference(time, now).is_some()
}

/// Mốc tham chiếu để gửi slot, hoặc `None` nếu chưa/không còn đến giờ. Giờ hẹn của ngày hôm nay còn trong thời gian bù ⇒
/// mốc là `now`. Giờ hẹn của ngày VN hôm TRƯỚC còn trong thời gian bù (slot gần nửa đêm, vd 23:00 chạy trễ qua 00:00) ⇒
/// mốc là giây cuối cùng của ngày hôm trước, để khoá ngày (`vn_day_key`) và khung số liệu thuộc về ngày của slot.
pub fn due_reference(time: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let today = slot_instant(time, now)?;
    if in_window(today, now) {
        return Some(now);
    }
    let yesterday = slot_instant(time, now - Duration::days(1))?;
    in_window(yesterday, now).then(|| vn_day_start(now) - Duration::seconds(1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotWindows {
    pub cur: Range,
    pub prev: Range,
    pub callbacks: Range,
    pub period_label: &'static str,
    pub reminder_label: &'static str,
}

/// Sáng: tổng kết trọn ngày hôm qua (so với hôm kia), lịch hẹn nhắc hôm nay.
/// Chiều: tổng kết hôm nay tới giờ (so với hôm qua CÙNG thời điểm), lịch hẹn nhắc ngày mai.
pub fn slot_windows(slot: Slot, now: DateTime<Utc>) -> SlotWindows {
    let day = Duration::days(1);
    let today = vn_day_start(now);
    match slot {
        Slot::Morning => {
            let y = today - day;
            SlotWindows {
                cur: Range { start: y, end: today },
                prev: Range { start: y - day, end: y },
                callbacks: Range {
                    start: today,
                    end: today + day,
                },
                period_label: "hôm qua",
                reminder_label: "hôm nay",
            }
        }
        Slot::Evening => SlotWindows {
            cur: Range { start: today, end: now },
            prev: Range {
                start: today - day,
                end: now - day,
            },
            callbacks: Range {
                start: today + day,
                end: today + day * 2,
            },
            period_label: "hôm nay",
            reminder_label: "ngày mai",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn ngay_va_moc_gio_viet_nam() {
        // 2026-11-26 20:00 UTC = 03:00 ngày 27 giờ VN.
        let now = at("2026-11-26T20:00:00Z");
        assert_eq!(vn_day_key(now), "2026-11-27");
        assert_eq!(vn_day_start(now), at("2026-11-26T17:00:00Z"));
        assert_eq!(slot_instant("08:00", now), Some(at("2026-11-27T01:00:00Z")));
        assert_eq!(slot_instant("8:00", now), None);
        assert_eq!(slot_instant("24:00", now), None);
    }

    #[test]
    fn dung_gio_va_thoi_gian_bu() {
        let t = "08:00"; // 01:00 UTC
        assert!(!is_slot_due(t, at("2026-11-27T00:59:59Z")));
        assert!(is_slot_due(t, at("2026-11-27T01:00:00Z")));
        assert!(is_slot_due(t, at("2026-11-27T04:59:59Z")));
        assert!(!is_slot_due(t, at("2026-11-27T05:00:00Z")));
        assert!(!is_slot_due("bad", at("2026-11-27T01:00:00Z")));
    }

    #[test]
    fn slot_gan_nua_dem_chay_tre_qua_ngay_moi() {
        // 23:00 VN = 16:00 UTC. 00:30 VN ngày sau (17:30Z) vẫn trong 4 giờ bù: mang ngày hôm trước.
        let now = at("2026-11-27T17:30:00Z");
        let r = due_reference("23:00", now).unwrap();
        assert_eq!(vn_day_key(r), "2026-11-27");
        assert_eq!(vn_day_key(now), "2026-11-28");
        assert_eq!(r, at("2026-11-27T16:59:59Z"));
        // Hết thời gian bù lúc 03:00 VN.
        assert!(due_reference("23:00", at("2026-11-27T19:59:59Z")).is_some());
        assert!(due_reference("23:00", at("2026-11-27T20:00:00Z")).is_none());
        // Trong ngày: mốc là now.
        let t = at("2026-11-27T16:10:00Z");
        assert_eq!(due_reference("23:00", t), Some(t));
        assert!(due_reference("23:00", at("2026-11-27T15:59:00Z")).is_none());
        // Giờ ban ngày không dây sang hôm sau.
        assert!(due_reference("08:00", at("2026-11-27T17:00:00Z")).is_none());
        assert!(due_reference("bad", now).is_none());
    }

    #[test]
    fn khung_so_lieu_sang_va_chieu() {
        let now = at("2026-11-27T01:30:00Z"); // 08:30 ngày 27 VN
        let m = slot_windows(Slot::Morning, now);
        assert_eq!(
            m.cur,
            Range {
                start: at("2026-11-25T17:00:00Z"),
                end: at("2026-11-26T17:00:00Z")
            }
        );
        assert_eq!(m.prev.end, m.cur.start);
        assert_eq!(m.callbacks.start, at("2026-11-26T17:00:00Z"));
        assert_eq!((m.period_label, m.reminder_label), ("hôm qua", "hôm nay"));
        let e = slot_windows(Slot::Evening, now);
        assert_eq!(
            e.cur,
            Range {
                start: at("2026-11-26T17:00:00Z"),
                end: now
            }
        );
        assert_eq!(e.prev.end, now - Duration::days(1));
        assert_eq!(e.callbacks.start, at("2026-11-27T17:00:00Z"));
        assert_eq!((e.period_label, e.reminder_label), ("hôm nay", "ngày mai"));
    }
}
