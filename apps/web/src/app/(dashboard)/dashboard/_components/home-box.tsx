import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Khung `.box` của bản demo: viền mảnh, nền thẻ, bóng rất nhẹ; tiêu đề `.box-h` có đường kẻ dưới. */
export const BOX = 'rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]'

/** Nút phụ nhỏ `.btn.sm` (Trả lời / Mở / Xem): chữ 14px, chạm ≥44px trên điện thoại. */
export const SMALL_BTN =
  'inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-[var(--input)] bg-[var(--card)] px-2.5 text-[14px] font-medium text-[var(--foreground)] transition hover:bg-[var(--muted)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] max-sm:min-h-11 max-sm:min-w-11'

/** Nút chữ trơn `.undo` (Xem trong dòng thời gian). */
export const GHOST_BTN =
  'inline-flex shrink-0 items-center rounded-md px-1.5 py-1 text-[14px] text-muted-foreground transition hover:bg-[var(--muted)] hover:text-[var(--foreground)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] max-sm:min-h-11 max-sm:min-w-11'

export function HomeBox({
  title,
  icon,
  aside,
  children,
  className,
  labelledBy,
}: {
  title: string
  icon?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  labelledBy: string
}) {
  return (
    <section aria-labelledby={labelledBy} className={cn(BOX, 'min-w-0', className)}>
      <header className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
        {icon}
        <h2 id={labelledBy} className="text-[15px] font-semibold text-[var(--foreground)]">{title}</h2>
        {aside !== undefined && <span className="ml-auto text-[14px] text-muted-foreground">{aside}</span>}
      </header>
      {children}
    </section>
  )
}

/** Trạng thái trống trong một khung: câu ngắn + (tuỳ chọn) 1 hành động dẫn tới màn sẵn có. */
export function HomeEmpty({ children, action, testId }: { children: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-5" data-testid={testId}>
      <p className="text-[14px] leading-relaxed text-muted-foreground">{children}</p>
      {action}
    </div>
  )
}
