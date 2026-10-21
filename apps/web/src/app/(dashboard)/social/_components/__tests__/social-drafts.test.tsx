import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import type { SocialDraft } from "@/hooks/use-social"
import { youtubeChoiceFrom, youtubeOptionsOf, EMPTY_YOUTUBE_CHOICE } from "../youtube-post-options"
import { composerStateFrom } from "../social-draft-state"
import { SocialDraftsList, draftLabel } from "../social-drafts-list"

const state = vi.hoisted(() => ({ drafts: [] as unknown[], loading: false }))
const api = vi.hoisted(() => ({ del: vi.fn(() => Promise.resolve({})), keepalive: vi.fn() }))
const toasts = vi.hoisted(() => ({ list: [] as { message: string; action?: { label: string; onClick: () => void } }[] }))

// Nháp đọc từ cache react-query thật (khoá ["social","drafts"]) như ứng dụng ⇒ thao tác "ẩn ngay" thấy được trong test.
vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialDrafts: () => {
    const q = useQuery({ queryKey: ["social", "drafts"], queryFn: () => state.drafts, initialData: state.drafts, staleTime: Infinity })
    return state.loading ? { data: undefined, isLoading: true, isError: false } : q
  },
  useSocialAccounts: () => ({ data: [{ id: 3, network: "facebook", name: "Fanpage", avatar_url: null, status: "active", last_error: null }] }),
}))
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  default: { delete: api.del },
  sendKeepalive: api.keepalive,
}))
vi.mock("sonner", () => {
  const push = (message: string, opts?: { action?: { label: string; onClick: () => void } }) => toasts.list.push({ message, action: opts?.action })
  return { toast: Object.assign(push, { success: push, error: push }) }
})

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const draft = (o: Partial<SocialDraft> = {}): SocialDraft => ({
  id: 1, title: null, content: "Dòng đầu\nDòng hai", media: [], targets: [], scheduled_at: null, ui: null, source: "web",
  created_at: "2026-10-15T01:00:00Z", updated_at: "2026-10-15T02:00:00Z", ...o,
})

describe("youtubeChoiceFrom", () => {
  it("đảo ngược youtubeOptionsOf", () => {
    const c = { title: "Tiêu đề", privacy: "public" as const, description: "Mô tả", tags: "a, b", category: "27" as const, kids: true, playlist: "PL1", thumbnail: { key: "social/u1_1_t.png", name: "t.png" } }
    const back = youtubeChoiceFrom(youtubeOptionsOf(c))
    expect(back).toEqual({ ...c, thumbnail: { key: "social/u1_1_t.png", name: "u1_1_t.png" } })
  })
  it("thiếu / sai giá trị ⇒ mặc định", () => {
    expect(youtubeChoiceFrom(undefined)).toEqual(EMPTY_YOUTUBE_CHOICE)
    expect(youtubeChoiceFrom({ privacy: "bậy", category_id: "999", tags: [1, "x"] })).toEqual({ ...EMPTY_YOUTUBE_CHOICE, tags: "x" })
  })
})

