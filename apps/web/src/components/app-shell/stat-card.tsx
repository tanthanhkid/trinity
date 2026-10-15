import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * Thẻ số liệu (KPI) dùng chung — ô icon hình vuông bo góc bên trái, nhãn nhạt
 * phía trên trị số đậm bên phải, xếp NGANG.
 *
 * ## Vì sao KHÔNG dùng gradient bão hoà
 *
 * Icon trắng trên nền đặc chỉ đạt chuẩn ĐỒ HOẠ (3:1, WCAG 1.4.11) với 4/7 tông
 * đo được (primary 4,53 · blue 5,11 · destructive-red 4,51 · violet 4,87), còn
 * lại (green 3,04 sát ngưỡng, amber 2,17 · sky 2,70 · gold 1,97) KHÔNG đạt hoặc
 * sát ngưỡng nguy hiểm. Để 1 bộ luật DUY NHẤT áp được cho MỌI tông: nền dùng
 * bậc "-soft", icon dùng `--foreground` (navy) — đo navy trên từng "-soft" đều
 * ≥ 14:1, thừa xa AA. 2 tông có bậc "ink"/"deep" riêng (primary, blue) dùng đúng
 * cặp đã có sẵn trong `app-tokens.css`:
 *   - `primary`: `--color-app-primary-soft` / `--color-app-primary-ink` — cặp
 *     "chip brand" (5,65:1).
 *   - `blue`: `--accent` / `--accent-foreground` — cặp "nhấn (điều hướng)" (6,11:1).
 * 5 tông còn lại (green/amber/red/violet/pink) đo trong
 * `__tests__/app-shell/stat-card-contrast.test.ts` (navy trên từng nền -soft,
 * tất cả 14,0–14,8:1).
 *
 * Dùng cho hàng thẻ số liệu ở `/management/employees/stats` và các màn thống kê.
 */
export type ShellStatTone = "primary" | "blue" | "green" | "amber" | "red" | "violet" | "pink"

const TONE_CLASS: Record<ShellStatTone, string> = {
  primary: "bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]",
  blue: "bg-accent text-accent-foreground",
  green: "bg-[var(--color-app-green-soft)] text-foreground",
  amber: "bg-[var(--color-app-amber-soft)] text-foreground",
  red: "bg-[var(--color-app-red-soft)] text-foreground",
  violet: "bg-[var(--color-app-violet-soft)] text-foreground",
  pink: "bg-[var(--color-app-pink-soft)] text-foreground",
}

export function ShellStatCard({
  icon: Icon,
  tone = "primary",
  label,
  value,
  hint,
  className,
}: {
  icon: LucideIcon
  tone?: ShellStatTone
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <Card className={cn("flex-row items-start gap-3 p-4", className)}>
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-[13px]",
          TONE_CLASS[tone],
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
        <p className="mt-0.5 truncate text-2xl font-bold tracking-tight text-foreground">
          {value}
        </p>
        {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </Card>
  )
}

/** Lưới thẻ số liệu — `.grid.g-4` của theme (gap 12px, 4→2→1 cột theo bề ngang). */
export function ShellStatGrid({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>
      {children}
    </div>
  )
}
