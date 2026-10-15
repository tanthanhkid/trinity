"use client"

import { useMemo } from "react"

export interface DonutSlice {
  key: string
  label: string
  color: string
  value: number
}

interface Props {
  slices: DonutSlice[]
  size?: number
  innerLabel?: string
  valueFormat?: (v: number) => string
  /**
   * Hiện chú thích (legend) bên dưới biểu đồ. Mặc định `true` để giữ nguyên
   * hành vi cho các báo cáo (báo cáo, chấm công). Truyền `false`
   * khi nơi gọi đã có bảng chú thích riêng bên cạnh (vd Dashboard nhân sự) để
   * tránh trùng lặp chú thích.
 */
  showLegend?: boolean
}

/**
 * Donut chart SVG inline — không phụ thuộc thư viện ngoài.
 *
 * Quy ước:
 * - mỗi slice có value >= 0
 * - nếu tổng = 0 thì hiện empty state
 * - innerLabel: dòng text nhỏ ở trung tâm (vd: "Tổng")
 */
export function DonutChart({
  slices,
  size = 200,
  innerLabel,
  valueFormat,
  showLegend = true,
}: Props) {
  const formatVal = valueFormat ?? ((v: number) => v.toLocaleString("vi-VN"))

  const total = useMemo(
    () => slices.reduce((acc, s) => acc + s.value, 0),
    [slices],
  )

  const paths = useMemo(() => {
    if (total === 0) return []
    const cx = size / 2
    const cy = size / 2
    const r = size * 0.4
    const ri = size * 0.24

    const toXY = (pct: number, radius: number) => {
      const angle = (pct * 2 * Math.PI) - Math.PI / 2
      return {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      }
    }

    const result: { key: string; d: string; color: string }[] = []
    let cumulative = 0

    for (const s of slices) {
      if (s.value === 0) continue
      const pctStart = cumulative / total
      const pctEnd = (cumulative + s.value) / total

      let d: string
      if (pctEnd - pctStart >= 1) {
        // Single full-circle slice: SVG cannot draw arc from point back to same point.
        // Draw as two half-arcs to form a full donut ring.
        const top = toXY(0, r)
        const bottom = toXY(0.5, r)
        const iTop = toXY(0, ri)
        const iBottom = toXY(0.5, ri)
        d = [
          `M ${top.x.toFixed(2)} ${top.y.toFixed(2)}`,
          `A ${r} ${r} 0 1 1 ${bottom.x.toFixed(2)} ${bottom.y.toFixed(2)}`,
          `A ${r} ${r} 0 1 1 ${top.x.toFixed(2)} ${top.y.toFixed(2)}`,
          `M ${iTop.x.toFixed(2)} ${iTop.y.toFixed(2)}`,
          `A ${ri} ${ri} 0 1 0 ${iBottom.x.toFixed(2)} ${iBottom.y.toFixed(2)}`,
          `A ${ri} ${ri} 0 1 0 ${iTop.x.toFixed(2)} ${iTop.y.toFixed(2)}`,
          `Z`,
        ].join(" ")
      } else {
        const largeArc = pctEnd - pctStart > 0.5 ? 1 : 0
        const outerStart = toXY(pctStart, r)
        const outerEnd = toXY(pctEnd, r)
        const innerStart = toXY(pctEnd, ri)
        const innerEnd = toXY(pctStart, ri)
        d = [
          `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
          `A ${r} ${r} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
          `L ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
          `A ${ri} ${ri} 0 ${largeArc} 0 ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
          `Z`,
        ].join(" ")
      }

      result.push({ key: s.key, d, color: s.color })
      cumulative += s.value
    }
    return result
  }, [slices, total, size])

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ minHeight: size }}
      >
        Không có dữ liệu
      </div>
    )
  }

  const cx = size / 2
  const cy = size / 2

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        className="shrink-0"
      >
        {paths.map((p) => {
          const slice = slices.find((s) => s.key === p.key)
          const pct = slice ? ((slice.value / total) * 100).toFixed(1) : "0"
          return (
            <path key={p.key} d={p.d} fill={p.color} stroke="var(--card)" strokeWidth={1.5}>
              <title>
                {slice
                  ? `${slice.label}: ${formatVal(slice.value)} (${pct}%)`
                  : p.key}
              </title>
            </path>
          )
        })}

        {/* Center text */}
        <text
          x={cx}
          y={innerLabel ? cy - 2 : cy + 6}
          textAnchor="middle"
          fontSize={Math.max(16, size * 0.1)}
          fontWeight="600"
          fill="var(--color-app-navy)"
        >
          {formatVal(total)}
        </text>
        {innerLabel && (
          <text
            x={cx}
            y={cy + 16}
            textAnchor="middle"
            fontSize={14}
            fill="var(--color-app-ink-2)"
          >
            {innerLabel}
          </text>
        )}
      </svg>

      {showLegend && (
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
          {slices.map((s) => {
            const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : "0"
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-muted-foreground">
                  {s.label} <span className="text-foreground font-medium">{pct}%</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
