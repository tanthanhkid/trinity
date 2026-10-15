"use client"

import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export interface ContactAssignableUser {
  id: number
  full_name: string | null
  email: string
}

/**
 * Nhân sự trong phạm vi `contacts.view` của CHÍNH người gọi — nguồn DUY NHẤT
 * cho mọi dropdown lọc người trên Danh bạ (Phụ trách, Người tạo). BE
 * (`GET /contacts/assignable-users`, `@Can('contacts.view')`) đã cắt theo
 * phạm vi own/team/subtree/all nên FE KHÔNG tự lọc theo vai trò hay dựng
 * cascade Phòng → Team → NV.
 */
export function useContactAssignableUsers(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true
  return useQuery<ContactAssignableUser[]>({
    queryKey: ["contacts", "assignable-users"],
    queryFn: async () => {
      const res = await apiClient.get<ContactAssignableUser[]>("/contacts/assignable-users")
      return Array.isArray(res.data) ? res.data : []
    },
    staleTime: 5 * 60 * 1000,
    enabled,
  })
}
