"use client"

/* Import Attendance* trỏ vào `../../attendance/_components/**` — component
 * dùng chung với màn Chấm công, không nhân bản riêng cho màn này. */
import { useState } from "react"
import { BarChart3, Building2, CalendarDays, Download, MoreHorizontal, Settings } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useIsPhone } from "@/hooks/use-is-phone"
import { cn } from "@/lib/utils"
import { ShellTabsContent as TabsContent, ShellTabs as Tabs, ShellTabsList as TabsList, ShellTabsTrigger as TabsTrigger } from "@/components/app-shell/tabs"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { MonthlyGrid } from "./_components/monthly-grid"
import { DetailTable } from "./_components/detail-table"
import { AttendanceSummaryCard } from "../../attendance/_components/attendance-summary-card"
import { AttendanceHistoryCard } from "../../attendance/_components/attendance-history-card"
import { AttendanceExportButton } from "../../attendance/_components/attendance-export-button"
import { AttendanceStatsDialog } from "../../attendance/_components/attendance-stats-dialog"
import { AttendanceSettingsDialog } from "../../attendance/_components/attendance-settings-dialog"
import { OfficesDialog } from "../../attendance/_components/offices-dialog"
import { WorkingSaturdaysDialog } from "../../attendance/_components/working-saturdays-dialog"
import { AdminRequestsPanel } from "./_components/admin-requests-panel"

function lastDayOfSelectedMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  const last = new Date(y, m, 0)
  const mm = String(last.getMonth() + 1).padStart(2, "0")
  const dd = String(last.getDate()).padStart(2, "0")
  return `${last.getFullYear()}-${mm}-${dd}`
}

function defaultMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

