import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/** Cài đặt > Fanpage > Bình luận tự động: luật, thử luật (không gửi gì), bình luận gần đây; không lộ thuật ngữ kỹ thuật. */
const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    delete: vi.fn(),
  },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

import { FacebookComments } from "@/app/(dashboard)/settings/_components/integrations/facebook-comments"

const PAGE = { id: 1, page_id: "111", name: "Phần mềm Trinity" } as never
const RULE = {
  id: 3, name: "Gửi bảng giá", page_id: "111", post_id: null, keywords: ["giá"], exclude_keywords: [], public_replies: ["Đã nhắn {ten}"],
  private_reply: "Chào {ten}, bảng giá đây", hide_if_phone: true, once_per_user: true, mode: "test", is_active: true, position: 0,
}
const COMMENT = {
  id: "9", page_id: "111", page_name: "Phần mềm Trinity", post_id: "111_5", post_url: "https://www.facebook.com/111_5", from_name: "Lan", message: "Giá sao ạ",
  commented_at: "2026-10-13T14:00:00.000Z", contact_id: 50, phone: null, rule_name: "Gửi bảng giá", status: "done", note: null, hidden: false,
  actions: { public_reply: { text: "Đã nhắn Lan", id: "r1" }, private_reply: { text: "Chào Lan, bảng giá đây", error: "Không nhắn riêng được: ứng dụng Facebook chưa có quyền" } },
}

function setup(enabled = true) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/facebook/comment-rules") return { data: { data: [RULE] } }
    if (url === "/facebook/comments") return { data: { data: [COMMENT] } }
    throw new Error(url)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><FacebookComments pages={[PAGE]} enabled={enabled} /></QueryClientProvider>)
}

beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); mockPatch.mockReset() })

