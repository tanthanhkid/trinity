import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { KanbanCard } from "@/types/kanban"

vi.mock("@/hooks/kanban/use-kanban-card-lookups", () => ({
  useKanbanCardLookups: () => ({
    boardName: (id: number) => (id === 3 ? "Bảng chăm sóc" : `Bảng #${id}`),
    column: (b: number, c: number) => (b === 3 && c === 9 ? { name: "Đang làm", isDone: false } : null),
    assigneeNames: (card: KanbanCard) => (card.assignee_id === 5 ? ["Sale Một"] : []),
    label: (b: number, id: string) => (b === 3 && id === "lb1" ? { name: "VIP", color: "#00753c" } : null),
  }),
}))

import { KanbanCardList } from "@/components/kanban/kanban-card-list"
import { kanbanPriorityLabel, kanbanPriorityTone } from "@/lib/kanban-display"

function card(over: Partial<KanbanCard>): KanbanCard {
  return {
    id: 1, board_id: 3, column_id: 9, position: 1, title: "Gọi lại", description: null,
    contact_id: 2, assignee_id: 5, assignee_ids: [5], created_by: 1, due_at: null,
    due_completed_at: null, priority: "urgent", labels: [], attributes: {}, completed_at: null,
    created_at: "", updated_at: "", contact: null, is_overdue: false, checklist_total: 0,
    checklist_done: 0, comment_count: 0, attachment_count: 0, ...over,
  }
}

describe("KanbanCardList hiển thị", () => {
  it("ưu tiên hiện tiếng Việt, Board/Người phụ trách hiện TÊN, không #id", () => {
    render(
      <KanbanCardList cards={[card({})]} isLoading={false} onOpenCard={() => {}} showBoardColumn showStatusColumn />,
    )
    expect(within(screen.getByRole("table")).getByText("Khẩn cấp")).toBeTruthy()
    expect(screen.queryByText("urgent")).toBeNull()
    expect(within(screen.getByRole("table")).getByText("Bảng chăm sóc")).toBeTruthy()
    expect(within(screen.getByRole("table")).getByText("Sale Một")).toBeTruthy()
    expect(within(screen.getByRole("table")).getByText("Đang làm")).toBeTruthy()
    expect(screen.queryByText("#3")).toBeNull()
    expect(screen.queryByText("#5")).toBeNull()
  })

  it("ẩn cột Nhãn khi không card nào có nhãn, hiện khi có", () => {
    const { rerender } = render(
      <KanbanCardList cards={[card({})]} isLoading={false} onOpenCard={() => {}} />,
    )
    expect(screen.queryByText("Nhãn")).toBeNull()
    rerender(
      <KanbanCardList cards={[card({ labels: ["lb1"] })]} isLoading={false} onOpenCard={() => {}} />,
    )
    expect(screen.getByText("Nhãn")).toBeTruthy()
    // nhãn lưu theo id → hiện TÊN từ label_defs, không in id thô
    expect(within(screen.getByRole("table")).getByText("VIP")).toBeTruthy()
    expect(screen.queryByText("lb1")).toBeNull()
  })

  it("map đủ 4 cấp ưu tiên, giá trị lạ/null không in tiếng Anh", () => {
    expect(["low", "normal", "high", "urgent"].map(kanbanPriorityLabel)).toEqual([
      "Thấp", "Bình thường", "Cao", "Khẩn cấp",
    ])
    expect(kanbanPriorityLabel(null)).toBeNull()
    expect(kanbanPriorityLabel("weird")).toBeNull()
    expect(kanbanPriorityTone("urgent")).toBe("red")
    expect(kanbanPriorityTone("high")).toBe("amber")
  })
})
