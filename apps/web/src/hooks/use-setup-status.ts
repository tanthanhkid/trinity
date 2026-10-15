import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { SetupStatus } from "@trinity/rbac"
import apiClient from "@/lib/api-client"

/** Phản hồi `GET /setup/status`. */
export interface SetupStatusPayload {
  status: SetupStatus
  mcp_url: string | null
  /** Có hoạt động AI trong 1 giờ gần đây (Claude/ChatGPT không báo khi bị ngắt nên không thể biết chắc hơn). */
  ai_connected: boolean
  /** Còn quyền đã cấp (chưa thu hồi/hết hạn) dù lâu không dùng. */
  ai_granted?: boolean
  ai_last_active_at?: string | null
  ai_connected_anyone: boolean
  can_build: boolean
}

export const SETUP_STATUS_KEY = ["setup", "status"] as const

/**
 * Trạng thái dựng quy trình. FAIL-OPEN: lỗi mạng/API lỗi ⇒ coi như `da_dung` (không bao giờ khoá nhầm cả công ty vì
 * một lần fetch hỏng — BE cũng coi khoá vắng = `da_dung`). `isLoading` cho cổng chặn route biết còn đang chờ.
 */
export function useSetupStatus() {
  const q = useQuery<SetupStatusPayload>({
    queryKey: SETUP_STATUS_KEY,
    queryFn: async () => (await apiClient.get<SetupStatusPayload>("/setup/status")).data,
    staleTime: 30_000,
    retry: 1,
  })
  return { data: q.data, status: (q.data?.status ?? "da_dung") as SetupStatus, isLoading: q.isLoading, refetch: q.refetch }
}

/** Nút "Hoàn tất" ở màn Bắt đầu (dang_dung → da_dung). */
export function useCompleteSetup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => (await apiClient.post<{ status: SetupStatus }>("/setup/complete")).data,
    onSettled: () => qc.invalidateQueries({ queryKey: SETUP_STATUS_KEY }),
  })
}
