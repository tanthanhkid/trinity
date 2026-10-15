"use client"

import { useId, useMemo } from "react"
import { darken, LABEL_CHIP_MIX, lighten } from "./leave-analytics-utils"
import { CHART_NEUTRAL } from "@/components/app-shell/charts/chart-colors"
import type { LeaveWeekBucket } from "@/hooks/use-attendance"

export interface LeaveBarSeries {
  department: string
  color: string
  values: number[] // length = weeks.length
}

interface Props {
  weeks: LeaveWeekBucket[]
  series: LeaveBarSeries[]
  height?: number
}

const W = 720
const PAD_L = 40
const PAD_R = 16
const PAD_T = 24
const PAD_B = 40

const DEPTH = 7

/**
 * Biểu đồ cột XẾP CHỒNG faux-3D (SVG inline): X = tuần, mỗi cột chồng theo phòng ban,
 * IN SỐ trực tiếp trong từng block màu. Gradient + mặt bên/đỉnh tối/sáng → khối 3D.
 */
export function LeaveStackedBar3D({ weeks, series, height = 300 }: Props) {
  const gid = useId().replace(/:/g, "")
  const H = height
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  const maxTotal = useMemo(() => {
    let m = 0
    for (let w = 0; w < weeks.length; w++) {
      let sum = 0
      for (const s of series) sum += s.values[w] ?? 0
      if (sum > m) m = sum
    }
    return m
  }, [weeks.length, series])

  if (weeks.length === 0 || maxTotal === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ minHeight: 160 }}
      >
        Không có dữ liệu nghỉ phép trong kỳ
      </div>
    )
  }

  const cols = weeks.length
  const slot = plotW / cols
  const barW = Math.min(slot * 0.5, 56)
  const baseY = PAD_T + plotH
  const yLen = (v: number) => (v / maxTotal) * plotH

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: baseY - f * plotH,
    v: Math.round(f * maxTotal),
  }))

  return (
    <div className="w-full">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          style={{ minWidth: 480 }}
        >
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${gid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lighten(s.color, 0.22)} />
                <stop offset="100%" stopColor={s.color} />
              </linearGradient>
            ))}
          </defs>

          {/* Lưới + nhãn trục Y */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD_L}
                y1={t.y}
                x2={W - PAD_R}
                y2={t.y}
                stroke="var(--color-app-chart-grid)"
                strokeWidth={1}
              />
              <text
                x={PAD_L - 6}
                y={t.y + 3}
                textAnchor="end"
                fontSize={14}
                fill="var(--color-app-ink-2)"
              >
                {t.v}
              </text>
            </g>
          ))}

          {weeks.map((week, w) => {
            const cx = PAD_L + slot * w + slot / 2
            const x = cx - barW / 2
            let cursorY = baseY
            let columnTotal = 0
            const blocks: React.ReactNode[] = []
            let topY = baseY
            let topColor = CHART_NEUTRAL

            series.forEach((s, si) => {
              const v = s.values[w] ?? 0
              if (v <= 0) return
              columnTotal += v
              const segH = yLen(v)
              const y = cursorY - segH
              topY = y
              topColor = s.color
              blocks.push(
                <g key={`${w}-${si}`}>
                  {/* Mặt bên phải (chiều sâu) */}
                  <path
                    d={`M ${x + barW} ${y} L ${x + barW + DEPTH} ${y - DEPTH} L ${x + barW + DEPTH} ${y + segH - DEPTH} L ${x + barW} ${y + segH} Z`}
                    fill={darken(s.color, 0.25)}
                  />
                  {/* Mặt trước */}
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={segH}
                    fill={`url(#${gid}-g${si})`}
                    stroke="var(--card)"
                    strokeWidth={0.75}
                  >
                    <title>{`${s.department} — ${week.label}: ${v}`}</title>
                  </rect>
                  {/* Số trong block (khi đủ cao) */}
                  {segH >= 18 && (
                    <>
                      <rect
                        x={x + barW / 2 - (String(v).length * 8.4 + 10) / 2}
                        y={y + segH / 2 - 10}
                        width={String(v).length * 8.4 + 10}
                        height={20}
                        rx={4}
                        fill={lighten(s.color, LABEL_CHIP_MIX)}
                      />
                      <text
                        x={x + barW / 2}
                        y={y + segH / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={14}
                        fontWeight="600"
                        fill="var(--color-app-navy)"
                      >
                        {v}
                      </text>
                    </>
                  )}
                </g>,
              )
              cursorY = y
            })

            return (
              <g key={w}>
                {blocks}
                {/* Mặt đỉnh của cột */}
                {columnTotal > 0 && (
                  <path
                    d={`M ${x} ${topY} L ${x + DEPTH} ${topY - DEPTH} L ${x + barW + DEPTH} ${topY - DEPTH} L ${x + barW} ${topY} Z`}
                    fill={lighten(topColor, 0.18)}
                  />
                )}
                {/* Tổng cột */}
                {columnTotal > 0 && (
                  <text
                    x={x + barW / 2 + DEPTH / 2}
                    y={topY - DEPTH - 4}
                    textAnchor="middle"
                    fontSize={14}
                    fontWeight="700"
                    fill="var(--color-app-navy)"
                  >
                    {columnTotal}
                  </text>
                )}
                {/* Nhãn tuần */}
                <text
                  x={cx}
                  y={baseY + 16}
                  textAnchor="middle"
                  fontSize={14}
                  fill="var(--color-app-ink-2)"
                >
                  {week.label}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* Chú thích phòng ban */}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3 text-xs">
        {series.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-muted-foreground">{s.department}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
