"use client"

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import { toast } from "sonner"

export const CONTRACTS_PAGE_SIZE = 10

// "no_contract" = nhân viên chưa có hợp đồng nào (danh sách liệt kê theo nhân viên).
export type ContractStatus = "active" | "expiring" | "expired" | "terminated" | "no_contract"

export interface ContractFilters {
  search?: string
  department?: string
  position?: string
  status?: string
  contract_type?: string
  employment_status?: string
  // Lọc theo team (team_lead user id) — đồng bộ /management/employees.
  team?: string
  page?: number
  sort_by?: string
  sort_dir?: "asc" | "desc"
}

export interface ContractEmployee {
  id: number
  employee_code: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
  position: string | null
  department: string | null
  // Team = trưởng nhóm (team_lead) trực thuộc, suy ra từ manager_id.
  team_lead_name: string | null
  team_lead_id: number | null
  gender: string | null
  job_title_name: string | null
  // Tình trạng làm việc suy từ employees.status.
  employment_status: "working" | "resigned"
}

// Dòng danh sách = 1 nhân viên + hợp đồng mới nhất (NULL khi chưa có hợp đồng).
export interface Contract {
  id: number | null
  contract_type: string | null
  signed_date: string | null
  end_date: string | null
  file_url: string | null
  notes: string | null
  is_terminated: boolean
  terminated_at: string | null
  created_at: string | null
  updated_at: string | null
  status: ContractStatus
  days_remaining: number | null
  employee: ContractEmployee
}

export interface ContractsResponse {
  data: Contract[]
  pagination: {
    total: number
    page: number
    page_size: number
    total_pages: number
  }
}

export interface CreateContractDto {
  employee_id: number
  contract_type?: string
  signed_date: string
  end_date?: string | null
  file_url?: string | null
  notes?: string | null
  is_terminated?: boolean
}

export interface UpdateContractDto {
  contract_type?: string
  signed_date?: string
  end_date?: string | null
  file_url?: string | null
  notes?: string | null
  is_terminated?: boolean
}

export function useContracts(filters: ContractFilters) {
  const params = new URLSearchParams()
  if (filters.search) params.set("search", filters.search)
  if (filters.department) params.set("department", filters.department)
  if (filters.position) params.set("position", filters.position)
  if (filters.status) params.set("status", filters.status)
  if (filters.contract_type) params.set("contract_type", filters.contract_type)
  if (filters.employment_status) params.set("employment_status", filters.employment_status)
  if (filters.team) params.set("team", filters.team)
  if (filters.sort_by) params.set("sort_by", filters.sort_by)
  if (filters.sort_dir) params.set("sort_dir", filters.sort_dir)
  params.set("page", String(filters.page ?? 1))
  params.set("page_size", String(CONTRACTS_PAGE_SIZE))

  const { can } = usePermissions()
  return useQuery<ContractsResponse>({
    enabled: can("contracts.view"),
    queryKey: ["contracts", filters],
    queryFn: async () => {
      const res = await apiClient.get<ContractsResponse>(`/management/contracts?${params.toString()}`)
      return res.data
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

// ─── Thống kê hợp đồng (dialog "Thống kê hợp đồng") ──────────────────────────

export interface ContractStatBucket {
  key: string
  label: string
  count: number
}
export interface ContractTeamBucket {
  team_lead_id: number | null
  label: string
  count: number
}
export interface ContractStats {
  total: number
  by_status: ContractStatBucket[]
  by_type: ContractStatBucket[]
  by_employment: ContractStatBucket[]
  by_team: ContractTeamBucket[]
  signed_by_month: { month: string; count: number }[]
  expiring_3m: ContractStatBucket[]
}

// bộ lọc dialog "Thống kê hợp đồng". Tất cả optional; không truyền gì =
// hành vi cũ (toàn bộ nhân viên, không lọc).
export interface ContractStatsFilters {
  date_from?: string
  date_to?: string
  department?: string
  team?: string
  employment_status?: string
}

export function useContractStats(enabled = false, filters?: ContractStatsFilters) {
  const params = new URLSearchParams()
  if (filters?.date_from) params.set("date_from", filters.date_from)
  if (filters?.date_to) params.set("date_to", filters.date_to)
  if (filters?.department) params.set("department", filters.department)
  if (filters?.team) params.set("team", filters.team)
  if (filters?.employment_status) params.set("employment_status", filters.employment_status)
  const qs = params.toString()

  return useQuery<ContractStats>({
    queryKey: ["contracts", "stats", filters ?? {}],
    queryFn: async () => {
      const res = await apiClient.get<ContractStats>(
        `/management/contracts/stats${qs ? `?${qs}` : ""}`,
      )
      return res.data
    },
    enabled,
    staleTime: 60_000,
  })
}

export function useContract(id: number | null) {
  return useQuery<Contract>({
    queryKey: ["contracts", id],
    queryFn: async () => {
      const res = await apiClient.get<Contract>(`/management/contracts/${id}`)
      return res.data
    },
    enabled: id !== null,
    staleTime: 30_000,
  })
}

export function useCreateContract() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: CreateContractDto) => {
      const res = await apiClient.post<Contract>("/management/contracts", dto)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contracts"] })
    },
  })
}

