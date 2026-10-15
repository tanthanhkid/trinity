"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { KanbanCardActivity } from "@/types/kanban"

const ACTIVITIES_KEY = "kanban-card-activities"

export function useKanbanCardActivities(cardId: number | null) {
  return useQuery<KanbanCardActivity[]>({
    queryKey: [ACTIVITIES_KEY, cardId],
    queryFn: async () => {
      const res = await apiClient.get<KanbanCardActivity[]>(`/kanban/cards/${cardId}/activities`)
      return Array.isArray(res.data) ? res.data : []
    },
    enabled: cardId != null,
    staleTime: 5_000,
  })
}

export function useAddKanbanComment(cardId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (content: string) => {
      const res = await apiClient.post<KanbanCardActivity>(`/kanban/cards/${cardId}/comments`, {
        content,
      })
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [ACTIVITIES_KEY, cardId] })
    },
  })
}
