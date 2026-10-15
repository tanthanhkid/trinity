import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export const LOGIN_WIFI_CHECK_QUERY_KEY = ["auth", "settings", "login-wifi-check"] as const

export interface LoginWifiCheckConfig {
  enabled: boolean
  /** true nếu env `LOGIN_WIFI_CHECK_ENABLED=true` đang ép bật bất kể toggle này. */
  envForced: boolean
}

/**
 * công tắc "Kiểm tra IP văn phòng khi
 * đăng nhập". ĐỌC rộng (mọi role — hiển thị trạng thái cho minh bạch), mặc
 * định OFF khi chưa cấu hình.
 */
export function useLoginWifiCheckConfig() {
  return useQuery({
    queryKey: LOGIN_WIFI_CHECK_QUERY_KEY,
    queryFn: async () =>
      (await apiClient.get<LoginWifiCheckConfig>("/auth/settings/login-wifi-check")).data,
    staleTime: 60_000,
  })
}

/** GHI — chỉ super_admin (403 nếu role khác gọi, gate ở BE). */
export function useUpdateLoginWifiCheckConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      (
        await apiClient.patch<{ enabled: boolean }>("/auth/settings/login-wifi-check", {
          enabled,
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LOGIN_WIFI_CHECK_QUERY_KEY })
    },
  })
}
