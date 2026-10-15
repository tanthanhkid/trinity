"use client"

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { AiAction, AiActionPage } from "@/lib/ai-actions"

const BASE = "/integrations/ai-actions"
export const AI_ACTIONS_KEY = ["integrations", "ai-actions"] as const

/** Lịch sử hoạt động AI CỦA MÌNH ('pending' = chỉ chờ duyệt, 'done' = tất cả) (BE chỉ trả của chính người đăng nhập). Lỗi → throw. Phân trang: component PHẢI gọi `fetchNextPage()`. */
export function useAiActions(status: "pending" | "done", enabled = true) {
  return useInfiniteQuery<AiActionPage>({
    queryKey: [...AI_ACTIONS_KEY, "list", status],
    enabled,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { limit: 20 }
      if (status === "pending") params.status = "pending"
      if (typeof pageParam === "number") params.cursor = pageParam
      const res = await apiClient.get<AiActionPage>(BASE, { params })
      return { data: Array.isArray(res.data?.data) ? res.data.data : [], next_cursor: res.data?.next_cursor ?? null }
    },
  })
}

/** Một đề xuất theo id (mở thẳng từ link `?id=` / thông báo, kể cả khi không nằm ở trang đầu). */
export function useAiAction(id: number | null) {
  return useQuery<AiAction>({
    queryKey: [...AI_ACTIONS_KEY, "one", id],
    enabled: id !== null,
    retry: false,
    // `executing` (đã nhận duyệt, chưa có kết quả) — tự làm mới tới khi xong.
    refetchInterval: (q) => (q.state.data?.status === "executing" ? 3000 : false),
    queryFn: async () => (await apiClient.get<AiAction>(`${BASE}/${id}`)).data,
  })
}

/** Cài đặt "Yêu cầu duyệt thay đổi do AI" (mặc định TẮT = AI ghi thẳng). Mọi người đăng nhập đọc được; chỉ quản trị đổi. */
export function useAiActionSettings(enabled = true) {
  return useQuery<{ require_approval: boolean }>({
    queryKey: [...AI_ACTIONS_KEY, "settings"],
    enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => ({ require_approval: (await apiClient.get<{ require_approval?: boolean }>(`${BASE}/settings`)).data?.require_approval === true }),
  })
}

export function useUpdateAiActionSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (require_approval: boolean) => (await apiClient.patch<{ require_approval: boolean }>(`${BASE}/settings`, { require_approval })).data,
    onSettled: () => { void qc.invalidateQueries({ queryKey: AI_ACTIONS_KEY }) },
  })
}

/** Số đề xuất đang chờ mình duyệt (badge). 404 (tính năng tắt) / lỗi ⇒ query lỗi ⇒ UI không hiện badge. */
export function useAiActionsPendingCount(enabled = true) {
  return useQuery<number>({
    queryKey: [...AI_ACTIONS_KEY, "pending-count"],
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const n = (await apiClient.get<{ pending?: number }>(`${BASE}/pending-count`)).data?.pending
      return typeof n === "number" && n > 0 ? n : 0
    },
  })
}

function useDecision(verb: "approve" | "reject") {
  const qc = useQueryClient()
  return useMutation({
    // duyệt đổi cấu trúc ảnh hưởng dữ liệu cần `confirm_text` = tên bảng gõ lại.
    mutationFn: async (arg: number | { id: number; confirmText?: string }) => {
      const id = typeof arg === "number" ? arg : arg.id
      const confirm = typeof arg === "number" || verb === "reject" ? undefined : arg.confirmText
      const url = `${BASE}/${id}/${verb}`
      return (await (confirm === undefined ? apiClient.post<AiAction>(url) : apiClient.post<AiAction>(url, { confirm_text: confirm }))).data
    },
    // Thành công HAY lỗi (409 đã xử lý, 403 mất quyền…) trạng thái ở BE đều có thể đã đổi ⇒ luôn tải lại.
    // Đề xuất dựng/đổi cấu trúc đổi cả menu, tính năng, trạng thái dựng ⇒ tải lại các khoá đó luôn.
    // KHÔNG trả Promise: react-query chờ nó xong mới gọi `onSuccess` của lời gọi `mutate` (đóng popup) và giữ `isPending` ⇒
    // làm mới chậm/treo là popup đứng im, nút khoá. Làm mới chạy nền.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: AI_ACTIONS_KEY })
      void qc.invalidateQueries({ queryKey: ["setup"] })
      void qc.invalidateQueries({ queryKey: ["settings", "org-features"] })
      void qc.invalidateQueries({ queryKey: ["custom-objects"] })
    },
  })
}

/** Duyệt = BE chạy thao tác thật bằng quyền của CHÍNH mình. */
export const useApproveAiAction = () => useDecision("approve")
export const useRejectAiAction = () => useDecision("reject")
