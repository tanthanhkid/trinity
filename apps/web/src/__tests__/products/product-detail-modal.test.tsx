import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ProductDetailModal } from "@/app/(dashboard)/products/_components/product-detail-modal"
import type { Product } from "@/types/product"

vi.mock("@/hooks/products/use-product-categories", () => ({
  useProductCategories: () => ({ data: [{ id: 1, name: "Bán lẻ" }] }),
  useAttributeDefs: () => ({
    data: [{ id: 1, category_id: 1, key: "rate", label: "Bảo hành", type: "percent", options: null }],
  }),
}))

const product: Product = {
  id: 1, code: "SP-01-SPRING", name: "Spring promo plan", project_id: null, brand: "Acme",
  color: null, tags: ["hot"], is_featured: false, image_url: null,
  category_id: 1, attributes: { rate: 10 },
  description: "Mô tả sản phẩm", price: 200000000, is_active: true, created_by: null,
  created_at: "", updated_at: "",
}

describe("popup chi tiết sản phẩm là Center Modal", () => {
  it("render dạng dialog với tên, mã (tag), giá, danh mục, thuộc tính", () => {
    render(<ProductDetailModal product={product} open onOpenChange={vi.fn()} />)
    const dlg = screen.getByRole("dialog")
    expect(dlg.className).toContain("sm:max-w-[680px]")
    expect(dlg.className).toContain("max-h-[90dvh]")
    expect(screen.getByText("Spring promo plan")).toBeTruthy()
    expect(screen.getByTestId("product-code-tag").textContent).toBe("SP-01-SPRING")
    expect(screen.getByTestId("product-price-block").textContent).toContain("200.000.000")
    expect(screen.getByText("Bán lẻ")).toBeTruthy()
    expect(screen.getByText("Bảo hành")).toBeTruthy()
    expect(screen.getByText("10%")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Đóng" })).toBeTruthy()
  })
  it("ngừng bán → badge + ô trạng thái hiện 'Ngừng bán'", () => {
    render(<ProductDetailModal product={{ ...product, is_active: false }} open onOpenChange={vi.fn()} />)
    expect(screen.getAllByText("Ngừng bán").length).toBe(2)
  })
  it("product null → không render nội dung", () => {
    render(<ProductDetailModal product={null} open onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId("product-price-block")).toBeNull()
  })
})
