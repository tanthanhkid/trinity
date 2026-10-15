"use client"

import { useId } from "react"
import { cn } from "@/lib/utils"
import {
  formatChartNumber,
  monotonePath,
  niceCeil,
  niceTicks,
  CHART_PALETTE,
  type PlotPoint,
} from "./chart-data"
import { ShellPlotFrame } from "./plot-frame"
import { areaAriaSummary } from "./chart-aria"

/* =============================================================================
 * Biểu đồ VÙNG/ĐƯỜNG theo thời gian — "Khách mới theo ngày".
 * Vẽ bằng SVG thuần; lý do không kéo thư viện biểu đồ ghi ở `bar-h.tsx`.
 *
 * 🔴 CHỈ dùng khi BE thật sự trả một CHUỖI theo thời gian. Không ghép 2 con số
 * rời thành "xu hướng" — đó là lý do thẻ chỉ số ở `/dashboard` dùng
 * `ShellMiniBars` (cặp cột hôm qua/hôm nay) chứ không dùng component này.
 * Ví dụ endpoint có chuỗi thật: `/reports/conversion → by_month[]`.
 *
 * Đường cong dùng `monotonePath` — mềm như thiết kế nhưng KHÔNG vẽ ra giá trị
 * ngoài khoảng dữ liệu thật (xem docblock của hàm đó).
 * ========================================================================== */

export interface ShellAreaSeries {
  name: string
  values: number[]
  /** Mặc định lấy theo thứ tự bảng màu danh mục. */
  color?: string
}

export interface ShellAreaProps {
  /** Nhãn trục X — độ dài phải khớp `values` của mọi series. */
  categories: string[]
  series: ShellAreaSeries[]
  height?: number
  /** Định dạng số trong `aria-label` + nhãn trục Y. */
  formatValue?: (v: number) => string
  className?: string
}

/** Màu mặc định theo series, KẸP chứ không xoay vòng — lý do ở `bar-v.tsx`. */
const seriesColor = (custom: string | undefined, i: number) =>
  custom ?? CHART_PALETTE[Math.min(i, CHART_PALETTE.length - 1)]

export function ShellArea({
  categories,
  series,
  height = 230,
  formatValue = formatChartNumber,
  className,
}: ShellAreaProps) {
  const gradientId = useId()
  const n = categories.length

  // Cận trên chung cho MỌI series — vẽ nhiều series trên 2 trục khác nhau là
  // cách kinh điển để 2 đường trông như cắt nhau trong khi không hề.
  // `slice(0, n)` giống lúc dựng điểm: series dài hơn danh sách nhãn sẽ thổi
  // cận trên lên và ép cả đường xuống thấp, im lặng.
  const all: number[] = []
  for (const s of series) for (const v of s.values.slice(0, n)) all.push(v)
  const top = niceCeil(all)
  const ticks = niceTicks(top)

  const xAt = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const yAt = (v: number) => {
    const safe = Number.isFinite(v) && v > 0 ? v : 0
    return 100 - Math.min(100, (safe / top) * 100)
  }

  return (
    <div className={cn("w-full", className)}>
      <ShellPlotFrame
        categories={categories}
        ticks={ticks}
        formatAxis={formatValue}
        xAlign="point"
        height={height}
      >
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={areaAriaSummary(categories, series, formatValue)}
        >
          <defs>
            {series.map((s, si) => {
              const color = seriesColor(s.color, si)
              return (
                <linearGradient
                  key={`${s.name}-${si}`}
                  id={`${gradientId}-${si}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  {/* Mirror `fill.gradient` của thiết kế: .28 → .02 */}
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="92%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              )
            })}
          </defs>

          {series.map((s, si) => {
            const color = seriesColor(s.color, si)
            const points: PlotPoint[] = s.values
              .slice(0, n)
              .map((v, i) => ({ x: xAt(i), y: yAt(v) }))
            if (points.length === 0) return null
            const line = monotonePath(points)

            // 1 điểm thì không có đường — vẽ một chấm để ô không trống trơn.
            // 🔴 Dùng <line> dài 0 + đầu bo tròn CHỨ KHÔNG <circle>: vùng vẽ bị
            // kéo ngang theo bề rộng cha nên `r` của circle ra hình bầu dục
            // (khung 600×230 ⇒ 8,4×3,2 px), và `vector-effect` không cứu được
            // vì circle tô bằng `fill`, không phải nét. Đầu nét bo tròn thì
            // luôn tròn vì nét đã được ghim non-scaling.
            if (points.length === 1) {
              return (
                <line
                  key={`${s.name}-${si}`}
                  x1={points[0].x}
                  y1={points[0].y}
                  x2={points[0].x}
                  y2={points[0].y}
                  stroke={color}
                  strokeWidth={6}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )
            }

            return (
              <g key={`${s.name}-${si}`}>
                <path
                  d={`${line} L${points[points.length - 1].x},100 L${points[0].x},100 Z`}
                  fill={`url(#${gradientId}-${si})`}
                  stroke="none"
                />
                <path
                  d={line}
                  fill="none"
                  stroke={color}
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  /* Ghim nét: vùng vẽ bị kéo ngang theo bề rộng cha, không có
                     thuộc tính này thì nét dày mỏng khác nhau tuỳ màn hình. */
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })}
        </svg>
      </ShellPlotFrame>

      {series.length > 1 && (
        <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
          {series.map((s, si) => (
            <li
              key={`${s.name}-${si}`}
              className="flex items-center gap-1.5 text-[14px] text-[var(--color-app-ink-2)]"
            >
              <span
                aria-hidden
                className="h-0.5 w-3.5 shrink-0 rounded-full"
                style={{
                  background: seriesColor(s.color, si),
                }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
