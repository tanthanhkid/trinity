import type { CSSProperties, ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * Thanh lọc dùng chung: khối `<section class="card pad">` + `.field`/`.label`
 * (flex column, gap 5px, label 12px semibold).
 *
 * Không tự dựng input/select — nhận field làm children để mỗi màn tự chọn
 * đúng field cần lọc.
 */
export function ShellFilterBar({
  children,
  actions,
  className,
}: {
  children: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <Card className={cn("gap-3 p-4", className)}>
      <div className="flex flex-wrap items-end gap-3">{children}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </Card>
  )
}

/** 1 ô lọc (label + control) — mirror `.field`/`.label` của theme. */
export function ShellFilterField({
  label,
  htmlFor,
  children,
  className,
  style,
}: {
  label: ReactNode
  /** id của ô nhập bên trong — gắn nhãn với control (a11y). */
  htmlFor?: string
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)} style={style}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
