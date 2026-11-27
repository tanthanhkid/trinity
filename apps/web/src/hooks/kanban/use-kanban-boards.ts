"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { loadKanbanOverview } from "@/lib/kanban-overview"
import type {
  CreateKanbanBoardPayload,
  KanbanBoard,
  KanbanBoardDetail,
  KanbanTemplate,
  UpdateKanbanBoardPayload,
} from "@/types/kanban"

/**
 * Data-layer "Board". Mirror quy ước `hooks/products/use-products.ts`
 * — queryKey mảng, `apiClient` trực tiếp, invalidate theo prefix key.
 */
const BOARDS_KEY = "kanban-boards"

/** `overview` (chỉ trang Kanban): lượt nạp đầu lấy cả board, thẻ từng cột, roster bằng `GET /kanban/overview`. */
export function useKanbanBoards(opts: { overview?: boolean } = {}) {
  const qc = useQueryClient()
  return useQuery<KanbanBoard[]>({
    queryKey: [BOARDS_KEY],
    queryFn: async () => {
      if (opts.overview) {
        const boards = await loadKanbanOverview(qc)
        if (boards) return boards
      }
      const res = await apiClient.get<KanbanBoard[]>("/kanban/boards")
      return Array.isArray(res.data) ? res.data : []
    },
    staleTime: 30_000,
  })
}

export function useKanbanBoardDetail(boardId: number | null) {
  return useQuery<KanbanBoardDetail>({
    queryKey: [BOARDS_KEY, boardId],
    queryFn: async () => {
      const res = await apiClient.get<KanbanBoardDetail>(`/kanban/boards/${boardId}`)
      return res.data
    },
    enabled: boardId != null,
    staleTime: 15_000,
  })
}

export function useKanbanTemplates() {
  return useQuery<KanbanTemplate[]>({
    queryKey: [BOARDS_KEY, "templates"],
    queryFn: async () => {
      const res = await apiClient.get<KanbanTemplate[]>("/kanban/boards/templates")
      return Array.isArray(res.data) ? res.data : []
    },
    staleTime: 60_000,
  })
}

function useInvalidateBoards() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [BOARDS_KEY] })
}

export function useCreateKanbanBoard() {
  const invalidate = useInvalidateBoards()
  return useMutation({
    mutationFn: async (payload: CreateKanbanBoardPayload) => {
      const res = await apiClient.post<KanbanBoard>("/kanban/boards", payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useCreateKanbanBoardFromTemplate() {
  const invalidate = useInvalidateBoards()
  return useMutation({
    mutationFn: async (payload: { template_key: string; name?: string }) => {
      const res = await apiClient.post<KanbanBoardDetail>("/kanban/boards/from-template", payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useUpdateKanbanBoard() {
  const invalidate = useInvalidateBoards()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateKanbanBoardPayload }) => {
      const res = await apiClient.patch<KanbanBoard>(`/kanban/boards/${id}`, payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteKanbanBoard() {
  const invalidate = useInvalidateBoards()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/kanban/boards/${id}`)
    },
    onSuccess: invalidate,
  })
}
