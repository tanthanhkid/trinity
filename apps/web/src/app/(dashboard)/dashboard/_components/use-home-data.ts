'use client'

/* Nguồn dữ liệu Trang chủ — CHỈ endpoint sẵn có, đúng quyền BE đang đòi:
 *  - Nhật ký AI hôm nay:  GET /integrations/ai-actions?limit=50          (@AuthOnly, BE lọc theo CHÍNH người đăng nhập; 404 = Kết nối AI tắt)
 *  - Đề xuất AI chờ duyệt: GET /integrations/ai-actions?status=pending   (như trên)
 *  - Số chờ duyệt:        GET /integrations/ai-actions/pending-count    (dùng lại hook của màn Hoạt động AI)
 *  - Thông báo chưa đọc:  GET /notifications?read=false · /notifications/unread-count (@AuthOnly, của chính mình)
 *  - Trợ lý đang kết nối: GET /integrations/ai-connections [?scope=all]  (@CanAny ai_connect/ai_admin; scope=all cần ai_admin)
 *  - Việc quá hạn:        GET /reports/dashboard-tasks (đã có trong `use-dashboard-overview.ts`, quyền reports.overview)
 *  - Kênh đã kết nối:     GET /reports/dashboard-channels (@AuthOnly; BE chỉ trả nhóm kênh hợp quyền + tính năng đang bật)
 * Không số giả. */

import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'
import { usePermissions } from '@/lib/rbac'
import { todayVn } from '@/lib/format'
import { AI_ACTIONS_KEY, useAiActionsPendingCount } from '@/hooks/ai-actions/use-ai-actions'
import type { AiActionPage } from '@/lib/ai-actions'
import { useAiConnections } from '@/app/(dashboard)/settings/_components/integrations/use-ai-connections'
import type { NotificationsPage } from '@/hooks/use-notifications-list'

const HOME_LIMIT = 50

async function fetchAiActions(params: Record<string, string | number>): Promise<AiActionPage> {
  const res = await apiClient.get<AiActionPage>('/integrations/ai-actions', { params })
  return { data: Array.isArray(res.data?.data) ? res.data.data : [], next_cursor: res.data?.next_cursor ?? null }
}

/** 50 hoạt động AI mới nhất của mình (mới nhất trước) — trang chủ lọc lấy phần của hôm nay. */
export function useRecentAiActions() {
  return useQuery<AiActionPage>({
    queryKey: [...AI_ACTIONS_KEY, 'home', todayVn()],
    queryFn: () => fetchAiActions({ limit: HOME_LIMIT }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  })
}

/** Đề xuất AI đang chờ chính mình duyệt (chỉ có khi quản trị bật "Yêu cầu duyệt", hoặc còn đề xuất cũ). */
export function usePendingAiActions() {
  return useQuery<AiActionPage>({
    queryKey: [...AI_ACTIONS_KEY, 'home', 'pending'],
    queryFn: () => fetchAiActions({ limit: 5, status: 'pending' }),
    staleTime: 30_000,
    retry: false,
  })
}

export { useAiActionsPendingCount }

/** 20 thông báo chưa đọc mới nhất — cùng endpoint với chuông thông báo (trang chủ lọc bỏ thông báo trùng với đề xuất AI). */
export function useUnreadNotifications() {
  return useQuery<NotificationsPage>({
    queryKey: ['notifications', 'home', 'unread'],
    queryFn: async () => (await apiClient.get<NotificationsPage>('/notifications', { params: { read: false, limit: 20 } })).data,
    staleTime: 30_000,
    retry: false,
  })
}

/** Tổng chưa đọc = 2 nhóm của chuông (profile + message) — DÙNG CHUNG cache key với `notifications-bell.tsx`. */
export function useUnreadNotificationCount(): number | null {
  const fetchCount = (category: 'profile' | 'message') => async () =>
    (await apiClient.get<{ count: number }>('/notifications/unread-count', { params: { category } })).data.count
  const a = useQuery({ queryKey: ['notifications', 'unread-count', 'profile'], queryFn: fetchCount('profile'), retry: false })
  const b = useQuery({ queryKey: ['notifications', 'unread-count', 'message'], queryFn: fetchCount('message'), retry: false })
  if (a.data === undefined || b.data === undefined) return null
  return a.data + b.data
}

/**
 * Trợ lý đang kết nối: người có `integrations.ai_admin` thấy của cả công ty (đúng như Cài đặt > Kết nối AI > "Mọi người"),
 * người có `integrations.ai_connect` thấy của mình; không có quyền nào ⇒ không gọi API (BE sẽ 403).
 */
export function useHomeAiConnections() {
  const { can, canAny } = usePermissions()
  const allowed = canAny('integrations.ai_connect', 'integrations.ai_admin')
  const all = can('integrations.ai_admin')
  const q = useAiConnections(all, allowed)
  return { ...q, allowed, all }
}

/** 404 từ các endpoint Kết nối AI = tính năng tắt trên máy chủ. */
export const isNotFound = (err: unknown): boolean => (err as { response?: { status?: number } })?.response?.status === 404

/** Kênh đã kết nối (khối "Kênh đã kết nối" ở đầu trang) — khớp `GET /reports/dashboard-channels`. */
export type ChannelState = 'ok' | 'attention' | 'off'
export interface HomeChannel {
  key: string
  kind: 'facebook_page' | 'zalo_oa' | 'social' | 'payment' | 'commerce' | 'store'
  network: string
  name: string
  state: ChannelState
  note: string
  today: { label: string; value: number } | null
  href: string
}
export interface HomeChannels {
  channels: HomeChannel[]
  available: { kind: HomeChannel['kind']; label: string; href: string }[]
}

export function useDashboardChannels() {
  return useQuery<HomeChannels>({
    queryKey: ['dashboard', 'channels'],
    queryFn: async () => (await apiClient.get<HomeChannels>('/reports/dashboard-channels')).data,
    staleTime: 60_000,
    retry: false,
  })
}
