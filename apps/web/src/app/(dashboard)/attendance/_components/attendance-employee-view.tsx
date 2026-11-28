"use client"

import { useState } from "react"
import { ShellTabsContent as TabsContent, ShellTabs as Tabs, ShellTabsList as TabsList, ShellTabsTrigger as TabsTrigger } from "@/components/app-shell/tabs"
import { todayVn } from "@/lib/format"
import {
  useAttendanceList,
  useTodaySummary,
  type AttendanceRecord,
  type TodaySummarySelf,
} from "@/hooks/use-attendance"
import { AttendanceCalendar } from "./attendance-calendar"
import { AttendanceCheckCard, dayPhase, PHASE_HEADLINE } from "./attendance-check-card"
import { AttendanceMonthStrip, AttendanceTodayRows } from "./attendance-day-summary"
import { AttendanceHistoryCard } from "./attendance-history-card"
import { AttendanceMyRequests } from "./attendance-my-requests"

const WEEKDAY = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"]

/** "Thứ Bảy, 28/11/2026" từ ngày VN dạng YYYY-MM-DD. */
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${WEEKDAY[wd]}, ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`
}

/**
 * Màn chấm công của NHÂN VIÊN (thiết kế chamcong-mobile): đầu trang ngày + trạng thái ca, khối nhấn đồng hồ
 * + nút chấm công, «Hôm nay», «Tháng N», hàng «Tạo đơn» kèm đơn gần đây. Điện thoại: một cột; desktop: hai cột
 * (khối chấm công bên trái, tháng và đơn bên phải). Lịch sử chấm công + Lịch cá nhân (thiết kế không vẽ) giữ ở tab bên dưới.
 */
export function AttendanceEmployeeView({
  userId,
  onCreate,
}: {
  userId: number | undefined
  onCreate: () => void
}) {
  const today = todayVn()
  const summary = useTodaySummary()
  // Người xem được cả công ty: /today trả số liệu chung (không có `record`) → lấy bản ghi của mình qua danh sách.
  const summaryIsSelf = !!summary.data && "record" in summary.data
  const own = useAttendanceList({ date_from: today, date_to: today, user_id: userId, page: 1, page_size: 1 })
  const record: AttendanceRecord | null = summaryIsSelf
    ? ((summary.data as TodaySummarySelf).record ?? null)
    : (own.data?.data[0] ?? null)
  const loading = summary.isLoading || (!summaryIsSelf && !!summary.data && own.isLoading)
  const [tab, setTab] = useState("book")

  return (
    <div className="flex flex-col gap-4">
      <div className="px-1">
        <div className="text-sm text-ax-ink-2">{longDate(today)}</div>
        <h1 className="ax-text-title mt-0.5 text-[26px] text-ax-ink">{PHASE_HEADLINE[dayPhase(record)]}</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(360px,440px)_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-4">
          <AttendanceCheckCard record={record} loading={loading} />
          <AttendanceTodayRows record={record} />
        </div>
        <div className="flex flex-col gap-4">
          <AttendanceMonthStrip userId={userId} />
          <AttendanceMyRequests userId={userId} onCreate={onCreate} />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="w-full">
        <TabsList>
          <TabsTrigger value="book">Lịch sử chấm công</TabsTrigger>
          <TabsTrigger value="calendar">Lịch cá nhân</TabsTrigger>
        </TabsList>
        <TabsContent value="book" className="mt-4">
          <AttendanceHistoryCard isAdmin={false} canEdit={false} userId={userId} />
        </TabsContent>
        <TabsContent value="calendar" className="mt-4">
          <AttendanceCalendar userId={userId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
