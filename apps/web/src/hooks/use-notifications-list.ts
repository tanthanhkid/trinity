import { useInfiniteQuery } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'

// ---------------------------------------------------------------------------
// infinite scroll cho danh sách thông báo, tách tab
// "Chưa đọc" / "Đã đọc" (KHÔNG còn giới hạn cứng 20 thông báo).
// ---------------------------------------------------------------------------

export interface NotificationItem {
  id: string
  title: string
  body: string
  event_type: string | null
  action_url: string | null
  is_read: boolean
  created_at: string
}

export interface NotificationsPage {
  data: NotificationItem[]
  next_cursor: number | null
}

const PAGE_SIZE = 20

async function fetchNotificationsPage(
  read: boolean,
  cursor: number | undefined,
): Promise<NotificationsPage> {
  const res = await apiClient.get<NotificationsPage>('/notifications', {
    params: { read, cursor, limit: PAGE_SIZE },
  })
  return res.data
}

/**
 * Infinite query theo trạng thái đọc (`read=true|false`). Query dùng CHUNG
 * cache key giữa 2 icon (Bell + MessageSquare) — cả 2 lọc client-side từ
 * cùng 1 nguồn dữ liệu theo `event_type`, tránh gọi API trùng lặp.
 */
export function useNotificationsInfinite(read: boolean, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['notifications', 'list', read],
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      fetchNotificationsPage(read, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage: NotificationsPage) => lastPage.next_cursor ?? undefined,
    enabled,
  })
}

export function flattenNotificationPages(
  pages: NotificationsPage[] | undefined,
): NotificationItem[] {
  if (!pages) return []
  return pages.flatMap((p) => p.data)
}
