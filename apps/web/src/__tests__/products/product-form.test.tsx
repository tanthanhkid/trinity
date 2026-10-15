import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * Ô tiền có dấu phân cách hàng nghìn, ảnh minh hoạ chọn từ máy — popup Thêm/Sửa sản phẩm.
 */
const createMutate = vi.fn()
const uploadMutate = vi.fn()
const apiPost = vi.fn()

vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => apiPost(...a), get: vi.fn() },
}))
vi.mock("@/hooks/use-projects", () => ({
  useActiveProjects: () => ({ data: [], isLoading: false }),
}))
vi.mock("@/hooks/products/use-products", () => ({
  useCreateProduct: () => ({ mutate: createMutate, isPending: false, isError: false }),
  useUpdateProduct: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useUploadProductImage: () => ({ mutate: uploadMutate, isPending: false, isError: false }),
}))
vi.mock("@/hooks/products/use-product-categories", () => ({
  useProductCategories: () => ({ data: [], isLoading: false }),
  useAttributeDefs: () => ({ data: [], isLoading: false }),
}))

import { ProductFormDialog } from "@/app/(dashboard)/products/_components/product-form-dialog"
import { slugifyProjectCode } from "@/app/(dashboard)/products/_components/project-quick-create-dialog"
import { validateProductImageFile } from "@/app/(dashboard)/products/_components/product-image-field"
import {
  CurrencyInput,
  formatCurrencyDigits,
  toCurrencyDigits,
} from "@/components/ui/currency-input"
import { useState } from "react"

function renderCreate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ProductFormDialog open onClose={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  createMutate.mockClear()
  uploadMutate.mockClear()
  apiPost.mockClear()
})

describe("định dạng tiền", () => {
  it("formatCurrencyDigits / toCurrencyDigits", () => {
    expect(formatCurrencyDigits("")).toBe("")
    expect(formatCurrencyDigits("999")).toBe("999")
    expect(formatCurrencyDigits("1500000")).toBe("1.500.000")
    expect(toCurrencyDigits("1.500.000 đ")).toBe("1500000")
    expect(toCurrencyDigits("007")).toBe("7")
    expect(toCurrencyDigits("0")).toBe("0")
    expect(toCurrencyDigits("abc")).toBe("")
    expect(toCurrencyDigits("-5")).toBe("5")
    expect(toCurrencyDigits("9".repeat(20))).toHaveLength(15)
  })

  it("CurrencyInput: gõ tới đâu hiện dấu chấm tới đó, state giữ chuỗi chữ số", () => {
    let latest = ""
    function Host() {
      const [v, setV] = useState("")
      latest = v
      return <CurrencyInput aria-label="tien" value={v} onValueChange={setV} />
    }
    render(<Host />)
    const el = screen.getByLabelText("tien") as HTMLInputElement
    fireEvent.change(el, { target: { value: "1500000" } })
    expect(el.value).toBe("1.500.000")
    expect(latest).toBe("1500000")
    fireEvent.change(el, { target: { value: "" } })
    expect(latest).toBe("")
  })

  it("gửi BE số nguyên; ô trống = null (không ép 0); '0' gửi 0", async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText(/Mã sản phẩm/), { target: { value: "SP-01" } })
    fireEvent.change(screen.getByLabelText(/Tên sản phẩm/), { target: { value: "Sản phẩm A" } })
    fireEvent.submit(screen.getByLabelText(/Tên sản phẩm/).closest("form") as HTMLFormElement)
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
    expect(createMutate.mock.calls[0][0].price).toBeNull()

    fireEvent.change(screen.getByLabelText("Giá (VNĐ)"), { target: { value: "2500000" } })
    expect((screen.getByLabelText("Giá (VNĐ)") as HTMLInputElement).value).toBe("2.500.000")
    fireEvent.submit(screen.getByLabelText(/Tên sản phẩm/).closest("form") as HTMLFormElement)
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(2))
    expect(createMutate.mock.calls[1][0].price).toBe(2500000)

    fireEvent.change(screen.getByLabelText("Giá (VNĐ)"), { target: { value: "0" } })
    fireEvent.submit(screen.getByLabelText(/Tên sản phẩm/).closest("form") as HTMLFormElement)
    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(3))
    expect(createMutate.mock.calls[2][0].price).toBe(0)
  })
})

describe("ảnh minh hoạ", () => {
  it("validateProductImageFile: chặn sai loại và quá 5MB", () => {
    expect(validateProductImageFile({ type: "image/png", size: 1000 })).toBeNull()
    expect(validateProductImageFile({ type: "application/pdf", size: 1000 })).toMatch(/JPG, PNG/)
    expect(validateProductImageFile({ type: "image/svg+xml", size: 1000 })).not.toBeNull()
    expect(validateProductImageFile({ type: "image/jpeg", size: 6 * 1024 * 1024 })).toMatch(/tối đa 5MB/)
  })

  it("chọn file hợp lệ → gọi upload; file sai loại → báo lỗi, không upload", () => {
    renderCreate()
    const input = screen.getByTestId("product-image-file") as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] },
    })
    expect(uploadMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/Chỉ chấp nhận ảnh/)).toBeInTheDocument()

    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    })
    expect(uploadMutate).toHaveBeenCalledTimes(1)
  })

  it("vẫn nhập được URL và hiện xem trước", () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText("Ảnh minh hoạ"), {
      target: { value: "https://cdn.example.com/a.png" },
    })
    expect(screen.getByAltText("Xem trước ảnh minh hoạ")).toHaveAttribute(
      "src",
      "https://cdn.example.com/a.png",
    )
  })
})

describe("tạo dự án nhanh", () => {
  it("slugifyProjectCode bỏ dấu, đúng ^[a-z0-9_]+$", () => {
    expect(slugifyProjectCode("Bán Lẻ")).toBe("ban_le")
    expect(slugifyProjectCode("  Đầu tư #1 ")).toBe("dau_tu_1")
  })

  it("dropdown Dự án có lối '+ Tạo dự án mới' dù danh sách rỗng", () => {
    renderCreate()
    fireEvent.click(screen.getByRole("combobox", { name: /Dự án/ }))
    expect(screen.getByText("+ Tạo dự án mới")).toBeInTheDocument()
  })
})
