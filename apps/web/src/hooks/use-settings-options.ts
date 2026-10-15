'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'

export interface SettingOption {
  id: number
  group_key: string
  value: string
  label: string
  sort_order: number
  is_active: boolean
  is_system: boolean
  metadata: Record<string, unknown> | null
}

export interface CreateOptionPayload {
  group_key: string
  value: string
  label: string
  sort_order?: number
  metadata?: Record<string, unknown>
}

export interface UpdateOptionPayload {
  label?: string
  sort_order?: number
  is_active?: boolean
  metadata?: Record<string, unknown>
}

interface ListResponse {
  data: SettingOption[]
  cached?: boolean
}

function buildKey(group: string, activeOnly: boolean): readonly unknown[] {
  return ['settings-options', group, activeOnly ? 'active' : 'all'] as const
}

/**
 * Đọc danh sách option theo group. Dùng cho UI Settings tab + dropdown.
 * Mọi user đăng nhập đều được gọi.
 *
 * Default `activeOnly = true`: dropdown chọn nguồn/giai đoạn/trạng thái KHÔNG
 * được hiện option đã tắt (admin tắt qua Settings là phải biến mất ngay).
 * Settings UI cần thấy cả inactive để toggle → explicit pass `activeOnly: false`.
 */
export function useSettingsOptions(
  group: string,
  opts: { activeOnly?: boolean } = {},
) {
  const activeOnly = opts.activeOnly ?? true
  return useQuery({
    queryKey: buildKey(group, activeOnly),
    queryFn: async () => {
      const res = await apiClient.get<ListResponse>('/settings/options', {
        params: { group, active: activeOnly ? 1 : 0 },
      })
      return res.data.data
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useCreateSettingOption(group: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateOptionPayload) => {
      const res = await apiClient.post<SettingOption>('/settings/options', payload)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings-options', group] })
    },
  })
}

export function useUpdateSettingOption(group: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateOptionPayload }) => {
      const res = await apiClient.patch<SettingOption>(
        `/settings/options/${id}`,
        payload,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings-options', group] })
    },
  })
}

export function useDeleteSettingOption(group: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiClient.delete<{ deleted: boolean; id: number }>(
        `/settings/options/${id}`,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings-options', group] })
    },
  })
}

/** Tạo slug a-z0-9_ từ label tiếng Việt có dấu. */
export function slugifyValue(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}
