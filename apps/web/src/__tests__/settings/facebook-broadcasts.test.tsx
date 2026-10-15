import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/** Cài đặt > Fanpage > Gửi hàng loạt: danh sách lượt gửi, đếm người nhận theo luật 24h, gửi có xác nhận, huỷ. */
const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a), patch: (...a: unknown[]) => mockPatch(...a), delete: vi.fn() },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

import { FacebookBroadcasts, broadcastScheduleError } from "@/app/(dashboard)/settings/_components/integrations/facebook-broadcasts"

const PAGE = { id: 1, page_id: "111", name: "Trinity Software", is_active: true } as never
const base = { page_id: "111", page_name: "Trinity Software", audience: {}, scheduled_at: null, total: 0, sent: 0, failed: 0, skipped: 0, source: "web", started_at: null, finished_at: null, created_at: "2026-10-14T01:00:00.000Z" }
const DONE = { ...base, id: 3, name: "Khai giảng", text: "Chào {ten}", status: "done", total: 5, sent: 3, failed: 1, skipped: 1, scheduled_at: "2026-10-14T02:00:00.000Z" }
const SENDING = { ...base, id: 4, name: "Khuyến mãi", text: "Giảm 20%", status: "sending", total: 10, sent: 2, source: "mcp" }
const RECIPIENTS = [{ id: 1, conversation_id: 9, customer_name: "Lan", contact_id: 2, status: "skipped", note: "Quá 24 giờ kể từ tin cuối của khách", sent_at: null }]

function renderIt(list: unknown[], highlight?: number) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/facebook/broadcasts") return { data: { data: list } }
    if (url.endsWith("/recipients")) return { data: { data: RECIPIENTS } }
    return { data: { data: [] } }
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><FacebookBroadcasts pages={[PAGE]} sources={[{ id: 7, label: "Fanpage" }]} highlight={highlight} /></QueryClientProvider>)
}

describe("FacebookBroadcasts", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("giờ hẹn: trống / quá gần / quá 7 ngày ⇒ lỗi", () => {
    const now = Date.parse("2026-10-14T08:00:00")
    expect(broadcastScheduleError("", now)).toMatch(/Chọn/)
    expect(broadcastScheduleError("2026-10-14T08:00", now)).toMatch(/1 phút/)
    expect(broadcastScheduleError("2026-10-22T08:00", now)).toMatch(/7 ngày/)
    expect(broadcastScheduleError("2026-10-15T08:00", now)).toBeNull()
  })

  it("thẻ lượt gửi: tiến độ, lỗi, bỏ qua vì quá 24h; trỏ tới thì mở sẵn người nhận", async () => {
    renderIt([SENDING, DONE], 3)
    expect(await screen.findByText("Khai giảng")).toBeInTheDocument()
    const [sending, done] = screen.getAllByTestId("broadcast-card")
    expect(sending.textContent).toContain("Đang gửi")
    expect(sending.textContent).toContain("Tạo qua trợ lý AI")
    expect(sending.textContent).toContain("Huỷ gửi")
    expect(done.textContent).toContain("Đã gửi 3/5")
    expect(done.textContent).toContain("1 lỗi")
    expect(done.textContent).toContain("1 bỏ qua (quá 24 giờ)")
    expect(done.className).toContain("ring-2")
    expect(await screen.findByTestId("broadcast-recipients")).toHaveTextContent("Quá 24 giờ")
  })

  it("soạn tin: đếm người nhận, xác nhận rồi mới tạo + gửi", async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === "/facebook/broadcasts/preview") return { data: { eligible: 4, outside_window: 9, sample: ["Lan", "Minh"] } }
      if (url === "/facebook/broadcasts") return { data: { ...base, id: 11, name: "Lịch học", text: "Chào {ten}", status: "draft" } }
      return { data: { ...base, id: 11, status: "scheduled" } }
    })
    renderIt([])
    fireEvent.click(await screen.findByRole("button", { name: /Soạn tin gửi hàng loạt/ }))
    fireEvent.change(screen.getByLabelText("Tên lượt gửi"), { target: { value: "Lịch học" } })
    fireEvent.change(screen.getByLabelText("Nội dung"), { target: { value: "Chào {ten}" } })
    const preview = await screen.findByTestId("broadcast-preview")
    expect(preview.textContent).toContain("4 khách sẽ nhận")
    expect(preview.textContent).toContain("9 khách khớp bộ lọc nhưng đã quá 24 giờ")
    fireEvent.click(screen.getByRole("button", { name: /Gửi ngay/ }))
    expect(mockPost).not.toHaveBeenCalledWith("/facebook/broadcasts", expect.anything())
    expect(await screen.findByText(/Tin đã gửi không thu hồi được/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Gửi" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/facebook/broadcasts/11/send", { scheduled_at: null }))
    expect(mockPost).toHaveBeenCalledWith("/facebook/broadcasts", { name: "Lịch học", page_id: "111", text: "Chào {ten}", audience: { source_ids: [], chat_link_ids: [] } })
  })
})
