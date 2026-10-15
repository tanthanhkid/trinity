import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * render TRƯỜNG ĐỘNG theo `ProductAttributeDef[]` của danh mục đã
 * chọn trong form tạo/sửa sản phẩm.
 *
 * ⚠️ jsdom KHÔNG tự phát sinh pointermove/mouseenter trước click như trình
 * duyệt thật khi user rê chuột — Base-UI Select CHỈ coi 1 item là
 * "highlighted" (và chấp nhận click) sau khi nhận pointermove/mouseenter,
 * nên `fireEvent.click()` trần chỉ chọn được item ĐANG highlight sẵn (item
 * đầu — ở đây là sentinel "— Chưa phân loại —"). `selectOption()` mô phỏng
 * ĐỦ chuỗi pointer thật để chọn được "Bán lẻ" (item thứ 2). Cộng thêm `fireEvent.mouseMove` (KHÔNG chỉ `mouseEnter`) — Base-UI
 * `SelectItem.onMouseMove` (KHÔNG phải `onMouseEnter`) là handler đặt
 * `activeIndex`/`highlighted`, và `onClick` bỏ qua click nếu item chưa
 * `highlighted` (trừ pointerType `touch`). Thiếu `mouseMove` → click không
 * chọn được item nào ngoài item đầu (đã highlight sẵn).
 */
import {
  findMissingRequiredAttributes,
} from "@/app/(dashboard)/products/_components/dynamic-attribute-fields"
import type { ProductAttributeDef } from "@/types/product-category"

function selectOption(option: HTMLElement) {
  fireEvent.pointerMove(option)
  fireEvent.mouseEnter(option)
  fireEvent.mouseMove(option)
  fireEvent.pointerDown(option)
  fireEvent.mouseDown(option)
  fireEvent.pointerUp(option)
  fireEvent.mouseUp(option)
  fireEvent.click(option)
}

const requiredTextDef: ProductAttributeDef = {
  id: 1,
  category_id: 3,
  key: "warranty",
  label: "Bảo hành",
  type: "text",
  options: null,
  is_required: true,
  sort_order: 0,
  created_at: "",
  updated_at: "",
}

const optionalNumberDef: ProductAttributeDef = {
  ...requiredTextDef,
  id: 2,
  key: "warranty_months",
  label: "Bảo hành (tháng)",
  type: "number",
  is_required: false,
}

describe("findMissingRequiredAttributes", () => {
  it("field bắt buộc thiếu → trả về key đó", () => {
    expect(findMissingRequiredAttributes([requiredTextDef], {})).toEqual(["warranty"])
  });

  it("field bắt buộc có giá trị → không thiếu", () => {
    expect(
      findMissingRequiredAttributes([requiredTextDef], { warranty: "12" }),
    ).toEqual([])
  })

  it("field optional thiếu → KHÔNG tính là thiếu", () => {
    expect(findMissingRequiredAttributes([optionalNumberDef], {})).toEqual([])
  })

  it("mảng rỗng (multiselect chưa chọn gì) VẪN coi là thiếu nếu bắt buộc", () => {
    const multiDef: ProductAttributeDef = {
      ...requiredTextDef,
      key: "colors",
      type: "multiselect",
      options: [{ value: "red", label: "Đỏ" }],
    }
    expect(findMissingRequiredAttributes([multiDef], { colors: [] })).toEqual(["colors"])
    expect(findMissingRequiredAttributes([multiDef], { colors: ["red"] })).toEqual([])
  })
})

// ───────────────────────────── render trong form thật ─────────────────────────────

const createMutate = vi.fn()

vi.mock("@/hooks/use-projects", () => ({
  useActiveProjects: () => ({ data: [], isLoading: false }),
}))

vi.mock("@/hooks/products/use-products", () => ({
  useCreateProduct: () => ({ mutate: createMutate, isPending: false, isError: false }),
  useUploadProductImage: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useUpdateProduct: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))

vi.mock("@/hooks/products/use-product-categories", () => ({
  useProductCategories: () => ({
    data: [{ id: 3, name: "Bán lẻ" }],
    isLoading: false,
  }),
  useAttributeDefs: (categoryId: number | null) => ({
    data: categoryId === 3 ? [requiredTextDef, optionalNumberDef] : [],
    isLoading: false,
  }),
}))

import { ProductFormDialog } from "@/app/(dashboard)/products/_components/product-form-dialog"

function renderCreateDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProductFormDialog open onClose={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  createMutate.mockClear()
})

describe("ProductFormDialog — render trường động theo danh mục", () => {
  it("chưa chọn danh mục → KHÔNG hiện field động nào", () => {
    renderCreateDialog()
    expect(screen.queryByLabelText("Bảo hành *")).not.toBeInTheDocument()
  })

  it("chọn danh mục → hiện đủ field động của danh mục đó (required đánh dấu *)", async () => {
    renderCreateDialog()
    fireEvent.click(screen.getByRole("combobox", { name: /Danh mục\/ngành/i }))
    selectOption(await screen.findByRole("option", { name: "Bán lẻ" }))

    expect(await screen.findByLabelText("Bảo hành *")).toBeInTheDocument()
    expect(screen.getByLabelText("Bảo hành (tháng)")).toBeInTheDocument()
  })

  it("submit khi THIẾU field bắt buộc → chặn lại, hiện lỗi, KHÔNG gọi API", async () => {
    renderCreateDialog()
    fireEvent.click(screen.getByRole("combobox", { name: /Danh mục\/ngành/i }))
    selectOption(await screen.findByRole("option", { name: "Bán lẻ" }))
    await screen.findByLabelText("Bảo hành *")

    fireEvent.change(screen.getByLabelText("Mã sản phẩm *"), { target: { value: "RETAIL-001" } })
    fireEvent.change(screen.getByLabelText("Tên sản phẩm *"), { target: { value: "Sản phẩm A" } })
    fireEvent.click(screen.getByRole("button", { name: "Tạo sản phẩm" }))

    expect(await screen.findByText("Bảo hành là bắt buộc")).toBeInTheDocument()
    expect(createMutate).not.toHaveBeenCalled()
  })

  it("điền đủ field bắt buộc → submit được, payload gửi ĐÚNG attributes", async () => {
    renderCreateDialog()
    fireEvent.click(screen.getByRole("combobox", { name: /Danh mục\/ngành/i }))
    selectOption(await screen.findByRole("option", { name: "Bán lẻ" }))
    await screen.findByLabelText("Bảo hành *")

    fireEvent.change(screen.getByLabelText("Mã sản phẩm *"), { target: { value: "RETAIL-001" } })
    fireEvent.change(screen.getByLabelText("Tên sản phẩm *"), { target: { value: "Sản phẩm A" } })
    fireEvent.change(screen.getByLabelText("Bảo hành *"), { target: { value: "12" } })
    fireEvent.click(screen.getByRole("button", { name: "Tạo sản phẩm" }))

    await waitFor(() => expect(createMutate).toHaveBeenCalled())
    const payload = createMutate.mock.calls[0][0]
    expect(payload.attributes).toEqual({ warranty: "12" })
    expect(payload.category_id).toBe(3)
  })
})
