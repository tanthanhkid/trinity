import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/* =============================================================================
 * Nhãn trạng thái (badge).
 *
 * 8 tông + biến thể `dotted` (chấm tròn cùng màu chữ ở đầu nhãn) + 3 cỡ.
 * Mỗi tông là 1 CẶP token `--color-app-tag-<tone>-bg/-ink` đã ĐO đạt AA — xem
 * bảng số trong `styles/app-tokens.css`. **KHÔNG viết hex/bậc palette Tailwind
 * trực tiếp ở chỗ gọi**: 2 nguồn đó nằm NGOÀI bảng token nên `contrast.test.ts`
 * không thể kiểm, nên nhãn dễ tụt dưới AA mà không ai biết.
 * ========================================================================== */

export type ShellBadgeTone =
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "violet"
  | "teal"
  | "slate"
  | "pink"

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

const SIZE = {
  sm: "h-[22px] px-[7px] text-sm",
  md: "h-6 px-[9px] text-xs",
  lg: "h-[27px] px-[10px] text-xs",
} as const

export function ShellBadge({
  tone = "slate",
  size = "md",
  dotted = false,
  className,
  children,
}: {
  tone?: ShellBadgeTone
  size?: keyof typeof SIZE
  /** Chấm tròn 5px cùng màu chữ ở đầu nhãn — `.badge.dotted` của theme. */
  dotted?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] whitespace-nowrap rounded-full font-bold",
        TONE[tone],
        SIZE[size],
        className,
      )}
    >
      {dotted && (
        <i aria-hidden className="size-[5px] shrink-0 rounded-full bg-current" />
      )}
      {children}
    </span>
  )
}
