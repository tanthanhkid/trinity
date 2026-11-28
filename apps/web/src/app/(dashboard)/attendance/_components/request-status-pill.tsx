import { cn } from "@/lib/utils"
import { REQUEST_STATUS_LABEL, type RequestStatus } from "./attendance-board-utils"

const TONE: Record<RequestStatus, string> = {
  pending: "bg-ax-warn-soft text-ax-warn",
  approved: "bg-ax-success-soft text-ax-success",
  rejected: "bg-ax-danger-soft text-[var(--ax-danger-ink)]",
}

/** Viên trạng thái đơn chấm công: chấm 6px + chữ 600, nền nhạt theo tông (cảnh báo / thành công / nguy hiểm). */
export function RequestStatusPill({
  status,
  className,
}: {
  status: RequestStatus
  className?: string
}) {
  return (
    <span
      data-slot="request-status-pill"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] leading-5 font-semibold",
        TONE[status],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {REQUEST_STATUS_LABEL[status]}
    </span>
  )
}
