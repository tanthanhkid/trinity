import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mockGet = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), post: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { EMPTY_FILTER, InteractionsView, filterParams } from "@/app/(dashboard)/inbox/_components/interactions-view"

const ROW = {
  key: "fb-comment:9", channel: "facebook", type: "comment", page_id: "p1", channel_name: "AiiLab", at: "2026-10-16T07:47:00.000Z",
  customer_name: "Thành", contact_id: 280, text: "Bé 9 tuổi học được không?", post_url: "https://www.facebook.com/p1_5", rule_name: "Ảnh bìa",
  auto_result: 'Luật "Ảnh bìa": đã trả lời công khai, đã nhắn riêng', hidden: false, status: "auto", ref: { comment_id: "9" },
}

describe("filterParams", () => {
  it("chuyển bộ lọc thành tham số API (ngày theo giờ VN)", () => {
    expect(filterParams(EMPTY_FILTER)).toEqual({})
    expect(filterParams({ ...EMPTY_FILTER, type: "comment", unanswered: true, rule: "1", from: "2026-10-16", q: " giá " }))
      .toEqual({ type: "comment", status: "unanswered", has_rule: "1", from: "2026-10-16T00:00:00+07:00", q: "giá" })
  })
})

describe("<InteractionsView>", () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/interactions/stats") return { data: { messages_today: 4, comments_today: 2, auto_handled_today: 1, unanswered_7d: 3 } }
      if (url === "/interactions") return { data: { data: [ROW], next_before: null } }
      if (url === "/interactions/comments/9/thread") return { data: { comments: [{ id: "9", message: ROW.text, at: ROW.at, status: "done", hidden: false, can_private_reply: false, actions: {} }], conversation: { id: 3, customer_name: "Thành" }, messages: [{ id: "1", direction: "out", text: "Chào Thành", at: ROW.at }] } }
      throw new Error(url)
    })
  })

  it("số hôm nay + dòng có kết quả luật; bấm mở chuỗi bình luận và tin nhắn riêng, có ô trả lời", async () => {
    const onOpen = vi.fn()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InteractionsView onOpenConversation={onOpen} /></QueryClientProvider>)
    await waitFor(() => expect(screen.getByTestId("interaction-stats").textContent).toContain("4"))
    expect(await screen.findByText(/đã nhắn riêng/)).toBeTruthy()
    expect(screen.getByText("Luật đã trả lời")).toBeTruthy()
    fireEvent.click(screen.getByTestId("interaction-row"))
    expect(await screen.findByText("Chào Thành")).toBeTruthy()
    expect(screen.getByTestId("comment-reply-open")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Nhắn tiếp trong Hộp thư/ }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ type: "message", ref: { conversation_id: 3 } }))
  })
})
