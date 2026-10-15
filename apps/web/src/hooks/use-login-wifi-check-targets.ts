import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export const LOGIN_WIFI_CHECK_TARGETS_QUERY_KEY = [
  "auth",
  "settings",
  "login-wifi-check-targets",
] as const
export const LOGIN_WIFI_CHECK_ROSTER_QUERY_KEY = [
  "auth",
  "settings",
  "login-wifi-check-targets",
  "roster",
] as const

export type LoginWifiCheckScopeType = "department" | "team" | "user"

export interface LoginWifiCheckTargetItem {
  scope_type: LoginWifiCheckScopeType
  target_user_id: number
}

export interface LoginWifiCheckTargetView extends LoginWifiCheckTargetItem {
  id: number
  target_name: string | null
  target_email: string | null
  target_active: boolean
}

export interface LoginWifiCheckRosterUser {
  id: number
  full_name: string | null
  email: string
  /** Tên các vai trò đang giữ (động, do admin tạo). */
  roles: string[]
  manager_id: number | null
}

/**
 * danh sách ÁP DỤNG (opt-in enforcement) cho kiểm tra wifi khi
 * đăng nhập. Cả 2 hook ĐỌC cần quyền `settings.integrations` (403 nếu thiếu, gate
 * ở BE) — component gọi hook này PHẢI tự đảm bảo chỉ render cho user có quyền
 * đó (mirror `SettingsLoginWifiCheck`, tab Settings ẩn hoàn toàn khi thiếu quyền).
 */
export function useLoginWifiCheckTargets(enabled: boolean) {
  return useQuery({
    queryKey: LOGIN_WIFI_CHECK_TARGETS_QUERY_KEY,
    queryFn: async () =>
      (
        await apiClient.get<LoginWifiCheckTargetView[]>(
          "/auth/settings/login-wifi-check-targets",
        )
      ).data,
    staleTime: 30_000,
    enabled,
  })
}

export function useLoginWifiCheckRoster(enabled: boolean) {
  return useQuery({
    queryKey: LOGIN_WIFI_CHECK_ROSTER_QUERY_KEY,
    queryFn: async () =>
      (
        await apiClient.get<LoginWifiCheckRosterUser[]>(
          "/auth/settings/login-wifi-check-targets/roster",
        )
      ).data,
    staleTime: 60_000,
    enabled,
  })
}

/** Thay TOÀN BỘ danh sách — mảng rỗng = xoá sạch (không ai bị áp dụng). */
export function useReplaceLoginWifiCheckTargets() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (items: LoginWifiCheckTargetItem[]) =>
      (
        await apiClient.put<LoginWifiCheckTargetView[]>(
          "/auth/settings/login-wifi-check-targets",
          { items },
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LOGIN_WIFI_CHECK_TARGETS_QUERY_KEY })
    },
  })
}
