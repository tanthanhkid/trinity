import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const created = vi.fn()
const menu = {
  categories: [{ id: 1, code: "cf", name: "Cà phê" }, { id: 2, code: "tr", name: "Trà" }],
  products: [
    { id: 1, code: "CF1", name: "Cà phê sữa", price: 30000, image_url: null, category_id: 1 },
    { id: 2, code: "TR1", name: "Trà đào", price: 45000, image_url: null, category_id: 2 },
  ],
}
const modifiers = [{ id: 10, group_name: "Size", name: "L", price_delta: 5000, sort_order: 0, is_active: true }]
let mods = modifiers

vi.mock("@/hooks/pos/use-pos", () => ({
  usePosMenu: () => ({ data: menu, isLoading: false, isError: false }),
  usePosModifiers: () => ({ data: mods }),
  usePosTables: () => ({ data: [{ id: 3, area_id: 1, name: "B1", sort_order: 0, is_active: true, open_order: null }] }),
  usePosAreas: () => ({ data: [{ id: 1, name: "Tầng 1", sort_order: 0, is_active: true }] }),
  usePosOrders: () => ({ data: [] }),
  useCreateOrder: () => ({ isPending: false, mutateAsync: created }),
  useUpdateOrder: () => ({ isPending: false, mutateAsync: vi.fn() }),
  usePayOrder: () => ({ isPending: false, mutate: vi.fn() }),
  useVoidOrder: () => ({ isPending: false, mutate: vi.fn() }),
  fetchPosQr: vi.fn(),
}))
vi.mock("react-qr-code", () => ({ default: () => null }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/lib/api-client", () => ({ default: { get: vi.fn() }, getApiErrorMessage: (_e: unknown, f: string) => f }))

import { PosSell } from "@/app/(dashboard)/pos/_components/pos-sell"
import { PosPrintProvider } from "@/app/(dashboard)/pos/_components/pos-receipt"

/** jsdom không có matchMedia — `useIsPhone` cần. matches=true giả lập điện thoại (<640px). */
const stubPhone = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }),
  })
stubPhone(false)

const renderSell = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PosPrintProvider><PosSell /></PosPrintProvider>
    </QueryClientProvider>,
  )

describe("PosSell", () => {
  beforeEach(() => { created.mockReset(); mods = modifiers })

  it("chạm món có tuỳ chọn → hộp thoại chọn size → vào giỏ với giá cộng thêm", () => {
    renderSell()
    fireEvent.click(screen.getByRole("button", { name: /Cà phê sữa/ }))
    fireEvent.click(screen.getByRole("button", { name: /^L \(\+5\.000đ\)/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Thêm · 35\.000đ/ }))
    const cart = screen.getByRole("complementary", { name: "Giỏ hàng" })
    expect(cart).toHaveTextContent("Cà phê sữa")
    expect(cart).toHaveTextContent("35.000đ")
  })

  it("không có tuỳ chọn nào → thêm thẳng 1 chạm; lọc theo danh mục và tìm nhanh", () => {
    mods = []
    renderSell()
    fireEvent.click(screen.getByRole("tab", { name: "Trà" }))
    expect(screen.queryByRole("button", { name: /Cà phê sữa/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Trà đào/ }))
    fireEvent.click(screen.getByRole("button", { name: "Tăng Trà đào" }))
    expect(screen.getByRole("complementary", { name: "Giỏ hàng" })).toHaveTextContent("90.000đ")
    fireEvent.change(screen.getByLabelText("Tìm món"), { target: { value: "zzz" } })
    expect(screen.getByText("Không có món phù hợp.")).toBeInTheDocument()
  })

  it("Lưu đơn gửi payload chỉ có id/số lượng (không giá/tổng) và nạp lại số liệu BE", async () => {
    mods = []
    created.mockResolvedValue({
      id: 9, code: "20260930-0001", shift_id: 1, table_id: null, order_type: "dine_in", status: "open", note: null,
      subtotal: 30000, discount_type: "none", discount_value: 0, discount_amount: 0, total: 30000,
      created_by: 1, created_at: "2026-09-30T03:00:00Z", paid_by: null, paid_at: null, void_reason: null,
      items: [{ id: 1, product_id: 1, product_name: "Cà phê sữa", unit_price: 30000, quantity: 1, options: [], note: null, line_total: 30000 }], payments: [],
    })
    renderSell()
    fireEvent.click(screen.getByRole("button", { name: /Cà phê sữa/ }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu đơn" }))
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    const body = created.mock.calls[0][0]
    expect(body.items).toEqual([{ product_id: 1, quantity: 1 }])
    expect(JSON.stringify(body)).not.toMatch(/price|total/)
    await waitFor(() => expect(screen.getByText("Đơn 20260930-0001")).toBeInTheDocument())
  })

  it("giỏ trống: nút Thanh toán / Lưu đơn bị khoá", () => {
    renderSell()
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Lưu đơn" })).toBeDisabled()
  })
})

describe("PosSell — điện thoại", () => {
  beforeEach(() => { created.mockReset(); mods = []; stubPhone(true) })
  afterEach(() => { stubPhone(false) })

  it("giỏ rỗng: thanh đáy gọn 'Chạm món để thêm', chưa dựng giỏ chi tiết", () => {
    renderSell()
    expect(screen.getByRole("button", { name: "Mở giỏ hàng" })).toHaveTextContent("Chạm món để thêm")
    expect(screen.queryByRole("complementary", { name: "Giỏ hàng" })).toBeNull()
  })

  it("thêm món → thanh đáy 'N món · Tổng' + Thanh toán; chạm mở giỏ trong bảng trượt (cùng PosCartPanel)", () => {
    renderSell()
    fireEvent.click(screen.getByRole("button", { name: /Cà phê sữa/ }))
    const bar = screen.getByRole("button", { name: /Mở giỏ hàng, 1 món/ })
    expect(bar).toHaveTextContent("30.000đ")
    expect(screen.getByRole("button", { name: "Thanh toán" })).toBeEnabled()
    fireEvent.click(bar)
    const cart = screen.getByRole("complementary", { name: "Giỏ hàng" })
    expect(cart).toHaveTextContent("Cà phê sữa")
    expect(within(cart).getByRole("button", { name: "Mới" })).toBeInTheDocument()
  })

  it("'Huỷ đơn này' không còn nằm cạnh nút Thanh toán trong giỏ (vào menu ⋯ khi đã có đơn)", async () => {
    created.mockResolvedValue({
      id: 9, code: "20260930-0001", shift_id: 1, table_id: null, order_type: "dine_in", status: "open", note: null,
      subtotal: 30000, discount_type: "none", discount_value: 0, discount_amount: 0, total: 30000,
      created_by: 1, created_at: "2026-09-30T03:00:00Z", paid_by: null, paid_at: null, void_reason: null,
      items: [{ id: 1, product_id: 1, product_name: "Cà phê sữa", unit_price: 30000, quantity: 1, options: [], note: null, line_total: 30000 }], payments: [],
    })
    renderSell()
    fireEvent.click(screen.getByRole("button", { name: /Cà phê sữa/ }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu đơn" }))
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: /Mở giỏ hàng/ }))
    const cart = screen.getByRole("complementary", { name: "Giỏ hàng" })
    expect(within(cart).queryByRole("button", { name: "Huỷ đơn này" })).toBeNull()
    expect(within(cart).getByRole("button", { name: "Thao tác khác" })).toBeInTheDocument()
  })
})
