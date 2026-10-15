import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"

export interface InsuranceSetting {
  id: number
  name: string
  code: string
  employee_rate: number | string
  base_cap: number | string | null
  effective_from: string
  effective_to: string | null
  is_active: boolean
  sort_order: number
  created_at: string
}

export interface InsuranceSettingPayload {
  name: string
  code: string
  employee_rate: number
  base_cap?: number | null
  effective_from: string
  effective_to?: string | null
  is_active?: boolean
  sort_order?: number
}

const QUERY_KEY = ["insurance-settings"]

export function useInsuranceSettings() {
  return useQuery<InsuranceSetting[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => (await apiClient.get<InsuranceSetting[]>("/insurance-settings")).data,
    staleTime: 60_000,
  })
}

export function useCreateInsuranceSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: InsuranceSettingPayload) =>
      (await apiClient.post<InsuranceSetting>("/insurance-settings", payload)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useUpdateInsuranceSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: Partial<InsuranceSettingPayload> }) =>
      (await apiClient.patch<InsuranceSetting>(`/insurance-settings/${id}`, payload)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useDeleteInsuranceSetting() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => { await apiClient.delete(`/insurance-settings/${id}`) },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export { getApiErrorMessage }
