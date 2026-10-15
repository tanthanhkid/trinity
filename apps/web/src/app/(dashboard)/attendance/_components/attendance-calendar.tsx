"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { formatDate, todayVn } from "@/lib/format"
import {
  useAttendanceList,
  useWorkingSaturdays,
  type AttendanceRecord,
} from "@/hooks/use-attendance"
import { AttendanceDetailDialog } from "./attendance-detail-dialog"

const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"]

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Năm + tháng (0-11) hiện tại theo giờ VN. */
function vnYearMonthNow(): { year: number; month: number } {
  const iso = todayVn() // YYYY-MM-DD theo Asia/Ho_Chi_Minh
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 }
}

function timeVn(iso: string | null): string {
  if (!iso) return "--:--"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

/**
 * Lịch chấm công cá nhân (theo tháng) của CHÍNH user đang đăng nhập.
 * - Ngày chỉ mới chấm VÀO (chưa chấm ra) → tô NỬA dưới xanh lá.
 * - Ngày chấm đủ VÀO + RA → tô FULL xanh lá.
 * - Click 1 ngày có chấm công → mở dialog chi tiết (giờ vào/ra).
 */
export function AttendanceCalendar({ userId }: { userId: number | undefined }) {
  const now = vnYearMonthNow()
  const [year, setYear] = useState(now.year)
  const [month, setMonth] = useState(now.month) // 0-11
  const [detailId, setDetailId] = useState<number | null>(null)

  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const monthStart = `${year}-${pad2(month + 1)}-01`
  const monthEnd = `${year}-${pad2(month + 1)}-${pad2(daysInMonth)}`

  const list = useAttendanceList({
    date_from: monthStart,
    date_to: monthEnd,
    user_id: userId, // luôn xem lịch của chính mình (admin cũng chỉ xem bản thân ở tab này)
    page: 1,
    page_size: 40,
    sort_by: "work_date",
    sort_dir: "asc",
  })

  // Thứ 7 được tính đi làm (cấu hình trong cài đặt chấm công) — để xác định ngày làm + tô đỏ khi vắng.
  const workingSat = useWorkingSaturdays()
  const workingSatSet = new Set(workingSat.data?.dates ?? [])

  // Map ngày-trong-tháng (1-31) → bản ghi. formatDate trả "DD/MM/YYYY" theo giờ VN → tránh lệch tz.
  const byDay = new Map<number, AttendanceRecord>()
  for (const r of list.data?.data ?? []) {
    const day = Number(formatDate(r.work_date).slice(0, 2))
    if (day >= 1 && day <= 31) byDay.set(day, r)
  }

  // Thứ của ngày 1 (Monday-first: 0=T2 .. 6=CN)
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  const todayIso = todayVn()
  const isCurrentMonth = todayIso.slice(0, 7) === `${year}-${pad2(month + 1)}`
  const todayDay = isCurrentMonth ? Number(todayIso.slice(8, 10)) : -1

  function prevMonth() {
    if (month === 0) {
      setYear((y) => y - 1)
      setMonth(11)
    } else {
      setMonth((m) => m - 1)
    }
  }
  function nextMonth() {
    if (month === 11) {
      setYear((y) => y + 1)
      setMonth(0)
    } else {
      setMonth((m) => m + 1)
    }
  }

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 max-sm:flex-wrap max-sm:gap-y-2">
        <CardTitle>Lịch chấm công cá nhân</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={prevMonth}
            aria-label="Tháng trước"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-[110px] text-center text-sm font-medium">
            Tháng {month + 1}/{year}
          </span>
          <Button
            size="icon"
            variant="outline"
            onClick={nextMonth}
            aria-label="Tháng sau"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 max-sm:px-3">
        {/* Chú thích màu */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded bg-emerald-500" /> Đủ vào + ra
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded bg-amber-500" /> Thiếu vào hoặc ra (quên 1)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded bg-red-500" /> Vắng (ngày làm, không chấm công)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded bg-sky-500" /> Nghỉ phép / Thai sản
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-3 rounded border" /> Ngày nghỉ / chưa tới
          </span>
        </div>

        {!userId ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Đang tải thông tin người dùng...
          </p>
        ) : (
          <>
            <div className="w-full max-w-md space-y-2">
              <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="py-1">
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
              {cells.map((day, idx) => {
                if (day === null) return <div key={`empty-${idx}`} />
                const rec = byDay.get(day)
                const hasIn = !!rec?.check_in_at
                const hasOut = !!rec?.check_out_at
                const complete = hasIn && hasOut
                const incomplete = hasIn !== hasOut // đúng 1 trong 2 (quên vào hoặc ra)
                const dateStr = `${year}-${pad2(month + 1)}-${pad2(day)}`
                const dow = new Date(year, month, day).getDay() // 0=CN .. 6=T7
                const isWorkingDay =
                  dow >= 1 && dow <= 5
                    ? true
                    : dow === 6
                      ? workingSatSet.has(dateStr)
                      : false
                const isPast = dateStr < todayIso
                // Nghỉ phép / thai sản: đơn được duyệt → có record nhưng check_in/out null
                const isLeave =
                  rec?.status === "leave" || rec?.status === "maternity"
                const absentWorking =
                  !isLeave && !hasIn && !hasOut && isWorkingDay && isPast && !list.isLoading && !list.isError
                const isToday = day === todayDay

                // Xanh dương = nghỉ phép/thai sản; Xanh lá = đủ vào+ra;
                // Cam = thiếu 1; Đỏ = ngày làm đã qua mà không chấm gì.
                const fill = isLeave
                  ? "bg-sky-500"
                  : complete
                    ? "bg-emerald-500"
                    : incomplete
                      ? "bg-amber-500"
                      : absentWorking
                        ? "bg-red-500"
                        : ""
                const filled = fill !== ""
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={!rec}
                    onClick={() => rec && setDetailId(rec.id)}
                    title={
                      rec
                        ? isLeave
                          ? `Nghỉ phép / Thai sản (${rec.status})`
                          : `Vào ${timeVn(rec.check_in_at)} · Ra ${timeVn(rec.check_out_at)}`
                        : absentWorking
                          ? "Ngày làm — chưa chấm công"
                          : undefined
                    }
                    // Ngoại lệ cho lưới lịch 7 cột: ô ≥40px (thực tế ~44px sau khi bỏ lề
                    // thừa) + khe 4px; 7×44 + 6×4 không thể thoả khe ≥8px trên 390px.
                    className={`relative aspect-square overflow-hidden rounded-md border text-sm transition max-sm:min-h-11 ${
                      rec
                        ? "cursor-pointer hover:ring-2 hover:ring-emerald-300"
                        : "cursor-default"
                    } ${isToday ? "ring-2 ring-sky-400" : ""}`}
                  >
                    {filled && <span className={`absolute inset-0 ${fill}`} />}
                    <span
                      className={`relative z-10 flex h-full items-center justify-center font-medium ${
                        filled ? "text-white" : "text-foreground"
                      }`}
                    >
                      {day}
                    </span>
                  </button>
                )
              })}
              </div>
            </div>
            {list.isLoading && (
              <p className="text-center text-xs text-muted-foreground">
                Đang tải...
              </p>
            )}
          </>
        )}
      </CardContent>

      <AttendanceDetailDialog
        recordId={detailId}
        canEdit={false}
        canDelete={false}
        onClose={() => setDetailId(null)}
      />
    </Card>
  )
}
