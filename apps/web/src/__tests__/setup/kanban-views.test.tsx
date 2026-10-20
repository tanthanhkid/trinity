/** kanban cho bảng động: cột theo trường lựa chọn, kéo thả đổi trạng thái; menu trỏ tới view. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { CustomObjectDef, CustomViewDef } from "@/types/custom-objects"

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

const mutate = vi.fn()
const recordsByFilter: Record<string, { id: number; title: string; owner_name: string | null; data: Record<string, unknown> }[]> = {}
vi.mock("@/hooks/custom-objects/use-custom-objects", () => ({
  useCustomRecords: (_k: string, p: { filter: string }) => {
    const items = recordsByFilter[JSON.parse(p.filter).trang_thai] ?? []
    return { data: { items, total: items.length, next_cursor: null }, isLoading: false, isError: false }
  },
  useCustomRecordMutations: () => ({ update: { mutate } }),
}))
vi.mock("@/hooks/custom-objects/use-custom-views", () => ({ useCustomViews: () => ({ data: [] }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => true, grants: {} }) }))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock("@/components/app-shell/page-header", () => ({ ShellPageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }))

import { CustomKanbanBoard } from "@/components/custom-objects/custom-kanban-board"
import { buildCustomMenuItems } from "@/components/app-shell/menu-custom"

const DEF = {
  key: "khach_hang", label: "Khách hàng", label_plural: "Khách hàng", icon: null, description: null,
  fields: [
    { id: 1, key: "ho_ten", label: "Họ tên", type: "text", is_title: true, required: true, is_unique: false, show_in_list: true, sort_order: 1, options: {}, help_text: null },
    { id: 2, key: "trang_thai", label: "Trạng thái", type: "select", is_title: false, required: false, is_unique: false, show_in_list: true, sort_order: 2, options: { choices: [{ value: "new", label: "Mới" }, { value: "contacted", label: "Đã liên hệ" }] }, help_text: null },
  ],
} as unknown as CustomObjectDef
const VIEW: CustomViewDef = { id: 1, key: "pipeline", object_key: "khach_hang", label: "Pipeline", type: "kanban", config: { group_by: "trang_thai" }, icon: null, show_in_nav: true, nav_order: 1, href: "/x/khach_hang/v/pipeline" }

beforeEach(() => {
  mutate.mockClear()
  recordsByFilter.new = [{ id: 7, title: "An", owner_name: null, data: { trang_thai: "new" } }]
  recordsByFilter.contacted = []
})

describe("CustomKanbanBoard", () => {
  it("cột theo đúng thứ tự lựa chọn của trường trạng thái, thẻ nằm đúng cột", () => {
    render(<CustomKanbanBoard def={DEF} view={VIEW} />)
    const cols = screen.getAllByTestId("kanban-column")
    expect(cols.map((c) => c.getAttribute("aria-label"))).toEqual(["Mới", "Đã liên hệ"])
    expect(cols[0].textContent).toContain("An")
  })
  it("kéo thẻ sang cột khác ⇒ sửa đúng trường trạng thái qua API sửa bản ghi", async () => {
    render(<CustomKanbanBoard def={DEF} view={VIEW} />)
    const cols = screen.getAllByTestId("kanban-column")
    // jsdom không có bố cục: đặt toạ độ hai cột để biết con trỏ đang ở cột nào.
    const rect = (left: number) => ({ left, right: left + 280, top: 0, bottom: 600, width: 280, height: 600, x: left, y: 0, toJSON: () => ({}) })
    cols[0].getBoundingClientRect = () => rect(0)
    cols[1].getBoundingClientRect = () => rect(292)
    const card = screen.getByTestId("kanban-card")
    fireEvent.pointerDown(card, { clientX: 20, clientY: 20, isPrimary: true, button: 0 })
    fireEvent.pointerMove(document, { clientX: 30, clientY: 20, isPrimary: true })
    fireEvent.pointerMove(document, { clientX: 400, clientY: 20, isPrimary: true })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.pointerUp(document, { clientX: 400, clientY: 20, isPrimary: true })
    expect(mutate).toHaveBeenCalledWith({ id: 7, input: { data: { trang_thai: "contacted" } } }, expect.anything())
  })
  it("thả lại đúng cột cũ ⇒ không gọi API", async () => {
    render(<CustomKanbanBoard def={DEF} view={VIEW} />)
    const card = screen.getByTestId("kanban-card")
    fireEvent.pointerDown(card, { clientX: 20, clientY: 20, isPrimary: true, button: 0 })
    fireEvent.pointerMove(document, { clientX: 40, clientY: 30, isPrimary: true })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    fireEvent.pointerUp(document, { clientX: 40, clientY: 30, isPrimary: true })
    expect(mutate).not.toHaveBeenCalled()
  })
  it("trường chia cột không còn là select ⇒ báo cần sửa màn, không vỡ trang", () => {
    render(<CustomKanbanBoard def={DEF} view={{ ...VIEW, config: { group_by: "ho_ten" } }} />)
    expect(screen.getByText("Kanban chưa dùng được")).toBeTruthy()
  })
})

describe("menu trỏ tới view", () => {
  it("mục view dùng href + khoá riêng; bản BE cũ (thiếu href) vẫn về /x/<key>", () => {
    const items = buildCustomMenuItems([
      { key: "khach_hang", label: "Pipeline", label_plural: "Pipeline", icon: null, nav_order: 1, href: "/x/khach_hang/v/pipeline", menu_key: "khach_hang__pipeline" },
      { key: "lop", label: "Lớp", label_plural: "Lớp", icon: null, nav_order: 2 },
    ])
    expect(items.map((i) => [i.key, i.href])).toEqual([["custom_khach_hang__pipeline", "/x/khach_hang/v/pipeline"], ["custom_lop", "/x/lop"]])
  })
})
