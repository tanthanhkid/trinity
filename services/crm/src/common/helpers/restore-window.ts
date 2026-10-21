/**
 * Cửa sổ khôi phục phía máy chủ cho nút "Hoàn tác" trên web (khách hàng, card Kanban):
 * toast chỉ hiện 5 giây, máy chủ để dư cho mạng chậm / bấm lại. Quá hạn ⇒ 410.
 */
export const RESTORE_WINDOW_MS = 10 * 60 * 1000;
