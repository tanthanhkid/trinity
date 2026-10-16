'use client'

/* Trang chủ "AI đã làm gì hôm nay" (bố cục bản demo đã duyệt): lời chào + câu tóm tắt → thẻ số → dòng thời gian AI
 * | Cần bạn xem · Trợ lý đang kết nối · gợi ý hỏi AI. Mọi số đều từ endpoint sẵn có (xem `use-home-data.ts`);
 * khối nào chưa có dữ liệu/không có quyền thì hiện trạng thái trống, KHÔNG số giả. */

import { useSyncExternalStore } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { getUserDisplayName } from '@/lib/user-identity'
import { formatDate, formatTimeVn, todayVn } from '@/lib/format'
import { greetingForHour, formatLongDateVn, vnClockParts } from './dashboard-greeting'
import { DashboardReportsButton } from './dashboard-reports-button'
import { DashboardOverviewFilter } from './dashboard-overview-filter'
import { useDashboardFilter } from './dashboard-filter-context'
import { EMPTY_FILTER } from './dashboard-filter-utils'
import { taskHref } from './dashboard-tasks-card'
import { AiTimelineView, type TimelineState } from './home-ai-timeline'
import { AskAiHint, NeedsReviewView, type ConnectionsState, type ReviewItem } from './home-side'
import { AiAssistantsHub, ChannelsHub, FeatureSuggestions } from './home-ai-hub'
import { HomeStats, type HomeStatItem } from './home-stats'
import { formatMoneyCompact, homeSummary, isAiActionDone, todaysAiActions } from './home-utils'
import { resolveNotificationHref } from '@/lib/notification-href'
import { usePermissions } from '@/lib/rbac'
import {
  useCanSeeOverview,
  useCanUseDashboardFilter,
  useDashboardFilterRoster,
  useDashboardOverview,
  useDashboardTasks,
} from './use-dashboard-overview'
import {
  isNotFound,
  useAiActionsPendingCount,
  useDashboardChannels,
  useHomeAiConnections,
  usePendingAiActions,
  useRecentAiActions,
  useUnreadNotificationCount,
  useUnreadNotifications,
} from './use-home-data'

const nf = (n: number) => n.toLocaleString('vi-VN')
const noopSubscribe = () => () => {}

