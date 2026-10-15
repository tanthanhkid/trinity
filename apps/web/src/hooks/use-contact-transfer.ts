"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

/**
 * Người quản lý/super_admin chuyển quyền phụ trách 1 liên hệ
 * (Danh bạ) cho sale khác qua `POST /contacts/:id/transfer`.
 * CHỈ đổi Contact.assigned_to.
 */
export interface TransferContactPayload {
  new_assigned_to: number
  reason?: string
}

export function useTransferContact(contactId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: TransferContactPayload) => {
      const { data } = await apiClient.post(`/contacts/${contactId}/transfer`, payload)
      return data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", contactId] })
      void qc.invalidateQueries({ queryKey: ["contact-activities", contactId] })
      void qc.invalidateQueries({ queryKey: ["contacts"] })
    },
  })
}

export interface AssignableContactSale {
  id: number
  full_name: string
  email: string
}

/**
 * GET /contacts/assignable-sales — danh sách sale ACTIVE trong phạm vi quản
 * lý người gọi (theo phạm vi quản lý: cấp dưới trực tiếp / toàn bộ nhánh / super_admin toàn bộ). Chỉ
 * fetch khi dialog mở (`enabled`).
 */
export function useAssignableContactSales(options: { enabled?: boolean } = {}) {
  return useQuery<AssignableContactSale[]>({
    queryKey: ["contacts", "assignable-sales"],
    queryFn: async () => {
      const res = await apiClient.get("/contacts/assignable-sales")
      const payload = res.data
      return Array.isArray(payload) ? payload : (payload?.data ?? [])
    },
    enabled: options.enabled ?? true,
  })
}

export interface BulkTransferContactsPayload {
  contact_ids: number[]
  new_assigned_to: number
  reason?: string
}

export interface BulkTransferContactsResult {
  transferredIds: number[]
  failed: Array<{ contactId: number; error: string }>
}

/** POST /contacts/bulk-transfer — chuyển nhiều liên hệ cùng lúc (vd sale nghỉ việc). */
export function useBulkTransferContacts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: BulkTransferContactsPayload) => {
      const { data } = await apiClient.post<BulkTransferContactsResult>(
        "/contacts/bulk-transfer",
        payload,
      )
      return data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contacts"] })
    },
  })
}
