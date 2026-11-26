//! Nội dung bản tin dựng bằng mẫu, không AI (`briefing-text.ts`).

use crate::types::{BriefingData, Content, Delta, ScopeKind, Slot};

/// `Number.prototype.toFixed` cho số không âm: làm tròn nửa lên trên GIÁ TRỊ NHỊ PHÂN CHÍNH XÁC (khác `{:.N}` của Rust
/// làm tròn nửa về chẵn: `2.5.toFixed(0)` là "3", Rust ra "2").
fn to_fixed(x: f64, digits: usize) -> String {
    // Khai triển thập phân đủ dài để chính xác tuyệt đối với mọi số trong dải dùng ở đây.
    let full = format!("{x:.80}");
    let (int, frac) = full.split_once('.').unwrap_or((&full, ""));
    let mut digits_vec: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_vec[i] == 9 {
                digits_vec[i] = 0;
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let s: String = digits_vec.iter().map(|d| char::from(b'0' + d)).collect();
    if digits == 0 {
        return s;
    }
    let split = s.len() - digits;
    format!("{}.{}", &s[..split], &s[split..])
}

/// `trim` của bản TS: `toFixed(d)`, bỏ số 0 thừa cuối phần lẻ, bỏ dấu chấm cuối, đổi `.` thành `,`.
fn trim_fixed(n: f64, digits: usize) -> String {
    let s = to_fixed(n, digits);
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    };
    s.replace('.', ",")
}

/// 1.250.000.000 → "1,25 tỷ"; 350.000.000 → "350 triệu"; dưới 1 triệu → "850 nghìn"; dưới 1000 → "N đồng".
pub fn format_vnd(v: i64) -> String {
    let f = v as f64;
    if v >= 1_000_000_000 {
        format!("{} tỷ", trim_fixed(f / 1e9, 2))
    } else if v >= 1_000_000 {
        format!("{} triệu", trim_fixed(f / 1e6, 1))
    } else if v >= 1_000 {
        format!("{} nghìn", trim_fixed(f / 1e3, 0))
    } else {
        format!("{v} đồng")
    }
}

fn plain(n: i64) -> String {
    n.to_string()
}

/// "(tăng 3 so với hôm trước)" / "(giảm 2 …)" / "(bằng hôm trước)".
pub fn delta_text(d: Delta, fmt: fn(i64) -> String) -> String {
    let diff = d.value - d.prev;
    if diff == 0 {
        return "(bằng hôm trước)".to_owned();
    }
    format!(
        "({} {} so với hôm trước)",
        if diff > 0 { "tăng" } else { "giảm" },
        fmt(diff.abs())
    )
}

fn day_label(day: &str) -> String {
    let mut it = day.split('-');
    let (_, m, d) = (it.next(), it.next().unwrap_or(""), it.next().unwrap_or(""));
    format!("{d}/{m}")
}

/// Dòng số liệu: nguồn duy nhất cho bản tin mẫu và dữ liệu đưa agent.
pub fn build_lines(data: &BriefingData) -> Vec<String> {
    let m = &data.metrics;
    let p = &data.period_label;
    let mut lines = vec![
        format!(
            "Khách mới {p}: {} {}.",
            m.new_contacts.value,
            delta_text(m.new_contacts, plain)
        ),
        format!(
            "Lượt đổi giai đoạn {p}: {} {}.",
            m.stage_changes.value,
            delta_text(m.stage_changes, plain)
        ),
        format!(
            "Deal {p}: tạo mới {}, thắng {}, thua {}.",
            m.deals_created.value, m.deals_won.value, m.deals_lost.value
        ),
        format!(
            "Doanh số {p}: {} {}.",
            format_vnd(m.won_value.value),
            delta_text(m.won_value, format_vnd)
        ),
        format!("Việc quá hạn: {}.", m.overdue_tasks),
        format!("Lịch hẹn nhắc {}: {}.", data.reminder_label, m.callbacks),
    ];
    if !m.top_sellers.is_empty() {
        let top: Vec<String> = m
            .top_sellers
            .iter()
            .map(|s| format!("{} ({} deal, {})", s.name, s.won_count, format_vnd(s.won_value)))
            .collect();
        lines.push(format!("Nổi bật {p}: {}.", top.join("; ")));
    }
    lines
}

/// Bản tin mẫu từ số liệu (không AI).
pub fn build_content(data: &BriefingData) -> Content {
    let kind = if data.slot == Slot::Morning { "sáng" } else { "chiều" };
    let scope = match data.scope {
        ScopeKind::Company => "Toàn công ty",
        ScopeKind::Team => "Nhóm của bạn",
        ScopeKind::Own => "Của riêng bạn",
    };
    let title = format!("Bản tin {kind} {} — {scope}", day_label(&data.day));
    let closing = if data.slot == Slot::Morning {
        "Chúc bạn một ngày làm việc hiệu quả."
    } else {
        "Cảm ơn bạn, hẹn gặp lại bản tin sáng mai."
    };
    let mut parts = vec![title.clone(), String::new()];
    parts.extend(build_lines(data).into_iter().map(|l| format!("- {l}")));
    parts.push(String::new());
    parts.push(closing.to_owned());
    Content {
        title,
        text: parts.join("\n"),
    }
}

