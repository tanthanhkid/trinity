import { describe, expect, it } from "vitest"
import {
  insertCardIntoColumnPages,
  removeCardFromColumnPages,
  type KanbanColumnPages,
} from "@/hooks/kanban/kanban-move-cache.helper"
import type { KanbanCard } from "@/types/kanban"

function card(id: number, column_id: number): KanbanCard {
  return {
    id,
    board_id: 1,
    column_id,
    position: id * 1000,
    title: `Card ${id}`,
    description: null,
    contact_id: null,
    assignee_id: null,
    assignee_ids: [],
    created_by: 1,
    due_at: null,
    due_completed_at: null,
    priority: null,
    labels: [],
    attributes: {},
    completed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    contact: null,
    is_overdue: false,
    checklist_total: 0,
    checklist_done: 0,
    comment_count: 0,
    attachment_count: 0,
  }
}

function pages(cardsPerPage: KanbanCard[][]): KanbanColumnPages {
  return {
    pages: cardsPerPage.map((cards, i) => ({
      cards,
      next_cursor: i < cardsPerPage.length - 1 ? cardsPerPage[i + 1][0]?.id ?? null : null,
      has_more: i < cardsPerPage.length - 1,
    })),
    pageParams: cardsPerPage.map((_, i) => (i === 0 ? undefined : i)),
  }
}

describe("removeCardFromColumnPages ( — optimistic drag)", () => {
  it("xoá đúng card ở trang chứa nó, giữ nguyên trang khác", () => {
    const data = pages([[card(1, 10), card(2, 10)], [card(3, 10)]])
    const { removed, next } = removeCardFromColumnPages(data, 2)
    expect(removed?.id).toBe(2)
    expect(next.pages[0].cards.map((c) => c.id)).toEqual([1])
    expect(next.pages[1].cards.map((c) => c.id)).toEqual([3])
  })

  it("card không có trong cache => removed=null, KHÔNG đổi data (giữ reference cũ)", () => {
    const data = pages([[card(1, 10)]])
    const { removed, next } = removeCardFromColumnPages(data, 999)
    expect(removed).toBeNull()
    expect(next).toBe(data)
  })
})

describe("insertCardIntoColumnPages ( — optimistic drag)", () => {
  it("KHÔNG before/after => chèn cuối trang đầu (append)", () => {
    const data = pages([[card(1, 10), card(2, 10)]])
    const next = insertCardIntoColumnPages(data, card(5, 99), {}, 10)
    expect(next.pages[0].cards.map((c) => c.id)).toEqual([1, 2, 5])
    expect(next.pages[0].cards[2].column_id).toBe(10)
  })

  it("after_card_id => chèn NGAY TRƯỚC card đó", () => {
    const data = pages([[card(1, 10), card(2, 10), card(3, 10)]])
    const next = insertCardIntoColumnPages(data, card(5, 99), { after_card_id: 2 }, 10)
    expect(next.pages[0].cards.map((c) => c.id)).toEqual([1, 5, 2, 3])
  })

  it("before_card_id => chèn NGAY SAU card đó", () => {
    const data = pages([[card(1, 10), card(2, 10), card(3, 10)]])
    const next = insertCardIntoColumnPages(data, card(5, 99), { before_card_id: 2 }, 10)
    expect(next.pages[0].cards.map((c) => c.id)).toEqual([1, 2, 5, 3])
  })

  it("neighbor chưa tải (không có trong trang đầu) => fallback chèn ĐẦU danh sách, KHÔNG rớt mất card", () => {
    const data = pages([[card(1, 10), card(2, 10)]])
    const next = insertCardIntoColumnPages(data, card(5, 99), { after_card_id: 999 }, 10)
    expect(next.pages[0].cards.map((c) => c.id)).toEqual([5, 1, 2])
  })

  it("cache cột đích rỗng (0 trang) => trả nguyên data, KHÔNG throw", () => {
    const data: KanbanColumnPages = { pages: [], pageParams: [] }
    const next = insertCardIntoColumnPages(data, card(5, 99), {}, 10)
    expect(next).toBe(data)
  })
})
