'use client'

import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'
import { usePermissions } from '@/lib/rbac'

export interface ProjectOption {
  id: number
  name: string
  code: string
  is_active: boolean
}

/**
 * GET /projects — backend mặc định chỉ trả về is_active=true (trừ khi truyền
 * ?include_inactive=true). Response là plain array ProjectOption[].
 *
 * queryKey ["projects","active"] — shared cache cho mọi component cần danh sách
 * dự án (kanban filter, list filter).
 */
export function useActiveProjects() {
  // BE `GET /projects` gate `products.view` — thiếu quyền thì KHÔNG gọi (tránh 403).
  const { can } = usePermissions()
  return useQuery<ProjectOption[]>({
    queryKey: ['projects', 'active'],
    enabled: can('products.view'),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const res = await apiClient.get<ProjectOption[]>('/projects')
      return Array.isArray(res.data) ? res.data : []
    },
  })
}
