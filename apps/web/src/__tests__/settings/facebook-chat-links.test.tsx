import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/** Cài đặt > Fanpage > Link / QR mở chat: danh sách link + QR, tạo link với nguồn khách. */
const mockGet = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))
vi.mock("react-qr-code", () => ({ default: ({ value }: { value: string }) => <div data-testid="qr">{value}</div> }))

import { FacebookChatLinks, qrFileName } from "@/app/(dashboard)/settings/_components/integrations/facebook-chat-links"

const PAGE = { id: 1, page_id: "111", name: "Trinity Software", is_active: true } as never
const LINK = {
  id: 4, code: "abcd2345", name: "Tờ rơi quán", page_id: "111", page_name: "Trinity Software", source_id: 12, source_label: "Tờ rơi",
  is_active: true, clicks: 7, chats: 3, url: "https://crm.example.vn/api/v1/facebook/go/abcd2345", messenger_url: "https://m.me/111?ref=abcd2345", created_at: "2026-10-14T01:00:00.000Z",
}

function renderIt(links: unknown[]) {
  mockGet.mockResolvedValue({ data: { data: links } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><FacebookChatLinks pages={[PAGE]} sources={[{ id: 12, label: "Tờ rơi" }]} highlight={4} /></QueryClientProvider>)
}

describe("FacebookChatLinks", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("tên tệp QR bỏ dấu, an toàn", () => {
    expect(qrFileName("Tờ rơi quán Đà Lạt!")).toBe("qr-to-roi-quan-da-lat.png")
    expect(qrFileName("???")).toBe("qr-mo-chat.png")
  })

  it("hiện link qua Trinity trong QR, nguồn, lượt mở và số khách vào chat; tô sáng link được trỏ tới", async () => {
    renderIt([LINK])
    expect(await screen.findByText("Tờ rơi quán")).toBeInTheDocument()
    expect(screen.getByTestId("qr")).toHaveTextContent(LINK.url)
    expect(screen.getByText(/Nguồn khách: Tờ rơi/)).toBeInTheDocument()
    expect(screen.getByTestId("chat-link-card").textContent).toContain("7 lượt mở · 3 khách vào chat")
    expect(screen.getByTestId("chat-link-card").className).toContain("ring-2")
  })

  it("tạo link: gửi tên + Page (một Page thì tự chọn) + nguồn null khi để theo Fanpage", async () => {
    renderIt([])
    expect(await screen.findByText("Chưa có link mở chat nào.")).toBeInTheDocument()
    mockPost.mockResolvedValue({ data: LINK })
    fireEvent.click(screen.getByRole("button", { name: /Tạo link mở chat/ }))
    fireEvent.change(screen.getByLabelText("Tên link"), { target: { value: "QR bàn 5" } })
    fireEvent.click(screen.getByRole("button", { name: /^Tạo link$/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/facebook/chat-links", { name: "QR bàn 5", page_id: "111", source_id: null }))
  })
})
