'use client'

import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/api-client'
import type { Project } from '@/components/projects/project-types'

/**
 * GET /projects — lấy projects đang hoạt động (is_active=true).
 * Dùng cho Settings > Dự án.
 * Chỉ lấy active để dự án bị soft delete không xuất hiện trong bảng.
 */
export function useProjectsAdmin() {
  return useQuery<Project[]>({
    queryKey: ['projects', 'active-admin'],
    staleTime: 30 * 1000,
    queryFn: async () => {
      const res = await apiClient.get<Project[]>('/projects')
      return Array.isArray(res.data) ? res.data : []
    },
  })
}
