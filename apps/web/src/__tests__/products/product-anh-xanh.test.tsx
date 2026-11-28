import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

/** Giao diện «Ánh xanh» của trang sản phẩm: bản nháp, thanh lưu desktop, màn xem nhanh điện thoại. */
const updateMutate = vi.fn()
vi.mock("@/hooks/use-projects", () => ({ useActiveProjects: () => ({ data: [] }) }))
vi.mock("@/hooks/products/use-products", () => ({
  useUpdateProduct: () => ({ mutate: updateMutate, isPending: false }),
  useUploadProductImage: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/products/use-product-categories", () => ({
  useProductCategories: () => ({ data: [{ id: 1, name: "Chăn ga gối nệm" }] }),
  useAttributeDefs: () => ({ data: [] }),
}))
vi.mock("@/components/app-shell/hover-link", () => ({
  HoverLink: ({ children, ...p }: { children: React.ReactNode; href: string }) => <a {...p}>{children}</a>,
}))

import { ProductEditorDesktop } from "@/app/(dashboard)/products/_components/product-editor-desktop"
import { ProductMobile } from "@/app/(dashboard)/products/_components/product-mobile"
import { countChanges, draftFromProduct, draftToPayload, groupDigits, readiness, validateDraft } from "@/app/(dashboard)/products/_components/product-draft"
import type { Product } from "@/types/product"

const P: Product = {
  id: 7, code: "GA-TC180", name: "Bộ ga gối", project_id: null, brand: "Everon", color: null, tags: ["a"],
  is_featured: false, image_url: null, category_id: 1, attributes: {}, description: "Mô tả", price: 1250000,
  is_active: true, created_by: 1, created_at: "", updated_at: "",
}

beforeEach(() => updateMutate.mockClear())

describe("product-draft", () => {
  it("dựng nháp, đếm thay đổi, đổi ra payload, kiểm lỗi", () => {
    const d = draftFromProduct(P)
    expect(countChanges(d, d)).toBe(0)
    const e = { ...d, name: "X", price: "", tags: ["a", "b"] }
    expect(countChanges(d, e)).toBe(3)
    expect(draftToPayload(e)).toMatchObject({ price: null, tags: ["a", "b"], category_id: 1 })
    expect(validateDraft(e).name).toBeTruthy()
    expect(groupDigits("1250000")).toBe("1.250.000")
    expect(readiness(d).filter((r) => r.ok)).toHaveLength(3) // thiếu ảnh
  })
})

describe("ProductEditorDesktop", () => {
  it("sửa tên ⇒ hiện thanh «1 thay đổi», Lưu gửi PATCH; mã bị khoá", () => {
    render(<ProductEditorDesktop product={P} canManage />)
    expect(screen.queryByRole("region", { name: "Thay đổi chưa lưu" })).toBeNull()
    expect((screen.getByLabelText("Mã sản phẩm") as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Tên sản phẩm"), { target: { value: "Tên mới" } })
    expect(screen.getByText("Có 1 thay đổi chưa lưu")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }))
    expect(updateMutate).toHaveBeenCalledTimes(1)
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ id: 7, payload: { name: "Tên mới" } })
  })
  it("tên quá ngắn ⇒ báo lỗi, không gửi", () => {
    render(<ProductEditorDesktop product={P} canManage />)
    fireEvent.change(screen.getByLabelText("Tên sản phẩm"), { target: { value: "A" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }))
    expect(updateMutate).not.toHaveBeenCalled()
    expect(screen.getByText("Tên sản phẩm tối thiểu 2 ký tự")).toBeTruthy()
  })
  it("không có quyền sửa ⇒ ô khoá, không có thanh lưu", () => {
    render(<ProductEditorDesktop product={P} canManage={false} />)
    expect((screen.getByLabelText("Tên sản phẩm") as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Tên sản phẩm"), { target: { value: "Z" } })
    expect(screen.queryByRole("button", { name: "Lưu" })).toBeNull()
  })
})

describe("ProductMobile", () => {
  it("ẩn/mở bán lưu NGAY; chỉ đọc thì không có nút sửa", () => {
    const { unmount } = render(<ProductMobile product={P} canManage />)
    fireEvent.click(screen.getByRole("switch"))
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ id: 7, payload: { is_active: false } })
    expect(screen.getByRole("button", { name: "Sửa toàn bộ thông tin" })).toBeTruthy()
    unmount()
    render(<ProductMobile product={P} canManage={false} />)
    expect(screen.queryByRole("button", { name: "Sửa toàn bộ thông tin" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Đổi giá" })).toBeNull()
  })
  it("Sửa toàn bộ mở màn sửa với Huỷ / Lưu", () => {
    render(<ProductMobile product={P} canManage />)
    fireEvent.click(screen.getByRole("button", { name: "Sửa toàn bộ thông tin" }))
    expect(screen.getByRole("heading", { name: "Sửa sản phẩm" })).toBeTruthy()
    expect((screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Tên sản phẩm"), { target: { value: "Tên khác" } })
    expect((screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
