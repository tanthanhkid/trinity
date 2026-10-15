"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export type BriefingSlot = "morning" | "evening"

export interface BriefingConfig {
  enabled: boolean
  morning_enabled: boolean
  evening_enabled: boolean
  morning_time: string
  evening_time: string
  in_app: boolean
}

export interface BriefingConfigResponse {
  config: BriefingConfig
  available: { feature: boolean }
}

export interface BriefingRow {
  id: number
  slot: BriefingSlot
  day: string
  title: string
  text: string
  channels: string[]
  created_at: string
}

export interface BriefingPreview {
  data: unknown
  content: { title: string; text: string }
}

const CONFIG_KEY = ["briefings", "config"] as const
const LIST_KEY = ["briefings", "list"] as const

export function useBriefingConfig() {
  return useQuery<BriefingConfigResponse>({
    queryKey: CONFIG_KEY,
    queryFn: async () => (await apiClient.get<BriefingConfigResponse>("/briefings/config")).data,
  })
}

export function useUpdateBriefingConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<BriefingConfig>) =>
      (await apiClient.patch<BriefingConfig>("/briefings/config", patch)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: CONFIG_KEY }),
  })
}

export function useRunBriefingNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (slot: BriefingSlot) =>
      (await apiClient.post<{ created: number; recipients: number }>("/briefings/run-now", null, { params: { slot } })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: LIST_KEY }),
  })
}

/** Bản tin CỦA MÌNH (BE lọc theo người đăng nhập). */
export function useMyBriefings() {
  return useQuery<BriefingRow[]>({
    queryKey: LIST_KEY,
    queryFn: async () => (await apiClient.get<BriefingRow[]>("/briefings")).data,
  })
}

export function useBriefingPreview(slot: BriefingSlot, enabled: boolean) {
  return useQuery<BriefingPreview | null>({
    queryKey: ["briefings", "preview", slot],
    enabled,
    queryFn: async () => (await apiClient.get<BriefingPreview | null>("/briefings/preview", { params: { slot } })).data,
  })
}
