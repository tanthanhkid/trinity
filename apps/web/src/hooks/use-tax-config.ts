import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"

export interface TaxBracket {
  id: number
  bracket_order: number
  lower_bound: number | string
  upper_bound: number | string | null
  rate: number | string
  effective_from: string
  effective_to: string | null
  is_active: boolean
}
export interface TaxSetting {
  id: number
  personal_deduction: number | string
  dependent_deduction: number | string
  effective_from: string
  effective_to: string | null
  is_active: boolean
}
export interface TaxConfig {
  brackets: TaxBracket[]
  settings: TaxSetting[]
}

const KEY = ["tax-config"]

export function useTaxConfig() {
  return useQuery<TaxConfig>({
    queryKey: KEY,
    queryFn: async () => (await apiClient.get<TaxConfig>("/tax-config")).data,
    staleTime: 60_000,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: KEY })
}

export function useUpdateBracket() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: Record<string, unknown> }) =>
      (await apiClient.patch(`/tax-config/brackets/${id}`, payload)).data,
    onSuccess: inv,
  })
}
export function useCreateBracket() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      (await apiClient.post(`/tax-config/brackets`, payload)).data,
    onSuccess: inv,
  })
}
export function useDeleteBracket() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async (id: number) => { await apiClient.delete(`/tax-config/brackets/${id}`) },
    onSuccess: inv,
  })
}
export function useUpdateTaxSetting() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: Record<string, unknown> }) =>
      (await apiClient.patch(`/tax-config/settings/${id}`, payload)).data,
    onSuccess: inv,
  })
}
export function useCreateTaxSetting() {
  const inv = useInvalidate()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      (await apiClient.post(`/tax-config/settings`, payload)).data,
    onSuccess: inv,
  })
}

export { getApiErrorMessage }
