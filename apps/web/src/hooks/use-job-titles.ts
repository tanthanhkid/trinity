import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import apiClient, { getApiErrorMessage } from '@/lib/api-client'
import { toast } from 'sonner'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JobTitle {
  id: number
  category: string
  rank_code: string
  name: string
  symbol: string
  base_salary: string   // BigInt serialized as string
  standard_target: string
  default_insurance_salary: string | null // mức đóng BHXH cố định (null = lương cơ bản)
  review_cycle_months: number
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CreateJobTitlePayload {
  category: string
  rank_code: string
  name: string
  symbol: string
  base_salary?: number
  standard_target?: number
  default_insurance_salary?: number | null
  review_cycle_months: number
  is_active?: boolean
  sort_order?: number
}

export interface UpdateJobTitlePayload {
  category?: string
  name?: string
  symbol?: string
  base_salary?: number
  standard_target?: number
  default_insurance_salary?: number | null
  review_cycle_months?: number
  is_active?: boolean
  sort_order?: number
}

export interface QueryJobTitlesParams {
  category?: string
  is_active?: boolean
}

// ─── Query Keys ───────────────────────────────────────────────────────────────

export const JOB_TITLES_QUERY_KEY = ['job-titles'] as const

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useJobTitles(params?: QueryJobTitlesParams) {
  return useQuery<JobTitle[]>({
    queryKey: [...JOB_TITLES_QUERY_KEY, params],
    queryFn: async () => {
      const searchParams = new URLSearchParams()
      if (params?.category) searchParams.set('category', params.category)
      if (params?.is_active !== undefined)
        searchParams.set('is_active', String(params.is_active))
      const qs = searchParams.toString()
      const res = await apiClient.get<JobTitle[]>(
        `/management/job-titles${qs ? `?${qs}` : ''}`,
      )
      return res.data
    },
  })
}

export function useJobTitle(id: number) {
  return useQuery<JobTitle>({
    queryKey: [...JOB_TITLES_QUERY_KEY, id],
    queryFn: async () => {
      const res = await apiClient.get<JobTitle>(`/management/job-titles/${id}`)
      return res.data
    },
    enabled: id > 0,
  })
}

export function useCreateJobTitle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreateJobTitlePayload) => {
      const res = await apiClient.post<JobTitle>('/management/job-titles', payload)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOB_TITLES_QUERY_KEY })
      toast.success('Đã tạo chức danh mới')
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, 'Không thể tạo chức danh'))
    },
  })
}

export function useUpdateJobTitle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateJobTitlePayload }) => {
      const res = await apiClient.patch<JobTitle>(`/management/job-titles/${id}`, payload)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOB_TITLES_QUERY_KEY })
      toast.success('Đã cập nhật chức danh')
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, 'Không thể cập nhật chức danh'))
    },
  })
}

export function useDeleteJobTitle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/management/job-titles/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOB_TITLES_QUERY_KEY })
      toast.success('Đã xoá chức danh')
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, 'Không thể xoá chức danh'))
    },
  })
}
