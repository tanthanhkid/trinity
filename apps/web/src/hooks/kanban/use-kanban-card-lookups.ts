"use client"

import { useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import type { KanbanBoardDetail, KanbanCard } from "@/types/kanban"
import { useKanbanBoards } from "./use-kanban-boards"
import { useKanbanUserRoster } from "./use-kanban-user-roster"

/**
 * Tra TÊN cho danh sách card: Board, Trạng thái (cột), Người phụ
 * trách — thay vì in `#id`. Dùng lại cache của `useKanbanBoards` /
 * `useKanbanUserRoster` / chi tiết board (cùng queryKey `kanban-boards`), nên
 * không thêm round-trip khi các màn khác đã nạp. `enabled=false` thì không gọi.
 */
export interface KanbanCardLookups {
  boardName: (boardId: number) => string
  /** Tên cột + cờ "hoàn thành" của cột đó; null khi chưa tra được. */
  column: (boardId: number, columnId: number) => { name: string; isDone: boolean } | null
  assigneeNames: (card: KanbanCard) => string[]
  /** Nhãn (tên + màu) theo id trong `label_defs` của board; null khi chưa tra được. */
  label: (boardId: number, labelId: string) => { name: string; color: string } | null
}

export function useKanbanCardLookups(cards: KanbanCard[], enabled = true): KanbanCardLookups {
  const { data: boards = [] } = useKanbanBoards()
  const { data: roster = [], isLoading: rosterLoading } = useKanbanUserRoster()

  const boardIds = useMemo(
    () => (enabled ? Array.from(new Set(cards.map((c) => c.board_id))).sort((a, b) => a - b) : []),
    [cards, enabled],
  )
  const details = useQueries({
    queries: boardIds.map((id) => ({
      queryKey: ["kanban-boards", id],
      queryFn: async () => (await apiClient.get<KanbanBoardDetail>(`/kanban/boards/${id}`)).data,
      staleTime: 15_000,
    })),
  })

  return useMemo(() => {
    const boardMap = new Map(boards.map((b) => [b.id, b.name]))
    const userMap = new Map(roster.map((u) => [u.id, u.full_name]))
    const columnMap = new Map<string, { name: string; isDone: boolean }>()
    const labelMap = new Map<string, { name: string; color: string }>()
    for (const d of details) {
      for (const l of d.data?.label_defs ?? []) {
        labelMap.set(`${d.data?.id}:${l.id}`, { name: l.name, color: l.color })
      }
      for (const col of d.data?.columns ?? []) {
        columnMap.set(`${col.board_id}:${col.id}`, { name: col.name, isDone: col.is_done })
      }
    }
    return {
      boardName: (id) => boardMap.get(id) ?? `Bảng #${id}`,
      column: (b, c) => columnMap.get(`${b}:${c}`) ?? null,
      label: (b, id) => labelMap.get(`${b}:${id}`) ?? null,
      assigneeNames: (card) => {
        const ids = card.assignee_ids?.length
          ? card.assignee_ids
          : card.assignee_id != null
            ? [card.assignee_id]
            : []
        return ids.map((id) => userMap.get(id) ?? (rosterLoading ? "…" : `Người dùng #${id}`))
      },
    }
  }, [boards, roster, rosterLoading, details])
}
