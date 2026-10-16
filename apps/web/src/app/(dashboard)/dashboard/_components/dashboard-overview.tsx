'use client'

/* Khối "Số liệu kinh doanh" phía dưới Trang chủ — dùng chung cho mọi role có
 * quyền gọi `/reports/dashboard-overview` + `/reports/dashboard-tasks`:
 * biểu đồ 6 tháng + cơ cấu cơ hội → Việc cần làm hôm nay + khách gần đây.
 * Hàng thẻ số và bộ lọc phạm vi đã lên đầu trang (`dashboard-home.tsx`); khối này
 * đọc CÙNG bộ lọc qua `DashboardFilterProvider` nên cùng queryKey, không gọi BE lần hai.
 *
 * KHÔNG có thẻ Báo giá / Hợp đồng sắp hết hạn / Công nợ: hệ thống chưa có
 * module tương ứng (bảng `contracts` chỉ là hợp đồng nhân sự) — không bịa số. */

import { useAuth } from '@/hooks/use-auth'
import { useRecentContacts } from '@/hooks/use-recent-contacts'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardTasksCard } from './dashboard-tasks-card'
import { DealStatusChart } from './dashboard-overview-charts'
import { OverviewTabbedChart } from './dashboard-overview-tabbed-chart'
import { DashboardRecentCustomers } from './dashboard-recent-customers'
import { describeFilter, isFilterActive } from './dashboard-filter-utils'
import { useDashboardFilter } from './dashboard-filter-context'
import {
  useCanSeeOverview,
  useDashboardFilterRoster,
  useDashboardOverview,
  useDashboardTasks,
} from './use-dashboard-overview'

export function DashboardOverview() {
  const canSee = useCanSeeOverview()
  const { user } = useAuth()
  const { effective } = useDashboardFilter()
  const roster = useDashboardFilterRoster()
  const overview = useDashboardOverview(effective)
  const tasks = useDashboardTasks(effective)
  // Chưa mở khách nào ⇒ thẻ "Khách hàng gần đây" không vẽ ⇒ thẻ Việc cần làm trải hết hàng, không để ô trống.
  const { recentContacts } = useRecentContacts()
  if (!canSee) return null
  const filterNote = isFilterActive(effective) ? describeFilter(roster.data, effective, user?.id ?? null) : null

  const data = overview.data
  return (
    <section aria-labelledby="home-business" className="flex flex-col gap-4">
      <h2 id="home-business" className="text-[15px] font-semibold text-[var(--foreground)]">
        Số liệu kinh doanh
      </h2>
      <p className="sr-only">số liệu tháng này, làm mới mỗi 5 phút</p>

      {overview.isError && (
        <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 text-[14px] text-[var(--color-app-ink-2)]">
          Không tải được số liệu Tổng quan. Thử tải lại trang.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {data ? <OverviewTabbedChart data={data} /> : <Skeleton className="h-[300px] rounded-2xl lg:col-span-2" />}
        {data ? <DealStatusChart data={data} /> : <Skeleton className="h-[300px] rounded-2xl" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <DashboardTasksCard
          tasks={tasks.data}
          isLoading={tasks.isLoading}
          filterNote={filterNote}
          className={recentContacts.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}
        />
        <DashboardRecentCustomers />
      </div>
    </section>
  )
}
