"use client"

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export const RECRUITMENT_PAGE_SIZE = 10

export type CandidateStage =
  | "applied"
  | "sent_manager"
  | "interview"
  | "test"
  | "offer"
  | "hired"

export type CandidateDecision = "pending" | "hired" | "rejected"

export type RecruitmentType = "internal" | "external"

export type CandidateGender = "M" | "F"

export interface Candidate {
  id: number
  full_name: string
  phone: string
  email: string | null
  position: string | null
  department: string | null
  source: string | null
  stage: CandidateStage
  decision: CandidateDecision
  recruitment_type: RecruitmentType
  applied_date: string
  cost: number | null
  note: string | null
  gender: CandidateGender | null
  interview_date: string | null
  interview_time: string | null
  recruiter_id: number | null
  recruiter_name: string | null
  created_at: string
}

export interface CandidateFilters {
  search?: string
  stage?: string
  source?: string
  decision?: string
  recruitment_type?: string
  page?: number
  sort_by?: string
  sort_dir?: "asc" | "desc"
}

export interface CandidatesResponse {
  data: Candidate[]
  pagination: {
    total: number
    page: number
    page_size: number
    total_pages: number
  }
}

export interface CreateCandidateDto {
  full_name: string
  phone: string
  email?: string | null
  position?: string | null
  department?: string | null
  source?: string | null
  stage: CandidateStage
  decision: CandidateDecision
  recruitment_type: RecruitmentType
  applied_date: string
  cost?: number | null
  note?: string | null
  gender?: CandidateGender | null
  interview_date?: string | null
  interview_time?: string | null
  recruiter_id?: number | null
}

export type UpdateCandidateDto = Partial<CreateCandidateDto>

export interface Recruiter {
  id: number
  full_name: string
  email: string | null
}

export interface RecruitmentStats {
  total: number
  by_stage: Record<string, number>
  by_decision: Record<string, number>
  by_source: Record<string, number>
  total_cost: number
}

export function useCandidates(filters: CandidateFilters) {
  const params = new URLSearchParams()
  if (filters.search) params.set("search", filters.search)
  if (filters.stage) params.set("stage", filters.stage)
  if (filters.source) params.set("source", filters.source)
  if (filters.decision) params.set("decision", filters.decision)
  if (filters.recruitment_type) params.set("recruitment_type", filters.recruitment_type)
  if (filters.sort_by) params.set("sort_by", filters.sort_by)
  if (filters.sort_dir) params.set("sort_dir", filters.sort_dir)
  params.set("page", String(filters.page ?? 1))
  params.set("page_size", String(RECRUITMENT_PAGE_SIZE))

  return useQuery<CandidatesResponse>({
    queryKey: ["recruitment", filters],
    queryFn: async () => {
      const res = await apiClient.get<CandidatesResponse>(
        `/management/recruitment/candidates?${params.toString()}`,
      )
      return res.data
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useRecruitmentStats(dateFrom?: string, dateTo?: string) {
  const params = new URLSearchParams()
  if (dateFrom) params.set("date_from", dateFrom)
  if (dateTo) params.set("date_to", dateTo)

  return useQuery<RecruitmentStats>({
    queryKey: ["recruitment", "stats", dateFrom, dateTo],
    queryFn: async () => {
      const res = await apiClient.get<RecruitmentStats>(
        `/management/recruitment/stats?${params.toString()}`,
      )
      return res.data
    },
    staleTime: 60_000,
  })
}

export function useCreateCandidate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: CreateCandidateDto) => {
      const res = await apiClient.post<Candidate>("/management/recruitment/candidates", dto)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recruitment"] })
    },
  })
}

export function useUpdateCandidate(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: UpdateCandidateDto) => {
      const res = await apiClient.patch<Candidate>(
        `/management/recruitment/candidates/${id}`,
        dto,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recruitment"] })
    },
  })
}

export function useDeleteCandidate(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.delete<{ ok: boolean }>(
        `/management/recruitment/candidates/${id}`,
      )
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recruitment"] })
    },
  })
}

// Danh sách người tuyển dụng phụ trách (quản lý nhân sự + super_admin) — dùng cho dropdown.
export function useRecruiters() {
  return useQuery<Recruiter[]>({
    queryKey: ["recruitment-recruiters"],
    queryFn: async () => {
      const res = await apiClient.get<Recruiter[]>(
        "/management/recruitment/recruiters",
      )
      return res.data
    },
    staleTime: 5 * 60_000,
  })
}
