"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { Extension, ExtensionRun, ExtensionVersion } from "@/lib/extensions"

const BASE = "/extensions"
export const EXTENSIONS_KEY = ["extensions"] as const

/** Danh sách chương trình con. 404 (tính năng tắt) ⇒ query lỗi ⇒ màn hình hiện thông báo "chưa bật" (lỗi thì throw). */
export function useExtensions() {
  return useQuery<Extension[]>({
    queryKey: [...EXTENSIONS_KEY, "list"],
    retry: false,
    queryFn: async () => {
      const rows = (await apiClient.get<{ data?: Extension[] }>(BASE)).data?.data
      return Array.isArray(rows) ? rows : []
    },
  })
}

export function useExtension(id: number | null) {
  return useQuery<{ extension: Extension; versions: ExtensionVersion[] }>({
    queryKey: [...EXTENSIONS_KEY, "one", id],
    enabled: id !== null,
    retry: false,
    queryFn: async () => (await apiClient.get(`${BASE}/${id}`)).data,
  })
}

/** Một phiên bản kèm MÃ NGUỒN (chỉ tải khi người duyệt mở). */
export function useExtensionVersion(id: number | null, version: number | null) {
  return useQuery<{ version: ExtensionVersion }>({
    queryKey: [...EXTENSIONS_KEY, "version", id, version],
    enabled: id !== null && version !== null,
    retry: false,
    queryFn: async () => (await apiClient.get(`${BASE}/${id}/versions/${version}`)).data,
  })
}

export function useExtensionLogs(id: number | null, enabled: boolean) {
  return useQuery<{ runs: ExtensionRun[]; next_cursor: number | null }>({
    queryKey: [...EXTENSIONS_KEY, "logs", id],
    enabled: enabled && id !== null,
    retry: false,
    queryFn: async () => (await apiClient.get(`${BASE}/${id}/logs`, { params: { limit: 20 } })).data,
  })
}

export type ExtensionAction = "approve" | "reject" | "deploy" | "rollback" | "disable" | "enable"

/** Mọi hành động của NGƯỜI duyệt. Thành công hay lỗi trạng thái ở BE đều có thể đã đổi ⇒ luôn tải lại. */
export function useExtensionAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (a: { id: number; action: ExtensionAction; version?: number; reason?: string }) => {
      const url = a.action === "approve" || a.action === "reject" ? `${BASE}/${a.id}/versions/${a.version}/${a.action}` : `${BASE}/${a.id}/${a.action}`
      const body = a.action === "deploy" || a.action === "rollback" ? { version: a.version } : a.action === "reject" || a.action === "disable" ? { reason: a.reason } : undefined
      return (await (body === undefined ? apiClient.post(url) : apiClient.post(url, body))).data
    },
    onSettled: () => qc.invalidateQueries({ queryKey: EXTENSIONS_KEY }),
  })
}
