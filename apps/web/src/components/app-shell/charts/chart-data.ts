/* =============================================================================
 * Hàm THUẦN chuẩn bị dữ liệu cho biểu đồ v2. Tách khỏi component
 * để unit test khoá được — phần dễ sai của biểu đồ là số, không phải SVG.
 * ========================================================================== */

/**
 * Nhóm hàng nghìn kiểu Việt cho MỌI con số trên biểu đồ v2.
 *
 * Lưu ý: quy ước của dự án cấm `toLocale*` cho NGÀY
 * (`Date.prototype.toLocaleString` phụ thuộc locale máy nên lệch giữa trình
 * duyệt ⇒ phải dùng `formatDate`/`formatDateTimeVn`). Ở đây là
 * `Number.prototype.toLocaleString` có TRUYỀN locale tường minh `"vi-VN"`,
 * chỉ làm mỗi việc chèn dấu phân cách hàng nghìn — không có mặt lịch/múi giờ
 * nào tham gia. `lib/format.ts` không có hàm tương đương cho số (chỉ có
 * `formatCurrency*` đã kèm ký hiệu tiền).
 */
export function formatChartNumber(v: number): string {
  return Math.round(v).toLocaleString("vi-VN")
}

/** 6 màu danh mục, ĐÚNG thứ tự (xem `styles/app-tokens.css`). */
export const CHART_PALETTE = [
  "var(--color-app-chart-1)",
  "var(--color-app-chart-2)",
  "var(--color-app-chart-3)",
  "var(--color-app-chart-4)",
  "var(--color-app-chart-5)",
  "var(--color-app-chart-6)",
] as const

/** Dải MỘT SẮC teal — chỉ dùng cho ĐỘ LỚN/thứ hạng, không cho danh mục. */
export const CHART_SEQ = [
  "var(--color-app-chart-seq-7)",
  "var(--color-app-chart-seq-6)",
  "var(--color-app-chart-seq-5)",
  "var(--color-app-chart-seq-4)",
  "var(--color-app-chart-seq-3)",
  "var(--color-app-chart-seq-2)",
  "var(--color-app-chart-seq-1)",
] as const

/**
 * Cùng 7 màu, nhưng NHẠT → ĐẬM.
 *
 * 🔴 `CHART_SEQ` cố ý xếp ĐẬM TRƯỚC vì nó phục vụ XẾP HẠNG (hạng 1 đậm
 * nhất). Heatmap thì ngược: giá trị càng lớn ô càng đậm. Dùng thẳng
 * `CHART_SEQ` cho heatmap là tô giá trị lớn thành màu nhạt — hình nói
 * ngược hẳn số, và không lỗi nào phát ra. Dẫn xuất từ chính mảng gốc để 7 màu
 * chỉ có MỘT nguồn, đổi bảng màu không phải sửa 2 nơi.
 */
export const CHART_SEQ_ASC = [...CHART_SEQ].reverse() as readonly string[]

export interface Sliceable {
  label: string
  value: number
}

/**
 * Giữ `max` lát lớn nhất, gộp phần đuôi thành một lát "Khác".
 *
 * 🔴 Đây là YÊU CẦU của bảng màu, không phải ý thích: bộ 6 màu chỉ PASS kiểm mù màu
 * chắc chắn ở 4 màu đầu (còn một cảnh báo CVD ở cặp thứ 5–6, chỉ chạm tới khi vẽ
 * quá 4 series — mà quá 4 thì phải gộp "Khác"). Vẽ 6 lát màu là đi thẳng vào
 * cặp màu mà validator đã cảnh báo.
 *
 * Lát "Khác" chỉ sinh ra khi đuôi có giá trị > 0 — không thêm một lát 0 vào
 * chú giải.
 */
export function takeTopWithOther<T extends Sliceable>(
  items: readonly T[],
  max = 4,
  otherLabel = "Khác",
): Sliceable[] {
  const sorted = [...items].sort((a, b) => b.value - a.value)
  if (sorted.length <= max) return sorted.map((i) => ({ label: i.label, value: i.value }))
  const head = sorted.slice(0, max).map((i) => ({ label: i.label, value: i.value }))
  let rest = 0
  for (const i of sorted.slice(max)) rest += i.value
  return rest > 0 ? [...head, { label: otherLabel, value: rest }] : head
}

/** Gắn màu danh mục theo đúng thứ tự bảng màu (không xoay vòng quá 6). */
export function withCategoryColors<T extends Sliceable>(
  items: readonly T[],
): (T & { color: string })[] {
  return items.map((item, i) => ({
    ...item,
    color: CHART_PALETTE[Math.min(i, CHART_PALETTE.length - 1)],
  }))
}

/** Gắn dải teal theo THỨ HẠNG (đậm nhất ở trên) — cho thanh xếp hạng. */
export function withSequentialColors<T extends Sliceable>(
  items: readonly T[],
): (T & { color: string })[] {
  return items.map((item, i) => ({
    ...item,
    color: CHART_SEQ[Math.min(i, CHART_SEQ.length - 1)],
  }))
}
/**
 * Cận trên "đẹp" cho trục: làm tròn lên theo bậc 1/2/5×10^n.
 *
 * Dùng vòng lặp chứ KHÔNG `Math.max(...values)`: trải mảng thành tham số
 * hàm có trần ngăn xếp. Ở đây mảng luôn nhỏ, nhưng helper này dễ bị copy sang
 * chỗ có mảng lớn nên giữ dạng an toàn ngay từ đầu.
 */
