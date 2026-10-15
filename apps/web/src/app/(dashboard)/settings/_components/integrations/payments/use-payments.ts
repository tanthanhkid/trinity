import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

/** Khớp `ConnectorStatus` của BE (`GET /connectors`). */
export interface ConnectorStatus {
  provider: "sepay" | "vnpay" | "momo" | "kiotviet" | "sapo" | "misa" | "woocommerce" | "shopee" | "lazada"
  connected: boolean
  status: "not_connected" | "active" | "error"
  settings: {
    account_number?: string; bank?: string; account_name?: string; code_prefix?: string
    tmn_code?: string; partner_code?: string; sandbox?: boolean
    [k: string]: unknown
  } | null
  last_event_at: string | null
  last_error: string | null
  webhook_path: string
  secret_key_configured: boolean
  server_configured?: boolean
}

/** Khớp `PaymentView` của BE. */
export interface Payment {
  id: number
  code: string
  amount: number
  description: string | null
  status: "pending" | "paid" | "cancelled" | "expired"
  source_type: string
  source_id: number | null
  contact_id: number | null
  paid_amount: number | null
  paid_via: string | null
  paid_at: string | null
  expires_at: string | null
  created_at: string
  transfer_content: string
  qr_url: string | null
  bank: { account_number: string; bank: string; account_name: string | null } | null
  pay_links?: { vnpay?: string; momo?: string }
}

export type GatewayProvider = "vnpay" | "momo"
export interface SaveGatewayInput {
  sandbox: boolean
  tmn_code?: string
  hash_secret?: string
  partner_code?: string
  access_key?: string
  secret_key?: string
}

export interface SaveSepayInput {
  account_number: string
  bank: string
  account_name?: string
  code_prefix?: string
  rotate_key?: boolean
}

const KEYS = { connectors: ["connectors"] as const, payments: ["payments"] as const }

export function useConnectors(enabled = true) {
  return useQuery<ConnectorStatus[]>({
    queryKey: KEYS.connectors,
    enabled,
    queryFn: async () => (await apiClient.get<ConnectorStatus[]>("/connectors")).data,
    staleTime: 30_000,
  })
}

export function useSaveSepay() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (b: SaveSepayInput) => (await apiClient.put<{ status: ConnectorStatus; api_key: string | null }>("/connectors/sepay", b)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.connectors }),
  })
}

export function useSaveGateway(provider: GatewayProvider) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (b: SaveGatewayInput) => (await apiClient.put<ConnectorStatus>(`/connectors/${provider}`, b)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.connectors })
      qc.invalidateQueries({ queryKey: KEYS.payments })
    },
  })
}

export function useDisconnectSepay() {
  return useDisconnect("sepay")
}

export function useDisconnect(provider: ConnectorStatus["provider"]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => apiClient.delete(`/connectors/${provider}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.connectors })
      qc.invalidateQueries({ queryKey: KEYS.payments })
    },
  })
}

export function usePayments(enabled = true) {
  return useQuery<Payment[]>({
    queryKey: KEYS.payments,
    enabled,
    queryFn: async () => (await apiClient.get<Payment[]>("/payments", { params: { limit: 50 } })).data,
    refetchInterval: 15_000,
  })
}

export function useCreatePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (b: { amount: number; description?: string; expires_in_hours?: number }) => (await apiClient.post<Payment>("/payments", b)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.payments }),
  })
}

export function useCancelPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => (await apiClient.post<Payment>(`/payments/${id}/cancel`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.payments }),
  })
}
