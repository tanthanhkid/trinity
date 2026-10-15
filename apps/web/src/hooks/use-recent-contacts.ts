"use client"

import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"

export interface RecentContact {
  id: number
  full_name: string | null
  viewed_at: string
}

function isRecentContactArray(body: unknown): body is RecentContact[] {
  return (
    Array.isArray(body) &&
    body.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "number" &&
        typeof (item as { viewed_at?: unknown }).viewed_at === "string",
    )
  )
}

/**
 * "KHÁCH GẦN ĐÂY" ở sidebar + Tổng quan — ẨN HẲN khi không có
 * quyền `contacts.view` (giống Danh bạ). BE (`GET /contacts/recent`, `@Can
 * ('contacts.view')`) đã tự lọc lại theo phạm vi hiện tại; hook chỉ thêm 1 lớp
 * KHÔNG GỌI API khi chắc chắn không có quyền.
 */
export function useRecentContacts() {
  const enabled = usePermissions().can("contacts.view")
  const query = useQuery({
    queryKey: ["contacts", "recent"],
    queryFn: async () => {
      const res = await apiClient.get<unknown>("/contacts/recent", { params: { limit: 5 } })
      if (!isRecentContactArray(res.data)) {
        throw new Error("contacts/recent: body không đúng shape")
      }
      return res.data
    },
    enabled,
    staleTime: 30_000,
  })
  return {
    recentContacts: enabled ? (query.data ?? []) : [],
    isLoading: enabled && query.isLoading,
  }
}
