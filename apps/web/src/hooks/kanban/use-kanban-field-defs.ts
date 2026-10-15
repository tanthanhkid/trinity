"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  CreateKanbanFieldDefPayload,
  KanbanFieldDef,
  UpdateKanbanFieldDefPayload,
} from "@/types/kanban"

const BOARDS_KEY = "kanban-boards"

function useInvalidateBoard(boardId: number) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [BOARDS_KEY, boardId] })
}

export function useCreateKanbanFieldDef(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async (payload: CreateKanbanFieldDefPayload) => {
      const res = await apiClient.post<KanbanFieldDef>(
        `/kanban/boards/${boardId}/field-defs`,
        payload,
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useUpdateKanbanFieldDef(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateKanbanFieldDefPayload }) => {
      const res = await apiClient.patch<KanbanFieldDef>(`/kanban/field-defs/${id}`, payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useReorderKanbanFieldDefs(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async (fieldDefIds: number[]) => {
      const res = await apiClient.post<KanbanFieldDef[]>(
        `/kanban/boards/${boardId}/field-defs/reorder`,
        { field_def_ids: fieldDefIds },
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteKanbanFieldDef(boardId: number) {
  const invalidate = useInvalidateBoard(boardId)
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/kanban/field-defs/${id}`)
    },
    onSuccess: invalidate,
  })
}
