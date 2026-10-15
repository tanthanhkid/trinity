/**
 * Cờ áp design system "ds-v2" — bật/tắt theo môi trường.
 *
 * Khi bật: font Montserrat, radius 0.83rem, hệ shadow-card/pop/brand-glow,
 * nút dạng pill, mục sidebar đang mở nền đặc, tiêu đề bảng nền xám nhạt.
 * Khi tắt (mặc định): giao diện cơ bản (Inter, radius 0.75rem, nút bo rounded-lg).
 *
 * Bật bằng biến môi trường `NEXT_PUBLIC_DS_V2=true`.
 *
 * ⚠️ `NEXT_PUBLIC_*` được INLINE lúc `next build`, KHÔNG đọc lúc chạy — đổi
 * giá trị là phải build lại. Verify sau build: grep `.next/static/chunks/*.css`
 * phải thấy `--radius:.83rem` (bật) hoặc `--radius:.75rem` (tắt).
 *
 * Cờ này KHÔNG đổi fix tương phản `--primary-foreground: oklch(1 0 0)` (AA) —
 * fix đó giữ nguyên ở cả hai chế độ.
 */
export const DS_V2_ENABLED = process.env.NEXT_PUBLIC_DS_V2 === 'true'
