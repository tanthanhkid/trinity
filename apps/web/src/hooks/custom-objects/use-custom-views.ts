import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { CustomViewDef } from "@/types/custom-objects"

/** Màn xem — khoá cache dưới gốc `["custom-objects", …]` nên duyệt đề xuất AI làm mới luôn. */
export const viewKeys = {
  list: (key: string) => ["custom-objects", "views", key] as const,
  one: (key: string, view: string) => ["custom-objects", "views", key, view] as const,
}

const base = (key: string) => `/custom-objects/${encodeURIComponent(key)}/views`

export function useCustomViews(key: string, enabled = true) {
  return useQuery<CustomViewDef[]>({
    queryKey: viewKeys.list(key),
    queryFn: async () => (await apiClient.get<CustomViewDef[]>(base(key))).data,
    enabled: enabled && !!key,
    staleTime: 60_000,
  })
}

export function useCustomView(key: string, view: string) {
  return useQuery<CustomViewDef>({
    queryKey: viewKeys.one(key, view),
    queryFn: async () => (await apiClient.get<CustomViewDef>(`${base(key)}/${encodeURIComponent(view)}`)).data,
    enabled: !!key && !!view,
    retry: (count, err) => (err as { response?: { status?: number } })?.response?.status !== 404 && count < 2,
  })
}