export function DashboardHome() {
  const { user } = useAuth()
  const name = user ? getUserDisplayName(user, '') : ''
  // Giờ + ngày phụ thuộc đồng hồ máy khách ⇒ chỉ dựng sau mount (SSR và lần hydrate đầu cùng markup).
  const hour = useSyncExternalStore(noopSubscribe, () => vnClockParts(new Date()).hour, () => null)

  const { can } = usePermissions()
  const canOverview = useCanSeeOverview()
  const canFilter = useCanUseDashboardFilter()
  const { filter, effective, setFilter } = useDashboardFilter()
  const roster = useDashboardFilterRoster()
  const overview = useDashboardOverview(effective)
  const tasks = useDashboardTasks(effective)
  // "Cần bạn xem" luôn là việc của CHÍNH mình, kể cả khi đang lọc xem người khác.
  const ownTasks = useDashboardTasks(EMPTY_FILTER)

  const recent = useRecentAiActions()
  const pending = usePendingAiActions()
  const pendingCount = useAiActionsPendingCount()
  const notices = useUnreadNotifications()
  const unreadCount = useUnreadNotificationCount()
  const conns = useHomeAiConnections()
  const channels = useDashboardChannels()
  // "Đang hoạt động" so với đồng hồ máy khách ⇒ chỉ tính sau mount (SSR và lần hydrate đầu cùng markup).
  const nowMs = useSyncExternalStore(noopSubscribe, () => Math.floor(Date.now() / 60_000) * 60_000, () => null)

  /* ---- AI hôm nay ---- */
  const aiDisabled = recent.isError && isNotFound(recent.error)
  const timelineState: TimelineState = recent.isLoading ? 'loading' : aiDisabled ? 'disabled' : recent.isError ? 'error' : 'ready'
  const today = todayVn()
  const todayRows = recent.data ? todaysAiActions(recent.data.data, today) : []
  const doneToday = todayRows.filter(isAiActionDone).length
  const failedToday = todayRows.filter((a) => a.status === 'failed').length
  // Trang đầu 50 mục toàn của hôm nay mà còn trang sau ⇒ thực tế có thể nhiều hơn: nói "50+", không đoán.
  const truncated = !!recent.data?.next_cursor && recent.data.data.length > 0 && todaysAiActions(recent.data.data.slice(-1), today).length === 1

  /* ---- Cần bạn xem ---- */
  const reviewItems: ReviewItem[] = []
  for (const a of pending.data?.data ?? []) {
    reviewItems.push({
      key: `ai-${a.id}`, dot: 'wait', title: a.summary, cta: 'Duyệt', href: `/ai-actions?id=${a.id}`,
      sub: `${a.client_name ?? 'Ứng dụng AI'} đề xuất · hết hạn ${formatTimeVn(a.expires_at)} ${formatDate(a.expires_at)}`,
    })
  }
  for (const t of (ownTasks.data?.items ?? []).filter((t) => t.overdue).slice(0, 3)) {
    reviewItems.push({
      key: `task-${t.key}`, dot: 'wait', title: t.title, cta: 'Mở', href: taskHref(t),
      sub: `Quá hạn từ ${formatDate(t.due_at)}${t.contact_name ? ` · ${t.contact_name}` : ''}`,
    })
  }
  // Thông báo "AI đề xuất — chờ duyệt" trùng với chính đề xuất đã liệt kê ở trên ⇒ bỏ khỏi danh sách và khỏi tổng đếm.
  const isAiNotice = (n: { event_type?: string | null }) => n.event_type === 'ai_action.created'
  const allNotices = notices.data?.data ?? []
  const aiNoticeUnread = allNotices.filter(isAiNotice).length
  for (const n of allNotices.filter((n) => !isAiNotice(n)).slice(0, 3)) {
    // Cùng luật dẫn link với chuông thông báo (chỉ đường nội bộ, fallback theo event_type).
    const href = resolveNotificationHref(can('payroll.manage'), n)
    reviewItems.push({ key: `n-${n.id}`, dot: 'unread', title: n.title, sub: n.body, href, cta: 'Mở' })
  }
  const settled = (q: { isSuccess: boolean; isError: boolean }) => q.isSuccess || q.isError
  const reviewReady = settled(pendingCount) && settled(notices) && (!canOverview || settled(ownTasks))
  const needReview = reviewReady
    ? (pendingCount.data ?? 0) + (canOverview ? (ownTasks.data?.overdue ?? 0) : 0) + Math.max(0, (unreadCount ?? 0) - aiNoticeUnread)
    : null

  /* ---- Trợ lý đang kết nối ---- */
  const connState: ConnectionsState = !conns.allowed
    ? 'no-permission'
    : conns.isLoading ? 'loading'
      : conns.isError ? (isNotFound(conns.error) || aiDisabled ? 'disabled' : 'error')
        : aiDisabled ? 'disabled' : 'ready'
  const connRows = conns.data ?? []

  /* ---- Thẻ số ---- */
  const aiStat: HomeStatItem = {
    key: 'ai', label: 'AI đã làm hôm nay',
    value: aiDisabled ? '—' : `${nf(doneToday)}${truncated ? '+' : ''} việc`,
    ...(aiDisabled
      ? { note: 'Kết nối AI chưa bật', tone: 'muted' as const }
      : failedToday > 0
        ? { note: `${nf(failedToday)} việc không thực hiện được`, tone: 'warn' as const }
        : todayRows[0]
          ? { note: `Gần nhất lúc ${formatTimeVn(todayRows[0].created_at)}`, tone: 'ok' as const }
          : { note: 'Chưa có việc nào hôm nay', tone: 'muted' as const }),
  }
  const stats: HomeStatItem[] = [aiStat]
  const ov = overview.data
  if (canOverview) {
    stats.push(
      {
        key: 'customers', label: 'Khách hàng', value: ov ? nf(ov.customers.total) : '—',
        ...(ov && ov.customers.new_this_month > 0
          ? { note: `+${nf(ov.customers.new_this_month)} khách mới tháng này`, tone: 'ok' as const }
          : { note: 'Chưa có khách mới tháng này', tone: 'muted' as const }),
      },
      {
        key: 'revenue', label: 'Doanh thu tháng này',
        value: ov?.revenue.this_month != null ? formatMoneyCompact(ov.revenue.this_month) : '—',
        title: ov?.revenue.this_month != null ? `${nf(ov.revenue.this_month)} ₫` : undefined,
        note: ov ? `${nf(ov.opportunities.open)} cơ hội đang mở` : undefined, tone: 'muted',
      },
      {
        key: 'tasks', label: 'Công việc', value: tasks.data ? nf(tasks.data.total) : '—',
        ...(tasks.data && tasks.data.overdue > 0
          ? { note: `${nf(tasks.data.overdue)} việc quá hạn`, tone: 'warn' as const }
          : { note: tasks.data ? `${nf(tasks.data.due_today)} việc đến hạn hôm nay` : undefined, tone: 'muted' as const }),
      },
    )
  } else {
    stats.push({
      key: 'review', label: 'Cần bạn xem', value: needReview === null ? '—' : nf(needReview),
      note: needReview ? 'Xem ở khung bên phải' : 'Không có gì đang chờ', tone: needReview ? 'warn' : 'muted',
    })
  }

  const summary = homeSummary(timelineState === 'ready' ? doneToday : null, needReview)

  return (
    <div className="flex flex-col gap-5 md:gap-[22px]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.01em] text-[var(--foreground)] sm:text-[26px]">
            {hour === null ? 'Xin chào' : greetingForHour(hour)}{name ? `, ${name}` : ''}
          </h1>
          <p className="mt-1 text-[15px] text-[var(--color-app-ink-2)]" aria-live="polite">
            {summary || ' '}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hour !== null && (
            <span className="text-[14px] text-muted-foreground max-sm:hidden">{formatLongDateVn(new Date())}</span>
          )}
          <DashboardReportsButton />
        </div>
      </div>

      {canOverview && canFilter && (
        <DashboardOverviewFilter roster={roster.data} value={filter} onChange={setFilter} selfId={user?.id ?? null} />
      )}

      {/* AI Native: trợ lý AI đang làm việc + kênh đã kết nối — thứ đầu tiên người dùng thấy. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <AiAssistantsHub
          state={connState}
          rows={connRows}
          showOwner={conns.all}
          doneToday={aiDisabled || timelineState !== 'ready' ? null : `${nf(doneToday)}${truncated ? '+' : ''} việc`}
          now={nowMs}
        />
        <ChannelsHub loading={channels.isLoading} error={channels.isError} data={channels.data} />
      </div>

      <HomeStats items={stats} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <AiTimelineView
          state={timelineState}
          rows={todayRows}
          userName={name}
          canConnect={conns.allowed}
          hasConnections={connRows.length > 0}
        />
        <div className="flex min-w-0 flex-col gap-4">
          <NeedsReviewView loading={!reviewReady} items={reviewItems} total={needReview} />
          {connState === 'ready' && connRows.length > 0 && <AskAiHint />}
        </div>
      </div>

      <FeatureSuggestions />
    </div>
  )
}
