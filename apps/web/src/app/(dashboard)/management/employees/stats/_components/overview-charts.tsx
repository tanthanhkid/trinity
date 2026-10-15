"use client"

import { Fragment } from "react"
import { Loader2 } from "lucide-react"
import { useEmployeeStats } from "@/hooks/use-employees"
/* Biểu đồ dùng bản nằm trong cây này, không import ngược từ module khác, để chỉnh một nơi không đổi nơi kia. */
import { DonutChart } from "@/app/(dashboard)/reports/_components/charts/donut-chart"
import type { DonutSlice } from "@/app/(dashboard)/reports/_components/charts/donut-chart"
import {
  toSlices,
  GENDER_LABELS,
  EDUCATION_LABELS,
  STATUS_LABELS,
} from "./stats-shared"

/**
 * 1 donut + 1 bảng chú thích DUY NHẤT bên phải (Tên · Số lượng · Tỷ lệ).
 * Chú thích dưới biểu đồ bị tắt (`showLegend={false}`) để không trùng lặp.
 * Bảng dùng grid 3 cột [auto_auto_auto] (KHÔNG dùng 1fr — tránh kéo dãn cột tên
 * ra full chiều rộng làm số lượng/tỷ lệ văng sang phải) → tên căn trái + ellipsis
 * (tooltip khi hover, giới hạn 12rem); số lượng + tỷ lệ căn phải bám sát ngay sau
 * tên thành 1 khối liền mạch, các dòng thẳng hàng (tabular-nums).
 */
function StatSection({ title, slices }: { title: string; slices: DonutSlice[] }) {
  const total = slices.reduce((s, r) => s + r.value, 0)
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="flex items-start gap-5 max-sm:flex-col max-sm:items-center">
        <DonutChart
          slices={slices}
          size={132}
          innerLabel={`${total} NV`}
          showLegend={false}
        />
        <div className="grid min-w-0 grid-cols-[auto_auto_auto] items-center justify-start gap-x-3 gap-y-1.5 pt-1 text-sm max-sm:w-full max-sm:grid-cols-[1fr_auto_auto]">
          {slices.map((s) => {
            const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : "0.0"
            return (
              <Fragment key={s.key}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="max-w-[12rem] truncate text-muted-foreground max-sm:max-w-none max-sm:whitespace-normal" title={s.label}>
                    {s.label}
                  </span>
                </span>
                <span className="text-right font-medium tabular-nums">{s.value}</span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {pct}%
                </span>
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Tổng quan nhân sự toàn công ty (KHÔNG áp bộ lọc) — 5 donut. */
export function OverviewCharts() {
  const { data, isLoading } = useEmployeeStats(true)

  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Tổng quan nhân sự</h2>
        {data && data.resigned_total > 0 && (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
            Đã nghỉ việc: {data.resigned_total} (tài khoản vô hiệu hoá)
          </span>
        )}
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Toàn công ty — không áp bộ lọc bên dưới.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
          <StatSection title="Theo phòng ban" slices={toSlices(data.by_department)} />
          <StatSection title="Theo giới tính" slices={toSlices(data.by_gender, GENDER_LABELS)} />
          <StatSection title="Theo trình độ học vấn" slices={toSlices(data.by_education, EDUCATION_LABELS)} />
          <StatSection title="Theo chức danh" slices={toSlices(data.by_job_title)} />
          <StatSection title="Theo trạng thái" slices={toSlices(data.by_status, STATUS_LABELS)} />
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Không có dữ liệu
        </p>
      )}
    </section>
  )
}
