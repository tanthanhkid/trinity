"use client"

import { cn } from "@/lib/utils"
import { formatChartNumber, CHART_SEQ_ASC } from "./chart-data"

/* =============================================================================
 * MA TRẬN MẬT ĐỘ (heatmap) — "Việc quá hạn: ngày × bước", "Nguồn khách × Bước pipeline"
 * (một sắc teal, `enableShades`, bo góc 4).
 *
 * 🔴 Dựng bằng `<table>` THẬT, không phải lưới div tô màu. Heatmap là kiểu
 * biểu đồ mã hoá TOÀN BỘ thông tin bằng màu — người mù màu hoặc dùng trình đọc
 * màn hình sẽ không đọc được gì nếu ô chỉ có nền. Với `<table>`, trình đọc màn
 * hình đọc được đúng quan hệ "hàng × cột = giá trị" ngay tại chỗ, không phải
 * chờ bấm nút "Bảng" của `ShellChartCard`.
 *
 * Vì vậy MỖI Ô ĐỀU IN SỐ. Và vì số nằm TRÊN nền màu-theo-dữ-liệu, màu chữ
 * KHÔNG chọn theo ý thích mà theo độ đậm của ô: 5 bậc nhạt đầu của dải teal
 * dùng chữ navy, 2 bậc đậm cuối dùng chữ trắng — ranh giới ĐO được, xem bảng
 * số ngay dưới đây.
 * ========================================================================== */

/**
 * Chỉ số bậc ĐẦU TIÊN của `CHART_SEQ_ASC` phải dùng CHỮ TRẮNG.
 *
 * Số liệu ĐO bằng công thức WCAG (hex → sRGB tuyến tính → độ chói), không ước
 * lượng bằng mắt: chữ trắng trên `#0e9c93` (bậc 5) chỉ **3,39:1** (dưới AA 4,5).
 * Navy `#101b46` vs trắng `#ffffff` trên 7 bậc teal:
 *
 *   bậc  hex        navy   trắng   → chọn
 *   1    #d2efeb   13,64    1,21     navy
 *   2    #a9e0da   11,33    1,46     navy
 *   3    #77cec4    9,00    1,84     navy
 *   4    #42b8ac    6,85    2,42     navy
 *   5    #0e9c93    4,89    3,39     navy   ← vẫn navy, sát ngưỡng nhất
 *   6    #0a7f78    3,41    4,86     TRẮNG  ← điểm đảo
 *   7    #065c57    2,11    7,85     TRẮNG
 *
 * Ô rỗng (giá trị 0) nền `--color-app-surface-2` #f4f8fd, navy trên đó 15,54.
 * ⇒ mọi ô đều ≥ 4,5:1. Đổi dải `CHART_SEQ_ASC` thì PHẢI đo lại và chỉnh hằng
 * này.
 *
 * ⚠️ Bảng trên đánh số bậc từ 1 (cách người đọc nói); hằng dưới đây là CHỈ SỐ
 * MẢNG tính từ 0 — giá trị 5 nghĩa là bậc 6 `#0a7f78`, KHÔNG phải bậc 5.
 * Khoá ở `__tests__/app-shell/chart-primitives.test.ts` (render
 * thật rồi soi lớp CSS từng ô), không phải ở `contrast.test.ts`.
 */
const WHITE_INK_FROM_STEP = 5

export interface ShellHeatmapRow {
  label: string
  /** Giá trị theo đúng thứ tự `columns`; thiếu phần tử coi như 0. */
  values: number[]
}

export interface ShellHeatmapProps {
  /** Nhãn cột (trục ngang) — giờ, thứ, bước pipeline… */
  columns: string[]
  rows: ShellHeatmapRow[]
  formatValue?: (v: number) => string
  /** Nhãn cột đầu tiên (ô góc trên-trái). */
  rowHeader?: string
  className?: string
}

