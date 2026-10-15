import { categoryColor, CHART_NEUTRAL } from "@/components/app-shell/charts/chart-colors"
/**
 * Helpers thuần (không React) cho khu "Phân tích nghỉ phép": bảng màu cố định + hình học SVG
 * cho donut faux-3D (gradient, label-line). Tách ra để unit-test độc lập.
 */

/** Bảng màu CỐ ĐỊNH cho 6 loại đơn — giữ nhất quán giữa các tháng. */
/**
 * 6 loại đơn — DANH MỤC, không phải thang đánh giá: "Nghỉ phép" và "Thai sản"
 * là quyền lợi hợp lệ, tô đỏ/cam như lỗi là nói sai về người lao động. Vì vậy
 * dùng bảng màu danh mục, KHÔNG dùng good/warn/bad.
 */
export const LEAVE_TYPE_COLORS: Record<string, string> = {
  forgot_check_in: categoryColor(0),
  forgot_check_out: categoryColor(1),
  late_arrival: categoryColor(2),
  early_leave: categoryColor(3),
  leave: categoryColor(4),
  maternity: categoryColor(5),
}

/** Màu giới tính (đồng bộ khối "So sánh giới tính" sẵn có). */
export const GENDER_COLORS: Record<"M" | "F" | "unknown", string> = {
  M: categoryColor(2),
  F: categoryColor(5),
  unknown: CHART_NEUTRAL,
}

/** Palette cho phòng ban (biểu đồ cột xếp chồng) — ổn định theo thứ tự đã sort. */
export const DEPARTMENT_PALETTE = Array.from({ length: 6 }, (_, i) => categoryColor(i))

export function departmentColor(index: number): string {
  // ⚠️ CÒN xoay vòng (`%`) vì số phòng ban do dữ liệu quyết định, không cắt
  // được ở FE. Quá 6 phòng thì phòng thứ 7 trùng màu phòng thứ 1 — đã có chú
  // giải tên kèm mỗi cột nên không mất thông tin, nhưng nếu tổ chức phình quá
  // 6 phòng thì nên gộp "Khác" ở tầng dữ liệu thay vì thêm màu.
  return DEPARTMENT_PALETTE[index % DEPARTMENT_PALETTE.length]
}

/** Màu cho loại đơn (fallback xám khi loại lạ). */
export function leaveTypeColor(type: string): string {
  return LEAVE_TYPE_COLORS[type] ?? CHART_NEUTRAL
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("")}`
}

/**
 * Trộn màu với trắng/đen để dựng mặt sáng–tối của khối faux-3D.
 *
 * 🔴 PHẢI xử lý được CẢ hex LẪN `var(--token)`. Nếu chỉ biết hex thì
 * `parseInt("va", 16)` → `NaN` → trả `#NaNNaNNaN`, và SVG tô chuỗi đó thành
 * ĐEN (không exception, không cảnh báo).
 *
 * Với `var()` không thể tính trong JS (giá trị chỉ tồn tại khi trình duyệt
 * cascade), nên đẩy phép trộn xuống CSS bằng `color-mix()` — trình duyệt tự
 * giải token rồi trộn. Hex vẫn đi đường số học cũ (0-diff cho mọi call-site
 * truyền hex, và không phụ thuộc `color-mix`).
 */
function mix(color: string, amount: number, towards: "white" | "black"): string {
  if (!color.startsWith("#")) {
    // `color-mix` nhận mọi giá trị màu CSS hợp lệ, kể cả `var(--…)`.
    return `color-mix(in srgb, ${towards} ${Math.round(amount * 100)}%, ${color})`
  }
  const [r, g, b] = parseHex(color)
  return towards === "white"
    ? toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount)
    : toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount))
}

/** Sáng hơn (mặt sáng của khối faux-3D). */
export function lighten(color: string, amount: number): string {
  return mix(color, amount, "white")
}

/** Tối hơn (mặt tối/đổ bóng của khối faux-3D). */
export function darken(color: string, amount: number): string {
  return mix(color, amount, "black")
}


/** Toạ độ trên đường tròn theo phân số chu vi (0 = 12h, thuận chiều kim đồng hồ). */
export function polarToXY(
  cx: number,
  cy: number,
  r: number,
  frac: number,
): { x: number; y: number } {
  const angle = frac * 2 * Math.PI - Math.PI / 2
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
}

/** Path 1 lát donut (vành dày) từ phân số bắt đầu → kết thúc. */
export function donutSlicePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startFrac: number,
  endFrac: number,
): string {
  // Một lát chiếm 100%: điểm đầu trùng điểm cuối nên cung SVG bị bỏ; cắt nhẹ để vẫn vẽ ra vành đầy.
  if (endFrac - startFrac >= 0.9999) endFrac = startFrac + 0.9999
  const largeArc = endFrac - startFrac > 0.5 ? 1 : 0
  const oS = polarToXY(cx, cy, rOuter, startFrac)
  const oE = polarToXY(cx, cy, rOuter, endFrac)
  const iS = polarToXY(cx, cy, rInner, endFrac)
  const iE = polarToXY(cx, cy, rInner, startFrac)
  return [
    `M ${oS.x.toFixed(2)} ${oS.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${oE.x.toFixed(2)} ${oE.y.toFixed(2)}`,
    `L ${iS.x.toFixed(2)} ${iS.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${iE.x.toFixed(2)} ${iE.y.toFixed(2)}`,
    "Z",
  ].join(" ")
}

/** Toạ độ đường dẫn nhãn (label-line) cho 1 lát: điểm trên cung → khuỷu → mốc text. */
export function labelLineGeometry(
  cx: number,
  cy: number,
  rOuter: number,
  midFrac: number,
): { p1: { x: number; y: number }; elbow: { x: number; y: number }; textX: number; textY: number; anchor: "start" | "end" } {
  const p1 = polarToXY(cx, cy, rOuter, midFrac)
  const elbow = polarToXY(cx, cy, rOuter + 12, midFrac)
  const onRight = elbow.x >= cx
  const textX = onRight ? elbow.x + 6 : elbow.x - 6
  return { p1, elbow, textX, textY: elbow.y, anchor: onRight ? "start" : "end" }
}

/**
 * Nền cục bộ cho SỐ/NHÃN đặt đè lên khối màu.
 *
 * 🔴 Không có màu chữ nào đọc được trên MỌI màu của bảng màu khi khối còn phủ
 * gradient — đo thật tại đúng vị trí chữ (giữa khối, ≈ `lighten(c, 0.11)`):
 * 4/7 màu cả trắng lẫn navy đều dưới AA 4,5:1 (chart-3 4,31/3,85 ·
 * chart-4 4,41/3,76 · chart-6 3,87/4,28 · xám 4,32/3,84). Đây đúng ca mà luật
 * dự án bảo "TÁCH CHỮ RA, đừng chỉnh từng màu".
 *
 * Tách rẻ nhất mà vẫn giữ nhãn tại chỗ: đặt chữ lên một mảng sáng cục bộ pha
 * 40% trắng với chính màu khối — navy trên đó thấp nhất vẫn 6,34:1 cho cả 7
 * màu, và mảng vẫn mang sắc của khối nên không cắt vụn thị giác.
 */
export const LABEL_CHIP_MIX = 0.4
