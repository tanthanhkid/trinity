/** Board Kanban: kéo thẻ → gửi đúng cột + thẻ trước/sau theo vị trí con trỏ; thả lại chỗ cũ thì không gọi máy chủ. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { KanbanCard } from "@/types/kanban"

// jsdom chưa có PointerEvent — dnd-kit cần `isPrimary`/`button` để nhận cú kéo chuột.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    isPrimary: boolean
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.isPrimary = init.isPrimary ?? true
      this.pointerId = init.pointerId ?? 1
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent
}

const card = (id: number, column_id: number): KanbanCard =>
  ({
    id, code: `CV00${id}`, board_id: 1, column_id, position: id, title: `Thẻ ${id}`, description: null, contact_id: null,
    assignee_id: null, assignee_ids: [], created_by: 1, due_at: null, due_completed_at: null, priority: null, labels: [],
    attributes: {}, completed_at: null, created_at: "", updated_at: "", contact: null, is_overdue: false,
    checklist_total: 0, checklist_done: 0, comment_count: 0, attachment_count: 0,
  }) as KanbanCard

const cardsByColumn: Record<number, KanbanCard[]> = {}
const move = vi.fn()
vi.mock("@/hooks/kanban/use-kanban-boards", () => ({
  useKanbanBoardDetail: () => ({
    isLoading: false,
    data: { id: 1, label_defs: [], columns: [{ id: 10, name: "Cần làm", color: null, wip_limit: null }, { id: 20, name: "Đang làm", color: null, wip_limit: null }] },
  }),
}))
vi.mock("@/hooks/kanban/use-kanban-cards", () => ({
  useKanbanCardsByColumn: (_b: number, columnId: number) => ({
    data: { pages: [{ cards: cardsByColumn[columnId] ?? [] }] }, isLoading: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(),
  }),
  useCreateKanbanCard: () => ({ mutate: vi.fn(), isPending: false }),
  useMoveKanbanCard: () => ({ mutate: move }),
}))
vi.mock("@/hooks/kanban/use-kanban-columns", () => ({ useReorderKanbanColumns: () => ({ mutate: vi.fn() }) }))
vi.mock("@/hooks/kanban/use-kanban-user-roster", () => ({ useKanbanUserRoster: () => ({ data: [] }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => true }) }))
vi.mock("@/components/kanban/kanban-card-dialog", () => ({ KanbanCardDialog: () => null }))

import { KanbanBoardView } from "@/components/kanban/kanban-board-view"

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/** Đặt toạ độ: cột 10 ở x 0–280, cột 20 ở x 292–572; thẻ cao 80, cách nhau 8, bắt đầu y 0. */
function layout() {
  document.querySelectorAll<HTMLElement>("[data-board-column]").forEach((col) => {
    const left = col.dataset.boardColumn === "10" ? 0 : 292
    col.getBoundingClientRect = () => rect(left, 0, 280, 800)
    const list = col.querySelector<HTMLElement>("[data-board-list]")!
    list.getBoundingClientRect = () => rect(left, 0, 280, 800)
    list.querySelectorAll<HTMLElement>("[data-board-item]").forEach((el, i) => {
      el.getBoundingClientRect = () => rect(left, i * 88, 280, 80)
    })
  })
}

async function dragCard(title: string, to: { x: number; y: number }) {
  layout()
  const el = screen.getByText(title).closest("[data-board-item]")!.firstElementChild!
  fireEvent.pointerDown(el, { clientX: 20, clientY: 20, isPrimary: true, button: 0 })
  fireEvent.pointerMove(document, { clientX: 30, clientY: 25, isPrimary: true })
  fireEvent.pointerMove(document, { clientX: to.x, clientY: to.y, isPrimary: true })
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  fireEvent.pointerUp(document, { clientX: to.x, clientY: to.y, isPrimary: true })
}

beforeEach(() => {
  move.mockClear()
  cardsByColumn[10] = [card(1, 10), card(2, 10)]
  cardsByColumn[20] = [card(3, 20), card(4, 20)]
})

describe("KanbanBoardView kéo thả", () => {
  it("thả giữa hai thẻ của cột khác ⇒ chuyển cột, chèn giữa đúng hai thẻ đó", async () => {
    render(<KanbanBoardView boardId={1} filters={{}} />)
    await dragCard("Thẻ 1", { x: 400, y: 90 })
    expect(move).toHaveBeenCalledWith({ id: 1, payload: { column_id: 20, before_card_id: 3, after_card_id: 4 } }, expect.anything())
  })

  it("thả cuối cột ⇒ nằm sau thẻ cuối", async () => {
    render(<KanbanBoardView boardId={1} filters={{}} />)
    await dragCard("Thẻ 1", { x: 400, y: 700 })
    expect(move).toHaveBeenCalledWith({ id: 1, payload: { column_id: 20, before_card_id: 4, after_card_id: undefined } }, expect.anything())
  })

  it("thả lại đúng chỗ cũ ⇒ không gọi máy chủ", async () => {
    render(<KanbanBoardView boardId={1} filters={{}} />)
    await dragCard("Thẻ 1", { x: 40, y: 30 })
    expect(move).not.toHaveBeenCalled()
  })

  it("thẻ hiện mã chung", () => {
    render(<KanbanBoardView boardId={1} filters={{}} />)
    expect(screen.getByText("CV001")).toBeTruthy()
  })
})
