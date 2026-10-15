"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowLeft, BarChart3, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { buttonVariants } from "@/components/ui/button"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { todayVn } from "@/lib/format"
import {
  useHrStats,
  useBirthdayList,
  useBirthdayExport,
  type HrStatsFilters,
} from "@/hooks/use-employees"
import { OverviewCharts } from "./_components/overview-charts"
import { HrStatsFilters as HrStatsFiltersBar } from "./_components/hr-stats-filters"
import { TeamStructureChart } from "./_components/team-structure-chart"
import { TeamStatusChart } from "./_components/team-status-chart"
import { BirthdayMonthChart } from "./_components/birthday-month-chart"
import { BirthdayListTable } from "./_components/birthday-list-table"
import { ResignedStats } from "./_components/resigned-stats"

function currentVnMonth(): number {
  return Number(todayVn().slice(5, 7))
}

function EmployeeStatsPageContent() {
  const { can } = usePermissions()
  const canView = can("employees.view")
  const canExport = can("employees.export")

  const [applied, setApplied] = useState<HrStatsFilters>({})
  const [month, setMonth] = useState<number>(currentVnMonth())

  const { data: hrStats, isLoading: hrLoading } = useHrStats(applied)
  const { data: birthday, isLoading: bdLoading } = useBirthdayList({
    ...applied,
    month,
  })
  const exportMut = useBirthdayExport()

  const handleExport = async () => {
    try {
      const blob = await exportMut.mutateAsync({ ...applied, month })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `danh-sach-sinh-nhat-thang-${month}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error("Không xuất được Excel — thử lại hoặc liên hệ quản trị viên")
    }
  }

  if (!canView) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Bạn không có quyền xem trang Thống kê nhân viên.
        </p>
      </div>
    )
  }

  const showHrLoader = hrLoading && !hrStats

  // Gộp số NV ĐÃ NGHỈ (resigned_by_team) vào cột "Nghỉ việc" của biểu đồ "trạng thái
  // theo team" — by_team_status (BE) chỉ đếm NV đang làm nên cột nghỉ việc = 0.
  const teamStatusRows = (() => {
    const base = (hrStats?.by_team_status ?? []).map((r) => ({ ...r }))
    const byId = new Map(base.map((r) => [r.team_lead_id, r]))
    for (const rt of hrStats?.resigned_by_team ?? []) {
      const found = byId.get(rt.team_lead_id)
      if (found) found.resigned = rt.count
      else
        base.push({
          team_lead_id: rt.team_lead_id,
          team_name: rt.team_name,
          active: 0,
          probation: 0,
          on_leave: 0,
          resigned: rt.count,
          other: 0,
        })
    }
    return base
  })()

  return (
    <div className="flex flex-col gap-4">
      <ShellPageHeader
        className="max-sm:-order-2"
        title="Thống kê nhân viên"
        icon={BarChart3}
        description={<span className="max-sm:hidden">Cơ cấu Team, trạng thái & sinh nhật nhân viên theo tháng.</span>}
        actions={
          <Link
            href="/management/employees"
            className={buttonVariants({ variant: "outline" })}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Quay lại danh sách
          </Link>
        }
      />

      {/* Tổng quan toàn công ty (không filter) */}
      <OverviewCharts />

      {/* Bộ lọc — áp cho phần Team + Sinh nhật bên dưới. Điện thoại: đưa lên ngay dưới header (CSS order, desktop không đổi) */}
      <div className="max-sm:-order-1">
        <HrStatsFiltersBar applied={applied} onApply={setApplied} />
      </div>

      {showHrLoader ? (
        <div className="flex justify-center rounded-[var(--radius)] border bg-card py-16 shadow-sm">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <TeamStructureChart
              rows={hrStats?.by_team ?? []}
              total={hrStats?.total ?? 0}
            />
            <TeamStatusChart rows={teamStatusRows} />
          </div>

          <BirthdayMonthChart
            rows={hrStats?.birthdays_by_month ?? []}
            selectedMonth={month}
            onSelect={setMonth}
          />

          {/* Danh sách sinh nhật ngay dưới biểu đồ → bấm tháng thấy danh sách liền */}
          <BirthdayListTable
            month={month}
            items={birthday?.items ?? []}
            isLoading={bdLoading && !birthday}
            canExport={canExport}
            exporting={exportMut.isPending}
            onExport={handleExport}
          />

          <ResignedStats stats={hrStats} />
        </>
      )}
    </div>
  )
}

/** Cổng quyền cấp trang: thiếu `employees.view` → Forbidden, không mount nội dung (0 request). */
export default function EmployeeStatsPage() {
  return (
    <PermissionGate permission="employees.view">
      <EmployeeStatsPageContent />
    </PermissionGate>
  )
}
