"use client"

import { useState } from "react"
import {
  CHART_METRICS,
  buildGroupTooltip,
  type AttendanceChartGroup,
  type GroupTooltip,
} from "./attendance-group-bar-chart-utils"

interface Props {
  groups: AttendanceChartGroup[]
  height?: number
  emptyText?: string
}

const PAD_LEFT = 44
const PAD_RIGHT = 16
const PAD_TOP = 28
const PAD_BOTTOM = 40
const MIN_CLUSTER_WIDTH = 100
const REFERENCE_INNER_WIDTH = 680

const fmt = (v: number) => v.toLocaleString("vi-VN")

interface HoverState {
  i: number
  x: number
  y: number
  flip: boolean
}

/**
 * Biểu đồ cột ghép theo Team/Phòng ban — SVG thuần (không thư viện).
 * Nhãn số trên mỗi cột, nền cụm xen kẽ, tự giãn rộng + cuộn ngang khi nhiều
 * nhóm, tooltip nổi hiển thị giá trị + % theo tổng nhân viên của nhóm.
 */
export function AttendanceGroupBarChart({ groups, height = 280, emptyText = "Không có dữ liệu" }: Props) {
  const [hover, setHover] = useState<HoverState | null>(null)

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        {emptyText}
      </div>
    )
  }

  const n = groups.length
  const innerW = Math.max(REFERENCE_INNER_WIDTH, n * MIN_CLUSTER_WIDTH)
  const totalW = PAD_LEFT + innerW + PAD_RIGHT
  const innerH = height - PAD_TOP - PAD_BOTTOM
  const clusterW = innerW / n
  const scrolls = innerW > REFERENCE_INNER_WIDTH

  let maxValue = 0
  for (const g of groups)
    for (const m of CHART_METRICS) if (g.stat[m.key] > maxValue) maxValue = g.stat[m.key]
  if (maxValue === 0) maxValue = 1

  const toY = (v: number) => PAD_TOP + innerH - (v / maxValue) * innerH
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((maxValue / 4) * i))

  const groupW = clusterW * 0.72
  const barW = groupW / CHART_METRICS.length
  const maxNameChars = Math.max(4, Math.floor(clusterW / 7))

  function onClusterMove(e: React.MouseEvent, i: number) {
    const wrap = e.currentTarget.closest("[data-chart-wrap]")?.getBoundingClientRect()
    if (!wrap) return
    const x = e.clientX - wrap.left
    const y = e.clientY - wrap.top
    setHover({ i, x, y, flip: x > wrap.width * 0.6 })
  }

  const tip: GroupTooltip | null = hover ? buildGroupTooltip(groups[hover.i]) : null

  return (
    <div data-chart-wrap className="relative w-full overflow-x-auto" onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${totalW} ${height}`}
        className={scrolls ? "block" : "block w-full"}
        style={scrolls ? { width: totalW } : undefined}
        role="img"
        aria-label="Biểu đồ thống kê chấm công theo nhóm"
      >
        {/* Lưới + nhãn trục Y */}
        {ticks.map((tv, i) => {
          const y = toY(tv)
          return (
            <g key={`y-${i}`}>
              <line x1={PAD_LEFT} x2={totalW - PAD_RIGHT} y1={y} y2={y} stroke="var(--color-app-chart-grid)" strokeDasharray="3 3" />
              <text x={PAD_LEFT - 6} y={y + 3} fontSize={14} textAnchor="end" fill="var(--color-app-ink-2)">
                {fmt(tv)}
              </text>
            </g>
          )
        })}

        {groups.map((g, i) => {
          const clusterX = PAD_LEFT + i * clusterW
          const groupX = clusterX + (clusterW - groupW) / 2
          const name = g.name.length > maxNameChars ? `${g.name.slice(0, maxNameChars - 1)}…` : g.name
          return (
            <g key={g.id}>
              {/* Nền cụm xen kẽ để tách nhóm */}
              {i % 2 === 1 && (
                <rect x={clusterX} y={PAD_TOP} width={clusterW} height={innerH} fill="var(--color-app-surface-2)" />
              )}
              {CHART_METRICS.map((m, j) => {
                const v = g.stat[m.key]
                const barH = (v / maxValue) * innerH
                const x = groupX + j * barW
                const y = toY(v)
                return (
                  <g key={m.key}>
                    <rect x={x} y={y} width={Math.max(1, barW - 2)} height={barH} fill={m.color} rx={2} />
                    {v > 0 && (
                      <text x={x + barW / 2 - 1} y={y - 4} fontSize={14} textAnchor="middle" fill="var(--color-app-navy)">
                        {fmt(v)}
                      </text>
                    )}
                  </g>
                )
              })}
              {/* Tên cụm */}
              <text x={clusterX + clusterW / 2} y={height - 8} fontSize={14} textAnchor="middle" fill="var(--color-app-ink-2)">
                {name}
              </text>
              {/* Vùng bắt hover phủ cả cụm (tooltip + fallback <title> cho cảm ứng) */}
              <rect
                x={clusterX}
                y={PAD_TOP}
                width={clusterW}
                height={innerH}
                fill="transparent"
                onMouseMove={(e) => onClusterMove(e, i)}
              >
                <title>
                  {`${g.name} • ${g.stat.headcount} NV\n${CHART_METRICS.map(
                    (m) => `${m.label}: ${fmt(g.stat[m.key])}`,
                  ).join("\n")}`}
                </title>
              </rect>
            </g>
          )
        })}
      </svg>

      {tip && hover && (
        <div
          className="pointer-events-none absolute z-50 w-max max-w-[260px] rounded-lg border bg-popover p-2.5 text-xs shadow-md"
          style={{ left: hover.flip ? undefined : hover.x + 12, right: hover.flip ? hover.x + 12 : undefined, top: hover.y + 12 }}
        >
          <p className="font-semibold text-foreground">
            {tip.name} <span className="font-normal text-muted-foreground">• {tip.headcount} NV</span>
          </p>
          {tip.meta && <p className="text-muted-foreground">{tip.meta}</p>}
          <div className="mt-1.5 space-y-1">
            {tip.metrics.map((m) => (
              <div key={m.key} className="flex items-center gap-1.5">
                <span className="inline-block size-2 shrink-0 rounded-sm" style={{ backgroundColor: m.color }} />
                <span className="text-muted-foreground">{m.label}:</span>
                <span className="font-medium text-foreground">
                  {fmt(m.value)}/{tip.headcount} ({m.pct}%)
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 border-t pt-1.5 text-muted-foreground">
            Tỷ lệ chấm công {fmt(tip.attendanceRate)}% · Chưa đủ công {fmt(tip.insufficient)} · Phút muộn{" "}
            {fmt(tip.lateMinutes)}
          </p>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-xs">
        {CHART_METRICS.map((m) => (
          <div key={m.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: m.color }} />
            <span className="text-muted-foreground">{m.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
