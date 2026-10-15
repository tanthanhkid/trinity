import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { ConnectorStatus } from "../payments/use-payments"

/** Khớp `ConnectorRecord` của BE (`GET /connectors/records`). */
export interface SalesRecord {
  id: number
  provider: string
  kind: "customer" | "order" | "invoice" | "product"
  external_id: string
  code: string | null
  name: string | null
  contact_id: number | null
  amount: number | null
  status: string | null
  data: { items?: Array<{ name: string; quantity: number; price: number }> }
  external_updated_at: string | null
}

export interface KiotVietSettings {
  retailer?: string
  client_id?: string
  webhook_ids?: number[]
  webhook_error?: string | null
  counts?: Partial<Record<"customers" | "products" | "orders" | "invoices", number>>
  last_sync_at?: string | null
}

export type SyncResult = { added: Partial<Record<"customers" | "products" | "orders" | "invoices" | "items", number>>; more: boolean }
export type ShopProvider = "kiotviet" | "sapo" | "misa" | "woocommerce"

export function useSalesConnectors(enabled = true) {
  return useQuery<ConnectorStatus[]>({
    queryKey: ["connectors", "commerce"],
    enabled,
    queryFn: async () => (await apiClient.get<ConnectorStatus[]>("/connectors/commerce")).data,
    staleTime: 30_000,
  })
}

export function useSaveShop(provider: ShopProvider) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (b: Record<string, string | undefined>) =>
      (await apiClient.put<{ first_sync: SyncResult | { error: string } }>(`/connectors/${provider}`, b)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors"] })
      qc.invalidateQueries({ queryKey: ["sales-records"] })
    },
  })
}

export function useSyncShop(provider: ShopProvider) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => (await apiClient.post<SyncResult>(`/connectors/${provider}/sync`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors"] })
      qc.invalidateQueries({ queryKey: ["sales-records"] })
    },
  })
}

export function useDisconnectShop(provider: ShopProvider) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => apiClient.delete(`/connectors/${provider}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
  })
}

export function useSalesRecords(kind: "order" | "invoice" | "customer" | "product", enabled = true) {
  return useQuery<SalesRecord[]>({
    queryKey: ["sales-records", kind],
    enabled,
    queryFn: async () => (await apiClient.get<SalesRecord[]>("/connectors/records", { params: { kind, limit: 30 } })).data,
  })
}

export type MarketProvider = "shopee" | "lazada"

export function useMarketConnect(provider: MarketProvider) {
  return useMutation({ mutationFn: async () => (await apiClient.post<{ authorize_url: string }>(`/connectors/${provider}/connect`)).data.authorize_url })
}

export function useMarketSync(provider: MarketProvider) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => (await apiClient.post<SyncResult>(`/connectors/${provider}/sync`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connectors"] })
      qc.invalidateQueries({ queryKey: ["sales-records"] })
    },
  })
}

export function useMarketDisconnect(provider: MarketProvider) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => apiClient.delete(`/connectors/${provider}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connectors"] }),
  })
}