function WorkdaysPageContent() {
  const { can } = usePermissions()
  // RBAC quyền + phạm vi: xem ngày công nhiều người = `attendance.view`; xoá/sửa
  // bản ghi + duyệt đơn = `attendance.manage`; cấu hình (ca, văn phòng, thứ 7)
  // = `attendance.config`; xuất = `attendance.export`. BE vẫn lọc theo scope.
  // "Quản lý chấm công" = xem ngày công của NHIỀU người → cần phạm vi ≥ team
  // (scope "own" chỉ có trang "Chấm công của tôi").
  const isAdmin = can("attendance.view", "team")
  const canManageRecords = can("attendance.manage")
  const canConfig = can("attendance.config")

  const [selectedMonth, setSelectedMonth] = useState<string>(defaultMonth)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [officesOpen, setOfficesOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [workingSatOpen, setWorkingSatOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const isPhone = useIsPhone()
  // Tab đang xem. Bộ lọc Tháng/Năm CHỈ áp cho "Tổng hợp theo nhân viên"
  // (summary) + "Chi tiết theo ngày" (detail) — 2 tab dùng dateFrom/dateTo.
  // "Lịch sử chấm công" + "Quản lý đơn" có bộ lọc riêng → ẩn Tháng/Năm để
  // tránh gây hiểu nhầm "filter không ra gì".
  const [tab, setTab] = useState<string>("history")
  const showMonthFilter = tab === "summary" || tab === "detail"

  if (!isAdmin) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500">
        Bạn không có quyền truy cập trang này
      </div>
    )
  }

  const showExportItem = can("attendance.export") && tab === "history"
  const showMoreMenu = showExportItem || canConfig

  const dateFrom = `${selectedMonth}-01`
  const dateTo = lastDayOfSelectedMonth(selectedMonth)

  return (
    <div className="flex flex-col gap-4">
      <ShellPageHeader
        title="Quản lý chấm công"
        icon={CalendarDays}
        description={<span className="max-sm:hidden">Thống kê và chi tiết chấm công nhân viên</span>}
        actions={
        <>
          {showMonthFilter && (
          <div className="flex items-center gap-2 max-sm:w-full">
            {(() => {
              const [selYear, selMonth] = selectedMonth.split("-").map(Number)
              const now = new Date()
              const currentYear = now.getFullYear()
              const currentMonth = now.getMonth() + 1
              const selectClass =
                "rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 max-sm:min-h-11 max-sm:flex-1"
              return (
                <>
                  <select
                    aria-label="Chọn tháng"
                    className={selectClass}
                    value={selMonth}
                    onChange={(e) => {
                      const newMonth = Number(e.target.value)
                      const mm = String(newMonth).padStart(2, "0")
                      setSelectedMonth(`${selYear}-${mm}`)
                    }}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option
                        key={m}
                        value={m}
                        disabled={selYear === currentYear && m > currentMonth}
                      >
                        Tháng {m}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Chọn năm"
                    className={selectClass}
                    value={selYear}
                    onChange={(e) => {
                      const newYear = Number(e.target.value)
                      const clampedMonth =
                        newYear === currentYear
                          ? Math.min(selMonth, currentMonth)
                          : selMonth
                      const mm = String(clampedMonth).padStart(2, "0")
                      setSelectedMonth(`${newYear}-${mm}`)
                    }}
                  >
                    {Array.from(
                      { length: currentYear - 2024 + 1 },
                      (_, i) => 2024 + i,
                    ).map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </>
              )
            })()}
          </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setStatsOpen(true)}
          >
            <BarChart3 className="size-4" />
            Thống kê chấm công
          </Button>
          {/* Mỗi tab có nút xuất riêng (Tổng hợp/Chi tiết) → nút header chỉ ở tab Lịch sử.
              <640px: Xuất Excel + Thiết lập gom vào menu "⋯"; desktop giữ nguyên. */}
          {can("attendance.export") && tab === "history" && (
            <AttendanceExportButton
              {...(isPhone ? { hideTrigger: true, open: exportOpen, onOpenChange: setExportOpen } : {})}
            />
          )}
          {canConfig && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-2 max-sm:hidden")}
              >
                <Settings className="size-4" />
                Thiết lập
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setWorkingSatOpen(true)}>
                  <CalendarDays className="size-4" />
                  Thứ 7 đi làm
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setOfficesOpen(true)}>
                  <Building2 className="size-4" />
                  Văn phòng
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                  <Settings className="size-4" />
                  Thiết lập ca làm
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isPhone && showMoreMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Thao tác khác"
                className={cn(buttonVariants({ variant: "outline", size: "icon" }), "max-sm:size-11")}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {showExportItem && (
                  <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setExportOpen(true)}>
                    <Download className="size-4" />
                    Xuất Excel
                  </DropdownMenuItem>
                )}
                {showExportItem && canConfig && <DropdownMenuSeparator />}
                {canConfig && (
                  <>
                    <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setWorkingSatOpen(true)}>
                      <CalendarDays className="size-4" />
                      Thứ 7 đi làm
                    </DropdownMenuItem>
                    <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setOfficesOpen(true)}>
                      <Building2 className="size-4" />
                      Văn phòng
                    </DropdownMenuItem>
                    <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setSettingsOpen(true)}>
                      <Settings className="size-4" />
                      Thiết lập ca làm
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="w-full">
        <TabsList layout="wrap">
          <TabsTrigger value="history" className="h-9 flex-none">Lịch sử chấm công</TabsTrigger>
          <TabsTrigger value="summary" className="h-9 flex-none">Tổng hợp theo nhân viên</TabsTrigger>
          <TabsTrigger value="detail" className="h-9 flex-none">Chi tiết theo ngày</TabsTrigger>
          <TabsTrigger value="requests" className="h-9 flex-none">Quản lý đơn</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-4">
          <div className="space-y-4">
            {canManageRecords && <AttendanceSummaryCard isAdmin={true} />}
            <AttendanceHistoryCard
              isAdmin={true}
              canEdit={canManageRecords}
              canDelete={canManageRecords}
            />
          </div>
        </TabsContent>

        <TabsContent value="summary" className="mt-4">
          <MonthlyGrid dateFrom={dateFrom} dateTo={dateTo} />
        </TabsContent>

        <TabsContent value="detail" className="mt-4">
          <DetailTable key={`${dateFrom}_${dateTo}`} dateFrom={dateFrom} dateTo={dateTo} />
        </TabsContent>

        <TabsContent value="requests" className="mt-4">
          <AdminRequestsPanel />
        </TabsContent>
      </Tabs>

      <AttendanceStatsDialog open={statsOpen} onOpenChange={setStatsOpen} />
      <WorkingSaturdaysDialog open={workingSatOpen} onOpenChange={setWorkingSatOpen} />
      <AttendanceSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {canConfig && (
        <OfficesDialog open={officesOpen} onOpenChange={setOfficesOpen} />
      )}
    </div>
  )
}

/** Cổng quyền cấp trang: thiếu `attendance.config` → Forbidden, không mount nội dung (0 request). */
export default function WorkdaysPage() {
  return (
    <PermissionGate permission="attendance.config">
      <WorkdaysPageContent />
    </PermissionGate>
  )
}
