import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import {
  AttributeDefForm,
  optionsToText,
  parseOptionsText,
} from "@/app/(dashboard)/products/_components/attribute-def-form"
import type { ProductAttributeDef } from "@/types/product-category"

/** sửa thuộc tính động (key khoá) + options round-trip. */
const def: ProductAttributeDef = {
  id: 9,
  category_id: 1,
  key: "size",
  label: "Kích cỡ",
  type: "select",
  options: [
    { value: "s", label: "Nhỏ" },
    { value: "l", label: "Lớn" },
  ],
  is_required: true,
  sort_order: 0,
  created_at: "",
  updated_at: "",
} as ProductAttributeDef

describe("AttributeDefForm chế độ sửa", () => {
  it("options round-trip qua textarea", () => {
    expect(parseOptionsText(optionsToText(def.options))).toEqual(def.options)
  })

  it("khoá key, nạp sẵn giá trị và gửi payload đã sửa", () => {
    const onSubmit = vi.fn()
    render(<AttributeDefForm initial={def} isSubmitting={false} onSubmit={onSubmit} onCancel={() => {}} />)
    expect(screen.getByLabelText("Key (kỹ thuật)")).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Nhãn hiển thị"), { target: { value: "Cỡ" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Cỡ", type: "select", is_required: true, options: def.options }),
    )
  })
})
