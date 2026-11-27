import type { InfiniteData, QueryClient } from "@tanstack/react-query"
import apiClient from "./api-client"
import type { KanbanBoard, KanbanBoardDetail, ListKanbanCardsResult } from "@/types/kanban"

/**
 * `GET /kanban/overview`: máy chủ gộp `boards` + chi tiết board đầu + trang đầu thẻ MỖI CỘT + roster tối giản thành một lượt
 * (trước đây `boards` → `boards/{id}` + `users` → từng `cards?column_id=` là ba đợt nối tiếp qua mạng).
 *
 * Không đổi component: kết quả được GHI THẲNG vào cache react-query dưới đúng khoá mà các hook cũ đọc, nên chúng thấy dữ liệu
 * mới và không gọi lại trong `staleTime`. Trang tiếp theo vẫn do `fetchNextPage` gọi `cards?cursor=` như cũ.
 * Chỉ dùng MỘT lần cho mỗi lần nạp trang (lượt refetch sau đi thẳng `/kanban/boards`); lỗi/thiếu ⇒ `null`, hook rơi về đường cũ.
 */
export const KANBAN_BOARDS_KEY = "kanban-boards"
export const KANBAN_CARDS_KEY = "kanban-cards"
export const KANBAN_ROSTER_KEY = "kanban-user-roster"

interface Overview {
  boards?: unknown
  board?: unknown
  cards?: unknown
  users?: unknown
}

let used = false

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isPage = (v: unknown): v is ListKanbanCardsResult => isObj(v) && Array.isArray(v.cards) && typeof v.has_more === "boolean"

/** Nạp overview và ghi cache; trả danh sách board, hoặc `null` nếu không dùng được. */
export async function loadKanbanOverview(qc: QueryClient): Promise<KanbanBoard[] | null> {
  if (used) return null
  used = true
  try {
    const d = (await apiClient.get<Overview>("/kanban/overview")).data
    if (!isObj(d) || !Array.isArray(d.boards)) return null
    const boards = d.boards as KanbanBoard[]
    const first = boards[0]
    if (first && isObj(d.board) && d.board.id === first.id) {
      qc.setQueryData<KanbanBoardDetail>([KANBAN_BOARDS_KEY, first.id], d.board as unknown as KanbanBoardDetail)
      if (isObj(d.cards)) {
        for (const [col, page] of Object.entries(d.cards)) {
          const id = Number(col)
          if (!Number.isInteger(id) || !isPage(page)) continue
          qc.setQueryData<InfiniteData<ListKanbanCardsResult, number | undefined>>(
            [KANBAN_CARDS_KEY, "column", id, {}],
            { pages: [page], pageParams: [undefined] },
          )
        }
      }
    }
    if (Array.isArray(d.users)) qc.setQueryData([KANBAN_ROSTER_KEY], d.users)
    return boards
  } catch {
    return null
  }
}

/** Chỉ cho test. */
export function resetKanbanOverviewForTests(): void {
  used = false
}
