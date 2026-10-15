'use client'

import { useQuery } from '@tanstack/react-query'
import { usePermissions } from '@/lib/rbac'
import apiClient from '@/lib/api-client'
import { todayVn } from '@/lib/format'
import {
  filterToParams,
  type DashboardFilterRoster,
  type DashboardFilterValue,
} from './dashboard-filter-utils'

/** Khớp `DashboardOverviewResult` của BE (`dashboard-overview.service.ts`). */
export interface DashboardOverviewData {
  scope_label: 'cá nhân' | 'team' | 'phòng' | 'toàn hệ thống' | 'theo bộ lọc'
  customers: { total: number; new_this_month: number; new_last_month: number }
  opportunities: { open: number; new_this_month: number; new_last_month: number }
  /** `null` = chưa có thương vụ thắng nào có giá trị — KHÁC 0 (→ hiện "—"). */
  revenue: { this_month: number | null; last_month: number | null }
  deal_status: { open: number; won: number; lost: number }
  months: string[]
  customers_by_month: number[]
  opportunities_by_month: number[]
  revenue_by_month: (number | null)[]
}

/** Khớp `DashboardTasksResult` của BE (`dashboard-tasks.service.ts`). */
export interface DashboardTaskItem {
  key: string
  kind: 'kanban' | 'reminder'
  id: number
  title: string
  contact_id: number | null
  contact_name: string | null
  due_at: string
  priority: string | null
  overdue: boolean
}
export interface DashboardTasksData {
  total: number
  due_today: number
  overdue: number
  items: DashboardTaskItem[]
}

/**
 * Quyền gọi 3 endpoint Tổng quan = `reports.overview` (BE `@Can('reports.overview')`). Phạm vi dữ liệu do BE quyết định theo scope của quyền đó.
 */
export function useCanSeeOverview(): boolean {
  return usePermissions().can('reports.overview')
}

/** BE cache Redis 5' → FE làm mới 5', không poll nền. */
export function useDashboardOverview(filter: DashboardFilterValue) {
  const enabled = useCanSeeOverview()
  return useQuery<DashboardOverviewData>({
    enabled,
    queryKey: ['dashboard-overview', todayVn(), filter],
    queryFn: async () =>
      (await apiClient.get<DashboardOverviewData>('/reports/dashboard-overview', { params: filterToParams(filter) })).data,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Việc hôm nay không cache ở BE (user tick xong phải thấy ngay) → poll 60s. */
export function useDashboardTasks(filter: DashboardFilterValue) {
  const enabled = useCanSeeOverview()
  return useQuery<DashboardTasksData>({
    enabled,
    queryKey: ['dashboard-tasks', todayVn(), filter],
    queryFn: async () =>
      (await apiClient.get<DashboardTasksData>('/reports/dashboard-tasks', { params: filterToParams(filter) })).data,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Bộ lọc Tổng quan = `reports.overview` với phạm vi >= team (BE kiểm lại độc lập). */
export function useCanUseDashboardFilter(): boolean {
  return usePermissions().can('reports.overview', 'team')
}

/** Roster Phòng/Team/NV từ cây `manager_id` — ít đổi, cache dài. */
export function useDashboardFilterRoster() {
  const enabled = useCanUseDashboardFilter()
  return useQuery<DashboardFilterRoster>({
    enabled,
    queryKey: ['dashboard-filter-roster'],
    queryFn: async () => (await apiClient.get<DashboardFilterRoster>('/reports/dashboard-filter-roster')).data,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
