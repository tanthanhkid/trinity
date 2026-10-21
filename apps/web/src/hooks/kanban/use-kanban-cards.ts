"use client"

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { toast } from "sonner"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { toastWithUndo } from "@/lib/undo"
import type {
  CreateKanbanCardPayload,
  KanbanCard,
  ListKanbanCardsResult,
  MoveKanbanCardPayload,
  MoveKanbanCardResult,
  QueryKanbanCardsParams,
  UpdateKanbanCardPayload,
} from "@/types/kanban"
import {
  insertCardIntoColumnPages,
  removeCardFromColumnPages,
  type KanbanColumnPages,
} from "./kanban-move-cache.helper"

const CARDS_KEY = "kanban-cards"

function buildQuery(params: QueryKanbanCardsParams & { cursor?: number }): string {
  const q = new URLSearchParams()
  if (params.board_id != null) q.set("board_id", String(params.board_id))
  if (params.column_id != null) q.set("column_id", String(params.column_id))
  if (params.contact_id != null) q.set("contact_id", String(params.contact_id))
  if (params.assignee_id != null) q.set("assignee_id", String(params.assignee_id))
  if (params.label) q.set("label", params.label)
  if (params.overdue != null) q.set("overdue", String(params.overdue))
  if (params.search) q.set("search", params.search)
  if (params.cursor != null) q.set("cursor", String(params.cursor))
  if (params.limit != null) q.set("limit", String(params.limit))
  return q.toString()
}

/**
 * Card theo CỘT — cursor phân trang + "tải thêm" (máy
 * cấu hình thấp, không kéo toàn bộ card 1 lần). UI PHẢI có nút gọi
 * `fetchNextPage()` — xem `kanban-column.tsx`.
 */
export function useKanbanCardsByColumn(
  boardId: number,
  columnId: number,
  filters: Omit<QueryKanbanCardsParams, "board_id" | "column_id" | "cursor"> = {},
) {
  return useInfiniteQuery<ListKanbanCardsResult>({
    queryKey: [CARDS_KEY, "column", columnId, filters],
    enabled: boardId > 0 && columnId > 0,
    queryFn: async ({ pageParam }) => {
      const qs = buildQuery({ ...filters, board_id: boardId, column_id: columnId, cursor: pageParam as number | undefined })
      const res = await apiClient.get<ListKanbanCardsResult>(`/kanban/cards?${qs}`)
      return res.data
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor ?? undefined : undefined),
    staleTime: 15_000,
  })
}

/** Danh sách card TOÀN board (dạng Bảng/List view — không tách theo cột). */
export function useKanbanCardsByBoard(
  boardId: number,
  filters: Omit<QueryKanbanCardsParams, "board_id" | "column_id" | "cursor"> = {},
) {
  return useInfiniteQuery<ListKanbanCardsResult>({
    queryKey: [CARDS_KEY, "board", boardId, filters],
    // boardId chưa chọn (0 — boards đang tải) → KHÔNG gọi: BE trả 400 với board_id=0.
    enabled: boardId > 0,
    queryFn: async ({ pageParam }) => {
      const qs = buildQuery({ ...filters, board_id: boardId, cursor: pageParam as number | undefined, limit: 30 })
      const res = await apiClient.get<ListKanbanCardsResult>(`/kanban/cards?${qs}`)
      return res.data
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor ?? undefined : undefined),
    staleTime: 15_000,
  })
}

/** Card gắn 1 khách hàng — dùng cho tab "Công việc" ở chi tiết Danh bạ. */
export function useKanbanCardsByContact(contactId: number) {
  return useInfiniteQuery<ListKanbanCardsResult>({
    queryKey: [CARDS_KEY, "contact", contactId],
    queryFn: async ({ pageParam }) => {
      const qs = buildQuery({ contact_id: contactId, cursor: pageParam as number | undefined, limit: 20 })
      const res = await apiClient.get<ListKanbanCardsResult>(`/kanban/cards?${qs}`)
      return res.data
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor ?? undefined : undefined),
    enabled: contactId != null,
    staleTime: 15_000,
  })
}

export function useKanbanCard(cardId: number | null) {
  return useQuery<KanbanCard>({
    queryKey: [CARDS_KEY, "detail", cardId],
    queryFn: async () => {
      const res = await apiClient.get<KanbanCard>(`/kanban/cards/${cardId}`)
      return res.data
    },
    enabled: cardId != null,
  })
}

