"use client"

import { cn } from "@/lib/utils"
import {
  formatChartNumber,
  niceCeil,
  niceTicks,
  CHART_PALETTE,
} from "./chart-data"
import { ShellPlotFrame } from "./plot-frame"
import { barVAriaSummary } from "./chart-aria"

/* =============================================================================
 * Cột DỌC — nhóm cạnh nhau (vd doanh số so với mục tiêu) hoặc xếp chồng (vd
 * doanh số theo bước pipeline). Vẽ bằng DOM + CSS, không SVG — cột là hình
 * chữ nhật, không cần đường cong.
 *
 * Khác `ShellBarH` (thanh ngang) ở chỗ dùng cho trục thời gian/hạng mục NGẮN
 * (tháng, giờ). Hạng mục là TÊN DÀI (khách hàng, nhân viên, lý do) thì dùng
 * `ShellBarH` — tên nằm ngang đọc được, còn ở đây sẽ phải xoay chữ.
 * ========================================================================== */

export interface ShellBarVSeries {
  name: string
  values: number[]
  /** Mặc định lấy theo thứ tự bảng màu danh mục. */
  color?: string
}

export interface ShellBarVProps {
  categories: string[]
  series: ShellBarVSeries[]
  /** Xếp chồng thay vì đặt cạnh nhau (tổng mỗi cột = tổng các series). */
  stacked?: boolean
  height?: number
  formatValue?: (v: number) => string
  className?: string
}

/**
 * Màu mặc định theo series — KHÔNG xoay vòng.
 *
 * `CHART_PALETTE` chỉ PASS kiểm mù màu chắc chắn ở 4 màu đầu; xoay vòng
 * (`i % 4`) làm series thứ 5 dùng lại đúng màu series thứ 1 mà không dấu hiệu
 * nào. Kẹp chỉ số như `withCategoryColors` để series thừa dùng chung màu cuối
 * — vẫn sai về danh mục, nhưng sai LỘ RA thay vì giả vờ đúng.
 */
const seriesColor = (custom: string | undefined, i: number) =>
  custom ?? CHART_PALETTE[Math.min(i, CHART_PALETTE.length - 1)]

/** Bề rộng cụm cột trong một dải, mirror `columnWidth: '52%'` của thiết kế. */
const BAND_FILL_PCT = 56

export function ShellBarV({
  categories,
  series,
  stacked = false,
  height = 230,
  formatValue = formatChartNumber,
  className,
}: ShellBarVProps) {
  const top = niceCeil(columnTotals(categories.length, series, stacked))
  const ticks = niceTicks(top)

  return (
    <div className={cn("w-full", className)}>
      <ShellPlotFrame
        categories={categories}
        ticks={ticks}
        formatAxis={formatValue}
        xAlign="band"
        height={height}
      >
        <div
          className="absolute inset-0 flex items-end"
          role="img"
          aria-label={barVAriaSummary(categories, series, stacked, formatValue)}
        >
          {categories.map((cat, ci) => (
            <div key={`${cat}-${ci}`} className="flex h-full flex-1 items-end justify-center">
              <div
                className={cn(
                  "flex h-full",
                  stacked ? "flex-col-reverse justify-start" : "items-end gap-[2px]",
                )}
                style={{ width: `${BAND_FILL_PCT}%` }}
              >
                {series.map((s, si) => {
                  const raw = s.values[ci]
                  const v = Number.isFinite(raw) && raw > 0 ? raw : 0
                  const pct = top > 0 ? (v / top) * 100 : 0
                  return (
                    <div
                      key={`${s.name}-${si}`}
                      title={`${cat} · ${s.name}: ${formatValue(v)}`}
                      className={cn(
                        "w-full",
                        // Bo góc ĐẦU CỘT: cụm nhóm bo mỗi cột, cụm xếp chồng
                        // chỉ bo lát trên cùng — mirror `borderRadiusApplication:'end'`.
                        stacked
                          ? si === series.length - 1 && "rounded-t-[3px]"
                          : "rounded-t-[3px]",
                      )}
                      style={{
                        height: `${pct}%`,
                        background: seriesColor(s.color, si),
                        /* Sàn 2px CHỈ cho cụm nhóm: giá trị nhỏ mà không có sàn
                           thì cột biến mất hẳn, đọc nhầm thành 0. KHÔNG áp cho
                           cụm xếp chồng — cộng sàn vào từng lát sẽ đẩy tổng cột
                           cao hơn tổng thật, tức biểu đồ nói sai con số. */
                        minHeight: !stacked && v > 0 ? 2 : undefined,
                      }}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
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
                className="size-2.5 shrink-0 rounded-[3px]"
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

/**
 * Giá trị quyết định cận trên trục: cụm xếp chồng lấy TỔNG mỗi cột, cụm nhóm
 * lấy từng giá trị rời. Lấy nhầm ở ca xếp chồng thì đỉnh cột vượt ra ngoài
 * khung vẽ.
 */
export function columnTotals(
  count: number,
  series: readonly ShellBarVSeries[],
  stacked: boolean,
): number[] {
  if (!stacked) {
    // Cắt theo `count`: series dài hơn danh sách nhãn 1 phần tử sẽ thổi cận
    // trên lên, làm MỌI cột thấp đi mà không dấu hiệu nào.
    const flat: number[] = []
    for (const s of series) for (const v of s.values.slice(0, count)) flat.push(v)
    return flat
  }
  const totals: number[] = []
  for (let i = 0; i < count; i++) {
    let sum = 0
    for (const s of series) {
      const v = s.values[i]
      if (Number.isFinite(v) && v > 0) sum += v
    }
    totals.push(sum)
  }
  return totals
}
