import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { ZaloOaMessage, ZaloOaStatus, ZaloOaThread } from "./zalo-oa-types"
import { pollUnlessChannelOff } from "@/lib/channel-off"
import { inboxPollMs } from "@/lib/realtime-mode"

const KEYS = {
  status: ["zalo-oa", "status"] as const,
  threads: ["zalo-oa", "threads"] as const,
  messages: (id: number) => ["zalo-oa", "messages", id] as const,
}

// Mọi query THROW khi lỗi để UI phân biệt "lỗi tải" với "trống".
export function useZaloOaStatus() {
  return useQuery<ZaloOaStatus>({
    queryKey: KEYS.status,
    queryFn: async () => (await apiClient.get<ZaloOaStatus>("/zalo-oa/status")).data,
    staleTime: 30_000,
  })
}

export function useConnectZaloOa() {
  return useMutation({ mutationFn: async () => (await apiClient.post<{ authorize_url: string }>("/zalo-oa/connect")).data.authorize_url })
}

export function useDisconnectZaloOa() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => apiClient.delete("/zalo-oa/connection"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["zalo-oa"] }),
  })
}

export function useSendZns() {
  return useMutation({
    mutationFn: async (b: { phone: string; template_id: string; template_data: Record<string, string> }) =>
      (await apiClient.post<{ message_id: string | null }>("/zalo-oa/zns", b)).data,
  })
}

/** Phân trang cursor — component PHẢI gọi `fetchNextPage()`. */
export function useZaloOaThreads(q: string, enabled: boolean) {
  return useInfiniteQuery<{ data: ZaloOaThread[]; meta: { next_cursor: number | null } }>({
    queryKey: [...KEYS.threads, q],
    enabled,
    refetchInterval: pollUnlessChannelOff(inboxPollMs("list", 15_000)),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { limit: 30 }
      if (q) params.q = q
      if (typeof pageParam === "number") params.cursor = pageParam
      return (await apiClient.get("/zalo-oa/threads", { params })).data
    },
  })
}

export function useZaloOaMessages(threadId: number | null) {
  return useQuery<ZaloOaMessage[]>({
    queryKey: KEYS.messages(threadId ?? 0),
    enabled: threadId !== null,
    refetchInterval: inboxPollMs("thread", 8_000),
    queryFn: async () => (await apiClient.get<{ data: ZaloOaMessage[] }>(`/zalo-oa/threads/${threadId}/messages`, { params: { limit: 100 } })).data.data,
  })
}

export function useReplyZaloOa(threadId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (text: string) => (await apiClient.post(`/zalo-oa/threads/${threadId}/messages`, { text })).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ["zalo-oa"] }),
  })
}

export function useMarkReadZaloOa() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => apiClient.post(`/zalo-oa/threads/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.threads }),
  })
}
