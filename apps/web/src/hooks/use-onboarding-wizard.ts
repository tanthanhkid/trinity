import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export type WizardStepKey = "ai" | "build" | "data" | "channels" | "post"

export interface WizardStep {
  key: WizardStepKey
  done: boolean
  skipped: boolean
  can_skip: boolean
  needs_admin: boolean
}

/** `GET /setup/wizard` — chưa `completed` thì web chỉ hiện wizard, không cho vào ứng dụng. */
export interface WizardView {
  enabled: boolean
  completed: boolean
  current: WizardStepKey | null
  steps: WizardStep[]
}

export interface WizardConfirmResult {
  ok: boolean
  message: string | null
  wizard: WizardView
}

export const WIZARD_KEY = ["setup", "wizard"] as const

export function useWizard() {
  return useQuery<WizardView>({
    queryKey: WIZARD_KEY,
    queryFn: async () => (await apiClient.get<WizardView>("/setup/wizard")).data,
    staleTime: 30_000,
    retry: 1,
  })
}

/** "Tôi đã làm xong" / "Bỏ qua": máy chủ kiểm thật rồi trả trạng thái mới. Không tự ghi `completed` vào cache —
 *  màn hoàn tất để người dùng bấm "Vào Trinity" rồi mới mở ứng dụng (`finishWizard`). */
export function useWizardAction(kind: "confirm" | "skip") {
  return useMutation({
    mutationFn: async (step: WizardStepKey) => (await apiClient.post<WizardConfirmResult>(`/setup/wizard/${kind}`, { step })).data,
  })
}

export function useFinishWizard() {
  const qc = useQueryClient()
  return (w: WizardView) => qc.setQueryData<WizardView>(WIZARD_KEY, { ...w, completed: true })
}
