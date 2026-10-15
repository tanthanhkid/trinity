import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  DeliveriesPage,
  DeliveryStatus,
  InboundSource,
  InboundSourceWithToken,
  PingResult,
  SimpleOption,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookEventDef,
} from "./webhook-types"

const OUT = "/integrations/webhooks"
export const WEBHOOK_KEYS = {
  events: ["integrations", "webhooks", "events"] as const,
  endpoints: ["integrations", "webhooks", "endpoints"] as const,
  deliveries: ["integrations", "webhooks", "deliveries"] as const,
  sources: ["integrations", "webhooks", "inbound-sources"] as const,
}

// Mọi query THROW khi lỗi: UI phân biệt "lỗi tải" với "chưa có dữ liệu".
export function useWebhookEvents(enabled: boolean) {
  return useQuery<WebhookEventDef[]>({
    queryKey: WEBHOOK_KEYS.events,
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async () => (await apiClient.get<WebhookEventDef[]>(`${OUT}/events`)).data,
  })
}

export function useWebhookEndpoints(enabled: boolean) {
  return useQuery<WebhookEndpoint[]>({
    queryKey: WEBHOOK_KEYS.endpoints,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: WebhookEndpoint[] }>(`${OUT}/endpoints`)).data.data,
  })
}

export interface EndpointInput {
  name: string
  url: string
  events: string[]
}

export function useEndpointMutations() {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: WEBHOOK_KEYS.endpoints })
    void qc.invalidateQueries({ queryKey: WEBHOOK_KEYS.deliveries })
  }
  return {
    create: useMutation({
      mutationFn: async (v: EndpointInput) => (await apiClient.post<WebhookEndpointWithSecret>(`${OUT}/endpoints`, v)).data,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: { id: number } & Partial<EndpointInput> & { is_active?: boolean }) =>
        (await apiClient.patch<WebhookEndpoint>(`${OUT}/endpoints/${id}`, body)).data,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: number) => (await apiClient.delete(`${OUT}/endpoints/${id}`)).data,
      onSuccess: refresh,
    }),
    rotate: useMutation({
      mutationFn: async (id: number) => (await apiClient.post<WebhookEndpointWithSecret>(`${OUT}/endpoints/${id}/rotate-secret`)).data,
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: async (id: number) => (await apiClient.post<PingResult>(`${OUT}/endpoints/${id}/test`)).data,
      onSuccess: refresh,
    }),
  }
}

export interface DeliveryFilters {
  endpointId?: number
  status?: DeliveryStatus
}

/** Nhật ký gửi, cursor — component PHẢI gọi `fetchNextPage()`. */
export function useWebhookDeliveries(filters: DeliveryFilters, enabled: boolean) {
  return useInfiniteQuery<DeliveriesPage>({
    queryKey: [...WEBHOOK_KEYS.deliveries, filters],
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { limit: 30 }
      if (filters.endpointId) params.endpoint_id = filters.endpointId
      if (filters.status) params.status = filters.status
      if (typeof pageParam === "string") params.cursor = pageParam
      return (await apiClient.get<DeliveriesPage>(`${OUT}/deliveries`, { params })).data
    },
  })
}

export function useRetryDelivery() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`${OUT}/deliveries/${id}/retry`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: WEBHOOK_KEYS.deliveries }),
  })
}

// ---- Webhook vào ----
export function useInboundSources(enabled: boolean) {
  return useQuery<InboundSource[]>({
    queryKey: WEBHOOK_KEYS.sources,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: InboundSource[] }>(`${OUT}/inbound-sources`)).data.data,
  })
}

export interface SourceInput {
  name: string
  default_assignee_id: number
  contact_source_id: number
  signed?: boolean
}

export function useSourceMutations() {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: WEBHOOK_KEYS.sources })
  return {
    create: useMutation({
      mutationFn: async (v: SourceInput) => (await apiClient.post<InboundSourceWithToken>(`${OUT}/inbound-sources`, v)).data,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: { id: number } & Partial<SourceInput> & { is_active?: boolean }) =>
        (await apiClient.patch<InboundSource & { signing_secret?: string }>(`${OUT}/inbound-sources/${id}`, body)).data,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: number) => (await apiClient.delete(`${OUT}/inbound-sources/${id}`)).data,
      onSuccess: refresh,
    }),
    rotateToken: useMutation({
      mutationFn: async (id: number) => (await apiClient.post<InboundSourceWithToken>(`${OUT}/inbound-sources/${id}/rotate-token`)).data,
      onSuccess: refresh,
    }),
  }
}

/** Nguồn khách (SettingOption group `contact_source`) đang bật. */
export function useContactSourceOptions(enabled: boolean) {
  return useQuery<SimpleOption[]>({
    queryKey: ["integrations", "contact-source-options"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiClient.get<Array<{ id: number; label: string }> | { data: Array<{ id: number; label: string }> }>("/settings/options", {
        params: { group: "contact_source", active: true },
      })
      const rows = Array.isArray(res.data) ? res.data : (res.data.data ?? [])
      return rows.map((o) => ({ id: o.id, label: o.label }))
    },
  })
}

/**
 * Người nhận khách: ĐÚNG nguồn mà BE ràng buộc — phạm vi `contacts.transfer` (`GET /contacts/assignable-sales`).
 * Không có quyền chuyển khách thì BE chỉ cho chọn CHÍNH MÌNH (caller tự thêm).
 */
export function useAssignableUsers(enabled: boolean) {
  return useQuery<SimpleOption[]>({
    queryKey: ["integrations", "assignable-users"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiClient.get<Array<{ id: number; full_name: string }> | { data: Array<{ id: number; full_name: string }> }>("/contacts/assignable-sales")
      const rows = Array.isArray(res.data) ? res.data : (res.data.data ?? [])
      return rows.map((u) => ({ id: u.id, label: u.full_name }))
    },
  })
}