/// Rút gọn cho thông báo trong app: 3 gạch đầu dòng đầu; không có gạch đầu dòng thì lấy đoạn đầu (≤ 280 đơn vị UTF-16).
pub fn short_body(content: &Content) -> String {
    let bullets: Vec<&str> = content
        .text
        .split('\n')
        .filter(|l| l.starts_with("- "))
        .take(3)
        .map(|l| &l[2..])
        .collect();
    if !bullets.is_empty() {
        return bullets.join(" ");
    }
    let body = content
        .text
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != content.title)
        .collect::<Vec<_>>()
        .join(" ");
    let units: usize = body.chars().map(char::len_utf16).sum();
    if units <= 280 {
        return body;
    }
    let mut n = 0;
    let cut: String = body
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= 279
        })
        .collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Metrics, TopSeller};

    #[test]
    fn dinh_dang_tien() {
        assert_eq!(format_vnd(1_250_000_000), "1,25 tỷ");
        assert_eq!(format_vnd(2_000_000_000), "2 tỷ");
        assert_eq!(format_vnd(350_000_000), "350 triệu");
        assert_eq!(format_vnd(1_500_000), "1,5 triệu");
        assert_eq!(format_vnd(850_000), "850 nghìn");
        assert_eq!(format_vnd(2_500), "3 nghìn"); // toFixed làm tròn nửa lên: 2.5 → "3"
        assert_eq!(format_vnd(999), "999 đồng");
        assert_eq!(format_vnd(0), "0 đồng");
        assert_eq!(format_vnd(999_999_999), "1000 triệu");
    }

    #[test]
    fn to_fixed_giong_js() {
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 thực ra nhỏ hơn 1.005
        assert_eq!(to_fixed(1.45, 1), "1.4"); // 1.45 = 1.4499999…
        assert_eq!(to_fixed(9.99, 1), "10.0");
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(123.0, 0), "123");
    }

    #[test]
    fn delta() {
        assert_eq!(
            delta_text(Delta { value: 5, prev: 2 }, plain),
            "(tăng 3 so với hôm trước)"
        );
        assert_eq!(
            delta_text(Delta { value: 1, prev: 3 }, plain),
            "(giảm 2 so với hôm trước)"
        );
        assert_eq!(delta_text(Delta { value: 4, prev: 4 }, plain), "(bằng hôm trước)");
        assert_eq!(
            delta_text(
                Delta {
                    value: 3_000_000,
                    prev: 1_000_000
                },
                format_vnd
            ),
            "(tăng 2 triệu so với hôm trước)"
        );
    }

    fn data(top: Vec<TopSeller>) -> BriefingData {
        BriefingData {
            slot: Slot::Morning,
            day: "2026-11-27".into(),
            period_label: "hôm qua".into(),
            reminder_label: "hôm nay".into(),
            scope: ScopeKind::Team,
            people_count: 3,
            metrics: Metrics {
                new_contacts: Delta { value: 5, prev: 2 },
                deals_won: Delta { value: 2, prev: 0 },
                won_value: Delta {
                    value: 1_250_000_000,
                    prev: 0,
                },
                overdue_tasks: 4,
                callbacks: 1,
                top_sellers: top,
                ..Metrics::default()
            },
        }
    }

    #[test]
    fn noi_dung_ban_tin_mau() {
        let c = build_content(&data(vec![TopSeller {
            user_id: 2,
            name: "An".into(),
            won_count: 2,
            won_value: 1_250_000_000,
        }]));
        assert_eq!(c.title, "Bản tin sáng 27/11 — Nhóm của bạn");
        let lines: Vec<&str> = c.text.split('\n').collect();
        assert_eq!(lines[0], c.title);
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "- Khách mới hôm qua: 5 (tăng 3 so với hôm trước).");
        assert_eq!(lines[5], "- Doanh số hôm qua: 1,25 tỷ (tăng 1,25 tỷ so với hôm trước).");
        assert_eq!(lines[8], "- Nổi bật hôm qua: An (2 deal, 1,25 tỷ).");
        assert_eq!(lines.last().copied(), Some("Chúc bạn một ngày làm việc hiệu quả."));
        assert_eq!(build_content(&data(vec![])).text.matches("\n- ").count(), 6);
    }

    #[test]
    fn rut_gon_thong_bao() {
        let c = build_content(&data(vec![]));
        assert_eq!(
            short_body(&c),
            "Khách mới hôm qua: 5 (tăng 3 so với hôm trước). Lượt đổi giai đoạn hôm qua: 0 (bằng hôm trước). Deal hôm qua: tạo mới 0, thắng 2, thua 0."
        );
        let agent = Content {
            title: "T".into(),
            text: format!("T\n\n{}", "a".repeat(300)),
        };
        let s = short_body(&agent);
        assert_eq!(s.chars().count(), 280);
        assert!(s.ends_with('…'));
        let short = Content {
            title: "T".into(),
            text: "T\n  nội dung  \n".into(),
        };
        assert_eq!(short_body(&short), "nội dung");
    }
}
