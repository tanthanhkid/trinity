import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { AiConnection } from "./integrations-meta"

export const AI_CONNECTIONS_KEY = ["integrations", "ai-connections"] as const

/** Kết nối AI của mình (`all=false`) hoặc của mọi người (`all=true`, cần ai_admin). Lỗi → throw. */
export function useAiConnections(all: boolean, enabled: boolean) {
  return useQuery<AiConnection[]>({
    queryKey: [...AI_CONNECTIONS_KEY, all ? "all" : "mine"],
    enabled,
    queryFn: async () => (await apiClient.get<{ data: AiConnection[] }>("/integrations/ai-connections", { params: all ? { scope: "all" } : undefined })).data.data,
  })
}

/** Thu hồi cả chuỗi token — token chết ngay ở lời gọi MCP kế tiếp. */
export function useRevokeAiConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/integrations/ai-connections/${id}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_CONNECTIONS_KEY }),
  })
}
