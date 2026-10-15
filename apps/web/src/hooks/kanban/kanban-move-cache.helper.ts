/**
 * Thao tác THUẦN trên cache `useInfiniteQuery` của 1 cột Kanban —
 * dùng cho optimistic update của kéo-thả. KHÔNG phụ thuộc React Query trực
 * tiếp (chỉ thao tác data structure) để dễ test + tái dùng.
 *
 * Best-effort: đây chỉ là hiệu ứng THỊ GIÁC tức thời trong lúc chờ server trả
 * lời — vị trí CHÍNH XÁC cuối cùng luôn đến từ `invalidateQueries` sau khi
 * mutation `onSettled` (kể cả optimistic đoán sai vị trí trong 1 nhịp ngắn,
 * KHÔNG có rủi ro dữ liệu sai vĩnh viễn).
 */
import type { InfiniteData } from "@tanstack/react-query"
import type { KanbanCard, ListKanbanCardsResult, MoveKanbanCardPayload } from "@/types/kanban"

export type KanbanColumnPages = InfiniteData<ListKanbanCardsResult>

/** Xoá card khỏi bất kỳ trang nào của cache cột (nếu có mặt) — dừng ở trang
 * ĐẦU TIÊN tìm thấy (1 card chỉ có thể ở đúng 1 cột/1 trang tại 1 thời điểm). */
export function removeCardFromColumnPages(
  data: KanbanColumnPages,
  cardId: number,
): { removed: KanbanCard | null; next: KanbanColumnPages } {
  let removed: KanbanCard | null = null
  const pages = data.pages.map((page) => {
    if (removed || !page.cards.some((c) => c.id === cardId)) return page
    const idx = page.cards.findIndex((c) => c.id === cardId)
    removed = page.cards[idx]
    const cards = page.cards.slice(0, idx).concat(page.cards.slice(idx + 1))
    return { ...page, cards }
  })
  return { removed, next: removed ? { ...data, pages } : data }
}

/**
 * Chèn card vào trang ĐẦU của cache cột đích theo `before_card_id`/`after_card_id`
 * — best-effort, không tìm thấy neighbor (chưa tải trang chứa nó) thì chèn ở
 * ĐẦU danh sách thay vì rớt mất card khỏi màn hình.
 */
export function insertCardIntoColumnPages(
  data: KanbanColumnPages,
  card: KanbanCard,
  payload: Pick<MoveKanbanCardPayload, "before_card_id" | "after_card_id">,
  targetColumnId: number,
): KanbanColumnPages {
  if (data.pages.length === 0) return data
  const moved: KanbanCard = { ...card, column_id: targetColumnId }
  const [firstPage, ...restPages] = data.pages
  const cards = [...firstPage.cards]
  let insertIndex: number
  if (payload.after_card_id != null) {
    const idx = cards.findIndex((c) => c.id === payload.after_card_id)
    insertIndex = idx === -1 ? 0 : idx
  } else if (payload.before_card_id != null) {
    const idx = cards.findIndex((c) => c.id === payload.before_card_id)
    insertIndex = idx === -1 ? cards.length : idx + 1
  } else {
    insertIndex = cards.length
  }
  cards.splice(insertIndex, 0, moved)
  return { ...data, pages: [{ ...firstPage, cards }, ...restPages] }
}
