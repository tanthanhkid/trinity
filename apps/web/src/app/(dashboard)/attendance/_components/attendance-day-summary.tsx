"use client"

import { useMemo } from "react"
import { formatTimeVn, todayVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  useAttendanceList,
  useAttendanceSettings,
  type AttendanceRecord,
} from "@/hooks/use-attendance"

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Loại ô của một ngày trong dải tháng. */
export type DayKind = "full" | "late" | "leave" | "none"

export function dayKind(r: Pick<AttendanceRecord, "status" | "check_in_at" | "late_minutes"> | undefined): DayKind {
  if (!r) return "none"
  if (r.status === "leave" || r.status === "maternity") return "leave"
  if (!r.check_in_at) return "none"
  return (r.late_minutes ?? 0) > 0 ? "late" : "full"
}

const KIND_CLASS: Record<DayKind, string> = {
  full: "bg-ax-success",
  late: "bg-ax-warn",
  leave: "bg-[#9DBBD6]",
  none: "bg-ax-line",
}

/** Hàng nhãn — giá trị trong thẻ (cao ≥ 56px, vùng chạm thoải mái). */
function Row({ label, children, first }: { label: string; children: React.ReactNode; first?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-14 items-center justify-between px-4",
        !first && "border-t border-ax-divider",
      )}
    >
      <span className="text-[15px]">{label}</span>
      {children}
    </div>
  )
}

/** «Hôm nay»: giờ vào / giờ ra / ca làm của chính mình. */
export function AttendanceTodayRows({ record }: { record: AttendanceRecord | null }) {
  const { data: shift } = useAttendanceSettings()
  const inAt = record?.check_in_at
  const outAt = record?.check_out_at
  return (
    <section aria-labelledby="att-today">
      <h2 id="att-today" className="ax-text-group mx-8 mb-1.5 text-ax-ink-2">
        Hôm nay
      </h2>
      <div className="ax-card overflow-hidden">
        <Row label="Giờ vào" first>
          <span className={cn("ax-amount text-[17px] font-semibold", !inAt && "text-ax-ink-3")}>
            {inAt ? formatTimeVn(inAt) : "Chưa chấm"}
          </span>
        </Row>
        <Row label="Giờ ra">
          <span className={cn("ax-amount text-[17px] font-semibold", !outAt && "text-ax-ink-3")}>
            {outAt ? formatTimeVn(outAt) : "Chưa chấm"}
          </span>
        </Row>
        <Row label="Ca làm">
          <span className="ax-amount text-[15px] text-ax-ink-2">
            {shift ? `${shift.work_start} – ${shift.work_end}` : "—"}
          </span>
        </Row>
        {shift && (
          <p className="border-t border-ax-divider px-4 py-3 text-[13px] text-ax-ink-2">
            Muộn sau <span className="ax-amount font-semibold text-ax-warn">{shift.late_after}</span> · Nghỉ trưa{" "}
            <span className="ax-amount">
              {shift.lunch_start}–{shift.lunch_end}
            </span>
          </p>
        )}
      </div>
    </section>
  )
}

/** «Tháng N»: dải một ô một ngày + tóm tắt số ngày đủ công / đi muộn / nghỉ phép. */
export function AttendanceMonthStrip({ userId }: { userId: number | undefined }) {
  const today = todayVn()
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const daysInMonth = new Date(year, month, 0).getDate()
  const list = useAttendanceList({
    date_from: `${year}-${pad2(month)}-01`,
    date_to: `${year}-${pad2(month)}-${pad2(daysInMonth)}`,
    user_id: userId,
    page: 1,
    page_size: 40,
    sort_by: "work_date",
    sort_dir: "asc",
  })

  const { cells, counts } = useMemo(() => {
    const byDay = new Map<number, AttendanceRecord>()
    for (const r of list.data?.data ?? []) byDay.set(Number(r.work_date.slice(8, 10)), r)
    const counts: Record<DayKind, number> = { full: 0, late: 0, leave: 0, none: 0 }
    const cells: DayKind[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const k = dayKind(byDay.get(d))
      cells.push(k)
      counts[k]++
    }
    return { cells, counts }
  }, [list.data, daysInMonth])

  const summary = `${counts.full} ngày đủ công, ${counts.late} ngày đi muộn, ${counts.leave} ngày nghỉ phép`
  return (
    <section aria-labelledby="att-month">
      <h2 id="att-month" className="ax-text-group mx-8 mb-1.5 text-ax-ink-2">
        Tháng {month}
      </h2>
      <div className="ax-card px-4 py-3.5">
        <div role="img" aria-label={summary} className="flex gap-1">
          {cells.map((k, i) => (
            <span key={i} className={cn("h-7 flex-1 rounded-[5px]", KIND_CLASS[k])} />
          ))}
        </div>
        <div className="mt-2.5 flex justify-between gap-2 text-sm text-ax-ink-2">
          <span>{counts.full} ngày đủ công</span>
          <span>{counts.late} đi muộn</span>
          <span>{counts.leave} nghỉ phép</span>
        </div>
      </div>
    </section>
  )
}