export function niceCeil(values: readonly number[]): number {
  let max = 0
  for (const v of values) if (Number.isFinite(v) && v > max) max = v
  if (max <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(max))
  const norm = max / pow
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * pow
}

/**
 * Các mốc trục — LUÔN chia hết, không có 2 mốc trùng nhau sau khi làm tròn.
 *
 * Chia thẳng `max/(ticks-1)` rồi `Math.round` từng mốc sẽ in ra
 * **"0 | 0 | 1 | 1 | 1"** khi `max` nhỏ (rất phổ biến — mỗi bước ≤2 deal,
 * "Lý do thất bại" 1–5 deal), nên ở đây chọn số vạch LỚN NHẤT (≤ `maxTicks`) mà `max` chia hết cho, nên bước
 * luôn nguyên. Ví dụ (`maxTicks=5` chặn ở 5 mốc, 6 mốc không bao giờ được xét):
 *
 *   niceTicks(1)   → [0, 1]
 *   niceTicks(2)   → [0, 1, 2]
 *   niceTicks(5)   → [0, 5]            ← chỉ 2 mốc
 *   niceTicks(50)  → [0, 25, 50]
 *   niceTicks(500) → [0, 125, 250, 375, 500]
 *
 * `niceCeil` chỉ trả 1/2/5×10^n nên luôn tồn tại lựa chọn chia hết.
 */
export function niceTicks(max: number, maxTicks = 5): number[] {
  if (!(max > 0)) return [0]
  for (let count = maxTicks; count >= 2; count--) {
    const step = max / (count - 1)
    if (Number.isInteger(step)) {
      return Array.from({ length: count }, (_, i) => step * i)
    }
  }
  return [0, max]
}

/* =============================================================================
 * Đường cong cho biểu đồ vùng/đường.
 * ========================================================================== */

export interface PlotPoint {
  x: number
  y: number
}

/**
 * Đường Bézier nội suy MONOTONE CUBIC qua các điểm (thuật toán Fritsch–Carlson).
 *
 * Spline "smooth" thông thường có thể VƯỢT BIÊN: giữa 2 mốc dữ liệu nó vẽ ra giá trị
 * KHÔNG TỒN TẠI — chuỗi 0 → 120 → 0 bị uốn xuống DƯỚI 0, tức biểu đồ báo cáo
 * hiển thị số âm ở nơi số thật là số đếm không âm. Ở màn ra quyết định thì đó
 * là bịa dữ liệu, không phải thẩm mỹ.
 *
 * Monotone cubic giữ dáng cong mềm nhưng có bảo đảm toán
 * học: đoạn nối 2 điểm không bao giờ ra ngoài khoảng [min, max] của chính 2
 * điểm đó. Bất biến này được khoá bằng test.
 *
 * Trả về chuỗi `d` của `<path>`; mảng rỗng → chuỗi rỗng (caller tự bỏ qua).
 */
export function monotonePath(points: readonly PlotPoint[]): string {
  const n = points.length
  if (n === 0) return ""
  if (n === 1) return `M${points[0].x},${points[0].y}`

  // Độ dốc từng đoạn.
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx)
  }

  // Tiếp tuyến tại từng điểm; đổi chiều dốc ⇒ tiếp tuyến 0 (không tạo bướu).
  const tangents: number[] = new Array(n)
  tangents[0] = slopes[0]
  tangents[n - 1] = slopes[n - 2]
  for (let i = 1; i < n - 1; i++) {
    tangents[i] =
      slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2
  }

  // Kẹp tiếp tuyến vào vòng tròn bán kính 3 — điều kiện đủ của Fritsch–Carlson
  // để đoạn cong đơn điệu, tức KHÔNG vượt ra ngoài khoảng 2 đầu mút.
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }
    const a = tangents[i] / slopes[i]
    const b = tangents[i + 1] / slopes[i]
    const s = a * a + b * b
    if (s > 9) {
      const f = 3 / Math.sqrt(s)
      tangents[i] = f * a * slopes[i]
      tangents[i + 1] = f * b * slopes[i]
    }
  }

  let d = `M${round(points[0].x)},${round(points[0].y)}`
  for (let i = 0; i < n - 1; i++) {
    const dx = (points[i + 1].x - points[i].x) / 3
    d +=
      `C${round(points[i].x + dx)},${round(points[i].y + tangents[i] * dx)}` +
      ` ${round(points[i + 1].x - dx)},${round(points[i + 1].y - tangents[i + 1] * dx)}` +
      ` ${round(points[i + 1].x)},${round(points[i + 1].y)}`
  }
  return d
}

/** Làm tròn 3 chữ số — đủ cho lưới 0–100 và giữ chuỗi `d` ngắn. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000
}
