"use client"

import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"

const PINNED_MENU_QUERY_KEY = ["users", "me", "pinned-menu"] as const

/** Tối đa 5 mục ghim ở UX — BE cho phép nhiều hơn
 *  (trần kỹ thuật chống payload rác), gate thao tác thật nằm ở đây. */
const MAX_PINS = 5

/**
 * Mặc định khi user CHƯA từng tuỳ chỉnh (chưa ghim gì → ghim sẵn bộ
 * mặc định). RBAC quyền + phạm vi: KHÔNG còn mặc định theo vai trò
 * cứng — mọi user dùng chung 1 bộ, mục nào user không đủ quyền thấy sẽ bị
 * `isItemVisible`/`isChildVisible` lọc lại trước khi render (không lộ gì).
 */
const DEFAULT_PINS = ["contacts", "reports", "kanban"]

export function getDefaultPinnedKeys(): string[] {
  return [...DEFAULT_PINS]
}

interface PinnedMenuResponse {
  keys: string[]
}

function isPinnedMenuResponse(body: unknown): body is PinnedMenuResponse {
  if (!body || typeof body !== "object") return false
  const keys = (body as { keys?: unknown }).keys
  return Array.isArray(keys) && keys.every((k) => typeof k === "string")
}

/**
 * Ghim menu sidebar. `pinnedKeys` LUÔN là danh sách hiệu lực để
 * render (đã fallback về mặc định chung khi user chưa tuỳ chỉnh) — KHÔNG
 * phải giá trị thô từ BE.
 */
export function usePinnedMenus() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: PINNED_MENU_QUERY_KEY,
    queryFn: async () => {
      const res = await apiClient.get<unknown>("/users/me/pinned-menu")
      // Shape lạ PHẢI throw để giữ cache cũ,
      // KHÔNG trả rỗng "thành công" (rỗng thành công sẽ ghi đè ghim đang tốt).
      if (!isPinnedMenuResponse(res.data)) {
        throw new Error("pinned-menu: body không đúng shape")
      }
      return res.data
    },
    staleTime: 60_000,
  })

  const customized = query.data?.keys ?? []
  const pinnedKeys = useMemo(
    () => (customized.length > 0 ? customized : getDefaultPinnedKeys()),
    [customized],
  )

  const mutation = useMutation({
    mutationFn: async (keys: string[]) =>
      (await apiClient.put<PinnedMenuResponse>("/users/me/pinned-menu", { keys })).data,
    onSuccess: (data) => {
      queryClient.setQueryData(PINNED_MENU_QUERY_KEY, data)
    },
    onError: () => {
      toast.error("Không lưu được mục ghim, thử lại sau.")
    },
  })

  const togglePin = (key: string) => {
    const current = customized.length > 0 ? customized : getDefaultPinnedKeys()
    if (current.includes(key)) {
      mutation.mutate(current.filter((k) => k !== key))
      return
    }
    if (current.length >= MAX_PINS) {
      toast.info(`Chỉ ghim tối đa ${MAX_PINS} mục — bỏ ghim bớt để ghim thêm.`)
      return
    }
    mutation.mutate([...current, key])
  }

  return {
    pinnedKeys,
    isPinned: (key: string) => pinnedKeys.includes(key),
    togglePin,
    atLimit: pinnedKeys.length >= MAX_PINS,
    isLoading: query.isLoading,
  }
}
