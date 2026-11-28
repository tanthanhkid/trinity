"use client"

import { ChevronRight } from "lucide-react"
import { isoToVnDate } from "@/lib/format"
import { REQUEST_TYPE_LABEL, useAttendanceRequests } from "@/hooks/use-attendance"
import { RequestStatusPill } from "./request-status-pill"

/**
 * Hàng «Tạo đơn» + các đơn gần đây của CHÍNH mình (thiết kế chamcong-mobile).
 * Quản lý/nhân sự thấy mọi đơn ở API nên lọc theo `userId` phía client.
 */
export function AttendanceMyRequests({
  userId,
  onCreate,
}: {
  userId: number | undefined
  onCreate: () => void
}) {
  const { data } = useAttendanceRequests({ page: 1, page_size: 100 })
  const mine = (data?.data ?? []).filter((r) => r.user_id === userId).slice(0, 5)
  return (
    <div className="ax-card overflow-hidden">
      <button
        type="button"
        onClick={onCreate}
        className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 text-left text-base font-semibold text-ax-primary outline-none transition-colors hover:bg-ax-hover focus-visible:shadow-[inset_0_0_0_2px_var(--ax-primary)]"
      >
        <span className="flex-1">Tạo đơn (quên chấm, xin nghỉ…)</span>
        <ChevronRight className="size-4 text-ax-ink-3" aria-hidden />
      </button>
      {mine.map((r) => (
        <div
          key={r.id}
          className="flex min-h-14 items-center gap-3 border-t border-ax-divider px-4 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[15px]">
              {REQUEST_TYPE_LABEL[r.type] ?? r.type} {isoToVnDate(r.work_date).slice(0, 5)}
            </div>
            <div className="truncate text-[13px] text-ax-ink-2">
              {r.status === "pending"
                ? r.reason
                : r.review_note
                  ? `${r.reviewer_name ?? "Quản lý"}: ${r.review_note}`
                  : r.reviewer_name
                    ? `Xử lý bởi ${r.reviewer_name}`
                    : r.reason}
            </div>
          </div>
          <RequestStatusPill status={r.status} />
        </div>
      ))}
    </div>
  )
}
