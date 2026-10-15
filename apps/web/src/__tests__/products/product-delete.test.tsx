import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ProductDeleteDialog } from "@/app/(dashboard)/products/_components/product-delete-dialog"
import { ProductCard } from "@/app/(dashboard)/products/_components/product-card"
import type { Product } from "@/types/product"

const product: Product = {
  id: 5, code: "CF-01", name: "Cà phê sữa", project_id: null, brand: null,
  color: null, tags: [], is_featured: false, image_url: null,
  category_id: null, attributes: {},
  description: null, price: 25000, is_active: true, created_by: null,
  created_at: "", updated_at: "",
}

function setup(error: { message: string; conflict: boolean } | null, p: Product = product) {
  const fns = { onCancel: vi.fn(), onConfirm: vi.fn(), onHide: vi.fn() }
  render(<ProductDeleteDialog product={p} pending={false} error={error} {...fns} />)
  return fns
}

describe("hộp xác nhận Xoá sản phẩm", () => {
  it("cảnh báo không hoàn tác; tách 2 hành động Ẩn và Xoá vĩnh viễn", () => {
    const fns = setup(null)
    expect(screen.getByRole("dialog").textContent).toContain("không thể hoàn tác")
    fireEvent.click(screen.getByRole("button", { name: /Xoá vĩnh viễn/ }))
    expect(fns.onConfirm).toHaveBeenCalledWith(product)
    fireEvent.click(screen.getByRole("button", { name: /Ẩn sản phẩm/ }))
    expect(fns.onHide).toHaveBeenCalledWith(product)
  })

  it("409: hiện NGUYÊN VĂN lý do BE, bỏ nút Xoá, còn nút Ẩn sản phẩm", () => {
    const msg = "Sản phẩm đã có trong 3 đơn bán hàng — không thể xoá hẳn, chỉ có thể ẩn"
    const fns = setup({ message: msg, conflict: true })
    expect(screen.getByRole("alert").textContent).toBe(msg)
    expect(screen.queryByRole("button", { name: /Xoá vĩnh viễn/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Ẩn sản phẩm/ }))
    expect(fns.onHide).toHaveBeenCalledWith(product)
  })

  it("lỗi khác 409 (mạng/5xx): hiện lỗi nhưng vẫn cho thử xoá lại", () => {
    setup({ message: "Máy chủ bận", conflict: false })
    expect(screen.getByRole("alert").textContent).toBe("Máy chủ bận")
    expect(screen.getByRole("button", { name: /Xoá vĩnh viễn/ })).toBeTruthy()
  })

  it("sản phẩm đã ẩn: không đề nghị Ẩn lần nữa", () => {
    setup(null, { ...product, is_active: false })
    expect(screen.queryByRole("button", { name: /Ẩn sản phẩm/ })).toBeNull()
  })
})

describe("thẻ sản phẩm: Ẩn và Xoá là 2 nút riêng, theo quyền", () => {
  const base = { product, categories: [], onViewDetail: vi.fn(), onEdit: vi.fn(), onToggleActive: vi.fn(), onDelete: vi.fn() }
  it("có quyền: thấy cả Ẩn và Xoá", () => {
    render(<ProductCard {...base} canEditFull canDelete />)
    expect(screen.getByRole("button", { name: /Ẩn/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Xoá/ })).toBeTruthy()
  })
  it("thiếu quyền: không có nút Ẩn/Xoá", () => {
    render(<ProductCard {...base} canEditFull={false} canDelete={false} />)
    expect(screen.queryByRole("button", { name: /Ẩn/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Xoá/ })).toBeNull()
  })
})
