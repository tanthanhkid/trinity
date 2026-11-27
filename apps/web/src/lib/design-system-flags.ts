import { resolveDsV2 } from './site-config'

/**
 * Cờ áp design system "ds-v2" — bật/tắt theo môi trường.
 *
 * Khi bật: font Montserrat, radius 0.83rem, hệ shadow-card/pop/brand-glow,
 * nút dạng pill, mục sidebar đang mở nền đặc, tiêu đề bảng nền xám nhạt.
 * Khi tắt (mặc định): giao diện cơ bản (Inter, radius 0.75rem, nút bo rounded-lg).
 *
 * Bật bằng `ds_v2` của `GET /api/v1/site-config` (máy chủ đọc `DS_V2_ENABLED` lúc chạy; đổi env + khởi động lại là đủ,
 * không build lại web). Script trong `<head>` (`SITE_CONFIG_INIT_SCRIPT`) áp cache cấu hình ngay trước bundle (fetch song song, không chặn) nên hằng số
 * module này đúng ở lần vẽ đầu từ lần thăm thứ hai. Chưa có cấu hình (máy chủ Next cũ, chưa có route) ⇒ lùi về `NEXT_PUBLIC_DS_V2` lúc build.
 *
 * Cờ này KHÔNG đổi fix tương phản `--primary-foreground: oklch(1 0 0)` (AA) —
 * fix đó giữ nguyên ở cả hai chế độ.
 */
export const DS_V2_ENABLED = resolveDsV2()
