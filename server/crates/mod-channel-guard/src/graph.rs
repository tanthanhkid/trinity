//! Kết quả một lời gọi Graph API và cách phân loại (`graph-observer.ts`): chỉ lời gọi GỬI RA lỗi do hành vi của công ty mới
//! tính vào ngưỡng tự tạm dừng; giới hạn cấp app thì cả app lùi chung.

/// Kết quả một lời gọi Graph (cũng là nội dung tin `graph` trên kênh `trinity_sync`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraphOutcome {
    pub ok: bool,
    pub http_status: i64,
    pub code: Option<i64>,
    pub subcode: Option<i64>,
    /// `true` = lời gọi GỬI RA (tin, trả lời/ẩn bình luận, đăng bài). Lời gọi đọc không tính vào ngưỡng nào.
    pub send: bool,
}

/// `#368` = Meta đã đánh dấu vi phạm chính sách/spam: dấu hiệu nặng nhất.
pub const GRAPH_POLICY_CODE: i64 = 368;

/// Giới hạn cấp APP (`#4`, `#613`, HTTP 429): dùng chung mọi công ty nên KHÔNG tính vào ngưỡng của một công ty.
pub fn is_app_level_limit(o: &GraphOutcome) -> bool {
    o.http_status == 429 || o.code == Some(4) || o.code == Some(613)
}

/// Lỗi của lời gọi GỬI RA do hành vi của một công ty: `#368` vi phạm chính sách/spam, `#551` người nhận không khả dụng,
/// `#17`/`#32` giới hạn theo người dùng/Page. KHÔNG tính: lời gọi đọc; giới hạn cấp app; ngoài cửa sổ 24h (subcode
/// 2018278 hoặc 1545041); token hết hạn (190); lỗi quyền thường gặp (`#10`, `#200`–`#299`).
pub fn is_block_outcome(o: &GraphOutcome) -> bool {
    if !o.send || is_app_level_limit(o) {
        return false;
    }
    if matches!(o.subcode, Some(2_018_278 | 1_545_041)) {
        return false;
    }
    matches!(o.code, Some(368 | 551 | 17 | 32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(http_status: i64, code: Option<i64>, subcode: Option<i64>, send: bool) -> GraphOutcome {
        GraphOutcome {
            ok: false,
            http_status,
            code,
            subcode,
            send,
        }
    }

    #[test]
    fn phan_loai_loi_chan() {
        for (o, want) in [
            (o(400, Some(368), None, true), true),
            (o(400, Some(551), None, true), true),
            (o(400, Some(17), None, true), true),
            (o(400, Some(32), None, true), true),
            (o(400, Some(368), None, false), false),
            (o(403, Some(10), None, false), false),
            (o(400, Some(10), None, true), false),
            (o(400, Some(200), None, true), false),
            (o(400, Some(190), None, true), false),
            (o(400, Some(551), Some(1_545_041), true), false),
            (o(400, Some(10), Some(2_018_278), true), false),
            (o(400, Some(4), None, true), false),
            (o(429, None, None, true), false),
            (o(500, None, None, true), false),
        ] {
            assert_eq!(is_block_outcome(&o), want, "{o:?}");
        }
    }

    #[test]
    fn gioi_han_cap_app() {
        assert!(is_app_level_limit(&o(400, Some(4), None, true)));
        assert!(is_app_level_limit(&o(400, Some(613), None, true)));
        assert!(is_app_level_limit(&o(429, None, None, true)));
        assert!(!is_app_level_limit(&o(400, Some(368), None, true)));
    }
}
