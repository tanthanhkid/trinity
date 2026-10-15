import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"

export type ComponentType = "allowance" | "bonus" | "deduction"
export type CalcMethod = "fixed" | "percent_base"

export interface SalaryComponent {
  id: number
  name: string
  code: string
  component_type: ComponentType
  calc_method: CalcMethod
  fixed_amount: number | null
  percent_value: number | string | null
  applies_to: string
  effective_from: string
  effective_to: string | null
  is_active: boolean
  sort_order: number
  description: string | null
  created_at: string
}

export interface SalaryComponentPayload {
  name: string
  code: string
  component_type: ComponentType
  calc_method: CalcMethod
  fixed_amount?: number
  percent_value?: number
  applies_to?: string
  effective_from: string
  effective_to?: string | null
  is_active?: boolean
  sort_order?: number
  description?: string
}

const QUERY_KEY = ["salary-components"]

export function useSalaryComponents() {
  return useQuery<SalaryComponent[]>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await apiClient.get<SalaryComponent[]>("/salary-components")
      return res.data
    },
    staleTime: 60_000,
  })
}

export function useCreateSalaryComponent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: SalaryComponentPayload) => {
      const res = await apiClient.post<SalaryComponent>("/salary-components", payload)
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useUpdateSalaryComponent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: Partial<SalaryComponentPayload> }) => {
      const res = await apiClient.patch<SalaryComponent>(`/salary-components/${id}`, payload)
      return res.data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useDeleteSalaryComponent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/salary-components/${id}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export { getApiErrorMessage }
