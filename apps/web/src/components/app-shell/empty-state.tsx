import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Trạng thái rỗng dùng chung: icon 56×56 bo góc 18, nền `--blue-soft`, chữ
 * `--blue`; `h4` tiêu đề + `p` mô tả tối đa 280px. Đậm hơn `components/ui/empty-state.tsx`
 * (icon xám mờ, không tiêu đề), có tiêu đề riêng ngoài mô tả — ý "đây là chỗ
 * trống có thể thao tác tiếp" thay vì "trang lỗi/hỏng".
 *
 * Icon dùng `bg-accent`/`text-accent-foreground` — ĐÚNG cặp "nhấn (điều
 * hướng)" đã được đo & khoá trong test tương phản (6,11:1), không phải
 * cặp màu mới.
 */
export function ShellEmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-5 py-9 text-center",
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-[18px] bg-accent text-accent-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
      {title && <h4 className="text-sm font-semibold text-foreground">{title}</h4>}
      {description && (
        <p className="max-w-[280px] text-xs text-muted-foreground">{description}</p>
      )}
      {action}
    </div>
  )
}
