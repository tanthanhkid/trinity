"use client"

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectContent,
} from "@/components/ui/select"
import type { BirthdayMonthRow } from "@/hooks/use-employees"
import { MONTH_LABELS } from "./stats-shared"
import { useMeasuredWidth } from "@/components/app-shell/charts/use-measured-width"

const HEIGHT = 260
const PAD_X = 40
const PAD_TOP = 24
const PAD_BOTTOM = 34

/**
 * Biểu đồ cột số NV sinh nhật theo tháng (T1→T12). Click cột để chọn tháng →
 * bảng danh sách sinh nhật bên dưới cập nhật. Cột đang chọn tô xanh thương hiệu.
 */
export function BirthdayMonthChart({
  rows,
  selectedMonth,
  onSelect,
}: {
  rows: BirthdayMonthRow[]
  selectedMonth: number
  onSelect: (month: number) => void
}) {
  const counts = MONTH_LABELS.map(
    (_, i) => rows.find((r) => r.month === i + 1)?.count ?? 0,
  )
  const maxValue = Math.max(1, ...counts)
  // viewBox rộng đúng bề rộng khung (1 đơn vị = 1px) ⇒ chữ 14px thật.
  const [boxRef, WIDTH] = useMeasuredWidth<HTMLDivElement>(720, 520)
  const innerW = WIDTH - PAD_X * 2
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM
  const bucketW = innerW / 12
  const barW = bucketW * 0.56
  const toY = (v: number) => PAD_TOP + innerH - (v / maxValue) * innerH

  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Sinh nhật nhân viên theo tháng</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Tháng:</span>
          <Select
            value={String(selectedMonth)}
            onValueChange={(v) => {
              if (v) onSelect(Number(v))
            }}
          >
            <SelectTrigger className="h-9 w-[110px]">
              <SelectValue>
                {(v) =>
                  typeof v === "string" && v ? `Tháng ${v}` : null
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MONTH_LABELS.map((_, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>
                  Tháng {i + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Bấm vào cột để xem danh sách sinh nhật tháng đó.
      </p>
      {/* Điện thoại: danh sách thanh ngang (số hiện sẵn, vùng chạm ≥44px) thay SVG 720px */}
      <ul className="space-y-1 sm:hidden">
        {counts.map((v, i) => {
          const month = i + 1
          const selected = month === selectedMonth
          return (
            <li key={month}>
              <button
                type="button"
                onClick={() => onSelect(month)}
                aria-pressed={selected}
                className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-sm ${selected ? "bg-[var(--color-app-primary-soft)] font-semibold text-[var(--color-app-primary-ink)]" : ""}`}
              >
                <span className="w-9 shrink-0 text-left">{MONTH_LABELS[i]}</span>
                <span className="h-2.5 flex-1 rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${(v / maxValue) * 100}%`,
                      backgroundColor: selected ? "var(--color-app-primary)" : "var(--color-app-chart-seq-2)",
                    }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums">{v}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div ref={boxRef} className="w-full overflow-x-auto max-sm:hidden">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block min-w-[520px] w-full"
          role="img"
          aria-label="Biểu đồ sinh nhật theo tháng"
        >
          {/* Đường lưới ngang */}
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
            const y = PAD_TOP + innerH - t * innerH
            return (
              <g key={`grid-${i}`}>
                <line
                  x1={PAD_X}
                  x2={WIDTH - PAD_X}
                  y1={y}
                  y2={y}
                  stroke="var(--color-app-chart-grid)"
                  strokeDasharray="3 3"
                />
                <text x={PAD_X - 6} y={y + 5} fontSize={14} textAnchor="end" fill="var(--color-app-ink-2)">
                  {Math.round(maxValue * t)}
                </text>
              </g>
            )
          })}

          {/* Cột mỗi tháng (clickable) */}
          {counts.map((v, i) => {
            const month = i + 1
            const selected = month === selectedMonth
            const x = PAD_X + i * bucketW + (bucketW - barW) / 2
            const y = toY(v)
            const barH = PAD_TOP + innerH - y
            return (
              <g
                key={month}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(month)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(month)
                }}
                style={{ cursor: "pointer" }}
              >
                {/* Vùng bấm phủ cả ô (kể cả cột rỗng) */}
                <rect
                  x={PAD_X + i * bucketW}
                  y={PAD_TOP}
                  width={bucketW}
                  height={innerH}
                  fill="transparent"
                />
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(barH, v > 0 ? 2 : 0)}
                  rx={3}
                  fill={selected ? "var(--color-app-primary)" : "var(--color-app-chart-seq-2)"}
                />
                {v > 0 && (
                  <text
                    x={x + barW / 2}
                    y={y - 4}
                    fontSize={14}
                    textAnchor="middle"
                    fill={selected ? "var(--color-app-primary)" : "var(--color-app-ink-2)"}
                    fontWeight={selected ? 700 : 400}
                  >
                    {v}
                  </text>
                )}
                <text
                  x={PAD_X + i * bucketW + bucketW / 2}
                  y={HEIGHT - 10}
                  fontSize={14}
                  textAnchor="middle"
                  fill={selected ? "var(--color-app-primary)" : "var(--color-app-ink-2)"}
                  fontWeight={selected ? 700 : 400}
                >
                  {MONTH_LABELS[i]}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}
