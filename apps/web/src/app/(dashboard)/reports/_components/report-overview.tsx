"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Users, Activity } from "lucide-react"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import { DateRangeFilter, type DateRange } from "./date-range-filter"
import { ReportKpiCard, ReportKpiCardSkeleton, type ReportDeltaMetric } from "./report-kpi-card"

interface ReportOverviewData {
  new_customers: ReportDeltaMetric
  activities: ReportDeltaMetric
  scope_label: "cá nhân" | "team" | "phòng" | "toàn hệ thống"
}

/**
 * Tab "Tổng quan" — KPI CRM tổng quát, KHÔNG đụng `deals`/doanh thu.
 */
export function ReportOverview() {
  const [dateRange, setDateRange] = useState<DateRange>({
    date_from: todayVn(),
    date_to: todayVn(),
  })

  const { data, isLoading } = useQuery<ReportOverviewData>({
    queryKey: ["report-overview", dateRange],
    queryFn: () =>
      apiClient.get("/reports/overview", { params: dateRange }).then((r) => r.data),
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[17px] font-semibold text-foreground">Tổng quan</h2>
          {data && (
            <p className="text-xs text-muted-foreground">
              Phạm vi: {data.scope_label}
            </p>
          )}
        </div>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      {/* `.toLocaleString("vi-VN")` dưới đây format SỐ (dấu phân cách nghìn),
          KHÔNG phải NGÀY (lệch múi giờ chỉ xảy ra với
          toLocaleDateString/toLocaleString trên Date). Mirror convention có
          sẵn ở charts/bar-chart.tsx + dashboard-stats-shared.tsx. */}
      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <ReportKpiCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <ReportKpiCard
            icon={Users}
            title="Khách hàng mới"
            value={data.new_customers.current.toLocaleString("vi-VN")}
            delta={data.new_customers}
            unit="khách"
          />
          <ReportKpiCard
            icon={Activity}
            title="Số hoạt động"
            value={data.activities.current.toLocaleString("vi-VN")}
            delta={data.activities}
            unit="hoạt động"
          />
        </div>
      )}
    </div>
  )
}
