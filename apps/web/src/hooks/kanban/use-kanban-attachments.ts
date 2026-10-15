"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { CreateKanbanAttachmentPayload, KanbanCardAttachment } from "@/types/kanban"

const ATTACHMENTS_KEY = "kanban-attachments"
const CARDS_KEY = "kanban-cards"

export function useKanbanAttachments(cardId: number | null) {
  return useQuery<KanbanCardAttachment[]>({
    queryKey: [ATTACHMENTS_KEY, cardId],
    queryFn: async () => {
      const res = await apiClient.get<KanbanCardAttachment[]>(`/kanban/cards/${cardId}/attachments`)
      return Array.isArray(res.data) ? res.data : []
    },
    enabled: cardId != null,
    staleTime: 5_000,
  })
}

function useInvalidateAttachments(cardId: number) {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: [ATTACHMENTS_KEY, cardId] })
    queryClient.invalidateQueries({ queryKey: [CARDS_KEY] })
  }
}

export function useCreateKanbanAttachment(cardId: number) {
  const invalidate = useInvalidateAttachments(cardId)
  return useMutation({
    mutationFn: async (payload: CreateKanbanAttachmentPayload) => {
      const res = await apiClient.post<KanbanCardAttachment>(`/kanban/cards/${cardId}/attachments`, payload)
      return res.data
    },
    onSuccess: invalidate,
  })
}

export function useDeleteKanbanAttachment(cardId: number) {
  const invalidate = useInvalidateAttachments(cardId)
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/kanban/attachments/${id}`)
    },
    onSuccess: invalidate,
  })
}
