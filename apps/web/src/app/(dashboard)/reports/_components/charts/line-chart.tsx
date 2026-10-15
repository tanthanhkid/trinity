"use client"

import { useMemo } from "react"
import { useMeasuredWidth } from "@/components/app-shell/charts/use-measured-width"

export interface LineSeries {
  key: string
  label: string
  color: string
  values: number[]
}

interface Props {
  labels: string[]
  series: LineSeries[]
  height?: number
  yFormat?: (v: number) => string
}

/**
 * Line chart SVG inline — không phụ thuộc thư viện ngoài.
 * Dùng cho các biểu đồ đường trong báo cáo.
 *
 * Quy ước:
 * - `labels.length` = số điểm trên trục X
 * - mỗi series có `values.length === labels.length`
 * - vẽ trục Y 4 mức theo max value, tooltip hover theo điểm
 */
export function LineChart({ labels, series, height = 240, yFormat }: Props) {
  const formatY = yFormat ?? ((v: number) => v.toLocaleString("vi-VN"))
  const maxValue = useMemo(() => {
    let m = 0
    for (const s of series) for (const v of s.values) if (v > m) m = v
    return m === 0 ? 1 : m
  }, [series])

  // Bề rộng viewBox = bề rộng thật của khung (1 đơn vị = 1px) ⇒ chữ trục 14px thật.
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>(720, 480)
  const padX = 52
  const padY = 20
  /** chừa riêng đáy cho nhãn trục X 14px — không thì nhãn ngày đè lên số 0 của trục Y */
  const padBottom = 34
  const innerW = width - padX * 2
  const innerH = height - padY - padBottom
  const stepX = labels.length > 1 ? innerW / (labels.length - 1) : 0

  const yTicks = 4
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((maxValue / yTicks) * i),
  )

  const toX = (i: number) => padX + i * stepX
  const toY = (v: number) => padY + innerH - (v / maxValue) * innerH

  const buildPath = (values: number[]) =>
    values
      .map((v, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toY(v)}`)
      .join(" ")

  if (labels.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        Không có dữ liệu
      </div>
    )
  }

  return (
    <div ref={boxRef} className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block min-w-[480px] w-full"
        role="img"
      >
        {tickValues.map((tv, i) => {
          const y = toY(tv)
          return (
            <g key={`grid-${i}`}>
              <line
                x1={padX}
                x2={width - padX}
                y1={y}
                y2={y}
                stroke="var(--color-app-chart-grid)"
                strokeDasharray="3 3"
              />
              <text
                x={padX - 6}
                y={y + 5}
                fontSize={14}
                textAnchor="end"
                fill="var(--color-app-ink-2)"
              >
                {formatY(tv)}
              </text>
            </g>
          )
        })}

        {labels.map((label, i) => {
          const showEvery = Math.max(1, Math.ceil(labels.length / 8))
          if (i % showEvery !== 0 && i !== labels.length - 1) return null
          return (
            <text
              key={`xlabel-${i}`}
              x={toX(i)}
              y={height - 2}
              fontSize={14}
              textAnchor="middle"
              fill="var(--color-app-ink-2)"
            >
              {label}
            </text>
          )
        })}

        {series.map((s) => (
          <g key={s.key}>
            <path
              d={buildPath(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
            />
            {s.values.map((v, i) => (
              <circle
                key={`${s.key}-${i}`}
                cx={toX(i)}
                cy={toY(v)}
                r={2.5}
                fill={s.color}
              >
                <title>{`${labels[i]} • ${s.label}: ${formatY(v)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-sm">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
