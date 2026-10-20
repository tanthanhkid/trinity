import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ActiveFilterChips, filterChips } from "@/components/custom-objects/custom-records-filters"
import { SortHeader } from "@/components/ui/sort-header"
import type { CustomFieldDef, CustomObjectDef } from "@/types/custom-objects"

const field = (key: string, type: CustomFieldDef["type"], extra: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  id: 1, key, label: key.toUpperCase(), type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: {}, help_text: null, ...extra,
})
const def = {
  fields: [
    field("tt", "select", { options: { choices: [{ value: "hoc", label: "Đang học" }] } }),
    field("diem", "number"), field("ngay", "date"), field("xong", "boolean"), field("ph", "relation", { options: { target: "contact" } }),
  ],
} as unknown as CustomObjectDef

describe("filterChips — chip bộ lọc đang áp", () => {
  it("chỉ lấy ô có giá trị, ghi giá trị dạng chữ", () => {
    expect(filterChips(def, {})).toEqual([])
    expect(filterChips(def, { diem: { min: "", max: "" } })).toEqual([])
    const chips = filterChips(def, {
      tt: "hoc", diem: { min: "5" }, ngay: { from: "2026-10-01", to: "2026-10-20" }, xong: "false", ph: 7,
    })
    expect(chips.map((c) => `${c.label}: ${c.value}`)).toEqual([
      "TT: Đang học", "DIEM: từ 5", "NGAY: 01/10/2026 – 20/10/2026", "XONG: Không", "PH: đã chọn",
    ])
  })
})

describe("ActiveFilterChips", () => {
  it("bỏ từng chip và xoá hết", () => {
    const onRemove = vi.fn()
    const onClear = vi.fn()
    render(<ActiveFilterChips chips={filterChips(def, { tt: "hoc", diem: { max: "9" } })} onRemove={onRemove} onClear={onClear} />)
    expect(screen.getByText("đến 9")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Bỏ bộ lọc TT" }))
    expect(onRemove).toHaveBeenCalledWith("tt")
    fireEvent.click(screen.getByRole("button", { name: "Xoá lọc" }))
    expect(onClear).toHaveBeenCalled()
  })

  it("không có chip thì không hiện gì", () => {
    const { container } = render(<ActiveFilterChips chips={[]} onRemove={() => {}} onClear={() => {}} />)
    expect(container.textContent).toBe("")
  })
})

describe("SortHeader", () => {
  it("bấm gọi onToggle; luôn có mũi tên để biết sắp được", () => {
    const onToggle = vi.fn()
    const { container, rerender } = render(<SortHeader label="Tên" dir={null} onToggle={onToggle} />)
    expect(container.querySelector("svg")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Tên" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<SortHeader label="Tên" dir="desc" onToggle={onToggle} />)
    expect(container.querySelector("svg")).toBeTruthy()
  })
})
