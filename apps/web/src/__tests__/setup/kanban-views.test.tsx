/** kanban cho bảng động: cột theo trường lựa chọn, kéo thả đổi trạng thái; menu trỏ tới view. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { CustomObjectDef, CustomViewDef } from "@/types/custom-objects"

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
  it("kéo thẻ sang cột khác ⇒ sửa đúng trường trạng thái qua API sửa bản ghi", () => {
    render(<CustomKanbanBoard def={DEF} view={VIEW} />)
    const cols = screen.getAllByTestId("kanban-column")
    const data = new Map<string, string>()
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "" }
    fireEvent.dragStart(screen.getByTestId("kanban-card"), { dataTransfer })
    fireEvent.dragOver(cols[1], { dataTransfer })
    fireEvent.drop(cols[1], { dataTransfer })
    expect(mutate).toHaveBeenCalledWith({ id: 7, input: { data: { trang_thai: "contacted" } } }, expect.anything())
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
