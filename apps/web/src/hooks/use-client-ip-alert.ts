"use client"

import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { fromBootstrap } from "@/lib/bootstrap"

/** Cảnh báo máy chủ không xác định được IP thật của người dùng (TRUSTED_PROXY). Chỉ quản trị viên nhận câu cảnh báo. */
export function useClientIpAlert() {
  return useQuery<{ warning: string | null }>({
    queryKey: ["settings", "client-ip", "alerts"],
    queryFn: () =>
      fromBootstrap("client_ip_alerts", async () => (await apiClient.get<{ warning: string | null }>("/settings/client-ip/alerts")).data),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  })
}
