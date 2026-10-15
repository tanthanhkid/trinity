"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import { DateRangeFilter, type DateRange } from "./date-range-filter"
import { BarChart } from "./charts/bar-chart"
import { LineChart } from "./charts/line-chart"
import { ReportCustomersUncontacted } from "./report-customers-uncontacted"

interface BreakdownItem {
  id: number | null
  label: string
  count: number
}

interface CustomersOverviewData {
  trend: { label: string; count: number }[]
  by_source: BreakdownItem[]
  by_status: BreakdownItem[]
  by_assignee: BreakdownItem[]
}

const CHART_COLOR = "var(--color-app-chart-1)"

/**
 * Tab "Khách hàng" — khách mới theo thời gian + phân bổ Nguồn/
 * Trạng thái/Người phụ trách + danh sách "chưa được chăm sóc quá N ngày".
 */
export function ReportCustomers() {
  const [dateRange, setDateRange] = useState<DateRange>({
    date_from: todayVn(),
    date_to: todayVn(),
  })

  const { data, isLoading } = useQuery<CustomersOverviewData>({
    queryKey: ["report-customers-overview", dateRange],
    queryFn: () =>
      apiClient
        .get("/reports/customers/overview", { params: dateRange })
        .then((r) => r.data),
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-foreground">Khách hàng</h2>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)]">
        <p className="mb-2 text-[15px] font-semibold text-foreground">Khách hàng mới theo thời gian</p>
        {isLoading || !data ? (
          <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
            Đang tải...
          </div>
        ) : (
          <LineChart
            labels={data.trend.map((t) => t.label)}
            series={[
              {
                key: "new_customers",
                label: "Khách mới",
                color: CHART_COLOR,
                values: data.trend.map((t) => t.count),
              },
            ]}
          />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <BreakdownCard title="Theo Nguồn" items={data?.by_source} loading={isLoading} />
        <BreakdownCard title="Theo Trạng thái" items={data?.by_status} loading={isLoading} />
        <BreakdownCard
          title="Theo người phụ trách"
          items={data?.by_assignee}
          loading={isLoading}
        />
      </div>

      <ReportCustomersUncontacted />
    </div>
  )
}

function BreakdownCard({
  title,
  items,
  loading,
}: {
  title: string
  items?: BreakdownItem[]
  loading: boolean
}) {
  const top = (items ?? []).slice(0, 8)
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)]">
      <p className="mb-2 text-[15px] font-semibold text-foreground">{title}</p>
      {loading ? (
        <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
          Đang tải...
        </div>
      ) : (
        <BarChart
          labels={top.map((i) => i.label)}
          series={[
            {
              key: "count",
              label: title,
              color: CHART_COLOR,
              values: top.map((i) => i.count),
            },
          ]}
          horizontal
          height={Math.max(160, top.length * 36)}
        />
      )}
    </div>
  )
}