export function useUpdateContract(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: UpdateContractDto) => {
      const res = await apiClient.patch<Contract>(`/management/contracts/${id}`, dto)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contracts"] })
    },
  })
}

export function useDeleteContract(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.delete<{ ok: boolean }>(`/management/contracts/${id}`)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contracts"] })
    },
  })
}

export function useUploadContractFile(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData()
      formData.append("file", file)
      // ⚠️ BẮT BUỘC override Content-Type multipart (nếu không axios serialize FormData thành JSON → BE 400)
      const res = await apiClient.post<Contract>(`/management/contracts/${id}/file`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contracts"] })
    },
  })
}

export function useDeleteContractFile(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.delete<Contract>(`/management/contracts/${id}/file`)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contracts"] })
    },
  })
}

// Xem file: fetch blob (kèm JWT qua apiClient) → mở tab mới (mirror pattern xem file đính kèm)
export function useViewContractFile() {
  return useMutation({
    // `win` mở SYNC trong onClick (user gesture) rồi truyền vào — tránh popup-blocker chặn
    // window.open gọi SAU await (lỗi cũ: bấm "Xem" không hiện gì).
    mutationFn: async ({ id, win }: { id: number; win: Window | null }) => {
      try {
        const res = await apiClient.get(`/management/contracts/${id}/file`, {
          responseType: "blob",
        })
        const url = URL.createObjectURL(res.data as Blob)
        if (win && !win.closed) {
          win.location.href = url
        } else {
          // Tab trống bị chặn → fallback tải file về máy
          const a = document.createElement("a")
          a.href = url
          a.download = `hop-dong-${id}`
          document.body.appendChild(a)
          a.click()
          a.remove()
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } catch (err) {
        win?.close()
        throw err
      }
    },
    onError: () =>
      toast.error("Không xem được file hợp đồng — thử lại hoặc kiểm tra quyền truy cập."),
  })
}

// ===== Hồ sơ mẫu hợp đồng — file mẫu chung, tải xuống =====

export interface ContractTemplate {
  id: number
  name: string
  mime: string
  size: number
  uploaded_by: number | null
  created_at: string
}

export function useContractTemplates() {
  return useQuery({
    queryKey: ["contract-templates"],
    queryFn: async () => {
      const res = await apiClient.get<ContractTemplate[]>("/management/contracts/templates")
      return res.data
    },
  })
}

export function useUploadContractTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, name }: { file: File; name?: string }) => {
      const formData = new FormData()
      formData.append("file", file)
      if (name) formData.append("name", name)
      // ⚠️ override Content-Type multipart
      const res = await apiClient.post<ContractTemplate>(
        "/management/contracts/templates",
        formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      )
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contract-templates"] }),
  })
}

export function useDeleteContractTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiClient.delete<{ ok: boolean }>(
        `/management/contracts/templates/${id}`,
      )
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contract-templates"] }),
  })
}

// Tải file mẫu: fetch blob (kèm JWT) → tải về máy (mirror useViewContractFile)
export function useDownloadContractTemplate() {
  return useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await apiClient.get(`/management/contracts/templates/${id}/file`, {
        responseType: "blob",
      })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement("a")
      a.href = url
      a.download = name || `mau-hop-dong-${id}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    onError: () => toast.error("Không tải được file mẫu — thử lại hoặc kiểm tra quyền."),
  })
}
