"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  CreateKanbanColumnPayload,
  KanbanColumn,
  UpdateKanbanColumnPayload,
} from "@/types/kanban"

const BOARDS_KEY = "kanban-boards"

function useInvalidateBoard(boardId: number) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [BOARDS_KEY, boardId] })
}

export function useCreateKanbanColumn(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async (payload: CreateKanbanColumnPayload) => {
      const res = await apiClient.post<KanbanColumn>(
        `/kanban/boards/${boardId}/columns`,
        payload,
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useUpdateKanbanColumn(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateKanbanColumnPayload }) => {
      const res = await apiClient.patch<KanbanColumn>(`/kanban/columns/${id}`, payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useReorderKanbanColumns(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async (columnIds: number[]) => {
      const res = await apiClient.post<KanbanColumn[]>(
        `/kanban/boards/${boardId}/columns/reorder`,
        { column_ids: columnIds },
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteKanbanColumn(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async ({ id, moveToColumnId }: { id: number; moveToColumnId?: number }) => {
      const qs = moveToColumnId != null ? `?move_to_column_id=${moveToColumnId}` : ""
      const res = await apiClient.delete(`/kanban/columns/${id}${qs}`)
      return res.data as { deleted: boolean; moved_cards: number }
    },
    onSuccess: invalidate,
  })
}