describe("FacebookComments", () => {
  it("hiện luật (chạy thử) và bình luận đã xử lý, lỗi từng việc ghi rõ", async () => {
    setup()
    expect(await screen.findByText("Gửi bảng giá")).toBeTruthy()
    expect(screen.getByText("Chạy thử")).toBeTruthy()
    expect(await screen.findByText("Giá sao ạ")).toBeTruthy()
    expect(screen.getByText(/Đã trả lời công khai: “Đã nhắn Lan”/)).toBeTruthy()
    expect(screen.getByText(/Chưa nhắn riêng qua Messenger.*chưa có quyền/)).toBeTruthy()
  })

  it("thử luật: gọi máy chủ chạy thử, hiện việc sẽ làm", async () => {
    setup()
    mockPost.mockResolvedValueOnce({ data: { matched_rule: { id: 3, name: "Gửi bảng giá", mode: "test" }, phone_found: null, actions: { private_reply: { text: "Chào Lan, bảng giá đây" } } } })
    fireEvent.change(screen.getByLabelText("Bình luận mẫu"), { target: { value: "giá?" } })
    fireEvent.click(screen.getByRole("button", { name: "Thử" }))
    await waitFor(() => expect(screen.getByTestId("dry-run-result").textContent).toMatch(/Sẽ nhắn riêng/))
    expect(mockPost).toHaveBeenCalledWith("/facebook/comment-rules/dry-run", expect.objectContaining({ message: "giá?", page_id: "111" }))
  })

  it("chưa có quyền bình luận ⇒ nhắc, vẫn soạn luật được", async () => {
    setup(false)
    expect(screen.getByText(/chưa được cấp quyền đọc và trả lời bình luận/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Thêm luật/ })).toBeTruthy()
  })

  it("Lưu luật: link bài + Mọi Fanpage (một Page) ⇒ tự chọn Page và gửi; lỗi máy chủ hiện ngay trong hộp thoại", async () => {
    setup()
    fireEvent.click(await screen.findByRole("button", { name: /Thêm luật/ }))
    fireEvent.change(await screen.findByLabelText(/Tên luật/), { target: { value: "Ảnh bìa" } })
    fireEvent.change(screen.getByLabelText(/Chỉ bài này/), { target: { value: "https://www.facebook.com/photo/?fbid=122112283401318324" } })
    fireEvent.change(screen.getByLabelText(/Nhắn riêng qua Messenger/), { target: { value: "Chào {ten}" } })
    mockPost.mockRejectedValueOnce(Object.assign(new Error("400"), { response: { status: 400, data: { message: "Không đọc được bài từ link này" } } }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu luật" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/facebook/comment-rules", expect.objectContaining({ page_id: "111", post_id: "https://www.facebook.com/photo/?fbid=122112283401318324" })))
    expect((await screen.findByTestId("rule-form-error")).textContent).toMatch(/Không đọc được bài/)
    expect(screen.getByRole("button", { name: "Lưu luật" })).toBeTruthy()
  })

  it("link có id Page chưa nối ⇒ báo lỗi trong hộp thoại, không gửi", async () => {
    setup()
    fireEvent.click(await screen.findByRole("button", { name: /Thêm luật/ }))
    fireEvent.change(await screen.findByLabelText(/Tên luật/), { target: { value: "Sai page" } })
    fireEvent.change(screen.getByLabelText(/Chỉ bài này/), { target: { value: "https://www.facebook.com/999999_123456" } })
    fireEvent.change(screen.getByLabelText(/Nhắn riêng qua Messenger/), { target: { value: "Chào" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu luật" }))
    expect((await screen.findByTestId("rule-form-error")).textContent).toMatch(/chưa nối/)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it("permalink có id không trùng Page đã nối ⇒ không tự gán Page duy nhất, yêu cầu chọn Fanpage", async () => {
    setup()
    fireEvent.click(await screen.findByRole("button", { name: /Thêm luật/ }))
    fireEvent.change(await screen.findByLabelText(/Tên luật/), { target: { value: "Permalink" } })
    fireEvent.change(screen.getByLabelText(/Chỉ bài này/), { target: { value: "https://www.facebook.com/permalink.php?story_fbid=123456&id=999999" } })
    fireEvent.change(screen.getByLabelText(/Nhắn riêng qua Messenger/), { target: { value: "Chào" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu luật" }))
    expect((await screen.findByTestId("rule-form-error")).textContent).toMatch(/Fanpage nào/)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it("explicitPageRef đọc id Page từ mọi dạng link", async () => {
    const { explicitPageRef } = await import("@/app/(dashboard)/settings/_components/integrations/facebook-comments")
    expect(explicitPageRef("https://www.facebook.com/1090368650834107_122112283401318324")).toEqual({ kind: "pair", id: "1090368650834107" })
    expect(explicitPageRef("https://www.facebook.com/permalink.php?story_fbid=123456&id=999999")).toEqual({ kind: "id", id: "999999" })
    expect(explicitPageRef("https://www.facebook.com/999999/posts/123456")).toEqual({ kind: "path", id: "999999" })
    expect(explicitPageRef("https://www.facebook.com/photo/?fbid=122112283401318324")).toBeNull()
  })

  it("không có thuật ngữ kỹ thuật", async () => {
    const { container } = setup()
    await screen.findByText("Giá sao ạ")
    expect(container.textContent).not.toMatch(/webhook|API|token|MCP|PSID/i)
  })

  it("trả lời tay: chọn nhắn riêng, gửi đúng API; lọc chưa trả lời gọi máy chủ với unanswered=1", async () => {
    setup()
    mockPost.mockResolvedValueOnce({ data: { id: "9", answered: true } })
    await screen.findByText("Giá sao ạ")
    fireEvent.click(screen.getByTestId("comment-reply-open"))
    fireEvent.click(screen.getByRole("button", { name: "Nhắn riêng (Messenger)" }))
    fireEvent.change(screen.getByLabelText("Nội dung trả lời"), { target: { value: "Em gửi bảng giá ạ" } })
    fireEvent.click(screen.getByTestId("comment-reply-send"))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/facebook/comments/9/reply", { text: "Em gửi bảng giá ạ", mode: "private" }))
    fireEvent.click(screen.getByTestId("comments-unanswered"))
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/facebook/comments", { params: { limit: 30, unanswered: 1 } }))
  })
})
