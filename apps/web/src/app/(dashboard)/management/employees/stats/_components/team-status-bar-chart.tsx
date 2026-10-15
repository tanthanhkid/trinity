"use client"

import { useMemo } from "react"
import { inkOn } from "@/components/app-shell/charts/chart-colors"

export interface TeamStatusSeries {
  key: string
  label: string
  color: string
  values: number[]
}

interface Props {
  labels: string[]
  series: TeamStatusSeries[]
  height?: number
}

const PAD_LEFT = 44
const PAD_RIGHT = 16
const PAD_TOP = 26 // chừa chỗ cho nhãn TỔNG trên đỉnh cột
const PAD_BOTTOM = 70 // chừa chỗ cho nhãn team xoay nghiêng
const BAR_W = 34
const MIN_CHART_W = 320

/** Bề rộng dành cho mỗi team — co giãn theo số lượng để ít team không trống huơ,
 *  nhiều team thì rộng ra (kích hoạt cuộn ngang ở thẻ cha). */
function perTeamWidth(n: number): number {
  if (n <= 3) return 120
  if (n <= 6) return 92
  if (n <= 10) return 74
  return 64
}

function truncate(s: string, max = 14): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Biểu đồ cột chồng SVG inline — RIÊNG cho trang Thống kê nhân sự (KHÔNG dùng
 * BarChart chung của reports để tránh ảnh hưởng các báo cáo khác).
 *
 * Cải tiến so với BarChart chung:
 * - Nhãn team XOAY NGHIÊNG -35° + rút gọn + `<title>` xem đầy đủ → không chồng chéo.
 * - In SỐ trực tiếp: tổng trên đỉnh mỗi cột + số từng phân đoạn (khi đủ cao).
 * - Bề rộng cột co giãn theo số team → CUỘN NGANG khi nhiều team.
 */
export function TeamStatusBarChart({ labels, series, height = 300 }: Props) {
  const totals = useMemo(
    () =>
      labels.map((_, i) =>
        series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0),
      ),
    [labels, series],
  )

  const maxValue = useMemo(() => {
    const m = Math.max(0, ...totals)
    return m === 0 ? 1 : m
  }, [totals])

  const innerH = height - PAD_TOP - PAD_BOTTOM
  const chartW = Math.max(labels.length * perTeamWidth(labels.length), MIN_CHART_W)
  const width = PAD_LEFT + chartW + PAD_RIGHT
  const bucketW = chartW / Math.max(labels.length, 1)

  const yTicks = 4
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((maxValue / yTicks) * i),
  )
  const toY = (v: number) => PAD_TOP + innerH - (v / maxValue) * innerH

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
    <div className="w-full">
      {/* Điện thoại: thanh ngang xếp chồng từng team (không cuộn ngang) */}
      <ul className="space-y-3 sm:hidden">
        {labels.map((label, i) => (
          <li key={`m-${i}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 font-medium">{label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {totals[i].toLocaleString("vi-VN")}
              </span>
            </div>
            <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
              {series.map((s) => {
                const v = s.values[i] ?? 0
                if (v <= 0 || totals[i] <= 0) return null
                return (
                  <span
                    key={s.key}
                    title={`${label} • ${s.label}: ${v.toLocaleString("vi-VN")}`}
                    className="h-full"
                    style={{ width: `${(v / totals[i]) * 100}%`, backgroundColor: s.color }}
                  />
                )
              })}
            </div>
            <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {series.map((s) =>
                (s.values[i] ?? 0) > 0 ? (
                  <span key={s.key}>
                    {s.label}: {s.values[i]}
                  </span>
                ) : null,
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto max-sm:hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        className="block max-w-none"
      >
        {/* Lưới + nhãn trục Y */}
        {tickValues.map((tv, i) => {
          const y = toY(tv)
          return (
            <g key={`grid-${i}`}>
              <line
                x1={PAD_LEFT}
                x2={width - PAD_RIGHT}
                y1={y}
                y2={y}
                stroke="var(--color-app-chart-grid)"
                strokeDasharray="3 3"
              />
              <text
                x={PAD_LEFT - 6}
                y={y + 3}
                fontSize={14}
                textAnchor="end"
                fill="var(--color-app-ink-2)"
              >
                {tv.toLocaleString("vi-VN")}
              </text>
            </g>
          )
        })}

        {/* Cột chồng theo từng team */}
        {labels.map((label, i) => {
          const cx = PAD_LEFT + i * bucketW + bucketW / 2
          const barX = cx - BAR_W / 2
          const total = totals[i]
          const labelY = height - PAD_BOTTOM + 16
          let stackTop = 0
          return (
            <g key={`team-${i}`}>
              {series.map((s) => {
                const v = s.values[i] ?? 0
                if (v <= 0) return null
                const barH = (v / maxValue) * innerH
                const y = toY(stackTop + v)
                stackTop += v
                return (
                  <g key={s.key}>
                    <rect
                      x={barX}
                      y={y}
                      width={BAR_W}
                      height={barH}
                      fill={s.color}
                      rx={2}
                    >
                      <title>{`${label} • ${s.label}: ${v.toLocaleString("vi-VN")}`}</title>
                    </rect>
                    {barH >= 15 && (
                      <text
                        x={cx}
                        y={y + barH / 2 + 3.5}
                        fontSize={14}
                        fontWeight={600}
                        textAnchor="middle"
                        fill={inkOn(s.color)}
                        pointerEvents="none"
                      >
                        {v}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* Tổng trên đỉnh cột */}
              {total > 0 && (
                <text
                  x={cx}
                  y={toY(total) - 6}
                  fontSize={14}
                  fontWeight={700}
                  textAnchor="middle"
                  fill="var(--color-app-navy)"
                >
                  {total.toLocaleString("vi-VN")}
                </text>
              )}

              {/* Nhãn team xoay nghiêng + tooltip đầy đủ */}
              <text
                x={cx}
                y={labelY}
                fontSize={14}
                textAnchor="end"
                fill="var(--color-app-navy)"
                transform={`rotate(-35 ${cx} ${labelY})`}
              >
                {truncate(label)}
                <title>{label}</title>
              </text>
            </g>
          )
        })}
      </svg>
      </div>

      {/* Chú thích trạng thái */}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-xs">
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
