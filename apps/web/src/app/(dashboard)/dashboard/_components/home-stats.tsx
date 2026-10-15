import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { BOX } from './home-box'

export interface HomeStatItem {
  key: string
  label: string
  value: string
  note?: string
  /** `ok` xanh (tốt lên) · `warn` cam (cần để ý) · `muted` xám (thông tin). Màu luôn đi kèm chữ, không chỉ màu. */
  tone?: 'ok' | 'warn' | 'muted'
  /** Số chính xác khi `value` là dạng rút gọn (vd doanh thu "6,4 triệu"). */
  title?: string
}

const TONE: Record<NonNullable<HomeStatItem['tone']>, string> = {
  ok: 'text-[var(--color-app-tag-green-ink)]',
  warn: 'text-[var(--color-app-tag-amber-ink)]',
  muted: 'text-muted-foreground',
}

/** Hàng thẻ số `.stats` của bản demo: nhãn xám, số lớn 26px, một dòng ghi chú có màu theo ý nghĩa. */
export function HomeStats({ items, loading }: { items: HomeStatItem[]; loading?: boolean }) {
  const cols = items.length >= 4 ? 'lg:grid-cols-4' : items.length === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
  return (
    <div className={cn('grid grid-cols-2 gap-3', cols)} data-testid="home-stats">
      {items.map((s) => (
        <div key={s.key} className={cn(BOX, 'min-w-0 px-4 py-3.5')} title={s.title}>
          <p className="truncate text-[14px] text-muted-foreground">{s.label}</p>
          <div className="mt-1 mb-0.5 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] tabular-nums text-[var(--foreground)] sm:text-[26px]">
            {loading ? <Skeleton className="h-7 w-20" /> : s.value}
          </div>
          {s.note && !loading && <p className={cn('text-[14px] leading-snug', TONE[s.tone ?? 'muted'])}>{s.note}</p>}
        </div>
      ))}
    </div>
  )
}
