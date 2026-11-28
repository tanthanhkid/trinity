import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Khung "trạng thái rỗng" dùng chung — icon minh hoạ + thông điệp + (tuỳ chọn) hành động.
 * Thay cho text xám trơ trọi để màn hình rỗng trông "chưa có dữ liệu" thay vì "lỗi/trống rỗng".
 *
 * @example «Ánh xanh» (docs/design/anh-xanh.md)
 * <EmptyState variant="ax" icon={Users} title="Chưa có khách nào trong giai đoạn Báo giá"
 *   message="Khi bạn chuyển khách sang Báo giá, họ sẽ hiện ở đây."
 *   action={<Button variant="ax-primary" size="ax">Thêm khách</Button>} />
 */
export function EmptyState({
  icon: Icon,
  title,
  message,
  action,
  className,
  variant = "default",
}: {
  /** `"ax"` = dáng «Ánh xanh» (khối lõm có quầng xanh nhạt, icon nét 20px, tiêu đề 15/600).
   *  Mặc định giữ dáng cũ. */
  variant?: "default" | "ax"
  icon?: LucideIcon
  /** Dòng tiêu đề 14/500 phía trên lời nhắn (tuỳ chọn). */
  title?: string
  message: string
  action?: ReactNode
  className?: string
}) {
  if (variant === "ax") {
    return (
      <div
        data-slot="empty-state"
        data-variant="ax"
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-[var(--ax-radius-card)] px-5 py-7 text-center ax-grad-empty shadow-[var(--ax-shadow-inset)]",
          className,
        )}
      >
        {Icon ? <Icon className="empty-enter-icon size-5 text-ax-ink-3" strokeWidth={1.75} aria-hidden /> : null}
        <div className="empty-enter-copy flex max-w-md flex-col gap-1 text-balance">
          {title ? <p className="text-[15px] font-semibold tracking-[-0.011em] text-ax-ink">{title}</p> : null}
          <p className="text-[13px] leading-5 text-ax-ink-2">{message}</p>
        </div>
        {action ? <div className="mt-1.5">{action}</div> : null}
      </div>
    )
  }
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
