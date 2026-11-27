//! Vị trí kiểu số thực (`position` Float): chèn giữa hai phần tử không phải đánh lại cả danh sách.
//! Bản TS: `common/kanban-position.helper.ts`, `kanban.constants.ts`.

/// Khoảng cách mặc định giữa hai vị trí liền kề.
pub const POSITION_GAP: f64 = 1024.0;

/// Vị trí khi thêm vào CUỐI (`None` = danh sách rỗng).
pub fn append(last: Option<f64>) -> f64 {
    last.map_or(POSITION_GAP, |l| l + POSITION_GAP)
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
    }
}
