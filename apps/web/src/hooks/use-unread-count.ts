'use client'

import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'
import { fromBootstrap } from '@/lib/bootstrap'

export type UnreadCategory = 'profile' | 'message'

export const unreadCountKey = (category: UnreadCategory) => ['notifications', 'unread-count', category] as const

/**
 * Số thông báo chưa đọc theo nhóm — MỘT nguồn cho chuông (Header) và Trang chủ: cùng khoá, cùng `queryFn`, cùng `staleTime`,
 * nên không còn hai bên mỗi bên gọi một lần. Lượt nạp đầu lấy từ `GET /bootstrap`.
 */
export function useUnreadCount(category: UnreadCategory, opts: { poll?: number | false } = {}) {
  return useQuery({
    queryKey: unreadCountKey(category),
    queryFn: () =>
      fromBootstrap<number>(
        category === 'profile' ? 'unread_profile' : 'unread_message',
        async () => (await apiClient.get<{ count: number }>('/notifications/unread-count', { params: { category } })).data.count,
        (raw) => (raw && typeof (raw as { count?: unknown }).count === 'number' ? (raw as { count: number }).count : undefined),
      ),
    staleTime: 30_000,
    refetchInterval: opts.poll ?? false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: opts.poll === undefined ? undefined : true,
    retry: false,
  })
}
