"use client"

import { useId, useMemo } from "react"
import {
  darken,
  donutSlicePath,
  labelLineGeometry,
  lighten,
  polarToXY,
  LABEL_CHIP_MIX,
} from "./leave-analytics-utils"

export interface LeaveDonutSlice {
  key: string
  label: string
  color: string
  value: number
}

type LabelMode = "legend-right" | "label-lines" | "legend-bottom"

interface Props {
  slices: LeaveDonutSlice[]
  size?: number
  innerLabel?: string
  labelMode?: LabelMode
  valueFormat?: (v: number) => string
}

/**
 * Donut faux-3D (SVG inline, không thư viện): vành dày + gradient sáng→tối + đổ bóng mềm.
 * 3 chế độ nhãn:
 * - `legend-right`: chú thích danh sách bên phải.
 * - `label-lines`: đường dẫn nhãn chỉ vào từng lát + tên + %.
 * - `legend-bottom`: nhãn in trên bề mặt lát (nếu đủ rộng) + chú thích căn giữa-dưới.
 */
export function LeaveDonut3D({
  slices,
  size = 200,
  innerLabel,
  labelMode = "legend-right",
  valueFormat,
}: Props) {
  const gid = useId().replace(/:/g, "")
  const fmt = valueFormat ?? ((v: number) => v.toLocaleString("vi-VN"))
  const total = useMemo(() => slices.reduce((a, s) => a + s.value, 0), [slices])

  const cx = size / 2
  const cy = size / 2
  const rOuter = size * 0.42
  const rInner = size * 0.26

  const segments = useMemo(() => {
    if (total === 0) return []
    const out: {
      key: string
      label: string
      color: string
      value: number
      path: string
      midFrac: number
      pct: number
    }[] = []
    let acc = 0
    for (const s of slices) {
      if (s.value <= 0) continue
      const start = acc / total
      const end = (acc + s.value) / total
      out.push({
        key: s.key,
        label: s.label,
        color: s.color,
        value: s.value,
        path: donutSlicePath(cx, cy, rOuter, rInner, start, end),
        midFrac: (start + end) / 2,
        pct: (s.value / total) * 100,
      })
      acc += s.value
    }
    return out
  }, [slices, total, cx, cy, rOuter, rInner])

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

  // label-lines cần vùng vẽ rộng hơn để chứa nhãn ngoài → mở rộng viewBox.
  const pad = labelMode === "label-lines" ? size * 0.42 : 0
  const vbX = -pad
  const vbW = size + pad * 2

  const containerClass =
    labelMode === "legend-right"
      ? "flex flex-row items-center gap-4"
      : "flex flex-col items-center gap-3"

  return (
    <div className={containerClass}>
      <svg
        viewBox={`${vbX} 0 ${vbW} ${size}`}
        width={vbW}
        height={size}
        role="img"
        className="h-auto max-w-full shrink"
        style={{ maxWidth: vbW }}
      >
        <defs>
          {segments.map((seg) => (
            <linearGradient
              key={seg.key}
              id={`${gid}-${seg.key}`}
              x1="0"
              y1="0"
              x2="1"
              y2="1"
            >
              <stop offset="0%" stopColor={lighten(seg.color, 0.28)} />
              <stop offset="65%" stopColor={seg.color} />
              <stop offset="100%" stopColor={darken(seg.color, 0.18)} />
            </linearGradient>
          ))}
          <filter id={`${gid}-shadow`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow
              dx="0"
              dy="3"
              stdDeviation="3"
              floodColor="var(--color-app-navy)"
              floodOpacity="0.18"
            />
          </filter>
        </defs>

        <g filter={`url(#${gid}-shadow)`}>
          {segments.map((seg) => (
            <path
              key={seg.key}
              d={seg.path}
              fill={`url(#${gid}-${seg.key})`}
              stroke="var(--card)"
              strokeWidth={1.5}
            >
              <title>{`${seg.label}: ${fmt(seg.value)} (${seg.pct.toFixed(1)}%)`}</title>
            </path>
          ))}
        </g>

        {/* Nhãn trên bề mặt (chỉ legend-bottom, lát đủ rộng ≥ 8%) */}
        {labelMode === "legend-bottom" &&
          segments
            .filter((s) => s.pct >= 8)
            .map((seg) => {
              const p = polarToXY(cx, cy, (rOuter + rInner) / 2, seg.midFrac)
              return (
                <g key={`sf-${seg.key}`}>
                  <rect
                    x={p.x - (seg.label.length * size * 0.036 + 8) / 2}
                    y={p.y - size * 0.045}
                    width={seg.label.length * size * 0.036 + 8}
                    height={size * 0.09}
                    rx={4}
                    fill={lighten(seg.color, LABEL_CHIP_MIX)}
                  />
                  <text
                    x={p.x}
                    y={p.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={size * 0.06}
                    fontWeight="600"
                    fill="var(--color-app-navy)"
                  >
                    {seg.label}
                  </text>
                </g>
              )
            })}

        {/* Đường dẫn nhãn */}
        {labelMode === "label-lines" &&
          segments.map((seg) => {
            const g = labelLineGeometry(cx, cy, rOuter, seg.midFrac)
            return (
              <g key={`ll-${seg.key}`}>
                <polyline
                  points={`${g.p1.x.toFixed(1)},${g.p1.y.toFixed(1)} ${g.elbow.x.toFixed(1)},${g.elbow.y.toFixed(1)} ${g.textX.toFixed(1)},${g.textY.toFixed(1)}`}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={1}
                />
                <text
                  x={g.textX + (g.anchor === "start" ? 2 : -2)}
                  y={g.textY}
                  textAnchor={g.anchor}
                  dominantBaseline="middle"
                  fontSize={size * 0.062}
                  fill="var(--color-app-ink-2)"
                >
                  {seg.label} ({seg.pct.toFixed(0)}%)
                </text>
              </g>
            )
          })}

        {/* Tâm: tổng + innerLabel */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={size * 0.11}
          fontWeight="700"
          fill="var(--color-app-navy)"
        >
          {fmt(total)}
        </text>
        {innerLabel && (
          <text
            x={cx}
            y={cy + size * 0.1}
            textAnchor="middle"
            fontSize={size * 0.065}
            fill="var(--color-app-ink-2)"
          >
            {innerLabel}
          </text>
        )}
      </svg>

      {(labelMode === "legend-right" || labelMode === "legend-bottom") && (
        <div
          className={
            labelMode === "legend-right"
              ? "flex flex-col gap-1.5 text-xs"
              : "flex flex-wrap items-center justify-center gap-3 text-xs"
          }
        >
          {slices.map((s) => {
            const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : "0"
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-muted-foreground">
                  {s.label}{" "}
                  <span className="font-medium text-foreground">
                    {fmt(s.value)} ({pct}%)
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
