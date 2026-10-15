"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Skeleton } from "@/components/ui/skeleton"
import apiClient from "@/lib/api-client"
import { todayVn } from "@/lib/format"
import { RecruitmentCharts } from "./mkt-data-charts"
import { DateRangeFilter, type DateRange } from "./date-range-filter"

interface RecruitmentOverview {
  positions_posted: number
  candidates_interested: number
  candidates_interviewed: number
  candidates_hired: number
  recruitment_messages: number | null
  recruitment_messages_available: boolean
  cv_received: number | null
  cv_received_available: boolean
}

/**
 * Tab "Tuyển dụng" — tab độc lập có bộ lọc thời gian riêng.
 * RBAC khớp BE `GET /reports/marketing/recruitment-overview`: marketing (scope chính
 * mình qua recruiter_id/created_by), super_admin/hr (toàn bộ).
 */
export function ReportRecruitment() {
  const [dateRange, setDateRange] = useState<DateRange>({
    date_from: todayVn(),
    date_to: todayVn(),
  })

  const { data: recruitmentOverview, isLoading: loadingRecruitment } =
    useQuery<RecruitmentOverview>({
      queryKey: ["report-recruitment", dateRange],
      queryFn: () =>
        apiClient
          .get("/reports/marketing/recruitment-overview", { params: dateRange })
          .then((r) => r.data),
    })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-[17px] font-semibold text-foreground">Tuyển dụng</h2>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      {loadingRecruitment || !recruitmentOverview ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : (
        <>
          <RecruitmentCharts data={recruitmentOverview} />
        </>
      )}
    </div>
  )
}
