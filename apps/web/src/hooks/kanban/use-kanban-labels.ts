"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  CreateKanbanLabelPayload,
  KanbanLabelListResult,
  UpdateKanbanLabelPayload,
} from "@/types/kanban"

/**
 * Nhãn màu board — mở cho MỌI role thấy board (KHÔNG riêng
 * super_admin), mirror gate BE `KanbanBoardsService.assertBoardVisible`.
 * Invalidate `["kanban-boards", boardId]` — cùng key `useKanbanBoardDetail`
 * đang giữ `label_defs`.
 */
const BOARDS_KEY = "kanban-boards"

function useInvalidateBoard(boardId: number) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [BOARDS_KEY, boardId] })
}

export function useCreateKanbanLabel(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async (payload: CreateKanbanLabelPayload) => {
      const res = await apiClient.post<KanbanLabelListResult>(
        `/kanban/boards/${boardId}/labels`,
        payload,
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useUpdateKanbanLabel(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: UpdateKanbanLabelPayload }) => {
      const res = await apiClient.patch<KanbanLabelListResult>(
        `/kanban/boards/${boardId}/labels/${id}`,
        payload,
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteKanbanLabel(boardId: number) {
  const invalidateBoard = useInvalidateBoard(boardId)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiClient.delete<KanbanLabelListResult>(
        `/kanban/boards/${boardId}/labels/${id}`,
      )
      return res.data
    },
    onSuccess: () => {
      invalidateBoard()
      // Xoá nhãn cũng tự dọn id đó khỏi MỌI card ở BE (`array_remove`) — card
      // đang cache FE vẫn giữ id cũ tới khi query card refetch.
      queryClient.invalidateQueries({ queryKey: ["kanban-cards"] })
    },
  })
}