export function ShellHeatmap({
  columns,
  rows,
  formatValue = formatChartNumber,
  rowHeader = "",
  className,
}: ShellHeatmapProps) {
  // Chỉ xét phần CÓ CỘT: hàng dài hơn `columns` sẽ đẩy `max` lên, làm mọi ô
  // nhạt đi và chú giải in một giá trị không xuất hiện ở ô nào.
  let max = 0
  for (const r of rows) {
    for (const v of r.values.slice(0, columns.length)) {
      if (Number.isFinite(v) && v > max) max = v
    }
  }

  return (
    <div className={cn("w-full", className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[3px] text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className="px-1 pb-1 text-left font-semibold text-[var(--color-app-ink-2)]"
              >
                {rowHeader}
              </th>
              {columns.map((c, ci) => (
                <th
                  key={`${c}-${ci}`}
                  scope="col"
                  className="px-1 pb-1 text-center font-semibold text-[var(--color-app-ink-2)]"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={`${row.label}-${ri}`}>
                <th
                  scope="row"
                  className="whitespace-nowrap py-1 pr-2 text-left font-medium text-[var(--color-app-ink-2)]"
                >
                  {row.label}
                </th>
                {columns.map((c, ci) => {
                  const raw = row.values[ci]
                  const v = Number.isFinite(raw) && raw > 0 ? raw : 0
                  const step = shadeStep(v, max)
                  return (
                    <td
                      key={`${c}-${ci}`}
                      title={`${row.label} · ${c}: ${formatValue(v)}`}
                      className={cn(
                        "rounded-[4px] px-1.5 py-1.5 text-center tabular-nums",
                        step >= WHITE_INK_FROM_STEP
                          ? "font-semibold text-white"
                          : "text-[var(--color-app-navy)]",
                      )}
                      style={{ background: cellColor(v, max) }}
                    >
                      {formatValue(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Chú giải thang độ đậm — không có nó thì màu ô là thông tin không giải mã được */}
      <div className="mt-2.5 flex items-center justify-end gap-1.5 text-sm text-[var(--color-app-ink-2)]">
        <span>0</span>
        <span
          aria-hidden
          className="h-2.5 w-5 rounded-[3px]"
          style={{ background: "var(--color-app-surface-2)" }}
        />
        {CHART_SEQ_ASC.map((c) => (
          <span
            key={c}
            aria-hidden
            className="h-2.5 w-5 rounded-[3px]"
            style={{ background: c }}
          />
        ))}
        <span>{formatValue(max)}</span>
      </div>
    </div>
  )
}

/**
 * Bậc đậm của một ô: chia đều `[0, max]` thành 7 bậc của `CHART_SEQ_ASC`.
 *
 * Giá trị > 0 luôn được ít nhất bậc 0 (nhạt nhất) — ô có dữ liệu không bao giờ
 * trông giống hệt ô rỗng; ô bằng 0 đi nhánh riêng ở caller (nền xám trung tính).
 */
export function shadeStep(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0
  const idx = Math.ceil((value / max) * CHART_SEQ_ASC.length) - 1
  return Math.max(0, Math.min(CHART_SEQ_ASC.length - 1, idx))
}

/**
 * Màu nền của một ô — hàm THUẦN để test đi đúng đường component chạy.
 *
 * 🔴 Tách ra vì bản đầu của khối này tô NGƯỢC (giá trị lớn ra màu nhạt) do
 * dùng nhầm `CHART_SEQ` (mảng xếp ĐẬM TRƯỚC, dành cho xếp hạng). Test khoá
 * bất biến "giá trị lớn hơn ⇒ ô tối hơn" phải gọi ĐÚNG hàm này; nếu test tự
 * ghép `CHART_SEQ_ASC[shadeStep(...)]` thì đảo chỉ số ngay trong component
 * vẫn lọt.
 */
export function cellColor(value: number, max: number): string {
  if (!(value > 0)) return "var(--color-app-surface-2)"
  return CHART_SEQ_ASC[shadeStep(value, max)]
}
