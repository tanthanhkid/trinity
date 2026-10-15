import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { GoogleStatus, GoogleSync, GoogleTargets, InspectResult, RunStats, SyncRun } from "./google-sheets-types"

const BASE = "/integrations/google"
export const GOOGLE_KEYS = {
  status: ["integrations", "google", "status"] as const,
  syncs: ["integrations", "google", "syncs"] as const,
  targets: ["integrations", "google", "targets"] as const,
  runs: (id: number) => ["integrations", "google", "runs", id] as const,
}

// Mọi query THROW khi lỗi: UI phân biệt "lỗi tải" với "chưa có dữ liệu".
export function useGoogleStatus() {
  return useQuery<GoogleStatus>({ queryKey: GOOGLE_KEYS.status, queryFn: async () => (await apiClient.get<GoogleStatus>(`${BASE}/status`)).data })
}

export function useGoogleSyncs(enabled: boolean) {
  return useQuery<GoogleSync[]>({
    queryKey: GOOGLE_KEYS.syncs,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: GoogleSync[] }>(`${BASE}/syncs`)).data.data,
  })
}

export function useGoogleTargets(enabled: boolean) {
  return useQuery<GoogleTargets>({
    queryKey: GOOGLE_KEYS.targets,
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await apiClient.get<GoogleTargets>(`${BASE}/targets`)).data,
  })
}

export function useSyncRuns(id: number, enabled: boolean) {
  return useQuery<SyncRun[]>({
    queryKey: GOOGLE_KEYS.runs(id),
    enabled,
    queryFn: async () => (await apiClient.get<{ data: SyncRun[] }>(`${BASE}/syncs/${id}/runs`)).data.data,
  })
}

export interface SyncInput {
  name: string
  direction: "import" | "export"
  spreadsheet?: string
  create_sheet?: boolean
  sheet_title: string
  target_kind: "contact" | "custom_object"
  target_object_key?: string
  column_map: Record<string, string>
  dedupe_key?: string
  actor_user_id?: number
  contact_source_id?: number
  schedule_minutes?: number | null
}

export function useGoogleActions() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: GOOGLE_KEYS.syncs })
    void qc.invalidateQueries({ queryKey: GOOGLE_KEYS.status })
    void qc.invalidateQueries({ queryKey: ["integrations", "google", "runs"] })
  }
  return {
    start: useMutation({ mutationFn: async () => (await apiClient.post<{ url: string }>(`${BASE}/oauth/start`)).data.url }),
    disconnect: useMutation({ mutationFn: async () => { await apiClient.delete(`${BASE}/connection`) }, onSuccess: refresh }),
    inspect: useMutation({ mutationFn: async (v: { spreadsheet: string; tab?: string }) => (await apiClient.post<InspectResult>(`${BASE}/inspect`, v)).data }),
    create: useMutation({ mutationFn: async (v: SyncInput) => (await apiClient.post<GoogleSync>(`${BASE}/syncs`, v)).data, onSuccess: refresh }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: { id: number; is_active?: boolean; schedule_minutes?: number | null; name?: string }) => (await apiClient.patch<GoogleSync>(`${BASE}/syncs/${id}`, body)).data,
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: async (id: number) => { await apiClient.delete(`${BASE}/syncs/${id}`) }, onSuccess: refresh }),
    run: useMutation({
      mutationFn: async ({ id, backfill }: { id: number; backfill?: boolean }) => (await apiClient.post<RunStats>(`${BASE}/syncs/${id}/run`, { backfill })).data,
      onSettled: refresh,
    }),
  }
}
