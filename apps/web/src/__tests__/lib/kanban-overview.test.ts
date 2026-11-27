import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"

const get = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => get(...a) } }))

import { loadKanbanOverview, resetKanbanOverviewForTests } from "@/lib/kanban-overview"

const page = (ids: number[], more = false) => ({ cards: ids.map((id) => ({ id })), next_cursor: null, has_more: more })
const body = {
  boards: [{ id: 7 }, { id: 8 }],
  board: { id: 7, columns: [{ id: 1 }, { id: 2 }] },
  cards: { "1": page([10]), "2": page([11, 12], true), "3": null },
  users: [{ id: 3, full_name: "C" }],
}

beforeEach(() => {
  get.mockReset()
  resetKanbanOverviewForTests()
})

describe("loadKanbanOverview", () => {
  it("ghi cache đúng khoá của hook cũ và trả danh sách board", async () => {
    get.mockResolvedValue({ data: body })
    const qc = new QueryClient()
    const boards = await loadKanbanOverview(qc)
    expect(get).toHaveBeenCalledTimes(1)
    expect(boards).toHaveLength(2)
    expect(qc.getQueryData(["kanban-boards", 7])).toEqual(body.board)
    expect(qc.getQueryData(["kanban-cards", "column", 2, {}])).toEqual({ pages: [page([11, 12], true)], pageParams: [undefined] })
    expect(qc.getQueryData(["kanban-cards", "column", 3, {}])).toBeUndefined()
    expect(qc.getQueryData(["kanban-user-roster"])).toEqual(body.users)
  })
  it("chỉ dùng một lần", async () => {
    get.mockResolvedValue({ data: body })
    const qc = new QueryClient()
    await loadKanbanOverview(qc)
    expect(await loadKanbanOverview(qc)).toBeNull()
    expect(get).toHaveBeenCalledTimes(1)
  })
  it("lỗi hoặc body lạ ⇒ null, không ghi cache", async () => {
    const qc = new QueryClient()
    get.mockRejectedValueOnce(new Error("404"))
    expect(await loadKanbanOverview(qc)).toBeNull()
    resetKanbanOverviewForTests()
    get.mockResolvedValueOnce({ data: [] })
    expect(await loadKanbanOverview(qc)).toBeNull()
    expect(qc.getQueryCache().getAll()).toHaveLength(0)
  })
  it("board chi tiết không khớp board đầu ⇒ không seed thẻ", async () => {
    get.mockResolvedValue({ data: { ...body, board: { id: 99, columns: [] } } })
    const qc = new QueryClient()
    await loadKanbanOverview(qc)
    expect(qc.getQueryData(["kanban-boards", 99])).toBeUndefined()
    expect(qc.getQueryData(["kanban-cards", "column", 1, {}])).toBeUndefined()
  })
})
