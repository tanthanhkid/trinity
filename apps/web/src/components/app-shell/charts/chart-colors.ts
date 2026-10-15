import { CHART_PALETTE } from "./chart-data"

/* =============================================================================
 * Màu cho MỌI biểu đồ v2 — một nguồn duy nhất.
 *
 * Vì sao tồn tại file này: màu series/lát gõ hex tay rải rác ở nhiều file thì
 * mỗi lần đổi bảng màu lại phải sửa từng chỗ, và ô màu chú giải sớm muộn cũng
 * lệch khỏi màu series. Mọi biểu đồ lấy màu từ đây.
 *
 * ## Chọn nhóm nào?
 *
 * · `categoryColor(i)` — DANH MỤC không có thứ bậc (dự án, nguồn data, loại
 *   hợp đồng). Kẹp ở màu cuối chứ KHÔNG xoay
 *   vòng: bảng màu chỉ PASS kiểm mù màu chắc chắn ở 4 màu đầu, xoay vòng làm
 *   hạng mục thứ 7 trùng màu hạng mục thứ 1 mà không dấu hiệu nào.
 *
 * · `CHART_STATUS` — thang ĐÁNH GIÁ tốt/cần theo dõi/kém (tuân thủ SLA, đúng
 *   giờ/đi muộn/vắng, hạn hợp đồng còn xa/gần/đã hết). 3 màu này
 *   dành riêng cho nghĩa đánh giá: đừng lấy chúng tô những hạng mục KHÔNG mang
 *   nghĩa đánh giá. Thang đánh giá vẽ dạng cột/lát vẫn là chỗ dùng ĐÚNG.
 *   ⚠️ Màu trạng thái đi kèm NHÃN CHỮ, không bao giờ đứng một mình (WCAG 1.4.1).
 *
 * · `CHART_NEUTRAL` — ô "Khác", "Chưa xác định", "Không có dữ liệu". Cố ý xám để
 *   không tranh chỗ với hạng mục có nghĩa.
 * ========================================================================== */

/** Màu danh mục thứ `i`, KẸP ở màu cuối (không xoay vòng). */
export function categoryColor(i: number): string {
  return CHART_PALETTE[Math.min(Math.max(i, 0), CHART_PALETTE.length - 1)]
}

/** Thang đánh giá 3 mức — LUÔN kèm nhãn chữ. */
export const CHART_STATUS = {
  good: "var(--color-app-chart-good)",
  warn: "var(--color-app-chart-warn)",
  bad: "var(--color-app-chart-bad)",
} as const

/** "Khác" / "Chưa xác định" — xám, không tranh chỗ với hạng mục có nghĩa. */
export const CHART_NEUTRAL = "var(--color-app-tag-slate-ink)"

/**
 * 4 mức cảnh báo theo độ gấp (vd hạn hợp đồng ≤1 / 1–2 / 2–3 tháng).
 *
 * Dùng dải teal MỘT SẮC chứ không 3 màu rời: đây là ĐỘ LỚN của mức độ gấp, mà
 * dải một sắc là thứ mắt đọc được theo thứ tự mà không cần tra chú giải. Riêng
 * mức gấp nhất dùng màu `bad` vì nó là ngưỡng hành động, không phải "đậm hơn".
 */
export const CHART_URGENCY = {
  now: CHART_STATUS.bad,
  soon: CHART_STATUS.warn,
  later: "var(--color-app-chart-seq-4)",
  far: "var(--color-app-chart-seq-2)",
} as const

/** Chữ navy — dùng trên các màu nền SÁNG của bảng màu. */
const INK_DARK = "var(--color-app-navy)"
/** Chữ trắng — dùng trên các màu nền TỐI của bảng màu. */
const INK_LIGHT = "#ffffff"

/**
 * Màu chữ đọc được khi đặt SỐ ĐÈ LÊN một cột/lát đã tô màu.
 *
 * 🔴 KHÔNG có một màu chữ nào dùng chung được. Đo thật (WCAG, hex → sRGB tuyến
 * tính → độ chói) trên 6 màu danh mục + xám "Khác":
 *
 *   màu        trắng   navy   → chọn
 *   chart-1     3,39   4,89     navy
 *   chart-2     3,29   5,04     navy
 *   chart-3     5,14   3,22     TRẮNG
 *   chart-4     5,33   3,11     TRẮNG
 *   chart-5     3,47   4,78     navy
 *   chart-6     4,51   3,68     TRẮNG
 *   slate-ink   5,45   3,04     TRẮNG
 *
 * Tức `fill="#ffffff"` cứng — cách 4 biểu đồ của v2 đang làm trước đợt này —
 * đẩy 3 trong 7 màu xuống 3,29–3,47:1, dưới AA. Bảng trên được test khoá.
 *
 * ⚠️ Màu KHÔNG nằm trong bảng trả về navy. Đó là phỏng đoán an toàn cho nền
 * sáng nhưng KHÔNG phải bảo đảm: truyền màu tự chế vào rồi in số đè lên là tự
 * quay lại đúng lỗi này. Cách chắc chắn nhất vẫn là đặt số NGOÀI cột như
 * `ShellBarH` làm.
 */
export function inkOn(color: string): string {
  return INK_ON[color] ?? INK_DARK
}

const INK_ON: Record<string, string> = {
  [CHART_PALETTE[0]]: INK_DARK,
  [CHART_PALETTE[1]]: INK_DARK,
  [CHART_PALETTE[2]]: INK_LIGHT,
  [CHART_PALETTE[3]]: INK_LIGHT,
  [CHART_PALETTE[4]]: INK_DARK,
  [CHART_PALETTE[5]]: INK_LIGHT,
  [CHART_NEUTRAL]: INK_LIGHT,
  [CHART_STATUS.good]: INK_LIGHT,
  [CHART_STATUS.warn]: INK_LIGHT,
  [CHART_STATUS.bad]: INK_LIGHT,
}

/**
 * Màu cho thanh XẾP HẠNG — MỘT sắc, không phải dải tuần tự.
 *
 * Không dùng `withSequentialColors` (dải teal 7 bậc) vì hai vấn đề đo
 * được: (1) 4/7 bậc dưới 3:1 trên nền thẻ trắng (seq-1 1,21 · seq-2 1,46 ·
 * seq-3 1,84 · seq-4 2,42), tức hạng 4 trở xuống gần như vô hình; (2) chỉ số
 * bị KẸP ở bậc cuối nên khi có 9 mục thì 3 mục cuối cùng một màu nhạt nhất —
 * và mục nhạt nhất lại thường là "Khác", vốn là TỔNG của cả đuôi nên hay là
 * thanh DÀI NHẤT.
 *
 * Dải tuần tự chỉ dành cho biểu đồ phễu. Độ dài thanh đã mang thông tin thứ hạng rồi, tô 7 sắc chỉ thêm
 * một kênh mã hoá thừa mà lại hỏng tương phản.
 *
 * "Khác" đi màu xám để phân biệt với các hạng mục có tên thật.
 */
export function withRankColors<T extends { label: string; value: number }>(
  items: readonly T[],
  otherLabel = "Khác",
): (T & { color: string })[] {
  return items.map((item) => ({
    ...item,
    color: item.label === otherLabel ? CHART_NEUTRAL : CHART_PALETTE[0],
  }))
}
