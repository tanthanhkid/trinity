"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type {
  CreateKanbanChecklistItemPayload,
  KanbanChecklistItem,
  UpdateKanbanChecklistItemPayload,
} from "@/types/kanban"

const CHECKLIST_KEY = "kanban-checklist"
const CARDS_KEY = "kanban-cards"

export function useKanbanChecklist(cardId: number | null) {
  return useQuery<KanbanChecklistItem[]>({
    queryKey: [CHECKLIST_KEY, cardId],
    queryFn: async () => {
      const res = await apiClient.get<KanbanChecklistItem[]>(`/kanban/cards/${cardId}/checklist-items`)
      return Array.isArray(res.data) ? res.data : []
    },
    enabled: cardId != null,
    staleTime: 5_000,
  })
}

function useInvalidateChecklist(cardId: number) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: [CHECKLIST_KEY, cardId] })
    // Badge "x/y" trên card mini-view (board/list) đọc từ query card — phải
    // refetch theo để tiến độ không lệch giữa dialog và board.
    queryClient.invalidateQueries({ queryKey: [CARDS_KEY] })
  }
}

export function useCreateKanbanChecklistItem(cardId: number) {
  const invalidate = useInvalidateChecklist(cardId)
  return useMutation({
    mutationFn: async (payload: CreateKanbanChecklistItemPayload) => {
      const res = await apiClient.post<KanbanChecklistItem>(
        `/kanban/cards/${cardId}/checklist-items`,
        payload,
      )
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useUpdateKanbanChecklistItem(cardId: number) {
  const invalidate = useInvalidateChecklist(cardId)
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateKanbanChecklistItemPayload }) => {
      const res = await apiClient.patch<KanbanChecklistItem>(`/kanban/checklist-items/${id}`, payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteKanbanChecklistItem(cardId: number) {
  const invalidate = useInvalidateChecklist(cardId)
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/kanban/checklist-items/${id}`)
    },
    onSuccess: invalidate,
  })
}
