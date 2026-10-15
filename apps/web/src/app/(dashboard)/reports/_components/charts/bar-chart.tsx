"use client"

import { useMemo } from "react"
import { useMeasuredWidth } from "@/components/app-shell/charts/use-measured-width"

export interface BarSeries {
  key: string
  label: string
  color: string
  values: number[]
}

interface Props {
  labels: string[]
  series: BarSeries[]
  height?: number
  yFormat?: (v: number) => string
  stacked?: boolean
  /**
   * chế độ NGANG (trục Y = labels, trục X = giá trị), label hiện ĐẦY ĐỦ
   * bên trái (không bị cắt/chồng khi label dài, vd tên Team). Mặc định `false`
   * (hành vi cũ, dọc) — KHÔNG đổi các nơi gọi khác.
   * Chỉ hỗ trợ single-series khi horizontal=true (đủ dùng cho use-case hiện tại).
 */
  horizontal?: boolean
}

/**
 * Bar chart SVG inline — không phụ thuộc thư viện ngoài.
 * Hỗ trợ single-series (vertical bars) và stacked multi-series.
 *
 * Quy ước:
 * - `labels.length` = số cột trên trục X (hoặc trục Y khi horizontal=true)
 * - mỗi series có `values.length === labels.length`
 * - stacked=true: bars xếp chồng per label bucket
 * - stacked=false (mặc định): bars cạnh nhau hoặc single-series
 * - horizontal=true: bars NGANG, chiều cao SVG tự giãn theo số lượng label
 */
export function BarChart({
  labels,
  series,
  height = 240,
  yFormat,
  stacked = false,
  horizontal = false,
}: Props) {
  const formatY = yFormat ?? ((v: number) => v.toLocaleString("vi-VN"))
  // Bề rộng viewBox = bề rộng thật của khung (1 đơn vị = 1px) ⇒ chữ 14px thật ở mọi cỡ khung.
  const [boxRef, measured] = useMeasuredWidth<HTMLDivElement>(720, 0)

  // `maxValue` PHẢI tính TRƯỚC mọi early-return (Rules of Hooks — số
  // lượng hook gọi phải cố định mỗi render, không được đặt useMemo sau `if`).
  const maxValue = useMemo(() => {
    if (stacked) {
      let m = 0
      for (let i = 0; i < labels.length; i++) {
        let sum = 0
        for (const s of series) sum += s.values[i] ?? 0
        if (sum > m) m = sum
      }
      return m === 0 ? 1 : m
    }
    let m = 0
    for (const s of series) for (const v of s.values) if (v > m) m = v
    return m === 0 ? 1 : m
  }, [series, labels.length, stacked])

  // chế độ NGANG: single-series only, label đầy đủ bên trái, chiều cao
  // tự giãn theo số lượng label. Early-return SAU mọi hook (đúng Rules of
  // Hooks) — KHÔNG đụng logic vertical bên dưới (hành vi mặc định
  // horizontal=false giữ nguyên 100% cho mọi nơi gọi khác).
  if (horizontal) {
    const hSeries = series[0]
    const hValues = hSeries?.values ?? []
    const hMax = Math.max(1, ...hValues.map((v) => v || 0))
    const hPadLeft = 8
    const hPadRight = 56
    const hRowH = 28
    const hRowGap = 8
    const hWidth = Math.max(320, measured)
    const hLabelW = Math.min(160, Math.round(hWidth * 0.34))
    const hBarAreaW = hWidth - hLabelW - hPadLeft - hPadRight
    const hHeight = Math.max(
      height,
      labels.length * (hRowH + hRowGap) + hRowGap,
    )
    const hColor = hSeries?.color ?? "var(--color-app-chart-1)"

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
          viewBox={`0 0 ${hWidth} ${hHeight}`}
          className="block min-w-[320px] w-full"
          role="img"
        >
          {labels.map((label, i) => {
            const v = hValues[i] ?? 0
            const y = hRowGap + i * (hRowH + hRowGap)
            const barW = (v / hMax) * hBarAreaW
            return (
              <g key={`hrow-${i}`}>
                <text
                  x={hLabelW}
                  y={y + hRowH / 2 + 4}
                  fontSize={14}
                  textAnchor="end"
                  fill="var(--color-app-navy)"
                >
                  {label}
                </text>
                <rect
                  x={hLabelW + hPadLeft}
                  y={y}
                  width={Math.max(0, barW)}
                  height={hRowH}
                  fill={hColor}
                  rx={3}
                >
                  <title>{`${label}: ${formatY(v)}`}</title>
                </rect>
                <text
                  x={hLabelW + hPadLeft + barW + 6}
                  y={y + hRowH / 2 + 4}
                  fontSize={14}
                  fontWeight={600}
                  textAnchor="start"
                  fill="var(--color-app-navy)"
                >
                  {formatY(v)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    )
  }

  const padX = 52
  const padY = 20
  const padBottom = 32
  const width = Math.max(480, measured)
  const innerW = width - padX * 2
  const innerH = height - padY - padBottom

  const yTicks = 4
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((maxValue / yTicks) * i),
  )

  const toY = (v: number) => padY + innerH - (v / maxValue) * innerH

  const bucketW = labels.length > 0 ? innerW / labels.length : 0
  const barGroupW = bucketW * 0.8
  const singleBarW = stacked
    ? barGroupW
    : series.length > 1
      ? barGroupW / series.length
      : Math.min(barGroupW, 32)

  const showEvery = Math.max(1, Math.ceil(labels.length / 8))

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
        {/* Grid lines + Y axis labels */}
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

        {/* X axis labels */}
        {labels.map((label, i) => {
          if (i % showEvery !== 0 && i !== labels.length - 1) return null
          const cx = padX + i * bucketW + bucketW / 2
          return (
            <text
              key={`xlabel-${i}`}
              x={cx}
              y={height - 8}
              fontSize={14}
              textAnchor="middle"
              fill="var(--color-app-ink-2)"
            >
              {label}
            </text>
          )
        })}

        {/* Bars */}
        {labels.map((label, i) => {
          const bucketX = padX + i * bucketW + (bucketW - barGroupW) / 2
          if (stacked) {
            let stackTop = 0
            return (
              <g key={`bucket-${i}`}>
                {[...series].reverse().map((s) => {
                  const v = s.values[i] ?? 0
                  const barH = (v / maxValue) * innerH
                  const y = toY(stackTop + v)
                  stackTop += v
                  return (
                    <rect
                      key={s.key}
                      x={bucketX}
                      y={y}
                      width={singleBarW}
                      height={barH}
                      fill={s.color}
                      rx={2}
                    >
                      <title>{`${label} • ${s.label}: ${formatY(v)}`}</title>
                    </rect>
                  )
                })}
              </g>
            )
          }
          return (
            <g key={`bucket-${i}`}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0
                const barH = (v / maxValue) * innerH
                const x =
                  bucketX +
                  (series.length > 1 ? si * singleBarW : (barGroupW - singleBarW) / 2)
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={toY(v)}
                    width={singleBarW - (series.length > 1 ? 1 : 0)}
                    height={barH}
                    fill={s.color}
                    rx={2}
                  >
                    <title>{`${label} • ${s.label}: ${formatY(v)}`}</title>
                  </rect>
                )
              })}
            </g>
          )
        })}
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
