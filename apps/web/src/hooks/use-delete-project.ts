'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import apiClient from '@/lib/api-client'

/**
 * Mutation hook: DELETE /projects/:id (soft delete — set is_active=false)
 * Chỉ super_admin mới được gọi. BE enforce @Roles('super_admin').
 * Invalidate cả 2 cache keys ["projects"] sau khi thành công.
 */
export function useDeleteProject(onSuccess?: () => void) {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiClient.delete(`/projects/${id}`)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Đã xoá dự án thành công')
      onSuccess?.()
    },
    onError: (err) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? 'Không thể xoá dự án. Vui lòng thử lại.'
      toast.error(msg)
    },
  })
}
