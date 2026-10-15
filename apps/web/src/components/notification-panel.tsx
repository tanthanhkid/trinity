'use client'

import { useEffect, useRef, useState } from 'react'
import type { Bell } from 'lucide-react'
import { Loader2 } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  useNotificationsInfinite,
  flattenNotificationPages,
  type NotificationItem,
} from '@/hooks/use-notifications-list'
import { EVENT_CONFIG, DEFAULT_EVENT_CONFIG, formatRelativeTime } from '@/lib/notification-display'

// ---------------------------------------------------------------------------
// cửa sổ Thông báo tách 2 tab "Chưa đọc" / "Đã đọc" +
// infinite scroll (bỏ giới hạn 20). Dùng chung cho cả 2 icon (Bell +
// MessageSquare) qua prop `categoryFilter`.
// ---------------------------------------------------------------------------

const SCROLL_THRESHOLD_PX = 80

interface NotificationPanelProps {
  open: boolean
  categoryFilter: (n: NotificationItem) => boolean
  emptyIcon: typeof Bell
  emptyLabelUnread: string
  emptyLabelRead: string
  onClickItem: (n: NotificationItem) => void
}

function NotificationRow({
  n,
  onClick,
}: {
  n: NotificationItem
  onClick: () => void
}) {
  const config = EVENT_CONFIG[n.event_type ?? ''] ?? DEFAULT_EVENT_CONFIG
  const Icon = config.icon

  return (
    <button
      type="button"
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
        !n.is_read ? 'bg-muted/30' : ''
      }`}
      onClick={onClick}
    >
      <div className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full ${config.iconClass}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`text-sm truncate ${!n.is_read ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
            title={n.title}
          >
            {n.title}
          </span>
          {!n.is_read && <span className={`size-2 shrink-0 rounded-full ${config.dotClass}`} />}
        </div>
        <p className={`mt-0.5 text-xs leading-relaxed line-clamp-2 ${!n.is_read ? 'text-foreground/70' : 'text-muted-foreground'}`}>
          {n.body}
        </p>
        <span className="mt-1 block text-sm text-muted-foreground/60">
          {formatRelativeTime(n.created_at)}
        </span>
      </div>
    </button>
  )
}

function TabPane({
  items,
  emptyLabel,
  emptyIcon: EmptyIcon,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  onLoadMore,
  onClickItem,
}: {
  items: NotificationItem[]
  emptyLabel: string
  emptyIcon: typeof Bell
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isLoading: boolean
  onLoadMore: () => void
  onClickItem: (n: NotificationItem) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  function handleScroll() {
    const el = containerRef.current
    if (!el || isFetchingNextPage || !hasNextPage) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceToBottom <= SCROLL_THRESHOLD_PX) onLoadMore()
  }

  // 2 icon (Bell/MessageSquare) dùng CHUNG queryKey + lọc client-side theo
  // event_type — nếu trang hiện tại không có item khớp category nhưng vẫn
  // còn trang phía sau, tự tải tiếp (KHÔNG dừng ở "rỗng" oan, và người dùng
  // không có cách nào cuộn để tải thêm khi danh sách đang hiển thị rỗng).
  useEffect(() => {
    if (!isLoading && items.length === 0 && hasNextPage && !isFetchingNextPage) {
      onLoadMore()
    }
  }, [isLoading, items.length, hasNextPage, isFetchingNextPage, onLoadMore])

  if (isLoading || (items.length === 0 && hasNextPage)) {
    return (
      <div className="flex justify-center py-8 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
        <EmptyIcon className="size-8 opacity-30" />
        <span className="text-sm">{emptyLabel}</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="max-h-[400px] overflow-y-auto">
      {items.map((n) => (
        <NotificationRow key={n.id} n={n} onClick={() => onClickItem(n)} />
      ))}
      {isFetchingNextPage && (
        <div className="flex justify-center py-3 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
    </div>
  )
}

export function NotificationPanel({
  open,
  categoryFilter,
  emptyIcon,
  emptyLabelUnread,
  emptyLabelRead,
  onClickItem,
}: NotificationPanelProps) {
  const [tab, setTab] = useState<'unread' | 'read'>('unread')

  // Mở dropdown → luôn quay về tab "Chưa đọc" (mặc định theo yêu cầu).
  useEffect(() => {
    if (open) setTab('unread')
  }, [open])

  const unreadQuery = useNotificationsInfinite(false, open && tab === 'unread')
  const readQuery = useNotificationsInfinite(true, open && tab === 'read')

  const unreadItems = flattenNotificationPages(unreadQuery.data?.pages).filter(categoryFilter)
  const readItems = flattenNotificationPages(readQuery.data?.pages).filter(categoryFilter)

  function handleClickItem(n: NotificationItem) {
    onClickItem(n)
    if (!n.is_read) setTab('read')
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as 'unread' | 'read')}>
      <TabsList variant="line" className="mx-4 mt-1">
        <TabsTrigger value="unread">Chưa đọc</TabsTrigger>
        <TabsTrigger value="read">Đã đọc</TabsTrigger>
      </TabsList>
      <TabsContent value="unread">
        <TabPane
          items={unreadItems}
          emptyLabel={emptyLabelUnread}
          emptyIcon={emptyIcon}
          hasNextPage={!!unreadQuery.hasNextPage}
          isFetchingNextPage={unreadQuery.isFetchingNextPage}
          isLoading={unreadQuery.isLoading}
          onLoadMore={() => void unreadQuery.fetchNextPage()}
          onClickItem={handleClickItem}
        />
      </TabsContent>
      <TabsContent value="read">
        <TabPane
          items={readItems}
          emptyLabel={emptyLabelRead}
          emptyIcon={emptyIcon}
          hasNextPage={!!readQuery.hasNextPage}
          isFetchingNextPage={readQuery.isFetchingNextPage}
          isLoading={readQuery.isLoading}
          onLoadMore={() => void readQuery.fetchNextPage()}
          onClickItem={handleClickItem}
        />
      </TabsContent>
    </Tabs>
  )
}
