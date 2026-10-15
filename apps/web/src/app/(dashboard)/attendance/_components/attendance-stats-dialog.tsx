"use client"

import { useState } from "react"
import { Check, Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import apiClient from "@/lib/api-client"
import { todayVn, firstDayOfMonthVn } from "@/lib/format"
import {
  useAttendanceStats,
  useDisciplineStats,
  useStatsFilterOptions,
  buildStatsParams,
  type StatsFilter,
  type TeamStatRow,
  type DepartmentStatRow,
  type DisciplineStats,
} from "@/hooks/use-attendance"
import {
  DateRangeFilter,
  type DateRange,
} from "@/app/(dashboard)/reports/_components/date-range-filter"
import {
  DonutChart,
  type DonutSlice,
} from "@/app/(dashboard)/reports/_components/charts/donut-chart"
import {
  LineChart,
  type LineSeries,
} from "@/app/(dashboard)/reports/_components/charts/line-chart"
import {
  BarChart,
  type BarSeries,
} from "@/app/(dashboard)/reports/_components/charts/bar-chart"
import { HorizontalBarChart, type HBarRow } from "./horizontal-bar-chart"
import { AttendanceAbsentTable } from "./attendance-absent-table"
import { AttendanceGroupBarChart } from "./attendance-group-bar-chart"
import type { AttendanceChartGroup } from "./attendance-group-bar-chart-utils"
import { LeaveAnalyticsSection } from "./leave-analytics-section"
import { CHART_NEUTRAL, CHART_STATUS, categoryColor } from "@/components/app-shell/charts/chart-colors"

/** "YYYY-MM-DD" → "DD/MM" (chuỗi sẵn, không cần parse Date — tránh lệch timezone) */
function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
}

const EMPTY_FILTER: StatsFilter = { department: [], team_id: [], office_id: [] }

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string
  value: number | string
  accent?: string
}) {
  return (
    <div className="rounded-[var(--radius)] border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${accent ?? "text-foreground"}`}>
        {typeof value === "number" ? value.toLocaleString("vi-VN") : value}
      </p>
    </div>
  )
}

