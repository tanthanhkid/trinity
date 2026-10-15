"use client"

/* =============================================================================
 * Khối tiêu đề trang dùng primitive `ShellPageHeader`
 * (`components/app-shell/page-header.tsx`); `Tabs`/`TabsList`/`TabsTrigger`
 * dùng `ShellTabs`/`ShellTabsList`/`ShellTabsTrigger`
 * (`components/app-shell/tabs.tsx`) — khung tab gạch chân xanh dương theo
 * thiết kế, KHÔNG đổi logic chuyển tab. */
import { useState } from "react"
import { BarChart3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ShellTabsContent as TabsContent, ShellTabs as Tabs, ShellTabsList as TabsList, ShellTabsTrigger as TabsTrigger } from "@/components/app-shell/tabs"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { useAuth } from "@/hooks/use-auth"
import { usePermissions } from "@/lib/rbac"
import { useAttendanceSettings } from "@/hooks/use-attendance"
import { AttendanceCheckCard } from "./_components/attendance-check-card"
import { AttendanceHistoryCard } from "./_components/attendance-history-card"
import { AttendanceCalendar } from "./_components/attendance-calendar"
import { AttendanceRequestForm } from "./_components/attendance-request-form"
import { AttendanceStatsDialog } from "./_components/attendance-stats-dialog"

export default function AttendancePage() {
  const { user } = useAuth()
  const { scopeOf } = usePermissions()
  const userId = user?.id
  // Ai có `attendance.view` với phạm vi rộng hơn "own" xem thống kê chấm công
  // của team/phòng/toàn bộ (BE tự scope theo `manager_id`).
  const viewScope = scopeOf("attendance.view")
  const canViewTeamStats = viewScope !== null && viewScope !== "own"
  const [statsOpen, setStatsOpen] = useState(false)
  // Tab đang mở: tab "Tạo đơn" có thanh đáy riêng (Gửi đơn) → ẩn thanh Chấm công vào/ra (<640px).
  const [tab, setTab] = useState("book")

  const { data: shift } = useAttendanceSettings()

  return (
    <div className="space-y-4">
      <ShellPageHeader
        title="Chấm công"
        description={
          <>
            <span className="max-sm:hidden">
              Chấm công theo IP văn phòng + thiết bị đã đăng ký (chụp selfie khi vào/ra).
            </span>
            {shift && (
              <>
                {" "}
                Ca làm:{" "}
                <span className="font-medium text-foreground">
                  {shift.work_start}–{shift.work_end}
                </span>{" "}
                · Muộn sau{" "}
                <span className="font-medium text-amber-700">{shift.late_after}</span>{" "}
                <span className="max-sm:hidden">
                  · Nghỉ trưa{" "}
                  <span className="font-medium text-foreground">
                    {shift.lunch_start}–{shift.lunch_end}
                  </span>
                </span>
                .
              </>
            )}
          </>
        }
        actions={
          canViewTeamStats && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-2"
              onClick={() => setStatsOpen(true)}
            >
              <BarChart3 className="size-4" />
              Thống kê chấm công nhóm
            </Button>
          )
        }
      />
      <AttendanceCheckCard hideActionBar={tab === "create-request"} />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="w-full">
        <TabsList>
          <TabsTrigger value="book">Lịch sử chấm công</TabsTrigger>
          <TabsTrigger value="calendar">Lịch cá nhân</TabsTrigger>
          <TabsTrigger value="create-request">Tạo đơn</TabsTrigger>
        </TabsList>
        <TabsContent value="book" className="mt-4">
          <AttendanceHistoryCard isAdmin={false} canEdit={false} userId={userId} />
        </TabsContent>
        <TabsContent value="calendar" className="mt-4">
          <AttendanceCalendar userId={userId} />
        </TabsContent>
        <TabsContent value="create-request" className="mt-4">
          <AttendanceRequestForm />
        </TabsContent>
      </Tabs>
      {canViewTeamStats && (
        <AttendanceStatsDialog open={statsOpen} onOpenChange={setStatsOpen} />
      )}
    </div>
  )
}
