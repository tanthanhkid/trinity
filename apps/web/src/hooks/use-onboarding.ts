import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

/** Phản hồi `GET /setup/onboarding` — dấu "xong" theo dữ liệu thật của công ty; `ai_connected` là của người đang xem. */
export interface OnboardingProgress {
  seen: boolean
  ai_connected: boolean
  workspace_built: boolean
  has_data: boolean
  channel_linked: boolean
  first_post: boolean
}

export const ONBOARDING_KEY = ["setup", "onboarding"] as const

export function useOnboarding(enabled = true) {
  return useQuery<OnboardingProgress>({
    queryKey: ONBOARDING_KEY,
    queryFn: async () => (await apiClient.get<OnboardingProgress>("/setup/onboarding")).data,
    staleTime: 30_000,
    retry: 1,
    enabled,
  })
}

/** Lần đầu mở màn Bắt đầu ⇒ ghi đã xem, lần đăng nhập sau không tự mở nữa (vẫn mở lại được từ menu). */
export function useMarkOnboardingSeen() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => (await apiClient.post<{ seen: boolean }>("/setup/onboarding/seen")).data,
    onSuccess: () => qc.setQueryData<OnboardingProgress>(ONBOARDING_KEY, (old) => (old ? { ...old, seen: true } : old)),
  })
}
