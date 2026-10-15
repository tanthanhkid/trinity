'use client'

import Link from 'next/link'
import { ChevronRight, Bell, SquareKanban } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, formatTimeVn, todayVn, vnDateKey } from '@/lib/format'
import type { DashboardTaskItem, DashboardTasksData } from './use-dashboard-overview'

/** Nhãn mức ưu tiên — LUÔN chữ + màu (không chỉ màu, WCAG 1.4.1). */
const PRIORITY: Record<string, { label: string; cls: string }> = {
  urgent: { label: 'Khẩn', cls: 'text-[var(--color-app-tag-red-ink)]' },
  high: { label: 'Cao', cls: 'text-[var(--color-app-tag-amber-ink)]' },
}

export function taskHref(t: DashboardTaskItem): string {
  if (t.kind === 'kanban') return `/kanban?card=${t.id}`
  return t.id > 0 ? `/contacts/${t.id}` : '/contacts' // id 0 = khách ngoài phạm vi xem
}

/** Hạn: hôm nay → giờ; ngày khác → ngày (quá hạn nói rõ). */
export function formatTaskDue(iso: string, today = todayVn()): string {
  return vnDateKey(iso) === today ? formatTimeVn(iso) : formatDate(iso)
}

function TaskRow({ t }: { t: DashboardTaskItem }) {
  const Icon = t.kind === 'kanban' ? SquareKanban : Bell
  const pr = t.priority ? PRIORITY[t.priority] : undefined
  return (
    <li>
      <Link
        href={taskHref(t)}
        className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-[var(--color-app-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--color-app-surface-2)] text-[var(--color-app-ink-2)]">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-[var(--color-app-navy)]">{t.title}</span>
          <span className="block truncate text-[14px] text-[var(--color-app-ink-2)]">
            {t.kind === 'reminder' ? 'Lịch hẹn nhắc' : 'Công việc'}
            {t.contact_name ? ` · ${t.contact_name}` : ''}
          </span>
        </span>
        {pr && <span className={cn('shrink-0 text-[14px] font-bold', pr.cls)}>{pr.label}</span>}
        <span
          className={cn(
            'shrink-0 text-right text-[14px] tabular-nums',
            t.overdue ? 'font-bold text-[var(--color-app-tag-red-ink)]' : 'text-[var(--color-app-ink-2)]',
          )}
        >
          {t.overdue && <span className="block text-[14px]">Quá hạn</span>}
          {formatTaskDue(t.due_at)}
        </span>
      </Link>
    </li>
  )
}

export function DashboardTasksCard({
  tasks,
  isLoading,
  filterNote,
  className,
}: {
  tasks: DashboardTasksData | undefined
  isLoading: boolean
  /** Có giá trị khi super_admin đang lọc — đổi mô tả "việc của riêng bạn". */
  filterNote?: string | null
  className?: string
}) {
  return (
    <section className={cn('flex flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]', className)}>
      <header className="flex items-center gap-2 px-3.5 pt-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-tight text-[var(--color-app-navy)]">Việc cần làm hôm nay</h3>
          <p className="mt-0.5 text-[14px] text-[var(--color-app-ink-2)]">
            {filterNote
              ? `Việc của: ${filterNote} — card Kanban đến hạn và lịch hẹn nhắc việc, gấp nhất trước.`
              : 'Việc của riêng bạn: card Kanban đến hạn và lịch hẹn nhắc việc, gấp nhất trước.'}
          </p>
        </div>
        <Link
          href="/kanban"
          className="relative ml-auto inline-flex shrink-0 after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] pointer-coarse:sm:after:-inset-y-[13px] items-center gap-0.5 max-sm:min-h-11 text-[14px] font-semibold text-[var(--color-app-primary-ink)] hover:underline"
        >
          Xem công việc <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </header>
      <div className="flex-1 p-2 pt-2">
        {isLoading ? (
          <div className="space-y-2 p-1.5">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
          </div>
        ) : !tasks || tasks.items.length === 0 ? (
          <p className="py-8 text-center text-[14px] text-[var(--color-app-ink-2)]">
            Không có việc cần xử lý hôm nay.
          </p>
        ) : (
          <>
            <ul>{tasks.items.map((t) => <TaskRow key={t.key} t={t} />)}</ul>
            {tasks.total > tasks.items.length && (
              <p className="px-2 pt-1 text-[14px] text-[var(--color-app-ink-2)]">
                Đang hiện {tasks.items.length}/{tasks.total} việc gấp nhất.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
