import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import apiClient from "@/lib/api-client"
import type { RefType, RefView } from "@/lib/refs/mentions"

/**
 * Gắn thẻ @ — React Query. BE lọc theo quyền xem của người dùng: bản ghi không thấy được thì KHÔNG có trong kết quả
 * (FE hiện thẻ đó là "không xem được"), không bao giờ lộ tên.
 */
const ROOT = ["refs"] as const

export interface RefPreview extends RefView { fields: { label: string; value: string }[] }
export interface RefBacklink { source: RefView; fields: string[] }

/** Chữ sau "@" → gợi ý (debounce 200ms, giữ kết quả cũ khi gõ tiếp để danh sách không nháy). */
export function useRefSuggest(query: string, enabled: boolean, limit = 8) {
  const [term, setTerm] = useState(query)
  useEffect(() => {
    const t = window.setTimeout(() => setTerm(query), 200)
    return () => window.clearTimeout(t)
  }, [query])
  return useQuery<RefView[]>({
    queryKey: [...ROOT, "suggest", term, limit],
    queryFn: async () => (await apiClient.get<RefView[]>("/refs/suggest", { params: { q: term || undefined, limit } })).data,
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  })
}

/** Mã → bản ghi (một lần gọi cho cả danh sách). Map khoá = mã chuẩn đã gửi. */
export function useResolvedCodes(codes: string[]) {
  const key = [...new Set(codes)].sort().slice(0, 50)
  return useQuery<Map<string, RefView>>({
    queryKey: [...ROOT, "resolve", key.join(",")],
    queryFn: async () => {
      const rows = (await apiClient.get<RefView[]>("/refs/resolve", { params: { codes: key.join(",") } })).data
      return new Map(rows.map((r) => [r.requested ?? r.code ?? "", r]))
    },
    enabled: key.length > 0,
    staleTime: 60_000,
  })
}

export function useRefBacklinks(type: RefType, id: number, enabled = true) {
  return useQuery<RefBacklink[]>({
    queryKey: [...ROOT, "backlinks", type, id],
    queryFn: async () => (await apiClient.get<RefBacklink[]>(`/refs/${type}/${id}/backlinks`)).data,
    enabled: enabled && id > 0,
    retry: false,
  })
}

export function useRefPreview(type: RefType, id: number, enabled: boolean) {
  return useQuery<RefPreview>({
    queryKey: [...ROOT, "preview", type, id],
    queryFn: async () => (await apiClient.get<RefPreview>(`/refs/${type}/${id}/preview`)).data,
    enabled,
    staleTime: 30_000,
    retry: false,
  })
}
