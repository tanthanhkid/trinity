"use client"

import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export const POSITION_PAGE_SIZE = 10

export type PositionStatus = "open" | "closed"

export interface RecruitmentPosition {
  id: number
  job_code: string
  department: string
  team: string | null
  position_title: string
  headcount: number
  recruiter_id: number | null
  recruiter_name: string | null
  opened_date: string | null
  expected_start_date: string | null
  description: string | null
  requirements: string | null
  recruitment_cost: number | null
  status: PositionStatus
  created_at: string
}

export interface PositionFilters {
  search?: string
  status?: string
  department?: string
  page?: number
  sort_by?: string
  sort_dir?: "asc" | "desc"
}

export interface PositionsResponse {
  data: RecruitmentPosition[]
  pagination: {
    total: number
    page: number
    page_size: number
    total_pages: number
  }
}

export interface CreatePositionDto {
  job_code: string
  department: string
  team?: string | null
  position_title: string
  headcount: number
  recruiter_id: number
  opened_date: string
  expected_start_date?: string | null
  description?: string | null
  requirements?: string | null
  recruitment_cost?: number | null
  status?: PositionStatus
}

export type UpdatePositionDto = Partial<CreatePositionDto>

export function usePositions(filters: PositionFilters) {
  const params = new URLSearchParams()
  if (filters.search) params.set("search", filters.search)
  if (filters.status) params.set("status", filters.status)
  if (filters.department) params.set("department", filters.department)
  if (filters.sort_by) params.set("sort_by", filters.sort_by)
  if (filters.sort_dir) params.set("sort_dir", filters.sort_dir)
  params.set("page", String(filters.page ?? 1))
  params.set("page_size", String(POSITION_PAGE_SIZE))

  return useQuery<PositionsResponse>({
    queryKey: ["recruitment-positions", filters],
    queryFn: async () => {
      const res = await apiClient.get<PositionsResponse>(
        `/management/recruitment/positions?${params.toString()}`,
      )
      return res.data
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useCreatePosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: CreatePositionDto) => {
      const res = await apiClient.post<RecruitmentPosition>(
        "/management/recruitment/positions",
        dto,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recruitment-positions"] })
    },
  })
}

export function useUpdatePosition(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: UpdatePositionDto) => {
      const res = await apiClient.patch<RecruitmentPosition>(
        `/management/recruitment/positions/${id}`,
        dto,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recruitment-positions"] })
    },
  })
}

export function useDeletePosition(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.delete<{ ok: boolean }>(
        `/management/recruitment/positions/${id}`,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recruitment-positions"] })
    },
  })
}
