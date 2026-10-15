'use client'

import { useQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Bell, MessageSquare, Inbox } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import apiClient from '@/lib/api-client'
import { useRouter } from 'next/navigation'
import { usePermissions } from '@/lib/rbac'
import { resolveNotificationHref } from '@/lib/notification-href'
import { useState } from 'react'
import { isPollMode } from '@/lib/realtime-mode'
import { NotificationPanel } from '@/components/notification-panel'
import { type NotificationItem, type NotificationsPage } from '@/hooks/use-notifications-list'
import { isMessageEvent } from '@/lib/notification-display'

// ---------------------------------------------------------------------------
// optimistic update mark-as-read (KHÔNG chỉ invalidateQueries).
// Trước đây chỉ invalidate → tab "Chưa đọc" đang active mới auto-refetch (do
// unread/read query loại trừ nhau qua `enabled`, xem notification-panel.tsx),
// nên item vừa click có thể ĐỨNG YÊN đến khi refetch xong hoặc user rời tab.
// Giờ move item ngay giữa 2 cache mảng (list,false) ↔ (list,true) + giảm
// unread-count TRƯỚC khi mutation resolve — không cần chờ mạng.
// ---------------------------------------------------------------------------

type NotificationsInfiniteData = InfiniteData<NotificationsPage, number | undefined>

/** Loại item khỏi cache tab "Chưa đọc" (mọi trang đã tải). */
function removeFromUnreadCache(queryClient: QueryClient, id: string): void {
  queryClient.setQueriesData<NotificationsInfiniteData>(
    { queryKey: ['notifications', 'list', false] },
    (old) => {
      if (!old) return old
      const pages = old.pages.map((page) => {
        const nextData = page.data.filter((item) => item.id !== id)
        return nextData.length === page.data.length ? page : { ...page, data: nextData }
      })
      return { ...old, pages }
    },
  )
}

/** Chèn item (đã đánh dấu is_read=true) lên đầu cache tab "Đã đọc". */
function prependToReadCache(queryClient: QueryClient, item: NotificationItem): void {
  const readItem: NotificationItem = { ...item, is_read: true }
  queryClient.setQueriesData<NotificationsInfiniteData>(
    { queryKey: ['notifications', 'list', true] },
    (old) => {
      if (!old || old.pages.length === 0) return old
      const [firstPage, ...rest] = old.pages
      if (firstPage.data.some((existing) => existing.id === readItem.id)) return old
      return { ...old, pages: [{ ...firstPage, data: [readItem, ...firstPage.data] }, ...rest] }
    },
  )
}

/** Giảm badge unread-count đúng category (profile/message) ngay lập tức. */
function decrementUnreadCount(queryClient: QueryClient, category: 'profile' | 'message'): void {
  queryClient.setQueryData<number>(['notifications', 'unread-count', category], (old) =>
    Math.max(0, (old ?? 1) - 1),
  )
}

interface MarkReadContext {
  previousLists: [readonly unknown[], unknown][]
  previousCounts: [readonly unknown[], unknown][]
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

// badge PHẢI dùng con số THẬT từ BE (COUNT có filter, KHÔNG
// LIMIT) — category tách 2 icon (Bell="profile" / MessageSquare="message").
// THROW khi !res.ok (axios tự throw khi status lỗi) — KHÔNG catch nuốt
// lỗi rồi trả 0 (sẽ làm badge nhảy về 0 sai khi mạng chập chờn).
async function fetchUnreadCount(category: 'profile' | 'message'): Promise<number> {
  const res = await apiClient.get<{ count: number }>('/notifications/unread-count', {
    params: { category },
  })
  return res.data.count
}

// ---------------------------------------------------------------------------
// NotificationsBell — tab Chưa đọc/Đã đọc + infinite
// scroll (KHÔNG còn giới hạn 20 thông báo).
// Wrapper duy nhất chứa toàn bộ query / mark-read logic.
// Render 2 icon: Bell (thông báo chung) + MessageSquare (chat/mention).
//
// Component này hiện cho mọi user đăng nhập; scope RBAC nằm ở tầng phát của BE.
// Không phát âm báo (tiếng chuông) ở đây.
// ---------------------------------------------------------------------------

// Poll mode (serverless): KHÔNG tự hỏi định kỳ — vòng hỏi thông báo ở `notification-socket.tsx` (60s, một lượt gọi) làm mới
// hai con số này khi có thông báo mới; thêm làm mới khi quay lại tab. Gộp từ 3 lượt gọi/30s xuống 1 lượt/60s (CPU Vercel).
// Bản VPS: socket đẩy realtime, poll 60s chỉ là dự phòng.
const POLL_MS: number | false = isPollMode() ? false : 60_000

export function NotificationsBell() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const { can } = usePermissions()

