"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  PosArea, PosDailyReport, PosMenu, PosModifier, PosOrder, PosOrderStatus, PosOrderWrite, PosPaymentInput,
  PosQr, PosSettings, PosShift, PosShiftState, PosShiftSummary, PosTable,
} from "@/types/pos"

/**
 * Data-layer POS. Mọi số tiền là số nguyên VND, BE tính lại tổng.
 * Lỗi mạng: THROW để React Query giữ cache cũ, không trả giá trị "rỗng" giả.
 */
const K = "pos"
const get = async <T,>(url: string, params?: object): Promise<T> => (await apiClient.get<T>(url, { params })).data

export const usePosSettings = () => useQuery({ queryKey: [K, "settings"], queryFn: () => get<PosSettings>("/pos/settings"), staleTime: 60_000 })
export const usePosMenu = () => useQuery({ queryKey: [K, "menu"], queryFn: () => get<PosMenu>("/pos/menu"), staleTime: 60_000 })
export const usePosAreas = () => useQuery({ queryKey: [K, "areas"], queryFn: () => get<PosArea[]>("/pos/areas") })
export const usePosTables = () => useQuery({ queryKey: [K, "tables"], queryFn: () => get<PosTable[]>("/pos/tables"), refetchInterval: 15_000 })
export const usePosModifiers = (includeInactive = false) =>
  useQuery({
    queryKey: [K, "modifiers", includeInactive],
    queryFn: () => get<PosModifier[]>("/pos/modifiers", includeInactive ? { include_inactive: true } : undefined),
    staleTime: 60_000,
  })
export const usePosShift = () => useQuery({ queryKey: [K, "shift"], queryFn: () => get<PosShiftState>("/pos/shifts/current"), refetchInterval: 30_000 })
export const usePosShifts = () =>
  useQuery({ queryKey: [K, "shifts"], queryFn: async () => (await get<{ data: PosShift[] }>("/pos/shifts", { limit: 30 })).data })
export const usePosShiftSummary = (id: number | null) =>
  useQuery({
    queryKey: [K, "shift-summary", id], enabled: id != null,
    queryFn: () => get<{ shift: PosShift; summary: PosShiftSummary }>(`/pos/shifts/${id}/summary`),
  })
export const usePosOrders = (status?: PosOrderStatus, refetchMs?: number) =>
  useQuery({
    queryKey: [K, "orders", status ?? "all"],
    queryFn: async () => (await get<{ data: PosOrder[] }>("/pos/orders", { status, limit: 50 })).data,
    refetchInterval: refetchMs,
  })
export const usePosDailyReport = (date: string) =>
  useQuery({ queryKey: [K, "report", date], queryFn: () => get<PosDailyReport>("/pos/reports/daily", { date }) })

export const fetchPosQr = (orderId: number, amount?: number) => get<PosQr>(`/pos/orders/${orderId}/qr`, amount ? { amount } : undefined)

/** Mọi thay đổi ca/đơn/bàn làm cũ nhiều truy vấn cùng lúc → invalidate cả nhánh `pos` trừ menu/settings. */
function useInvalidate(keys: string[]) {
  const qc = useQueryClient()
  return () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [K, k] })))
}
const ORDER_KEYS = ["orders", "tables", "shift", "shifts", "shift-summary", "report"]

export function useOpenShift() {
  const inv = useInvalidate(ORDER_KEYS)
  return useMutation({ mutationFn: async (opening_cash: number) => (await apiClient.post("/pos/shifts/open", { opening_cash })).data, onSuccess: inv })
}
export function useCloseShift() {
  const inv = useInvalidate(ORDER_KEYS)
  return useMutation({
    mutationFn: async (p: { id: number; closing_cash_counted: number; note?: string }) =>
      (await apiClient.post<{ shift: PosShift; summary: PosShiftSummary }>(`/pos/shifts/${p.id}/close`, { closing_cash_counted: p.closing_cash_counted, note: p.note })).data,
    onSuccess: inv,
  })
}
export function useCreateOrder() {
  const inv = useInvalidate(ORDER_KEYS)
  return useMutation({ mutationFn: async (b: PosOrderWrite) => (await apiClient.post<PosOrder>("/pos/orders", b)).data, onSuccess: inv })
}
export function useUpdateOrder() {
  const inv = useInvalidate(ORDER_KEYS)
  return useMutation({
    mutationFn: async (p: { id: number; body: PosOrderWrite }) => (await apiClient.patch<PosOrder>(`/pos/orders/${p.id}`, p.body)).data,
    onSuccess: inv,
  })
}
export function usePayOrder() {
  const inv = useInvalidate(ORDER_KEYS)
  return useMutation({
    mutationFn: async (p: { id: number; payments: PosPaymentInput[] }) => (await apiClient.post<PosOrder>(`/pos/orders/${p.id}/pay`, { payments: p.payments })).data,
    onSuccess: inv,
  })
}
export function useVoidOrder() {
  const inv = useInvalidate(ORDER_KEYS)
  return useMutation({
    mutationFn: async (p: { id: number; reason: string }) => (await apiClient.post<PosOrder>(`/pos/orders/${p.id}/void`, { reason: p.reason })).data,
    onSuccess: inv,
  })
}

/** Ghi cấu hình (quản lý): settings, khu vực, bàn, tuỳ chọn. `body` KHÔNG chứa id (BE cấm field thừa). */
export function usePosConfigMutation(keys: string[]) {
  const inv = useInvalidate(keys)
  return useMutation({
    mutationFn: async (p: { method: "post" | "patch"; url: string; body: object }) => (await apiClient[p.method](p.url, p.body)).data,
    onSuccess: inv,
  })
}
