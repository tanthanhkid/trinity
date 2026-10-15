"use client"

import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"

export interface KanbanUserRosterItem {
  id: number
  full_name: string
  email?: string
}

interface UsersListResponse {
  data?: KanbanUserRosterItem[]
}

/**
 * Roster cho picker "Người phụ trách" — `GET /users`, theo quyền `users.view`.
 *
 * ⚠️ Giới hạn: người có phạm vi xem hẹp (chỉ chính mình) sẽ chỉ thấy chính họ
 * trong picker (chống enumerate nhân sự). Cần mở rộng thì làm endpoint roster
 * riêng, KHÔNG bypass RBAC tại đây.
 */
export function useKanbanUserRoster() {
  // `GET /users` cần `users.view` — thiếu quyền thì không gọi (tránh 403).
  const canViewUsers = usePermissions().can("users.view")
  return useQuery<KanbanUserRosterItem[]>({
    queryKey: ["kanban-user-roster"],
    queryFn: async () => {
      const res = await apiClient.get<UsersListResponse | KanbanUserRosterItem[]>(
        "/users?limit=500",
      )
      const payload = res.data
      if (Array.isArray(payload)) return payload
      return payload.data ?? []
    },
    staleTime: 5 * 60 * 1000,
    enabled: canViewUsers,
  })
}
