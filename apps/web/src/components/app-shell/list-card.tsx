import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Thẻ dùng chung cho danh sách dạng thẻ trên điện thoại — 1 thẻ =
 * 1 dòng dữ liệu, dùng cạnh `ShellResponsiveList`. Không tự áp `space-y` giữa
 * các thẻ — bọc ngoài bằng `<div className="space-y-3 sm:hidden">` ở nơi gọi.
 */
export function ShellListCard({
  children,
  onClick,
  className,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "space-y-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-card p-4 text-sm shadow-[var(--shadow-card)]",
        onClick && "cursor-pointer active:bg-muted/40",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** 1 dòng "nhãn — giá trị" bên trong `ShellListCard` (label trái, value phải). */
export function ShellListCardRow({
  label,
  value,
  className,
}: {
  label: ReactNode
  value: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium">{value}</span>
    </div>
  )
}
