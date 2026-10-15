import type { ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * Khung bảng dùng chung: `<section class="card">` bọc `.table-toolbar` + `.table-wrap`.
 *   - `.table-toolbar`: `padding:12px 14px`, `border-bottom:1px solid var(--line)`.
 *   - `.table-wrap`: `overflow-x:auto` — bảng rộng cuộn NGANG trong
 *     khung, KHÔNG làm cả trang cuộn ngang.
 *   - `thead th`: CỐ Ý không dùng `text-transform:uppercase` (làm mất dấu thanh
 *     tiếng Việt ở một số font/hệ điều hành).
 *
 * Không tự dựng `<table>` — bọc ngoài bảng/nội dung bất kỳ để có cùng
 * khung thẻ + thanh công cụ trên mọi màn.
 */
export function ShellTableFrame({
  title,
  toolbar,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden p-0", className)}>
      {(title || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {title && <h3 className="text-sm font-bold text-foreground">{title}</h3>}
          {toolbar && (
            <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>
          )}
        </div>
      )}
      <div className={cn("overflow-x-auto", bodyClassName)}>{children}</div>
    </Card>
  )
}
