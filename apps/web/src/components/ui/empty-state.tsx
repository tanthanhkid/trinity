import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Khung "trạng thái rỗng" dùng chung — icon minh hoạ + thông điệp + (tuỳ chọn) hành động.
 * Thay cho text xám trơ trọi để màn hình rỗng trông "chưa có dữ liệu" thay vì "lỗi/trống rỗng".
 */
export function EmptyState({
  icon: Icon,
  title,
  message,
  action,
  className,
}: {
  icon?: LucideIcon
  /** Dòng tiêu đề 14/500 phía trên lời nhắn (tuỳ chọn). */
  title?: string
  message: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-10 text-center text-muted-foreground",
        className,
      )}
    >
      {Icon ? (
        <span className="empty-enter-icon flex size-12 items-center justify-center rounded-full bg-muted">
          <Icon className="size-6" aria-hidden />
        </span>
      ) : null}
      <div className="empty-enter-copy flex max-w-md flex-col gap-1 text-balance">
        {title ? <p className="text-sm font-medium text-foreground">{title}</p> : null}
        <p className={title ? "text-[13px] leading-5" : "text-sm text-foreground/80"}>{message}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
