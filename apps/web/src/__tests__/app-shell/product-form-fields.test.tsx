import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Màn Sản phẩm: bài test "ô số tắt spinner" chỉ còn
 * ĐÚNG 1 ô số tĩnh (`price`, "Giá (VNĐ)"). Cơ chế gốc (đo bằng
 * Chrome thật) không đổi — chỉ đổi field nào đứng làm đại diện.
 *
 * `product-form-dialog.tsx` nay gọi `useProductCategories`/`useAttributeDefs`
 * (React Query) → `renderEdit`/`renderCreate` PHẢI bọc `QueryClientProvider`.
 */

const createMutate = vi.fn()
const updateMutate = vi.fn()

vi.mock("@/hooks/use-projects", () => ({
  useActiveProjects: () => ({
    data: [{ id: 7, name: "Acme" }],
    isLoading: false,
  }),
}))

vi.mock("@/hooks/products/use-products", () => ({
  useCreateProduct: () => ({ mutate: createMutate, isPending: false, isError: false }),
  useUpdateProduct: () => ({ mutate: updateMutate, isPending: false, isError: false }),
  useUploadProductImage: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))

vi.mock("@/hooks/products/use-product-categories", () => ({
  useProductCategories: () => ({ data: [{ id: 3, name: "Bán lẻ" }], isLoading: false }),
  useAttributeDefs: () => ({ data: [], isLoading: false }),
}))

import { ProductFormDialog } from "@/app/(dashboard)/products/_components/product-form-dialog"
import {
  toPickerHex,
  COLOR_PICKER_FALLBACK,
} from "@/app/(dashboard)/products/_components/product-form-schema"
import type { Product } from "@/types/product"

const SRC = join(__dirname, "../..")
const DIALOG_SRC = readFileSync(
  join(SRC, "app/(dashboard)/products/_components/product-form-dialog.tsx"),
  "utf8",
)

/** Sản phẩm mẫu — dùng chế độ SỬA để mọi field bắt buộc đã có sẵn giá trị. */
function makeProduct(over: Partial<Product> = {}): Product {
  return {
    id: 12,
    code: "SP-500",
    name: "Premium plan online",
    project_id: 7,
    brand: "Acme",
    color: "#00753c",
    tags: ["Premium", "Popular"],
    is_featured: false,
    image_url: null,
    category_id: null,
    attributes: {},
    description: null,
    price: 500_000_000,
    is_active: true,
    created_by: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...over,
  }
}

function renderEdit(product: Product = makeProduct()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProductFormDialog open product={product} onClose={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  createMutate.mockClear()
  updateMutate.mockClear()
})

// ─────────────────────────────────────────────────────────────

describe("chuẩn hoá giá trị màu cho bảng chọn (toPickerHex)", () => {
  it("giữ nguyên mã hex 6 chữ số", () => {
    expect(toPickerHex("#00753c")).toBe("#00753c")
  })

  it("hạ chữ hoa về chữ thường — thẻ color tự chuẩn hoá về thường, để lệch sẽ đá nhau mỗi lần render", () => {
    expect(toPickerHex("#00753C")).toBe("#00753c")
  })

  it("bung mã rút gọn 3 chữ số (CSS hiểu, thẻ color thì không)", () => {
    expect(toPickerHex("#0a7")).toBe("#00aa77")
    expect(toPickerHex("#FFF")).toBe("#ffffff")
  })

  it("bỏ khoảng trắng thừa", () => {
    expect(toPickerHex("  #00753c  ")).toBe("#00753c")
  })

  it("TÊN màu CSS → về mã mặc định, KHÔNG ném lỗi (trường này cố ý nhận cả tên)", () => {
    expect(toPickerHex("teal")).toBe(COLOR_PICKER_FALLBACK)
    expect(toPickerHex("rgb(0,117,60)")).toBe(COLOR_PICKER_FALLBACK)
  })

  it("giá trị đang gõ dở / rỗng / null → mã mặc định, KHÔNG làm vỡ form", () => {
    expect(toPickerHex("#0075")).toBe(COLOR_PICKER_FALLBACK)
    expect(toPickerHex("#GGGGGG")).toBe(COLOR_PICKER_FALLBACK)
    expect(toPickerHex("")).toBe(COLOR_PICKER_FALLBACK)
    expect(toPickerHex(undefined)).toBe(COLOR_PICKER_FALLBACK)
    expect(toPickerHex(null)).toBe(COLOR_PICKER_FALLBACK)
  })
})

describe("ô vuông màu MỞ ĐƯỢC bảng chọn", () => {
  it("có thẻ <input type=color> bấm được, không còn là <span> trang trí", () => {
    renderEdit()
    const picker = screen.getByLabelText("Chọn màu") as HTMLInputElement
    expect(picker).toBeInTheDocument()
    expect(picker.tagName).toBe("INPUT")
    expect(picker.type).toBe("color")
  })

  it("mở sẵn ĐÚNG màu đang lưu trên sản phẩm", () => {
    renderEdit(makeProduct({ color: "#00753c" }))
    expect((screen.getByLabelText("Chọn màu") as HTMLInputElement).value).toBe("#00753c")
  })

  it("chọn màu → ghi vào ô text VÀ gửi lên BE đúng chuỗi đó", async () => {
    renderEdit()
    const picker = screen.getByLabelText("Chọn màu")
    const text = screen.getByLabelText("Màu (hex/tên)") as HTMLInputElement

    fireEvent.change(picker, { target: { value: "#b13442" } })

    await waitFor(() => expect(text.value).toBe("#b13442"))

    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    await waitFor(() => expect(updateMutate).toHaveBeenCalled())
    expect(updateMutate.mock.calls[0][0].payload.color).toBe("#b13442")
  })

  it("TÊN màu người dùng gõ KHÔNG bị bảng chọn ghi đè — contract gửi BE giữ nguyên chuỗi", async () => {
    renderEdit(makeProduct({ color: null }))
    const text = screen.getByLabelText("Màu (hex/tên)") as HTMLInputElement

    fireEvent.change(text, { target: { value: "teal" } })

    // Bảng chọn lùi về mã mặc định (nó không hiểu tên màu)…
    await waitFor(() =>
      expect((screen.getByLabelText("Chọn màu") as HTMLInputElement).value).toBe(
        COLOR_PICKER_FALLBACK,
      ),
    )
    // …nhưng KHÔNG được đụng vào thứ người dùng đang gõ.
    expect(text.value).toBe("teal")

    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    await waitFor(() => expect(updateMutate).toHaveBeenCalled())
    expect(updateMutate.mock.calls[0][0].payload.color).toBe("teal")
  })

  it("ô màu để TRỐNG vẫn gửi null như cũ (không hoá thành #000000)", async () => {
    renderEdit(makeProduct({ color: null }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))
    await waitFor(() => expect(updateMutate).toHaveBeenCalled())
    expect(updateMutate.mock.calls[0][0].payload.color).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────

describe("trường Thẻ không còn ở thế sắp xuống dòng", () => {
  it("ô Thẻ KHÔNG còn nằm trong hàng lưới 3 cột (cột 202,7px < nhãn 207,3px)", () => {
    renderEdit()
    const tags = screen.getByLabelText("Thẻ (phân cách bởi dấu phẩy)")
    expect(tags.closest(".grid-cols-3")).toBeNull()
  })

  it("nhãn giữ NGUYÊN chữ — sửa bố cục chứ không giấu thông tin đi", () => {
    renderEdit()
    expect(screen.getByLabelText("Thẻ (phân cách bởi dấu phẩy)")).toBeInTheDocument()
  })
})

describe("dialog không tự căn giữa lại mỗi lần đổi chiều cao", () => {
  it("mọi dòng lỗi LUÔN chiếm chỗ — bật/tắt lỗi không đổi chiều cao form", () => {
    // Không còn khối render-có-điều-kiện nào cho thông báo lỗi của field.
    expect(DIALOG_SRC).not.toMatch(/\{form\.formState\.errors\.\w+ && \(/)
    // Và mỗi chỗ hiện lỗi đều giữ sẵn 1 dòng.
    const reserved = DIALOG_SRC.match(/min-h-4 text-xs leading-4 text-destructive/g) ?? []
    expect(reserved.length).toBeGreaterThanOrEqual(4)
  })

  it("KHÔNG khoá chiều cao cố định — thứ đó đẻ dải trống dưới footer", () => {
    expect(DIALOG_SRC).not.toContain("h-[min(90vh,52rem)]")
    expect(DIALOG_SRC).toContain("max-h-[90vh]")
  })

  it("🔴 số ô giữ chỗ KHÔNG đổi khi lỗi bật — đây là thứ giữ chiều cao đứng yên", async () => {
    renderEdit()
    const countSlots = () => document.querySelectorAll("p.min-h-4").length
    const before = countSlots()
    expect(before).toBeGreaterThanOrEqual(4)

    // Ép hiện lỗi: xoá trắng ô bắt buộc rồi submit.
    const name = screen.getByLabelText(/Tên sản phẩm/i)
    fireEvent.change(name, { target: { value: "" } })
    fireEvent.submit(name.closest("form") as HTMLFormElement)
    await waitFor(() => expect(document.body.textContent).toBeTruthy())

    expect(countSlots()).toBe(before)
  })
})

describe("ô Giá (VNĐ) không còn là <input type=number>", () => {
  it("dùng ô text định dạng tiền: không có spinner/wheel để đổi giá trị âm thầm", () => {
    renderEdit()
    const el = screen.getByLabelText("Giá (VNĐ)")
    expect(el).toHaveAttribute("type", "text")
    expect(el).toHaveAttribute("inputmode", "numeric")
  })

  it("hiện dấu chấm hàng nghìn kiểu VN cho giá đã lưu", () => {
    renderEdit()
    expect((screen.getByLabelText("Giá (VNĐ)") as HTMLInputElement).value).toBe("500.000.000")
  })
})

describe("gõ ở ô khác KHÔNG dựng lại ô Thẻ (mất focus / nhảy layout)", () => {
  it("ô Thẻ vẫn là ĐÚNG node DOM cũ sau khi gõ ở ô Tên", () => {
    renderEdit()
    const tagsBefore = screen.getByLabelText("Thẻ (phân cách bởi dấu phẩy)")
    const name = screen.getByLabelText("Tên sản phẩm *")

    fireEvent.change(name, { target: { value: "Premium plan online 2" } })
    fireEvent.change(name, { target: { value: "Premium plan online 3" } })

    expect(screen.getByLabelText("Thẻ (phân cách bởi dấu phẩy)")).toBe(tagsBefore)
  })

  it("ô Thẻ giữ được focus xuyên suốt lúc gõ chính nó", () => {
    renderEdit()
    const tags = screen.getByLabelText("Thẻ (phân cách bởi dấu phẩy)") as HTMLInputElement
    tags.focus()
    fireEvent.change(tags, { target: { value: "Premium, Popular, Low price" } })
    expect(document.activeElement).toBe(tags)
    expect(tags.value).toBe("Premium, Popular, Low price")
  })
})

describe("ô Màu vẫn báo lỗi bằng tiếng Việt khi vượt 32 ký tự", () => {
  it("chuỗi quá dài thì hiện lỗi và KHÔNG gửi lên BE", async () => {
    renderEdit()
    fireEvent.change(screen.getByLabelText("Màu (hex/tên)"), {
      target: { value: "x".repeat(33) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }))

    expect(await screen.findByText("Màu tối đa 32 ký tự")).toBeInTheDocument()
    expect(updateMutate).not.toHaveBeenCalled()
  })
})
