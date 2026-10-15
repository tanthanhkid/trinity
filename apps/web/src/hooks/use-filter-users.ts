import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"

export interface FilterUser {
  id: number
  full_name: string
  email: string
}

interface UsersResponse {
  data?: FilterUser[]
}

/**
 * RBAC quyền + phạm vi: KHÔNG lọc `/users?role=<mã vai trò>` — vai trò do
 * admin tự đặt tên, KHÔNG có mã cố định để lọc, và quyền xem danh sách do BE
 * (`GET /users`, `users.view` + phạm vi) quyết. Dropdown chọn người dùng 2 hook
 * generic dưới đây.
 */
async function fetchUsers(query: string): Promise<FilterUser[]> {
  const res = await apiClient.get<UsersResponse | FilterUser[]>(`/users?limit=1000&${query}`)
  const payload = res.data
  if (Array.isArray(payload)) return payload
  return (payload as UsersResponse).data ?? []
}

/**
 * Toàn bộ nhân sự ĐANG HOẠT ĐỘNG trong phạm vi `users.view` của người gọi —
 * dùng cho dropdown "gán/lọc theo người" (báo cáo…). Cache 5 phút.
 */
export function useActiveUsers(options: { enabled?: boolean } = {}) {
  // `GET /users` yêu cầu `users.view` — thiếu quyền thì KHÔNG gọi (403).
  const canViewUsers = usePermissions().can("users.view")
  const enabled = (options.enabled ?? true) && canViewUsers
  return useQuery<FilterUser[]>({
    queryKey: ["filter-users", "active"],
    queryFn: () => fetchUsers("status=active"),
    staleTime: 5 * 60 * 1000,
    enabled,
  })
}

/**
 * Nhân sự ĐANG HOẠT ĐỘNG báo cáo trực tiếp cho `managerId` (cây `users.manager_id`)
 * — dùng cho cascade Team → Nhân viên. Chỉ fire khi `managerId` có giá trị.
 */
export function useUsersByManager(
  managerId: number | undefined,
  options: { enabled?: boolean } = {},
) {
  const canViewUsers = usePermissions().can("users.view")
  const enabled = (options.enabled ?? true) && managerId !== undefined && canViewUsers
  return useQuery<FilterUser[]>({
    queryKey: ["filter-users", "by-manager", managerId],
    queryFn: () => fetchUsers(`status=active&manager_id=${managerId}`),
    staleTime: 5 * 60 * 1000,
    enabled,
  })
}
