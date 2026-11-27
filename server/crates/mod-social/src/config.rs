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
