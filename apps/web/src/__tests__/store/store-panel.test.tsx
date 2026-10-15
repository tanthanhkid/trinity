import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

const mockGet = vi.fn()
const mockPut = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), put: (...a: unknown[]) => mockPut(...a), patch: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { StorePanel } from "@/app/(dashboard)/settings/_components/integrations/store/store-panel"

const INITIAL = useAuthStore.getState()
const grant = (...perms: string[]) => useAuthStore.setState({ permissions: Object.fromEntries(perms.map((p) => [p, true])) as never })
const SETTINGS = { slug: "", name: "", tagline: null, theme: "toi-gian", accent: "#2563eb", phone: null, address: null, cover_url: null, logo_url: null, cod: true, bank_transfer: false, published: false, product_ids: [] }

beforeEach(() => { mockGet.mockReset(); mockPut.mockReset() })
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("<StorePanel>", () => {
  it("chọn sản phẩm có giá, đặt địa chỉ, chọn giao diện, mở bán ⇒ PUT đúng cấu hình", async () => {
    grant("pos.manage", "deals.view")
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/store/settings") return { data: SETTINGS }
      if (url === "/store/orders") return { data: [] }
      if (url.startsWith("/products")) return { data: [{ id: 10, name: "Bánh mì", price: 20000, is_active: true }, { id: 12, name: "Chưa có giá", price: null, is_active: true }] }
      throw new Error(url)
    })
    mockPut.mockImplementation(async (_u: string, b: unknown) => ({ data: b }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><StorePanel /></QueryClientProvider>)
    fireEvent.change(await screen.findByLabelText("Tên cửa hàng"), { target: { value: "Cửa hàng ABC" } })
    fireEvent.change(screen.getByLabelText("Địa chỉ trang"), { target: { value: "Cua-Hang-ABC" } })
    fireEvent.click(screen.getByRole("radio", { name: /Sôi động/ }))
    expect(await screen.findByText("Bánh mì")).toBeTruthy()
    expect(screen.queryByText("Chưa có giá")).toBeNull()
    fireEvent.click(screen.getByText("Bánh mì"))
    fireEvent.click(screen.getByRole("switch", { name: "Mở bán" }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("/store/settings", expect.objectContaining({ name: "Cửa hàng ABC", slug: "cua-hang-abc", theme: "soi-dong", product_ids: [10], published: true })))
    expect(await screen.findByText("Chưa có đơn nào")).toBeTruthy()
  })
})
