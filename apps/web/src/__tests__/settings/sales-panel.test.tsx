import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }))

/** Cài đặt › Kết nối & AI › Bán hàng: KiotViet chưa nối ⇒ "Chưa kết nối"; nối ⇒ gửi đúng khoá; hoá đơn đồng bộ hiện danh sách. */
const mockGet = vi.fn()
const mockPut = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => mockGet(...a), put: (...a: unknown[]) => mockPut(...a), post: (...a: unknown[]) => mockPost(...a), delete: vi.fn() },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { SalesPanel } from "@/app/(dashboard)/settings/_components/integrations/sales/sales-panel"

const INITIAL = useAuthStore.getState()
const grant = (...perms: string[]) => useAuthStore.setState({ permissions: Object.fromEntries(perms.map((p) => [p, true])) as never })
const kv = (over: Record<string, unknown> = {}) => ({ provider: "kiotviet", connected: false, status: "not_connected", settings: null, last_event_at: null, last_error: null, webhook_path: "/api/v1/connectors/kiotviet/webhook", secret_key_configured: true, ...over })

function setup(conn = kv(), invoices: unknown[] = []) {
  mockGet.mockImplementation(async (url: string, cfg?: { params?: { kind?: string } }) => {
    if (url === "/connectors/commerce") return { data: [conn] }
    if (url === "/connectors/records") return { data: cfg?.params?.kind === "invoice" ? invoices : [] }
    throw new Error(`unexpected ${url}`)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SalesPanel /></QueryClientProvider>)
}
beforeEach(() => { mockGet.mockReset(); mockPut.mockReset(); mockPost.mockReset() })
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("<SalesPanel>", () => {
  it("chưa nối ⇒ Chưa kết nối; nối ⇒ PUT đúng tên gian hàng + khoá", async () => {
    grant("integrations.webhooks", "deals.view")
    mockPut.mockResolvedValue({ data: { first_sync: { added: { customers: 3, invoices: 5, orders: 0, products: 2 }, more: false } } })
    setup()
    const row = await screen.findByTestId("conn-kiotviet")
    expect(within(row).getByText("Chưa kết nối")).toBeTruthy()
    fireEvent.click(within(row).getByRole("button", { name: "Kết nối" }))
    fireEvent.change(screen.getByLabelText("Tên gian hàng"), { target: { value: "cuahangabc" } })
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "cid-123456" } })
    fireEvent.change(screen.getByLabelText("Mã bảo mật (Client Secret)"), { target: { value: "secret-value-x" } }) // gitleaks:allow — khoá giả
    fireEvent.click(screen.getByRole("button", { name: /Kết nối$/ }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("/connectors/kiotviet", { retailer: "cuahangabc", client_id: "cid-123456", client_secret: "secret-value-x" }))
  })

  it("Sapo: nhập tên cửa hàng + API key + secret ⇒ PUT /connectors/sapo", async () => {
    grant("integrations.webhooks", "deals.view")
    mockPut.mockResolvedValue({ data: { first_sync: { added: { customers: 1, orders: 2, products: 3 }, more: false } } })
    setup()
    fireEvent.click(within(await screen.findByTestId("conn-sapo")).getByRole("button", { name: "Kết nối" }))
    fireEvent.change(screen.getByLabelText("Tên cửa hàng"), { target: { value: "cuahangabc" } })
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key12345678" } })
    fireEvent.change(screen.getByLabelText("Mật khẩu (API secret)"), { target: { value: "secret-value-x" } }) // gitleaks:allow — khoá giả
    fireEvent.click(screen.getByRole("button", { name: /Kết nối$/ }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("/connectors/sapo", { store: "cuahangabc", api_key: "key12345678", secret: "secret-value-x" }))
  })

  it("WooCommerce: địa chỉ + ck/cs ⇒ PUT /connectors/woocommerce", async () => {
    grant("integrations.webhooks", "deals.view")
    mockPut.mockResolvedValue({ data: { first_sync: { added: { customers: 0, orders: 1, products: 4 }, more: false } } })
    setup()
    fireEvent.click(within(await screen.findByTestId("conn-woocommerce")).getByRole("button", { name: "Kết nối" }))
    fireEvent.change(screen.getByLabelText("Địa chỉ cửa hàng"), { target: { value: "https://shop.example.com" } })
    fireEvent.change(screen.getByLabelText("Consumer key"), { target: { value: "ck_abc" } })
    fireEvent.change(screen.getByLabelText("Consumer secret"), { target: { value: "cs_def" } }) // gitleaks:allow — khoá giả
    fireEvent.click(screen.getByRole("button", { name: /Kết nối$/ }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("/connectors/woocommerce", { url: "https://shop.example.com", consumer_key: "ck_abc", consumer_secret: "cs_def" }))
  })

  it("Shopee: máy chủ chưa cấu hình ⇒ tắt nút; đã cấu hình ⇒ Kết nối xin URL cấp quyền của sàn", async () => {
    grant("integrations.webhooks", "deals.view")
    mockPost.mockResolvedValue({ data: { authorize_url: "https://partner.test-stable.shopeemobile.com/api/v2/shop/auth_partner?x=1" } })
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/connectors/commerce") return { data: [kv(), kv({ provider: "shopee", server_configured: true }), kv({ provider: "lazada", server_configured: false })] }
      return { data: [] }
    })
    const assign = vi.fn()
    Object.defineProperty(window, "location", { value: { ...window.location, set href(v: string) { assign(v) } }, writable: true })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><SalesPanel /></QueryClientProvider>)
    const lz = await screen.findByTestId("conn-lazada")
    expect((within(lz).getByRole("button", { name: /Kết nối/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(lz).getByText(/LAZADA_APP_KEY/)).toBeTruthy()
    fireEvent.click(within(screen.getByTestId("conn-shopee")).getByRole("button", { name: /Kết nối/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/connectors/shopee/connect"))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining("shopeemobile.com")))
  })

  it("MISA: máy chủ chưa đặt MISA_APP_ID ⇒ nút Kết nối tắt + ghi chú rõ", async () => {
    grant("integrations.webhooks", "deals.view")
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/connectors/commerce") return { data: [kv(), kv({ provider: "misa", server_configured: false })] }
      return { data: [] }
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><SalesPanel /></QueryClientProvider>)
    const row = await screen.findByTestId("conn-misa")
    expect((within(row).getByRole("button", { name: "Kết nối" }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(row).getByText(/MISA_APP_ID/)).toBeTruthy()
  })

  it("đã nối ⇒ số đếm + nút Đồng bộ gọi API; hoá đơn hiện mã, tiền, mặt hàng", async () => {
    grant("integrations.webhooks", "deals.view")
    mockPost.mockResolvedValue({ data: { added: { customers: 0, invoices: 1, orders: 0, products: 0 }, more: false } })
    setup(kv({ connected: true, status: "active", settings: { retailer: "cuahangabc", counts: { customers: 3, invoices: 5 } } }), [
      { id: 1, provider: "kiotviet", kind: "invoice", external_id: "77", code: "HD0001", name: "Nguyễn Văn An", contact_id: 11, amount: 350000, status: "Hoàn thành", data: { items: [{ name: "Cà phê", quantity: 2, price: 25000 }] }, external_updated_at: "2026-10-15T02:30:00.000Z" },
    ])
    const row = await screen.findByTestId("conn-kiotviet")
    expect(within(row).getByText(/3 khách · 5 hoá đơn/)).toBeTruthy()
    expect(within(screen.getByTestId("conn-sapo")).getByText("Chưa kết nối")).toBeTruthy()
    fireEvent.click(within(row).getByRole("button", { name: /Đồng bộ/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/connectors/kiotviet/sync"))
    expect(await screen.findByText("HD0001")).toBeTruthy()
    expect(screen.getByText(/Cà phê ×2/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "Xem khách" }).getAttribute("href")).toBe("/contacts/11")
  })
})
