"use client"

import { useMemo } from "react"
import {
  useLeaveAnalytics,
  type LeaveTypeSlice,
  type StatsFilter,
} from "@/hooks/use-attendance"
import { LeaveDonut3D, type LeaveDonutSlice } from "./leave-donut-3d"
import { LeaveStackedBar3D, type LeaveBarSeries } from "./leave-stacked-bar-3d"
import {
  GENDER_COLORS,
  departmentColor,
  leaveTypeColor,
} from "./leave-analytics-utils"

interface Props {
  dateFrom: string
  dateTo: string
  filter: StatsFilter
  open: boolean
}

const toDonutSlices = (rows: LeaveTypeSlice[]): LeaveDonutSlice[] =>
  rows.map((r) => ({
    key: r.type,
    label: r.label,
    color: leaveTypeColor(r.type),
    value: r.value,
  }))

/**
 * Khu "Phân tích nghỉ phép" trong popup Thống kê chấm công — 4 biểu đồ SVG faux-3D.
 * Render độc lập (loading riêng qua `useLeaveAnalytics(..., open)`) như DisciplineSections.
 */
export function LeaveAnalyticsSection({ dateFrom, dateTo, filter, open }: Props) {
  const { data, isLoading } = useLeaveAnalytics(dateFrom, dateTo, filter, open)

  const barSeries: LeaveBarSeries[] = useMemo(() => {
    if (!data) return []
    return data.by_week.departments.map((d, i) => ({
      department: d.department,
      color: departmentColor(i),
      values: d.values,
    }))
  }, [data])

  if (isLoading && !data) {
    return (
      <div className="rounded-xl border p-4 text-sm text-muted-foreground">
        Đang tải phân tích nghỉ phép…
      </div>
    )
  }
  if (!data) return null

  const genderSlices: LeaveDonutSlice[] = data.by_gender.map((g) => ({
    key: g.gender,
    label: g.label,
    color: GENDER_COLORS[g.gender],
    value: g.value,
  }))

  const totalDays = data.by_type_days.reduce((s, r) => s + r.value, 0)
  const totalRequests = data.by_type_requests.reduce((s, r) => s + r.value, 0)

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div>
        <h3 className="text-sm font-semibold">Phân tích nghỉ phép</h3>
        <p className="text-xs text-muted-foreground">
          Theo loại đơn · theo tuần × phòng ban · theo giới tính
        </p>
      </div>

      {totalRequests === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          Chưa có dữ liệu nghỉ phép trong kỳ
        </div>
      ) : (
        <div className="space-y-5">
          {/* Hàng 1: 2 donut theo loại */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Tổng ngày nghỉ theo loại (đơn đã duyệt)
              </p>
              <LeaveDonut3D
                slices={toDonutSlices(data.by_type_days)}
                size={180}
                innerLabel="ngày"
                labelMode="legend-right"
              />
            </div>
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Số đơn xin nghỉ theo loại (tất cả đơn)
              </p>
              <LeaveDonut3D
                slices={toDonutSlices(data.by_type_requests)}
                size={180}
                innerLabel="đơn"
                labelMode="legend-right"
              />
            </div>
          </div>

          {/* Hàng 2: cột xếp chồng theo tuần × phòng ban (full-width) */}
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Tình hình nghỉ theo tuần (xếp chồng theo phòng ban)
            </p>
            <LeaveStackedBar3D weeks={data.by_week.weeks} series={barSeries} height={300} />
          </div>

          {/* Hàng 3: donut theo giới tính (căn giữa) */}
          <div className="rounded-lg border p-3">
            <p className="mb-2 text-center text-xs font-medium text-muted-foreground">
              Tổng ngày nghỉ theo giới tính
            </p>
            <div className="flex justify-center">
              <LeaveDonut3D
                slices={genderSlices}
                size={190}
                innerLabel="ngày"
                labelMode="legend-bottom"
              />
            </div>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            Tổng ngày nghỉ (đã duyệt): {totalDays.toLocaleString("vi-VN")} · Tổng đơn:{" "}
            {totalRequests.toLocaleString("vi-VN")}
          </p>
        </div>
      )}
    </div>
  )
}
