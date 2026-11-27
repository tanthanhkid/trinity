//! Vị trí kiểu số thực (`position` Float): chèn giữa hai phần tử không phải đánh lại cả danh sách.
//! Bản TS: `common/kanban-position.helper.ts`, `kanban.constants.ts`.

/// Khoảng cách mặc định giữa hai vị trí liền kề.
pub const POSITION_GAP: f64 = 1024.0;

/// Vị trí khi thêm vào CUỐI (`None` = danh sách rỗng).
pub fn append(last: Option<f64>) -> f64 {
    last.map_or(POSITION_GAP, |l| l + POSITION_GAP)
}

/// Khoảng cách tối thiểu còn dùng được; nhỏ hơn thì phải sắp lại cả danh sách.
pub const MIN_GAP: f64 = 1e-6;

/// Vị trí khi chèn giữa `before` (đứng trước) và `after`. `None` khi khoảng cách đã cạn: người gọi sắp lại cả danh sách
/// rồi tính lại.
pub fn between(before: Option<f64>, after: Option<f64>) -> Option<f64> {
    match (before, after) {
        (None, None) => Some(POSITION_GAP),
        (None, Some(a)) => Some(if a / 2.0 > 0.0 { a / 2.0 } else { a - POSITION_GAP }),
        (Some(b), None) => Some(b + POSITION_GAP),
        (Some(b), Some(a)) => {
            let gap = a - b;
            if gap <= MIN_GAP { None } else { Some(b + gap / 2.0) }
        }
    }
}

/// Vị trí mới cho `count` phần tử, cách đều [`POSITION_GAP`].
pub fn renormalized(count: usize) -> Vec<f64> {
    (1..=count).map(|i| i as f64 * POSITION_GAP).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_va_chuan_hoa() {
        assert_eq!(append(None), 1024.0);
        assert_eq!(append(Some(3.5)), 1027.5);
        assert_eq!(renormalized(3), [1024.0, 2048.0, 3072.0]);
        assert!(renormalized(0).is_empty());
        assert_eq!(between(None, None), Some(1024.0));
        assert_eq!(between(None, Some(10.0)), Some(5.0));
        assert_eq!(between(None, Some(-1.0)), Some(-1025.0));
        assert_eq!(between(Some(3.0), None), Some(1027.0));
        assert_eq!(between(Some(1.0), Some(3.0)), Some(2.0));
        assert_eq!(between(Some(1.0), Some(1.0 + 1e-7)), None);
    }
}
