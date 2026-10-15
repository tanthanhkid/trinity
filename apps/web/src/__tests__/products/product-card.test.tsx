import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProductCard } from "@/app/(dashboard)/products/_components/product-card"
import { ProductsFilterBar } from "@/app/(dashboard)/products/_components/products-filter-bar"
import type { Product } from "@/types/product"

const base: Product = {
  id: 1, code: "SP10", name: "Spring promo plan", project_id: null, brand: "Acme",
  color: null, tags: [], is_featured: false, image_url: "/uploads/products/a.png",
  category_id: null, attributes: {}, description: null,
  price: 1500000, is_active: true, created_by: null, created_at: "", updated_at: "",
}
const props = { canEditFull: true, canDelete: true, categories: [], onViewDetail: vi.fn(), onEdit: vi.fn(), onToggleActive: vi.fn(), onDelete: vi.fn() }

describe("card hiển thị ảnh minh hoạ", () => {
  it("render <img> theo image_url", () => {
    render(<ProductCard product={base} {...props} />)
    expect(screen.getByAltText(/Ảnh minh hoạ Spring promo/).getAttribute("src")).toBe("/uploads/products/a.png")
  })
  it("ảnh lỗi → rơi về khối chữ cái đầu, không để trống", () => {
    render(<ProductCard product={base} {...props} />)
    fireEvent.error(screen.getByAltText(/Ảnh minh hoạ Spring promo/))
    expect(screen.queryByAltText(/Ảnh minh hoạ Spring promo/)).toBeNull()
    expect(screen.getByTestId("product-cover").textContent).toBe("AC")
  })
  it("không có image_url → khối chữ cái đầu", () => {
    render(<ProductCard product={{ ...base, image_url: null }} {...props} />)
    expect(screen.queryByRole("img")).toBeNull()
  })
})

describe("badge trạng thái + action", () => {
  it("badge Đang mở bán / Ngừng bán", () => {
    const { rerender } = render(<ProductCard product={base} {...props} />)
    expect(screen.getByText("Đang mở bán")).toBeTruthy()
    rerender(<ProductCard product={{ ...base, is_active: false }} {...props} />)
    expect(screen.getByText("Ngừng bán")).toBeTruthy()
  })
  it("Xem chi tiết là nút phụ (outline, không nền đặc — chuẩn một hành động chính)", () => {
    render(<ProductCard product={base} {...props} />)
    const btn = screen.getByRole("button", { name: /Xem chi tiết/ })
    expect(btn.className).not.toContain("bg-primary")
    expect(btn.className).toContain("border-input")
  })
})

/** jsdom không có matchMedia — `useIsPhone` (qua MobileFilterSheet) cần. */
const stubPhone = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }),
  })

describe("thanh lọc", () => {
  afterEach(() => { stubPhone(false) })
  const bar = (over: Partial<Parameters<typeof ProductsFilterBar>[0]> = {}) => (
    <ProductsFilterBar
      search="" onSearchChange={vi.fn()} categoryFilter="ALL" onCategoryChange={vi.fn()}
      projectFilter="ALL" onProjectChange={vi.fn()} showInactive={false}
      onShowInactiveChange={vi.fn()} categories={[]} projects={[]} total={7} {...over}
    />
  )
  it("điện thoại: lọc gom vào 'Bộ lọc (n)', ô tìm ở ngoài", () => {
    stubPhone(true)
    render(bar({ showInactive: true }))
    expect(screen.getByRole("button", { name: "Bộ lọc (1)" })).toBeTruthy()
    expect(screen.queryByRole("switch")).toBeNull()
    expect(screen.getByPlaceholderText(/Tìm mã/)).toBeTruthy()
  })
  it("hiện tổng số + switch bật/tắt sản phẩm đã tắt", () => {
    stubPhone(false)
    const onShow = vi.fn()
    render(
      <ProductsFilterBar
        search="" onSearchChange={vi.fn()} categoryFilter="ALL" onCategoryChange={vi.fn()}
        projectFilter="ALL" onProjectChange={vi.fn()} showInactive={false}
        onShowInactiveChange={onShow} categories={[]} projects={[]} total={7}
      />,
    )
    expect(screen.getByText("7")).toBeTruthy()
    fireEvent.click(screen.getByRole("switch"))
    expect(onShow).toHaveBeenCalledWith(true)
  })
})

describe("sản phẩm đã tắt không làm mờ chữ", () => {
  it("opacity chỉ áp lên ảnh bìa, không phải cả thẻ", () => {
    const { container } = render(<ProductCard product={{ ...base, is_active: false }} {...props} />)
    expect((container.firstChild as HTMLElement).className).not.toContain("opacity-")
    expect(screen.getByTestId("product-cover").className).toContain("opacity-60")
  })
})
