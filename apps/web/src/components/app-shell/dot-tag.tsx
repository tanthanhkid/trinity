import type { CSSProperties, ReactNode } from "react"
import type { ShellBadgeTone } from "@/components/app-shell/badge"
import { cn } from "@/lib/utils"

/* =============================================================================
 * Nhãn có chấm màu của giao diện mới — cùng hình với nhãn giai đoạn ở màn Khách hàng
 * (`StagePill`) và nhãn trạng thái ở Hộp thư (`StatusPill`): bo 6px, chữ 14px, chấm cùng màu chữ.
 * Màu lấy từ cặp token `--color-app-tag-<tone>-bg/-ink` (đã đo AA, có bản tối) như `ShellBadge`.
 * `style` cho trường hợp màu do người dùng chọn (nhãn Kanban) — khi đó không dùng `tone`.
 * ========================================================================== */

const TONE: Record<ShellBadgeTone, string> = {
  blue: "bg-[var(--color-app-tag-blue-bg)] text-[var(--color-app-tag-blue-ink)]",
  green: "bg-[var(--color-app-tag-green-bg)] text-[var(--color-app-tag-green-ink)]",
  amber: "bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]",
  red: "bg-[var(--color-app-tag-red-bg)] text-[var(--color-app-tag-red-ink)]",
  violet: "bg-[var(--color-app-tag-violet-bg)] text-[var(--color-app-tag-violet-ink)]",
  teal: "bg-[var(--color-app-tag-teal-bg)] text-[var(--color-app-tag-teal-ink)]",
  slate: "bg-[var(--color-app-tag-slate-bg)] text-[var(--color-app-tag-slate-ink)]",
  pink: "bg-[var(--color-app-tag-pink-bg)] text-[var(--color-app-tag-pink-ink)]",
}

export function DotTag({
  tone = "slate",
  dotColor,
  outline = false,
  className,
  style,
  title,
  children,
}: {
  tone?: ShellBadgeTone
  /** Màu chấm riêng (vd màu nhãn Kanban do người dùng chọn); chữ giữ màu thường để đủ tương phản. */
  dotColor?: string
  /** Nền thẻ + viền 1px (dùng với `dotColor`). */
  outline?: boolean
  className?: string
  style?: CSSProperties
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      style={style}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-sm font-medium",
        outline ? "border border-[var(--border)] bg-[var(--card)] text-[var(--color-app-ink-2)]" : TONE[tone],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: dotColor ?? "currentColor" }} />
      <span className="truncate">{children}</span>
    </span>
  )
}
