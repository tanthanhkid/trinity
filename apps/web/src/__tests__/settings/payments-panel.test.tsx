import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/** Cài đặt › Kết nối & AI › Thanh toán: SePay chưa kết nối ⇒ "Chưa kết nối" (không báo lỗi); kết nối ⇒ hiện khoá ĐÚNG MỘT LẦN; QR của yêu cầu chờ trả. */
const mockGet = vi.fn()
const mockPut = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    put: (...a: unknown[]) => mockPut(...a),
    post: (...a: unknown[]) => mockPost(...a),
    delete: vi.fn(),
  },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { PaymentsPanel } from "@/app/(dashboard)/settings/_components/integrations/payments/payments-panel"

const INITIAL = useAuthStore.getState()
const grant = (...perms: string[]) => useAuthStore.setState({ permissions: Object.fromEntries(perms.map((p) => [p, true])) as never })
const sepay = (over: Record<string, unknown> = {}) => ({
  provider: "sepay", connected: false, status: "not_connected", settings: null, last_event_at: null, last_error: null,
  webhook_path: "/api/v1/connectors/sepay/webhook", secret_key_configured: true, ...over,
})
const payment = (over: Record<string, unknown> = {}) => ({
  id: 1, code: "TRN7K2QXM", amount: 150000, description: "Học phí", status: "pending", source_type: "manual", source_id: null, contact_id: null,
  paid_amount: null, paid_via: null, paid_at: null, expires_at: null, created_at: "2026-10-14T15:00:00.000Z", transfer_content: "TRN7K2QXM",
  qr_url: "https://qr.sepay.vn/img?acc=0123499999&bank=MBBank&amount=150000&des=TRN7K2QXM", bank: { account_number: "0123499999", bank: "MBBank", account_name: null }, ...over,
})

function setup(conn = sepay(), payments: unknown[] = []) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/connectors") return { data: [conn] }
    if (url === "/payments") return { data: payments }
    throw new Error(`unexpected ${url}`)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><PaymentsPanel /></QueryClientProvider>)
}

beforeEach(() => { mockGet.mockReset(); mockPut.mockReset(); mockPost.mockReset() })
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("<PaymentsPanel>", () => {
  it("chưa kết nối ⇒ 'Chưa kết nối' + nút Kết nối, không báo lỗi", async () => {
    grant("integrations.webhooks", "deals.view", "deals.manage")
    setup()
    const row = await screen.findByTestId("conn-sepay")
    expect(within(row).getByText("Chưa kết nối")).toBeTruthy()
    expect(within(row).getByRole("button", { name: "Kết nối" })).toBeTruthy()
    expect(within(screen.getByTestId("conn-vnpay")).getByText("Chưa kết nối")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("Chưa có yêu cầu thanh toán")).toBeTruthy()
  })

  it("kết nối ⇒ gửi đúng cấu hình và hiện API key một lần", async () => {
    grant("integrations.webhooks", "deals.view")
    mockPut.mockResolvedValue({ data: { status: sepay({ connected: true }), api_key: "sepay_secret123" } })
    setup()
    fireEvent.click(within(await screen.findByTestId("conn-sepay")).getByRole("button", { name: "Kết nối" }))
    fireEvent.change(screen.getByLabelText("Số tài khoản"), { target: { value: "0123499999" } })
    fireEvent.change(screen.getByLabelText("Ngân hàng"), { target: { value: "MBBank" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("/connectors/sepay", expect.objectContaining({ account_number: "0123499999", bank: "MBBank", code_prefix: "TRN" })))
    expect(await screen.findByText("sepay_secret123")).toBeTruthy()
  })

  it("đã kết nối nhưng chưa có giao dịch ⇒ chờ giao dịch đầu tiên + địa chỉ webhook", async () => {
    grant("integrations.webhooks")
    setup(sepay({ connected: true, status: "active", settings: { account_number: "0123499999", bank: "MBBank", code_prefix: "TRN" } }))
    await waitFor(() => expect(screen.getByText("Chờ giao dịch đầu tiên")).toBeTruthy())
    expect(screen.getByText(/\/api\/v1\/connectors\/sepay\/webhook$/)).toBeTruthy()
  })

  it("VNPay: dán khoá ⇒ PUT /connectors/vnpay, mặc định môi trường thử", async () => {
    grant("integrations.webhooks")
    mockPut.mockResolvedValue({ data: sepay({ provider: "vnpay", connected: true }) })
    setup()
    fireEvent.click(within(await screen.findByTestId("conn-vnpay")).getByRole("button", { name: "Kết nối" }))
    fireEvent.change(screen.getByLabelText("Mã website (vnp_TmnCode)"), { target: { value: "TESTTMN1" } })
    fireEvent.change(screen.getByLabelText("Chuỗi bí mật (vnp_HashSecret)"), { target: { value: "SECRETKEY123456789" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }))
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith("/connectors/vnpay", expect.objectContaining({ tmn_code: "TESTTMN1", hash_secret: "SECRETKEY123456789", sandbox: true }))) // gitleaks:allow — khoá giả
  })

  it("bấm yêu cầu chờ trả ⇒ hiện QR + nội dung chuyển khoản", async () => {
    grant("deals.view")
    setup(sepay(), [payment(), payment({ id: 2, code: "TRNAAAAAA", status: "paid", paid_at: "2026-10-14T16:00:00.000Z", paid_amount: 150000, qr_url: null })])
    expect(mockGet).not.toHaveBeenCalledWith("/connectors")
    fireEvent.click(await screen.findByText("TRN7K2QXM"))
    const img = await screen.findByRole("img")
    expect(img.getAttribute("src")).toContain("des=TRN7K2QXM")
    expect(screen.getAllByText("Đã thanh toán").length).toBeGreaterThan(0)
  })
})