describe("composerStateFrom", () => {
  it("nháp của AI (không có ui): suy từ kênh, caption, tuỳ chọn, tệp, giờ", () => {
    const s = composerStateFrom(
      draft({
        content: "Chung",
        media: [{ key: "social/u1_1_a.png", type: "image", content_type: "image/png", size: 5, name: "a.png" }],
        targets: [
          { account_id: 3, caption: "Riêng", options: { first_comment: "Link" } },
          { account_id: 4, options: { title: "T", privacy: "unlisted" } },
        ],
        scheduled_at: "2030-01-01T00:00:00Z",
      }),
    )
    expect(s.selected).toEqual([3, 4])
    expect(s.captions[3]).toBe("Riêng")
    expect(s.openCaption[3]).toBe(true)
    expect(s.fbFirst[3]).toBe("Link")
    expect(s.ytChoice[4]).toMatchObject({ title: "T", privacy: "unlisted" })
    expect(s.uploads[0]).toMatchObject({ name: "a.png", item: { key: "social/u1_1_a.png" } })
    expect(s.scheduleOn).toBe(true)
    expect(s.scheduleAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
  it("nháp từ web: khôi phục nguyên ui", () => {
    const ui = { content: "Ui", selected: [3], captions: { 3: "x" }, openCaption: { 3: true }, ytChoice: {}, fbFirst: {}, ttChoice: {}, scheduleOn: false, scheduleAt: "", uploads: [] }
    expect(composerStateFrom(draft({ content: "Khác", ui }))).toEqual(ui)
  })
})

describe("danh sách nháp", () => {
  beforeEach(() => {
    state.loading = false
    state.drafts = []
  })
  it("tên nháp: tiêu đề, không thì dòng đầu nội dung", () => {
    expect(draftLabel({ title: " Khuyến mãi ", content: "x" })).toBe("Khuyến mãi")
    expect(draftLabel({ title: null, content: "\n  Dòng đầu\nhai" })).toBe("Dòng đầu")
    expect(draftLabel({ title: null, content: "" })).toBe("(Bài nháp trống)")
  })
  it("rỗng ⇒ lời nhắn tiếng Việt", () => {
    renderWithQuery(<SocialDraftsList onOpen={vi.fn()} />)
    expect(screen.getByText("Chưa có bài nháp")).toBeInTheDocument()
  })
  it("hiện nháp, kênh, giờ hẹn; Mở gọi onOpen với đúng nháp", () => {
    const d = draft({ targets: [{ account_id: 3 }], scheduled_at: "2030-01-01T00:00:00Z", source: "mcp" })
    state.drafts = [d]
    const onOpen = vi.fn()
    renderWithQuery(<SocialDraftsList onOpen={onOpen} />)
    expect(screen.getByText("Dòng đầu")).toBeInTheDocument()
    expect(screen.getByText(/Hẹn/)).toBeInTheDocument()
    expect(screen.getByText(/qua AI/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Mở" }))
    expect(onOpen).toHaveBeenCalledWith(d)
  })
  it("Xoá hỏi xác nhận trước", () => {
    state.drafts = [draft()]
    renderWithQuery(<SocialDraftsList onOpen={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /Xoá/ }))
    expect(screen.getByText("Xoá bài nháp?")).toBeInTheDocument()
  })

  describe("xoá có hoàn tác 5 giây", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      api.del.mockClear()
      api.keepalive.mockClear()
      toasts.list = []
    })
    afterEach(() => vi.useRealTimers())

    const confirmDelete = () => {
      fireEvent.click(screen.getByRole("button", { name: /Xoá/ }))
      fireEvent.click(screen.getByRole("button", { name: "Xoá nháp" }))
    }

    it("ẩn ngay; chưa gửi lệnh trong 5 giây; hết 5 giây mới gửi DELETE", async () => {
      state.drafts = [draft({ id: 7 })]
      renderWithQuery(<SocialDraftsList onOpen={vi.fn()} />)
      confirmDelete()
      expect(screen.queryByText("Dòng đầu")).toBeNull()
      expect(toasts.list.at(-1)).toMatchObject({ message: "Đã xoá bài nháp.", action: { label: "Hoàn tác" } })
      await act(async () => { vi.advanceTimersByTime(4999) })
      expect(api.del).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(api.del).toHaveBeenCalledWith("/social/drafts/7")
    })

    it("bấm Hoàn tác ⇒ không bao giờ gửi lệnh xoá", async () => {
      state.drafts = [draft({ id: 8 })]
      renderWithQuery(<SocialDraftsList onOpen={vi.fn()} />)
      confirmDelete()
      act(() => toasts.list.at(-1)!.action!.onClick())
      await act(async () => { vi.advanceTimersByTime(10_000) })
      expect(api.del).not.toHaveBeenCalled()
      expect(toasts.list.at(-1)!.message).toBe("Đã hoàn tác")
    })

    it("đóng tab khi đang chờ ⇒ gửi bằng fetch keepalive, không gửi lần hai", async () => {
      state.drafts = [draft({ id: 9 })]
      renderWithQuery(<SocialDraftsList onOpen={vi.fn()} />)
      confirmDelete()
      act(() => { window.dispatchEvent(new Event("pagehide")) })
      expect(api.keepalive).toHaveBeenCalledWith("DELETE", "/social/drafts/9")
      await act(async () => { vi.advanceTimersByTime(10_000) })
      expect(api.del).not.toHaveBeenCalled()
    })
  })
})