/** Bộ lọc multi-select (Popover + danh sách tick). Không có ô nhập → không lo focus-steal. */
function MultiSelectFilter<T extends string | number>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  selected: T[]
  onChange: (next: T[]) => void
}) {
  const count = selected.length
  const toggle = (v: T) => {
    onChange(
      selected.includes(v)
        ? selected.filter((x) => x !== v)
        : [...selected, v],
    )
  }
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: count > 0 ? "soft" : "outline", size: "sm" }),
          "h-9 gap-1 max-sm:min-h-11",
        )}
      >
        {label}
        {count > 0 ? ` (${count})` : ""}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-64 overflow-y-auto p-1">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Không có dữ liệu
          </p>
        ) : null}
        {count > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mb-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent max-sm:min-h-11"
          >
            Bỏ chọn tất cả ({count})
          </button>
        )}
        {options.map((o) => {
          const active = selected.includes(o.value)
          return (
            <button
              key={String(o.value)}
              type="button"
              onClick={() => toggle(o.value)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent max-sm:min-h-11",
                active && "font-medium",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input",
                )}
              >
                {active && <Check className="size-3" />}
              </span>
              <span className="flex-1 truncate">{o.label}</span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/** Nút xuất Excel — tải blob qua apiClient (JWT tự đính kèm), có trạng thái loading. */
function ExportButton({
  endpoint,
  params,
  filename,
  label,
}: {
  endpoint: string
  params: Record<string, string | string[] | number[]>
  filename: string
  label: string
}) {
  const [busy, setBusy] = useState(false)
  async function handleExport() {
    setBusy(true)
    try {
      const res = await apiClient.get<Blob>(endpoint, {
        params,
        responseType: "blob",
      })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error("Không xuất được Excel — thử lại sau.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={busy}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "h-8 gap-1.5 max-sm:min-h-11",
      )}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
      {label}
    </button>
  )
}

/** Màu tỷ lệ chấm công: ≥90% xanh, 70–90% vàng, <70% đỏ. */
function rateClass(rate: number): string {
  if (rate >= 90) return "text-emerald-600"
  if (rate >= 70) return "text-amber-700"
  return "text-red-600"
}

/** 7 ô số liệu chung cho bảng Team + Phòng ban (đếm theo NGƯỜI). */
function GroupMetricCells({ r }: { r: TeamStatRow | DepartmentStatRow }) {
  return (
    <>
      <td className="px-2 py-2 text-center font-medium">{r.headcount}</td>
      <td className="px-2 py-2 text-center text-blue-600">
        {r.checked_in_people}
      </td>
      <td className="px-2 py-2 text-center text-emerald-600">
        {r.present_people}
      </td>
      <td className="px-2 py-2 text-center text-amber-700">{r.late_people}</td>
      <td className="px-2 py-2 text-center text-orange-600">
        {r.insufficient_people}
      </td>
      <td className="px-2 py-2 text-center text-red-600">{r.absent_people}</td>
      <td className={cn("px-2 py-2 text-center font-semibold", rateClass(r.attendance_rate))}>
        {r.attendance_rate.toLocaleString("vi-VN")}%
      </td>
      <td className="px-2 py-2 text-center text-amber-700">
        {r.total_late_minutes.toLocaleString("vi-VN")}
      </td>
    </>
  )
}

const GROUP_METRIC_HEADERS = (
  <>
    <th className="px-2 py-2 text-center">Tổng NV</th>
    <th className="px-2 py-2 text-center">Đã chấm công</th>
    <th className="px-2 py-2 text-center">Có mặt</th>
    <th className="px-2 py-2 text-center">Đi muộn</th>
    <th className="px-2 py-2 text-center">Chưa đủ công</th>
    <th className="px-2 py-2 text-center">Vắng</th>
    <th className="px-2 py-2 text-center">Tỷ lệ %</th>
    <th className="px-2 py-2 text-center">Tổng phút muộn</th>
  </>
)

const GENDER_COLOR: Record<"M" | "F" | "unknown", string> = {
  M: categoryColor(2),
  F: categoryColor(5),
  unknown: CHART_NEUTRAL,
}

/** Tên hiển thị NV trong biểu đồ/bảng kỷ luật. */
function empName(full_name: string | null, user_id: number): string {
  return full_name ?? `NV #${user_id}`
}

/** 3 khối kỷ luật: Top nghỉ / Top đi muộn-về sớm / So sánh giới tính. */
function DisciplineSections({
  data,
  exportParams,
}: {
  data: DisciplineStats
  exportParams: Record<string, string | string[] | number[]>
}) {
  const absentRows: HBarRow[] = data.top_absent.map((r) => ({
    label: empName(r.full_name, r.user_id),
    segments: [
      { key: "absent", label: "Ngày nghỉ", color: CHART_STATUS.bad, value: r.absent_days },
    ],
  }))

  const violationRows: HBarRow[] = data.top_violation.map((r) => ({
    label: empName(r.full_name, r.user_id),
    segments: [
      { key: "late", label: "Đi muộn", color: CHART_STATUS.warn, value: r.late_minutes },
      { key: "early", label: "Về sớm", color: categoryColor(3), value: r.early_minutes },
    ],
  }))

  const genderLabels = ["Ngày nghỉ", "Lần đi muộn", "Lần về sớm"]
  const genderSeries: BarSeries[] = data.by_gender.map((g) => ({
    key: g.gender,
    label: g.gender_label,
    color: GENDER_COLOR[g.gender],
    values: [g.total_absent_days, g.total_late_count, g.total_early_count],
  }))

  return (
    <>
      {/* Top 10 nghỉ nhiều nhất */}
      <div className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">Top 10 nhân viên nghỉ nhiều nhất</p>
          <ExportButton
            endpoint="/management/attendance/stats/export-top-absent"
            params={exportParams}
            filename="top-nv-nghi-nhieu.xlsx"
            label="Xuất Excel"
          />
        </div>
        {absentRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Không có nhân viên nghỉ trong kỳ.
          </p>
        ) : (
          <>
            <HorizontalBarChart
              rows={absentRows}
              valueFormat={(v) => `${v.toLocaleString("vi-VN")} ngày`}
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2">Họ tên</th>
                    <th className="px-2 py-2">Team</th>
                    <th className="px-2 py-2">Chức vụ</th>
                    <th className="px-2 py-2 text-center">Ngày nghỉ</th>
                    <th className="px-2 py-2 text-center">Số lần nghỉ</th>
                    <th className="px-2 py-2 text-center">Tỷ lệ %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_absent.map((r) => (
                    <tr key={r.user_id} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">
                        {empName(r.full_name, r.user_id)}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{r.team_name}</td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {r.position ?? "—"}
                      </td>
                      <td className="px-2 py-2 text-center font-semibold text-red-600">
                        {r.absent_days}
                      </td>
                      <td className="px-2 py-2 text-center">{r.absent_occurrences}</td>
                      <td className="px-2 py-2 text-center text-red-600">
                        {r.absent_rate.toLocaleString("vi-VN")}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Top 10 đi muộn / về sớm */}
      <div className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">
            Top 10 nhân viên đi muộn / về sớm nhiều nhất
          </p>
          <ExportButton
            endpoint="/management/attendance/stats/export-top-late-early"
            params={exportParams}
            filename="top-nv-di-muon-ve-som.xlsx"
            label="Xuất Excel"
          />
        </div>
        {violationRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Không có nhân viên đi muộn / về sớm trong kỳ.
          </p>
        ) : (
          <>
            <HorizontalBarChart
              rows={violationRows}
              valueFormat={(v) => `${v.toLocaleString("vi-VN")} phút`}
              legend={[
                { key: "late", label: "Phút đi muộn", color: CHART_STATUS.warn },
                { key: "early", label: "Phút về sớm", color: categoryColor(3) },
              ]}
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2">Họ tên</th>
                    <th className="px-2 py-2">Team</th>
                    <th className="px-2 py-2 text-center">Phút muộn</th>
                    <th className="px-2 py-2 text-center">Phút về sớm</th>
                    <th className="px-2 py-2 text-center">Phút vi phạm</th>
                    <th className="px-2 py-2 text-center">Lần muộn</th>
                    <th className="px-2 py-2 text-center">Lần về sớm</th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_violation.map((r) => (
                    <tr key={r.user_id} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">
                        {empName(r.full_name, r.user_id)}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{r.team_name}</td>
                      <td className="px-2 py-2 text-center text-amber-700">
                        {r.late_minutes.toLocaleString("vi-VN")}
                      </td>
                      <td className="px-2 py-2 text-center text-violet-600">
                        {r.early_minutes.toLocaleString("vi-VN")}
                      </td>
                      <td className="px-2 py-2 text-center font-semibold">
                        {r.violation_minutes.toLocaleString("vi-VN")}
                      </td>
                      <td className="px-2 py-2 text-center">{r.late_count}</td>
                      <td className="px-2 py-2 text-center">{r.early_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* So sánh theo giới tính */}
      <div className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">So sánh chấm công theo giới tính</p>
          <ExportButton
            endpoint="/management/attendance/stats/export-by-gender"
            params={exportParams}
            filename="thong-ke-cham-cong-theo-gioi-tinh.xlsx"
            label="Xuất Excel"
          />
        </div>
        {data.by_gender.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Không có dữ liệu.
          </p>
        ) : (
          <>
            <BarChart labels={genderLabels} series={genderSeries} height={240} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2">Giới tính</th>
                    <th className="px-2 py-2 text-center">Tổng nhân sự</th>
                    <th className="px-2 py-2 text-center">Tổng ngày nghỉ</th>
                    <th className="px-2 py-2 text-center">Lần đi muộn</th>
                    <th className="px-2 py-2 text-center">Lần về sớm</th>
                    <th className="px-2 py-2 text-center">Tỷ lệ đủ công</th>
                    <th className="px-2 py-2 text-center">Tỷ lệ thiếu công</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_gender.map((g) => (
                    <tr key={g.gender} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">{g.gender_label}</td>
                      <td className="px-2 py-2 text-center">{g.headcount}</td>
                      <td className="px-2 py-2 text-center text-red-600">
                        {g.total_absent_days}
                      </td>
                      <td className="px-2 py-2 text-center text-amber-700">
                        {g.total_late_count}
                      </td>
                      <td className="px-2 py-2 text-center text-violet-600">
                        {g.total_early_count}
                      </td>
                      <td className="px-2 py-2 text-center text-emerald-600">
                        {g.full_attendance_rate.toLocaleString("vi-VN")}%
                      </td>
                      <td className="px-2 py-2 text-center text-orange-600">
                        {g.insufficient_rate.toLocaleString("vi-VN")}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  )
}

export function AttendanceStatsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Mặc định: hôm nay → hôm nay. Người dùng tự đổi khoảng ngày qua DateRangeFilter.
  const [range, setRange] = useState<DateRange>({
    date_from: firstDayOfMonthVn(),
    date_to: todayVn(),
  })
  const [filter, setFilter] = useState<StatsFilter>(EMPTY_FILTER)
  const { data, isLoading } = useAttendanceStats(
    range.date_from,
    range.date_to,
    filter,
    open,
  )
  const { data: filterOptions } = useStatsFilterOptions(open)
  const { data: discipline } = useDisciplineStats(
    range.date_from,
    range.date_to,
    filter,
    open,
  )

  const exportParams = buildStatsParams(range.date_from, range.date_to, filter)

  const classifySlices: DonutSlice[] = data
    ? [
        { key: "on_time", label: "Đúng giờ", color: "var(--color-app-primary)", value: data.summary.on_time },
        { key: "late", label: "Đi muộn", color: CHART_STATUS.warn, value: data.summary.late },
      ]
    : []

  const coverageSlices: DonutSlice[] = data
    ? [
        { key: "checked_in", label: "Đã chấm công", color: "var(--color-app-primary)", value: data.distinct_checked_in },
        { key: "not_checked_in", label: "Chưa chấm công", color: CHART_NEUTRAL, value: data.not_checked_in },
      ]
    : []

  const lineLabels = data?.daily.map((d) => shortDate(d.date)) ?? []
  const lineSeries: LineSeries[] = data
    ? [
        { key: "checked_in", label: "Lượt chấm công", color: "var(--color-app-primary)", values: data.daily.map((d) => d.checked_in) },
        { key: "late", label: "Đi muộn", color: CHART_STATUS.warn, values: data.daily.map((d) => d.late) },
      ]
    : []

  const teamRows = data?.by_team ?? []
  const deptRows = data?.by_department ?? []

  const teamGroups: AttendanceChartGroup[] = teamRows.map((r) => ({
    id: r.team_id?.toString() ?? "none",
    name: r.team_name,
    stat: r,
  }))
  const deptGroups: AttendanceChartGroup[] = deptRows.map((r) => ({
    id: r.department,
    name: r.department,
    meta: r.head_name ? `Trưởng phòng: ${r.head_name}` : undefined,
    stat: r,
  }))

  const activeFilterCount =
    filter.department.length + filter.team_id.length + filter.office_id.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-[95vw] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Thống kê chấm công</DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto pr-1">
          <DateRangeFilter value={range} onChange={setRange} />

          {/* Bộ lọc Phòng ban / Team / Văn phòng — áp cho toàn bộ popup */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Lọc:
            </span>
            <MultiSelectFilter
              label="Phòng ban"
              options={(filterOptions?.departments ?? []).map((d) => ({
                value: d,
                label: d,
              }))}
              selected={filter.department}
              onChange={(department) => setFilter((f) => ({ ...f, department }))}
            />
            <MultiSelectFilter
              label="Team"
              options={(filterOptions?.teams ?? []).map((t) => ({
                value: t.id,
                label: t.name,
              }))}
              selected={filter.team_id}
              onChange={(team_id) => setFilter((f) => ({ ...f, team_id }))}
            />
            <MultiSelectFilter
              label="Văn phòng"
              options={(filterOptions?.offices ?? []).map((o) => ({
                value: o.id,
                label: o.name,
              }))}
              selected={filter.office_id}
              onChange={(office_id) => setFilter((f) => ({ ...f, office_id }))}
            />
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter(EMPTY_FILTER)}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline max-sm:min-h-11 max-sm:px-2"
              >
                Xoá lọc
              </button>
            )}
          </div>

          {isLoading && !data ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Đang tải dữ liệu thống kê...
            </div>
          ) : !data ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Không có dữ liệu.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MetricCard label="Tổng nhân viên" value={data.total_employees} />
                <MetricCard label="Đã chấm công" value={data.distinct_checked_in} accent="text-emerald-600" />
                <MetricCard label="Chưa chấm công" value={data.not_checked_in} accent="text-slate-500" />
                <MetricCard label="Lượt vào" value={data.summary.checked_in} accent="text-blue-600" />
                <MetricCard label="Lượt ra" value={data.summary.checked_out} accent="text-violet-600" />
                <MetricCard label="Đủ vào-ra (có mặt)" value={data.summary.complete} accent="text-emerald-600" />
                <MetricCard label="Lượt đúng giờ" value={data.summary.on_time} accent="text-emerald-600" />
                <MetricCard label="Lượt đi muộn" value={data.summary.late} accent="text-amber-700" />
                <MetricCard label="Tổng phút muộn" value={data.summary.total_late_minutes} accent="text-amber-700" />
              </div>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="rounded-xl border p-4">
                  <p className="mb-2 text-sm font-semibold">
                    Phân loại lượt chấm công
                  </p>
                  <DonutChart slices={classifySlices} size={180} innerLabel="Lượt chấm" />
                </div>
                <div className="rounded-xl border p-4">
                  <p className="mb-2 text-sm font-semibold">
                    Người đã chấm công / tổng
                  </p>
                  <DonutChart slices={coverageSlices} size={180} innerLabel="Nhân viên" />
                </div>
              </div>

              <div className="rounded-xl border p-4">
                <p className="mb-2 text-sm font-semibold">Xu hướng theo ngày</p>
                <LineChart labels={lineLabels} series={lineSeries} height={240} />
              </div>

              {/* Thống kê theo Team */}
              {teamRows.length > 0 && (
                <div className="space-y-3 rounded-xl border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">Thống kê theo Team</p>
                    <ExportButton
                      endpoint="/management/attendance/stats/export-by-team"
                      params={exportParams}
                      filename="thong-ke-cham-cong-theo-team.xlsx"
                      label="Xuất Excel theo Team"
                    />
                  </div>
                  <AttendanceGroupBarChart groups={teamGroups} height={280} />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="px-2 py-2">Team</th>
                          {GROUP_METRIC_HEADERS}
                        </tr>
                      </thead>
                      <tbody>
                        {teamRows.map((r) => (
                          <tr
                            key={r.team_id ?? "none"}
                            className="border-b last:border-0"
                          >
                            <td className="px-2 py-2 font-medium">
                              {r.team_name}
                            </td>
                            <GroupMetricCells r={r} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Thống kê theo phòng ban */}
              {deptRows.length > 0 && (
                <div className="space-y-3 rounded-xl border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">Thống kê theo phòng ban</p>
                    <ExportButton
                      endpoint="/management/attendance/stats/export-by-department"
                      params={exportParams}
                      filename="thong-ke-cham-cong-theo-phong-ban.xlsx"
                      label="Xuất Excel theo Phòng ban"
                    />
                  </div>
                  <AttendanceGroupBarChart groups={deptGroups} height={280} />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[820px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="px-2 py-2">Phòng ban</th>
                          <th className="px-2 py-2">Trưởng phòng</th>
                          {GROUP_METRIC_HEADERS}
                        </tr>
                      </thead>
                      <tbody>
                        {deptRows.map((r) => (
                          <tr
                            key={r.department}
                            className="border-b last:border-0"
                          >
                            <td className="px-2 py-2 font-medium">
                              {r.department}
                            </td>
                            <td className="px-2 py-2 text-muted-foreground">
                              {r.head_name ?? "—"}
                            </td>
                            <GroupMetricCells r={r} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Về sớm — đơn xin về sớm + phút thiếu giờ + top NV về sớm */}
              {data.early_leave.total > 0 && (
                <div className="space-y-3 rounded-xl border p-4">
                  <p className="text-sm font-semibold">Về sớm</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <MetricCard label="Tổng đơn về sớm" value={data.early_leave.total} />
                    <MetricCard
                      label="Đã duyệt (bù công)"
                      value={data.early_leave.approved}
                      accent="text-emerald-600"
                    />
                    <MetricCard
                      label="Từ chối"
                      value={data.early_leave.rejected}
                      accent="text-red-600"
                    />
                    <MetricCard
                      label="Tổng phút về sớm"
                      value={data.early_leave.total_minutes}
                      accent="text-amber-700"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tỷ lệ đơn được duyệt:{" "}
                    <span className="font-semibold text-foreground">
                      {data.early_leave.approval_rate.toLocaleString("vi-VN")}%
                    </span>
                    {data.early_leave.pending > 0 &&
                      ` · Chờ duyệt: ${data.early_leave.pending}`}
                  </p>
                  {data.early_leave.top_leavers.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[420px] text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs text-muted-foreground">
                            <th className="px-2 py-2">Nhân viên về sớm nhiều nhất</th>
                            <th className="px-2 py-2 text-center">Số lần</th>
                            <th className="px-2 py-2 text-center">Tổng phút</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.early_leave.top_leavers.map((l) => (
                            <tr key={l.user_id} className="border-b last:border-0">
                              <td className="px-2 py-2 font-medium">
                                {l.full_name ?? `NV #${l.user_id}`}
                              </td>
                              <td className="px-2 py-2 text-center text-amber-700">
                                {l.count}
                              </td>
                              <td className="px-2 py-2 text-center text-amber-700">
                                {l.minutes.toLocaleString("vi-VN")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* 3 khối kỷ luật — tải độc lập với getAttendanceStats (endpoint riêng) */}
          {discipline && (
            <DisciplineSections data={discipline} exportParams={exportParams} />
          )}

          {/* Phân tích nghỉ phép (4 biểu đồ) — tải độc lập qua endpoint riêng */}
          <LeaveAnalyticsSection
            dateFrom={range.date_from}
            dateTo={range.date_to}
            filter={filter}
            open={open}
          />

          {/* Bảng NV vắng (chưa chấm vào lẫn ra) — có ô CHỌN NGÀY riêng (mặc định = ngày
              kết thúc bộ lọc), thay đổi tùy ý độc lập với khoảng ngày của biểu đồ; tự fetch. */}
          <AttendanceAbsentTable initialDate={range.date_to} enabled={open} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