  // 2 badge (Bell/MessageSquare) LUÔN dùng con số COUNT thật từ
  // BE (KHÔNG suy từ length của list bị LIMIT trang) — badge khớp tuyệt đối
  // với tab "Chưa đọc" trong popup vì cùng 1 nguồn dữ liệu.
  // component này mount TOÀN CỤC trong header, chạy liên tục cho
  // MỌI phiên đăng nhập bất kể đang xem trang nào — cùng với WebSocket
  // `notification-socket.tsx` (push realtime `notification:count`), 2 poll này
  // chỉ là lớp DỰ PHÒNG khi socket rớt. Giãn 30s→60s giảm ~50% tải poll nền cho
  // quy mô 5-10 user; `refetchIntervalInBackground` mặc định đã là `false`
  // (không cấu hình global khác ở providers.tsx) nên tab ẩn vốn đã KHÔNG poll —
  // đặt tường minh ở đây để không phụ thuộc ngầm vào default của thư viện.
  const { data: bellUnread = 0 } = useQuery({
    queryKey: ['notifications', 'unread-count', 'profile'],
    queryFn: () => fetchUnreadCount('profile'),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })

  const { data: msgUnread = 0 } = useQuery({
    queryKey: ['notifications', 'unread-count', 'message'],
    queryFn: () => fetchUnreadCount('message'),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })

  const [bellOpen, setBellOpen] = useState(false)
  const [msgOpen, setMsgOpen] = useState(false)

  // Optimistic mark-as-read: dời item khỏi mảng Chưa đọc + chèn lên đầu mảng
  // Đã đọc + giảm badge NGAY khi click — không đợi round-trip API.
  const markReadMutation = useMutation({
    mutationFn: (n: NotificationItem) => apiClient.patch(`/notifications/${n.id}/read`, {}),
    onMutate: async (n: NotificationItem): Promise<MarkReadContext> => {
      await queryClient.cancelQueries({ queryKey: ['notifications', 'list'] })
      await queryClient.cancelQueries({ queryKey: ['notifications', 'unread-count'] })

      const previousLists = queryClient.getQueriesData({ queryKey: ['notifications', 'list'] })
      const previousCounts = queryClient.getQueriesData({ queryKey: ['notifications', 'unread-count'] })

      removeFromUnreadCache(queryClient, n.id)
      prependToReadCache(queryClient, n)
      decrementUnreadCount(queryClient, isMessageEvent(n.event_type) ? 'message' : 'profile')

      return { previousLists, previousCounts }
    },
    onError: (error, _n, context) => {
      console.error('[notifications-bell] mark-read failed', error)
      // lỗi mạng tạm thời (không có response, vd timeout/mất kết nối) —
      // KHÔNG rollback optimistic update, để nguyên "đã đọc" và chờ invalidate
      // ở onSettled tự đối chiếu lại với server. Chỉ rollback khi server TRẢ
      // LỜI dứt khoát là thất bại (403/404/500...).
      const isDefiniteFailure = axios.isAxiosError(error) && error.response != null
      if (!isDefiniteFailure || !context) return
      context.previousLists.forEach(([key, data]) => queryClient.setQueryData(key, data))
      context.previousCounts.forEach(([key, data]) => queryClient.setQueryData(key, data))
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
      queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] })
    },
  })

  function handleClickItem(n: NotificationItem) {
    const href = resolveNotificationHref(can('payroll.manage'), n)
    if (!n.is_read) markReadMutation.mutate(n)
    if (href) router.push(href)
  }

  return (
    <>
      {/* ---- Icon Chuông: thông báo / pipeline / payslip ----
          Số đếm trên chuông/tin nhắn là NGOẠI LỆ duy nhất của luật chữ >= 14px: huy hiệu nằm đè góc
          nút 32px, chữ 14px ("99+") che mất biểu tượng. Nâng 10px → 12px đậm. */}
      <DropdownMenu onOpenChange={setBellOpen}>
        <DropdownMenuTrigger className="relative inline-flex size-8 max-sm:size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sm font-semibold outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
          <Bell className="size-5" />
          {bellUnread > 0 && (
            <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[12px] font-semibold leading-none tabular-nums text-white">
              {bellUnread > 99 ? '99+' : bellUnread}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-1rem)] p-0">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-4 py-3 text-base font-semibold">
              Thông báo
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="m-0" />
            <NotificationPanel
              open={bellOpen}
              categoryFilter={(n) => !isMessageEvent(n.event_type)}
              emptyIcon={Inbox}
              emptyLabelUnread="Không có thông báo mới"
              emptyLabelRead="Chưa có thông báo đã đọc"
              onClickItem={handleClickItem}
            />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ---- Icon Tin nhắn: chat tag / mention / internal ---- */}
      <DropdownMenu onOpenChange={setMsgOpen}>
        <DropdownMenuTrigger className="relative inline-flex size-8 max-sm:size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sm font-semibold outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
          <MessageSquare className="size-5" />
          {msgUnread > 0 && (
            <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-600 px-1 text-[12px] font-semibold leading-none tabular-nums text-white">
              {msgUnread > 99 ? '99+' : msgUnread}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-1rem)] p-0">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-4 py-3 text-base font-semibold">
              Tin nhắn &amp; đề cập
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="m-0" />
            <NotificationPanel
              open={msgOpen}
              categoryFilter={(n) => isMessageEvent(n.event_type)}
              emptyIcon={MessageSquare}
              emptyLabelUnread="Không có tin nhắn mới"
              emptyLabelRead="Chưa có tin nhắn đã đọc"
              onClickItem={handleClickItem}
            />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
