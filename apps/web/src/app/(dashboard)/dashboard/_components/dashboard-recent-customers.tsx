'use client'

import Link from 'next/link'
import { ChevronRight, Users } from 'lucide-react'
import { usePermissions } from '@/lib/rbac'
import { useRecentContacts } from '@/hooks/use-recent-contacts'
import { formatRelativeTimeVn } from '@/lib/nav-time'

/**
 * "Khách hàng gần đây" — dùng ĐÚNG nguồn của nhóm "Khách gần đây"
 * ở sidebar (`GET /contacts/recent`, BE đã lọc theo phạm vi `contacts.view`; thiếu
 * quyền đó thì không gọi API và thẻ không hiện). Là khách BẠN vừa mở xem, không phải khách
 * mới của team.
 */
export function DashboardRecentCustomers({ className }: { className?: string }) {
  const { recentContacts } = useRecentContacts()
  if (recentContacts.length === 0) return null
  return (
    <section className={`flex flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)] ${className ?? ''}`}>
      <header className="flex items-center gap-2 px-3.5 pt-3">
        <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]">
          <Users className="size-4" aria-hidden />
        </span>
        <h3 className="text-[15px] font-semibold text-[var(--color-app-navy)]">Khách hàng gần đây</h3>
        <Link
          href="/contacts"
          className="ml-auto inline-flex items-center gap-0.5 text-[14px] font-semibold text-[var(--color-app-primary-ink)] hover:underline max-sm:min-h-11"
        >
          Xem tất cả <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </header>
      <ul className="p-2 pt-2">
        {recentContacts.map((c) => (
          <li key={c.id}>
            <Link
              href={`/contacts/${c.id}`}
              className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-[var(--color-app-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--color-app-primary-soft)] text-[14px] font-bold text-[var(--color-app-primary-ink)]">
                {(c.full_name?.trim()[0] ?? '?').toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-[var(--color-app-navy)]">
                  {c.full_name ?? `Khách #${c.id}`}
                </span>
                <span className="block truncate text-[14px] text-[var(--color-app-ink-2)]">
                  Xem {formatRelativeTimeVn(c.viewed_at)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Widget độc lập (`widgets.ts`, quyền `contacts.view`) cho người KHÔNG có khối
 * Tổng quan: khi có `reports.overview`, thẻ đã nằm trong khối đó nên không vẽ lần hai.
 */
export function DashboardRecentCustomersStandalone() {
  const { can } = usePermissions()
  if (can('reports.overview')) return null
  return <DashboardRecentCustomers />
}
