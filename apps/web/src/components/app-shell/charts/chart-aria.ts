/* =============================================================================
 * Câu mô tả cho TRÌNH ĐỌC MÀN HÌNH của các biểu đồ v2.
 *
 * Gom về một chỗ vì đây là một mối quan tâm duy nhất và rất dễ viết sai theo
 * cùng một kiểu: đọc ra một con số KHÔNG TỒN TẠI trong biểu đồ (vd cộng "Doanh
 * số thực đạt" với "Mục tiêu" ở cụm cột nhóm — không có ở cột nào, cũng không
 * có trong bảng số).
 *
 * Nguyên tắc chung cho mọi hàm ở đây:
 *   · CHỈ đọc con số CÓ THẬT trong dữ liệu, kèm nhãn để biết nó thuộc về đâu.
 *   · KHÔNG đọc hết 14–30 điểm (nghe như đọc số điện thoại) — số chính xác
 *     lấy ở nút "Bảng" của `ShellChartCard`, đó là phân vai giữa biểu đồ và bảng.
 * ========================================================================== */

import type { ShellAreaSeries } from "./area"
import type { ShellBarVSeries } from "./bar-v"
import { columnTotals } from "./bar-v"

/**
 * Câu mô tả cho trình đọc màn hình: tên series + khoảng thời gian + đỉnh.
 * KHÔNG đọc hết 14–30 điểm (nghe như đọc số điện thoại) — số chính xác lấy ở
 * nút "Bảng" của `ShellChartCard`, đúng phân vai đã chốt cho mọi biểu đồ v2.
 */
export function areaAriaSummary(
  categories: string[],
  series: ShellAreaSeries[],
  format: (v: number) => string,
): string {
  if (categories.length === 0) return "Biểu đồ đường: không có dữ liệu"
  const range = `từ ${categories[0]} đến ${categories[categories.length - 1]}`
  const parts = series.map((s) => {
    let max = 0
    let at = 0
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i]
      if (Number.isFinite(v) && v > max) {
        max = v
        at = i
      }
    }
    return `${s.name}: cao nhất ${format(max)} tại ${categories[at] ?? "?"}`
  })
  return `Biểu đồ đường ${categories.length} mốc, ${range}. ${parts.join("; ")}.`
}

/** Mô tả ngắn cho trình đọc màn hình; số chính xác nằm ở nút "Bảng". */
export function barVAriaSummary(
  categories: string[],
  series: ShellBarVSeries[],
  stacked: boolean,
  format: (v: number) => string,
): string {
  if (categories.length === 0) return "Biểu đồ cột: không có dữ liệu"
  const names = series.map((s) => s.name).join(", ")
  const head =
    `Biểu đồ ${stacked ? "cột xếp chồng" : "cột"} ${categories.length} hạng mục` +
    `, ${series.length} chỉ số: ${names}.`

  // 🔴 Cụm NHÓM tuyệt đối KHÔNG đọc tổng các series: "Doanh số thực đạt" +
  // "Mục tiêu" cộng lại ra một con số không tồn tại ở cột nào, cũng không có
  // trong bảng số của thẻ — trình đọc màn hình nghe một số bịa. Chỉ cụm XẾP
  // CHỒNG mới có khái niệm tổng cột.
  if (stacked) {
    const totals = columnTotals(categories.length, series, true)
    const at = indexOfMax(totals)
    return `${head} Cột cao nhất ${categories[at]} với tổng ${format(totals[at])}.`
  }

  let best = { value: 0, cat: categories[0], name: names }
  for (const s of series) {
    for (let i = 0; i < Math.min(s.values.length, categories.length); i++) {
      const v = s.values[i]
      if (Number.isFinite(v) && v > best.value) {
        best = { value: v, cat: categories[i], name: s.name }
      }
    }
  }
  return `${head} Giá trị lớn nhất: ${best.name} tại ${best.cat} với ${format(best.value)}.`
}

/** Vị trí phần tử lớn nhất; mảng rỗng/toàn 0 → 0 (caller đã chặn rỗng). */
function indexOfMax(values: readonly number[]): number {
  let at = 0
  for (let i = 1; i < values.length; i++) if (values[i] > values[at]) at = i
  return at
}
