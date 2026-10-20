"use client"

import type { ElementType } from "react"
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { RollingNumber } from "@/components/ui/rolling-number"

/** Khớp `DeltaMetric` BE (`reports/helpers/report-date-range.helper.ts`). */
export interface ReportDeltaMetric {
  current: number
  previous: number
  delta_abs: number
  delta_pct: number | null
}

interface Props {
  icon: ElementType
  title: string
  /** Giá trị hiển thị đã format (vd "1.234", "42%"). */
  value: string
  delta?: ReportDeltaMetric | null
  /** Đơn vị đọc kèm nhãn biến động (vd "khách", "cuộc"). */
  unit?: string
  compareLabel?: string
}

/**
 * Thẻ KPI đơn giản cho Trung tâm báo cáo — CỐ Ý KHÔNG tái dùng
 * `dashboard/_components/dashboard-stats-shared.tsx` `KpiCard` (thẻ đó gắn
 * chặt với giao diện riêng của widget Dashboard).
 * Đây là bản self-contained: icon + tiêu đề + trị số lớn + badge delta.
 */
export function ReportKpiCard({
  title,
  value,
  delta,
  unit,
  compareLabel = "so kỳ trước",
}: Props) {
  // Dáng `.stat` của bản demo (cùng Trang chủ): nhãn xám 14px, số 26px, một dòng biến động.
  // Prop `icon` giữ để không phải sửa chỗ gọi — giao diện mới không vẽ ô icon trong thẻ số.
  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-4 py-3.5 shadow-[var(--shadow-card)]">
      <p className="truncate text-sm text-muted-foreground">{title}</p>
      <div className="mt-1 mb-0.5 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-foreground tabular-nums sm:text-[26px]">
        <RollingNumber text={value} />
      </div>
      <div className="text-sm text-muted-foreground">
        {delta ? (
          <ReportDeltaBadge delta={delta} unit={unit} compareLabel={compareLabel} />
        ) : (
          <span className="flex items-center gap-1">
            <Minus className="size-3.5 shrink-0" />
            chưa có dữ liệu{unit ? ` · ${unit}` : ""}
          </span>
        )}
      </div>
    </div>
  )
}

export function ReportDeltaBadge({
  delta,
  unit,
  compareLabel = "so kỳ trước",
}: {
  delta: ReportDeltaMetric
  unit?: string
  compareLabel?: string
}) {
  if (delta.delta_pct === null) {
    // previous = 0 — "chưa có dữ liệu để so" KHÁC "0%".
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-[var(--color-app-ink-2)]">
        <Minus className="size-3.5 shrink-0" />
        <span>Mới{unit ? ` · ${unit}` : ""}</span>
      </span>
    )
  }
  const trend = delta.delta_abs > 0 ? "up" : delta.delta_abs < 0 ? "down" : "flat"
  const palette =
    trend === "up"
      ? "text-[var(--color-app-primary-ink)]"
      : trend === "down"
        ? "text-[var(--color-app-tag-red-ink)]"
        : "text-[var(--color-app-ink-2)]"
  const Icon = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus
  const sign = delta.delta_abs > 0 ? "+" : ""
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-1 font-semibold", palette)}>
      <Icon className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap tabular-nums">
        {sign}
        {delta.delta_pct}%
      </span>
      <span className="min-w-0 font-normal text-[var(--color-app-ink-2)]">
        {compareLabel}
        {unit ? ` · ${unit}` : ""}
      </span>
    </span>
  )
}

export function ReportKpiCardSkeleton() {
  return (
    <div className="flex flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-4 py-3.5 shadow-[var(--shadow-card)]">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-2 h-7 w-20" />
      <Skeleton className="mt-1.5 h-4 w-28" />
    </div>
  )
}
