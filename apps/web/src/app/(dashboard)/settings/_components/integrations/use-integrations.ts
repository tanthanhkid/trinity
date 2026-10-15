import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import {
  vnDayEndIso,
  vnDayStartIso,
  type IntegrationAuditPage,
  type IntegrationAuditStatus,
  type IntegrationChannel,
  type IntegrationsStatus,
} from "./integrations-meta"

export const INTEGRATIONS_STATUS_KEY = ["integrations", "status"] as const

/** Cờ máy chủ (`GET /integrations/status`). Lỗi → throw: UI phân biệt "đang lỗi" với "tắt". */
export function useIntegrationsStatus(enabled: boolean) {
  return useQuery<IntegrationsStatus>({
    queryKey: INTEGRATIONS_STATUS_KEY,
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await apiClient.get<IntegrationsStatus>("/integrations/status")).data,
  })
}

export interface AuditFilters {
  channel?: IntegrationChannel
  status?: IntegrationAuditStatus
  /** yyyy-mm-dd (giờ VN) */
  from?: string
  to?: string
}

/** Nhật ký tích hợp, phân trang cursor — component PHẢI gọi `fetchNextPage()`. */
export function useIntegrationAuditLogs(filters: AuditFilters, enabled: boolean) {
  return useInfiniteQuery<IntegrationAuditPage>({
    queryKey: ["integrations", "audit-logs", filters],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { limit: 50 }
      if (filters.channel) params.channel = filters.channel
      if (filters.status) params.status = filters.status
      if (filters.from) params.from = vnDayStartIso(filters.from)
      if (filters.to) params.to = vnDayEndIso(filters.to)
      if (typeof pageParam === "string") params.cursor = pageParam
      return (await apiClient.get<IntegrationAuditPage>("/integrations/audit-logs", { params })).data
    },
  })
}
