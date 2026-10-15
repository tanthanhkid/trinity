"use client"

import { useMemo } from "react"
import { useMeasuredWidth } from "@/components/app-shell/charts/use-measured-width"

export interface HBarSegment {
  key: string
  label?: string
  color: string
  value: number
}

export interface HBarRow {
  label: string
  segments: HBarSegment[]
}

export interface HBarLegend {
  key: string
  label: string
  color: string
}

interface Props {
  rows: HBarRow[]
  valueFormat?: (v: number) => string
  legend?: HBarLegend[]
}

const ROW_H = 26
const ROW_GAP = 8
const LABEL_W = 150
const PAD_X = 8
const PAD_TOP = 8
const VALUE_W = 60

/**
 * Biểu đồ thanh NGANG SVG inline — không thư viện ngoài.
 * - 1 segment/row → thanh đơn (vd: số ngày nghỉ).
 * - nhiều segment/row → xếp chồng ngang (vd: đi muộn + về sớm).
 * Nhãn (tên NV) bên trái, tổng giá trị cuối thanh.
 */
export function HorizontalBarChart({ rows, valueFormat, legend }: Props) {
  const fmt = valueFormat ?? ((v: number) => v.toLocaleString("vi-VN"))
  // viewBox rộng đúng bề rộng khung (1 đơn vị = 1px) ⇒ chữ 14px thật.
  const [boxRef, WIDTH] = useMeasuredWidth<HTMLDivElement>(720, 560)

  const maxTotal = useMemo(() => {
    let m = 0
    for (const r of rows) {
      let s = 0
      for (const seg of r.segments) s += seg.value
      if (s > m) m = s
    }
    return m === 0 ? 1 : m
  }, [rows])

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Không có dữ liệu
      </div>
    )
  }

  const barAreaW = WIDTH - LABEL_W - VALUE_W - PAD_X * 2
  const height = PAD_TOP * 2 + rows.length * ROW_H + (rows.length - 1) * ROW_GAP

  return (
    <div ref={boxRef} className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="block min-w-[560px] w-full"
        role="img"
      >
        {rows.map((r, i) => {
          const y = PAD_TOP + i * (ROW_H + ROW_GAP)
          const total = r.segments.reduce((acc, s) => acc + s.value, 0)
          let x = LABEL_W + PAD_X
          return (
            <g key={`${r.label}-${i}`}>
              <text
                x={LABEL_W}
                y={y + ROW_H / 2 + 4}
                fontSize={14}
                textAnchor="end"
                fill="var(--color-app-navy)"
              >
                <title>{r.label}</title>
                {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
              </text>
              {r.segments.map((seg) => {
                const w = (seg.value / maxTotal) * barAreaW
                const segX = x
                x += w
                return (
                  <rect
                    key={seg.key}
                    x={segX}
                    y={y}
                    width={Math.max(0, w)}
                    height={ROW_H}
                    fill={seg.color}
                    rx={3}
                  >
                    <title>{`${r.label} • ${seg.label ?? seg.key}: ${fmt(seg.value)}`}</title>
                  </rect>
                )
              })}
              <text
                x={x + 6}
                y={y + ROW_H / 2 + 4}
                fontSize={14}
                textAnchor="start"
                fill="var(--color-app-navy)"
                fontWeight={600}
              >
                {fmt(total)}
              </text>
            </g>
          )
        })}
      </svg>

      {legend && legend.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-sm">
          {legend.map((l) => (
            <div key={l.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ backgroundColor: l.color }}
              />
              <span className="text-muted-foreground">{l.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