function useInvalidateCards() {
  const queryClient = useQueryClient()
  // `deletedId`: bỏ qua query chi tiết của card vừa xoá — hộp thoại còn mở thì refetch sẽ ra 404.
  return (deletedId?: number) => {
    queryClient.invalidateQueries({
      queryKey: [CARDS_KEY],
      predicate: (q) => deletedId == null || !(q.queryKey[1] === "detail" && q.queryKey[2] === deletedId),
    })
    queryClient.invalidateQueries({ queryKey: ["kanban-boards"] })
  }
}

export function useCreateKanbanCard() {
  const invalidate = useInvalidateCards()
  return useMutation({
    mutationFn: async (payload: CreateKanbanCardPayload) => {
      const res = await apiClient.post<KanbanCard>("/kanban/cards", payload)
      return res.data
    },
    onSuccess: () => invalidate(),
  })
}

export function useUpdateKanbanCard() {
  const invalidate = useInvalidateCards()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: UpdateKanbanCardPayload }) => {
      const res = await apiClient.patch<KanbanCard>(`/kanban/cards/${id}`, payload)
      return res.data
    },
    onSuccess: () => invalidate(),
  })
}

/**
 * Kéo-thả — optimistic update: dời card sang cache cột đích NGAY
 * (không đợi round-trip), rollback về snapshot cũ nếu BE từ chối (RBAC/cột
 * ẩn/wip...). Vị trí optimistic là BEST-EFFORT (`insertCardIntoColumnPages`)
 * — `onSettled` LUÔN invalidate để đồng bộ lại vị trí CHÍNH XÁC từ server
 * (kể cả khi optimistic đoán đúng, tránh 2 nguồn sự thật lệch nhau lâu dài).
 */
export function useMoveKanbanCard() {
  const invalidate = useInvalidateCards()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, payload }: { id: number; payload: MoveKanbanCardPayload }) => {
      const res = await apiClient.post<MoveKanbanCardResult>(`/kanban/cards/${id}/move`, payload)
      return res.data
    },
    onMutate: async ({ id, payload }) => {
      await queryClient.cancelQueries({ queryKey: [CARDS_KEY, "column"] })
      const previous = queryClient.getQueriesData<InfiniteData<ListKanbanCardsResult>>({
        queryKey: [CARDS_KEY, "column"],
      })

      let movedCard: KanbanCard | null = null
      for (const [key, data] of previous) {
        if (!data) continue
        const { removed, next } = removeCardFromColumnPages(data as KanbanColumnPages, id)
        if (removed) {
          movedCard = removed
          queryClient.setQueryData(key, next)
          break
        }
      }

      if (movedCard) {
        const targetEntry = previous.find(([key]) => (key as unknown[])[2] === payload.column_id)
        if (targetEntry) {
          const [targetKey] = targetEntry
          const currentTargetData = queryClient.getQueryData<InfiniteData<ListKanbanCardsResult>>(targetKey)
          if (currentTargetData) {
            queryClient.setQueryData(
              targetKey,
              insertCardIntoColumnPages(
                currentTargetData as KanbanColumnPages,
                movedCard,
                payload,
                payload.column_id,
              ),
            )
          }
        }
      }

      return { previous }
    },
    onError: (_err, _vars, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data))
    },
    onSettled: () => invalidate(),
  })
}

/**
 * Xoá card có Hoàn tác phía máy chủ: card biến khỏi cột ngay và lệnh xoá (mềm) gửi luôn;
 * "Hoàn tác" gọi `POST /kanban/cards/:id/restore` (người đã xoá / Quản trị, trong 10 phút).
 * Xoá lỗi hoặc khôi phục ⇒ tải lại cột để card hiện về chỗ cũ.
 */
export function useDeleteKanbanCardWithUndo() {
  const queryClient = useQueryClient()
  const invalidate = useInvalidateCards()
  return (id: number, title?: string) => {
    queryClient.setQueriesData<KanbanColumnPages>({ queryKey: [CARDS_KEY, "column"] }, (d) =>
      d ? removeCardFromColumnPages(d, id).next : d,
    )
    apiClient
      .delete(`/kanban/cards/${id}`)
      .then(() =>
        toastWithUndo({
          message: title ? `Đã xoá card “${title}”` : "Đã xoá card",
          onUndo: () =>
            apiClient
              .post(`/kanban/cards/${id}/restore`)
              .then(() => toast.success("Đã khôi phục card"))
              .catch((err) => toast.error(getApiErrorMessage(err, "Không khôi phục được card")))
              .finally(() => invalidate()),
        }),
      )
      .catch((err) => toast.error(getApiErrorMessage(err, "Không xoá được card")))
      .finally(() => invalidate(id))
  }
}

export function useDeleteKanbanCard() {
  const invalidate = useInvalidateCards()
  return useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/kanban/cards/${id}`)
    },
    onSuccess: (_data, id) => invalidate(id),
  })
}
