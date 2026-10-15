"use client"

import { cn } from "@/lib/utils"

/* =============================================================================
 * Vành khuyên (donut) — "Cơ cấu đơn hàng theo sản
 * phẩm", "Tỷ lệ chốt deal". Vẽ bằng SVG thuần; lý do không
 * dùng thư viện biểu đồ ghi ở `bar-h.tsx`.
 *
 * Cách vẽ: mỗi lát là một `<circle>` cùng tâm, tô bằng `stroke-dasharray`
 * (phần hiện = độ dài cung) + `stroke-dashoffset` (điểm bắt đầu). Xoay -90°
 * để lát đầu bắt đầu từ 12 giờ như thiết kế.
 *
 * ⚠️ Chú giải KHÔNG chỉ có chấm màu — mỗi mục luôn kèm SỐ và %; đây là cùng
 * lý do với nút "Bảng" ở `chart-card.tsx`: không bắt người đọc phân biệt
 * màu mới lấy được thông tin.
 * ========================================================================== */

export interface ShellDonutItem {
  label: string
  value: number
  color: string
}

export interface ShellDonutProps {
  items: ShellDonutItem[]
  size?: number
  thickness?: number
  /** Chữ lớn giữa vòng (vd "53%"). */
  centerValue?: string
  /** Chữ nhỏ dưới `centerValue`. */
  centerLabel?: string
  /** Ẩn chú giải (khi vòng chỉ để đọc số ở giữa). */
  hideLegend?: boolean
  formatValue?: (v: number) => string
  className?: string
}

const DEFAULT_FORMAT = (v: number) => Math.round(v).toLocaleString("vi-VN")

export function ShellDonut({
  items,
  size = 188,
  thickness = 26,
  centerValue,
  centerLabel,
  hideLegend = false,
  formatValue = DEFAULT_FORMAT,
  className,
}: ShellDonutProps) {
  let total = 0
  for (const i of items) if (Number.isFinite(i.value) && i.value > 0) total += i.value

  const r = (size - thickness) / 2
  const circumference = 2 * Math.PI * r
  let acc = 0

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="presentation">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--color-app-chart-grid)"
            strokeWidth={thickness}
          />
          {total > 0 &&
            items.map((item) => {
              if (!(item.value > 0)) return null
              const frac = item.value / total
              const dash = frac * circumference
              const offset = -acc * circumference
              acc += frac
              return (
                <circle
                  key={item.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={offset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              )
            })}
        </svg>
        {(centerValue || centerLabel) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            {centerValue && (
              <span className="text-[26px] font-bold leading-none tabular-nums text-[var(--color-app-navy)]">
                {centerValue}
              </span>
            )}
            {centerLabel && (
              <span className="mt-1 text-[14px] text-[var(--color-app-ink-2)]">
                {centerLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {!hideLegend && (
        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1.5">
          {items.map((item) => {
            const pct = total > 0 ? Math.round((item.value / total) * 100) : 0
            return (
              <li
                key={item.label}
                className="flex items-center gap-1.5 text-[14px] text-[var(--color-app-ink-2)]"
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: item.color }}
                />
                <span>{item.label}</span>
                <span className="font-semibold tabular-nums text-[var(--color-app-navy)]">
                  {formatValue(item.value)}
                </span>
                <span className="tabular-nums">({pct}%)</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
