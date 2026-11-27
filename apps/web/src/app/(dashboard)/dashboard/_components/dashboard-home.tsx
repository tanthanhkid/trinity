'use client'

/* Trang chủ "AI đã làm gì hôm nay" (bố cục bản demo đã duyệt): lời chào + câu tóm tắt → thẻ số → dòng thời gian AI
 * | Cần bạn xem · Trợ lý đang kết nối · gợi ý hỏi AI. Mọi số đều từ endpoint sẵn có (xem `use-home-data.ts`);
 * khối nào chưa có dữ liệu/không có quyền thì hiện trạng thái trống, KHÔNG số giả. */

import { useState, useSyncExternalStore } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { getUserDisplayName } from '@/lib/user-identity'
import { formatDate, formatTimeVn, todayVn } from '@/lib/format'
import { greetingForHour, formatLongDateVn, vnClockParts } from './dashboard-greeting'
import { DashboardReportsButton } from './dashboard-reports-button'
import { useDashboardFilter } from './dashboard-filter-context'
import { EMPTY_FILTER } from './dashboard-filter-utils'
import { taskHref } from './dashboard-tasks-card'
import { AiTimelineView, type TimelineState } from './home-ai-timeline'
import { AskAiHint, NeedsReviewView, type ConnectionsState, type ReviewItem } from './home-side'
import { ChannelsHub, FeatureSuggestions } from './home-ai-hub'
import { DashboardTasksCard } from './dashboard-tasks-card'
import { FacebookNudge, FACEBOOK_CONNECT_HREF } from './facebook-nudge'
import { FunnelCard, HeatmapCard, KpiStrip, LeaderboardCard, type KpiItem } from './command-center-cards'
import { useCommandCenter } from './use-command-center'
import { PERIODS, deltaOf, formatMoneyTr, formatPct, type PeriodKey } from './command-center-utils'
import { homeSummary, isAiActionDone, todaysAiActions } from './home-utils'
import { resolveNotificationHref } from '@/lib/notification-href'
import { usePermissions } from '@/lib/rbac'
import {
  useCanSeeOverview,
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
  // Không có bộ lọc phạm vi trên giao diện: số liệu theo đúng quyền người đang xem (server tự giới hạn).
  const { effective } = useDashboardFilter()
  const [period, setPeriod] = useState<PeriodKey>('7d')
  const center = useCommandCenter(period)
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

  /* ---- Fanpage Facebook: chỉ endpoint kênh sẵn có. Người có quyền quản lý kết nối được trả `available` có Fanpage khi chưa nối. ---- */
  const fbOffer = channels.data?.available.find((a) => a.kind === 'facebook_page')
  const fbUnconnected = !!fbOffer && !(channels.data?.channels ?? []).some((c) => c.kind === 'facebook_page')

  /* ---- Dải chỉ số (số lớn là chữ thường, KHÔNG số "lăn": số lăn kẹt ở 0 khi ô chưa được quan sát) ---- */
  const ccLoading = center.isLoading
  const aiItem: KpiItem = {
    key: 'ai', label: 'AI đã làm hôm nay', dot: 'var(--color-app-chart-2)',
    value: aiDisabled ? '—' : `${nf(doneToday)}${truncated ? '+' : ''} việc`,
    note: aiDisabled ? 'Kết nối AI chưa bật' : failedToday > 0 ? `${nf(failedToday)} việc lỗi` : todayRows[0] ? `gần nhất ${formatTimeVn(todayRows[0].created_at)}` : 'chưa có việc nào',
    tone: failedToday > 0 ? 'warn' : 'ok',
  }
  const reviewItem: KpiItem = {
    key: 'review', label: 'Cần bạn xem', dot: 'var(--color-app-chart-2)',
    value: needReview === null ? '—' : nf(needReview),
    note: needReview ? 'xem bên dưới' : 'không có gì chờ', tone: needReview ? 'warn' : 'ok',
  }
  const ov = overview.data
  const win = center.data?.win_rate
  const items: KpiItem[] = canOverview
    ? [
        {
          key: 'revenue', label: 'Doanh thu tháng', dot: 'var(--color-app-primary)',
          value: ov?.revenue.this_month != null ? formatMoneyTr(ov.revenue.this_month) : '—',
          title: ov?.revenue.this_month != null ? `${nf(ov.revenue.this_month)} ₫` : undefined,
          delta: ov && ov.revenue.this_month != null ? deltaOf(ov.revenue.this_month, ov.revenue.last_month ?? 0) : undefined,
          note: ov && ov.revenue.this_month == null ? 'chưa có thương vụ thắng' : undefined,
        },
        {
          key: 'customers', label: 'Khách hàng', dot: 'var(--color-app-chart-1)',
          value: ov ? nf(ov.customers.total) : '—',
          delta: ov ? deltaOf(ov.customers.new_this_month, ov.customers.new_last_month) : undefined,
          note: ov && ov.customers.new_this_month === 0 && ov.customers.new_last_month === 0 ? 'chưa có khách mới tháng này' : ov ? 'mới tháng này' : undefined,
        },
        {
          key: 'opps', label: 'Cơ hội đang mở', dot: 'var(--color-app-chart-4)',
          value: ov ? nf(ov.opportunities.open) : '—',
          delta: ov ? deltaOf(ov.opportunities.new_this_month, ov.opportunities.new_last_month) : undefined,
          note: ov && ov.opportunities.new_this_month === 0 && ov.opportunities.new_last_month === 0 ? 'chưa có cơ hội mới' : ov ? 'mới tháng này' : undefined,
        },
        {
          key: 'win', label: 'Tỉ lệ thắng', dot: 'var(--color-app-chart-5)',
          value: win ? (win.rate === null ? '—' : formatPct(win.rate)) : '—',
          note: win ? (win.won + win.lost > 0 ? `${nf(win.won)} / ${nf(win.won + win.lost)} thương vụ` : 'chưa có thương vụ đóng') : undefined,
        },
        {
          key: 'overdue', label: 'Việc quá hạn', dot: 'var(--color-app-red)',
          value: tasks.data ? nf(tasks.data.overdue) : '—',
          note: tasks.data ? `${nf(tasks.data.due_today)} đến hạn hôm nay` : undefined,
          tone: tasks.data && tasks.data.overdue > 0 ? 'bad' : 'ok',
        },
        reviewItem,
      ]
    : [aiItem, reviewItem]
  const stripLoading = canOverview && (overview.isLoading || tasks.isLoading) && !ov
  const periodAside = PERIODS.find((p) => p.key === period)?.aside ?? ''
  const updatedAt = center.dataUpdatedAt || overview.dataUpdatedAt

  const summary = homeSummary(timelineState === 'ready' ? doneToday : null, needReview)

  return (
    <div className="flex flex-col gap-3 md:gap-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-3 text-[20px] font-semibold leading-[26px] tracking-[-0.01em] text-[var(--foreground)]">
            Trung tâm điều hành
            {updatedAt > 0 && hour !== null && (
              <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-[var(--color-app-tag-green-ink)]">
                <i aria-hidden className="block size-2 rounded-full bg-[var(--color-app-green)]" />
                Cập nhật {formatTimeVn(new Date(updatedAt))}
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-[14px] text-[var(--color-app-ink-2)]" aria-live="polite">
            {hour === null ? 'Xin chào' : greetingForHour(hour)}{name ? `, ${name}` : ''}. {summary}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hour !== null && <span className="text-[14px] text-muted-foreground max-lg:hidden">{formatLongDateVn(new Date())}</span>}
          {canOverview && (
            <div role="group" aria-label="Kỳ xem" className="inline-flex rounded-[9px] border border-[var(--border)] bg-[var(--card)] p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={period === p.key}
                  onClick={() => setPeriod(p.key)}
                  className={`rounded-[7px] px-2.5 py-0.5 text-[14px] font-medium transition max-sm:min-h-11 ${period === p.key ? 'bg-[var(--foreground)] text-[var(--background)]' : 'text-[var(--color-app-ink-2)] hover:bg-[var(--muted)]'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <DashboardReportsButton />
        </div>
      </div>

      <FacebookNudge unconnected={fbUnconnected} canManage={can('integrations.webhooks')} href={fbOffer?.href ?? FACEBOOK_CONNECT_HREF} />

      <KpiStrip items={items} loading={stripLoading} />

      {canOverview && (
        <div className="grid items-stretch gap-3 lg:grid-cols-[1fr_1.15fr_1.05fr]">
          <FunnelCard data={center.data} loading={ccLoading} error={center.isError} aside={periodAside} />
          <HeatmapCard data={center.data} loading={ccLoading} error={center.isError} />
          <LeaderboardCard data={center.data} loading={ccLoading} error={center.isError} aside={periodAside} />
        </div>
      )}

      <div className={canOverview ? 'grid items-start gap-3 lg:grid-cols-[1fr_1.15fr_1.05fr]' : 'grid items-start gap-3 lg:grid-cols-2'}>
        <ChannelsHub loading={channels.isLoading} error={channels.isError} data={channels.data} />
        {canOverview && (
          <DashboardTasksCard tasks={tasks.data} isLoading={tasks.isLoading} error={tasks.error} onRetry={() => void tasks.refetch()} />
        )}
        <AiTimelineView
          state={timelineState}
          rows={todayRows}
          userName={name}
          canConnect={conns.allowed}
          hasConnections={connRows.length > 0}
        />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <NeedsReviewView loading={!reviewReady} items={reviewItems} total={needReview} />
        {connState === 'ready' && connRows.length > 0 && <AskAiHint />}
      </div>

      <FeatureSuggestions />
    </div>
  )
}
