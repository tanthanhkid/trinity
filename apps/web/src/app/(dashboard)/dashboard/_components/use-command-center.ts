'use client'

import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'
import { todayVn } from '@/lib/format'
import { useCanSeeOverview } from './use-dashboard-overview'
import { periodRange, type PeriodKey } from './command-center-utils'

/** Khớp `GET /reports/dashboard-command-center` (mod-reports `command_center.rs`). */
export interface FunnelStage {
  key: 'customers' | 'opportunities' | 'won'
  count: number
  value: number | null
}
export interface CommandCenterData {
  scope_label: string
  funnel: {
    stages: FunnelStage[]
    by_status: Record<'open' | 'won' | 'lost', { count: number; value: number }>
  }
  heatmap: { cells: number[][]; max: number; total: number; peak_hours: number[]; timezone: string }
  leaderboard: { user_id: number; full_name: string; won_count: number; won_value: number; tasks_done: number }[]
  win_rate: {
    won: number
    lost: number
    rate: number | null
    previous: { won: number; lost: number; rate: number | null }
  }
}

/** Server cache 120 giây ⇒ làm mới 2 phút, không poll nền. Quyền `reports.overview`, phạm vi do server quyết. */
export function useCommandCenter(period: PeriodKey) {
  const enabled = useCanSeeOverview()
  const today = todayVn()
  const { from, to } = periodRange(period, today)
  return useQuery<CommandCenterData>({
    enabled,
    queryKey: ['dashboard-command-center', from, to],
    queryFn: async () =>
      (await apiClient.get<CommandCenterData>('/reports/dashboard-command-center', { params: { date_from: from, date_to: to } })).data,
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
    retry: false,
  })
}
