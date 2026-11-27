//! `social.config.ts` phần mạng: chỉ còn Facebook Page; YouTube, TikTok, Google Business, Instagram đã gỡ (G04).

pub const SOCIAL_NETWORKS: [&str; 1] = ["facebook"];

pub fn is_social_network(v: &str) -> bool {
    SOCIAL_NETWORKS.contains(&v)
}

pub fn network_label(network: &str) -> &'static str {
    match network {
        "facebook" => "Facebook Page",
        _ => "",
    }
}

/// Mạng đã gỡ (migration `0021_social_fanpage_only`): kênh cũ `disabled`, bài cũ giữ làm lịch sử.
pub const REMOVED_SOCIAL_NETWORKS: [(&str, &str); 4] = [
    ("instagram", "Instagram"),
    ("youtube", "YouTube"),
    ("tiktok", "TikTok"),
    ("google_business", "Google Business Profile"),
];

/// Câu báo khi thao tác trên mạng đã gỡ; `None` nếu không phải mạng đã gỡ.
pub fn removed_network_message(network: &str) -> Option<String> {
    REMOVED_SOCIAL_NETWORKS
        .iter()
        .find(|(k, _)| *k == network)
        .map(|(_, label)| {
            format!(
                "Trinity đã ngừng hỗ trợ {label}: chỉ còn đăng bài lên Fanpage Facebook. Bài cũ vẫn xem được trong lịch sử."
            )
        })
}

/// URL Meta chuyển người dùng về; phải đăng ký ĐÚNG chuỗi này trong app Meta.
pub fn social_redirect_uri(base: &str, network: &str) -> String {
    format!("{base}/api/v1/social/oauth/callback/{network}")
}

/// Hẹn giờ tối đa 90 ngày tới.
pub const MAX_SCHEDULE_AHEAD_MS: i64 = 90 * 86_400_000;

/// Tối đa tệp đính kèm mỗi bài.
pub const MAX_MEDIA_PER_POST: usize = 10;

/// Giới hạn ký tự (UTF-16, như `String.length`) của nội dung một mạng; mạng đã gỡ không có.
pub fn caption_limit(network: &str) -> Option<usize> {
    match network {
        "facebook" => Some(63_206),
        _ => None,
    }
}

/// Vị trí (UTF-16) mạng bắt đầu giấu chữ sau "Xem thêm" (số xấp xỉ, chỉ để xem trước): Facebook gập sau 480 ký tự hoặc 5 dòng,
/// chạm mốc nào trước thì gập ở đó. Chữ ngắn hơn mốc ⇒ `None`.
pub fn truncated_at(network: &str, text: &str) -> Option<usize> {
    let (chars, lines) = match network {
        "facebook" => (480_usize, 5_usize),
        _ => return None,
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut cut: Option<usize> = (units.len() > chars).then_some(chars);
    let newlines: Vec<usize> = units
        .iter()
        .enumerate()
        .filter(|(_, u)| **u == 0x0A)
        .map(|(i, _)| i)
        .collect();
    // Hết dòng thứ `lines` mà còn chữ phía sau ⇒ gập tại đó.
    if let Some(&idx) = newlines.get(lines - 1) {
        let rest = String::from_utf16_lossy(&units[idx + 1..]);
        if !crate::utm::js_trim(&rest).is_empty() && cut.is_none_or(|c| idx < c) {
            cut = Some(idx);
        }
    }
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mang_va_cau_bao() {
        assert!(is_social_network("facebook") && !is_social_network("youtube") && !is_social_network("Facebook"));
        assert!(removed_network_message("facebook").is_none());
        assert!(
            removed_network_message("tiktok")
                .unwrap()
                .starts_with("Trinity đã ngừng hỗ trợ TikTok:")
        );
        assert!(removed_network_message("constructor").is_none());
        assert_eq!(
            social_redirect_uri("https://a.example", "facebook"),
            "https://a.example/api/v1/social/oauth/callback/facebook"
        );
    }
}
