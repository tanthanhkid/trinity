import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SocialComposer } from "../social-composer"
import { composerStateFrom } from "../social-draft-state"
import { defaultCampaign, firstLinkWithUtm, slugOf, utmChoiceFromTargets, utmPayload, withUtm } from "../social-utm"

const state = vi.hoisted(() => ({ create: vi.fn(), saveDraft: vi.fn() }))

vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialSnippets: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSnippetMutations: () => ({ save: { isPending: false, mutate: vi.fn() }, remove: { isPending: false, mutate: vi.fn() } }),
  useQueueSlots: () => ({ data: [], isLoading: false, isSuccess: true }),
  useQueueNext: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSocialAccounts: () => ({
    data: [
      { id: 3, network: "facebook", name: "Fanpage", avatar_url: null, status: "active", last_error: null },
      { id: 4, network: "google_business", name: "Quán", avatar_url: null, status: "active", last_error: null },
    ],
    isLoading: false,
  }),
  useTiktokCreatorInfos: () => ({}),
  useSocialMutations: () => ({
    create: { isPending: false, mutateAsync: state.create },
    createRecurrence: { isPending: false, mutateAsync: vi.fn() },
    saveDraft: { isPending: false, mutate: state.saveDraft, mutateAsync: vi.fn() },
    publishDraft: { isPending: false, mutateAsync: vi.fn() },
  }),
}))

describe("slug và tên chiến dịch mặc định", () => {
  it("vài từ đầu, bỏ dấu, bỏ liên kết", () => {
    expect(slugOf("Khuyến mãi Đặc biệt mùa thu 2026 rất lớn")).toBe("khuyen-mai-dac-biet")
    expect(slugOf("https://shop.vn/x Ưu đãi lớn")).toBe("uu-dai-lon")
  })
  it("không có chữ ⇒ bai-yyyy-mm-dd", () => {
    expect(defaultCampaign("  🎉 ", new Date(2026, 9, 5))).toBe("bai-2026-10-05")
    expect(defaultCampaign("Chào bạn", new Date(2026, 9, 5))).toBe("chao-ban")
  })
})

describe("utmPayload", () => {
  it("tắt ⇒ null; bật mà để trống ⇒ tên mặc định; khoảng trắng → '-'", () => {
    expect(utmPayload({ on: false, campaign: "x", content: "" }, "a")).toBeNull()
    expect(utmPayload({ on: true, campaign: "", content: "" }, "Mua ngay hôm nay")).toEqual({ campaign: "mua-ngay-hom-nay" })
    expect(utmPayload({ on: true, campaign: " thu 2026 ", content: " b 1 " }, "x")).toEqual({ campaign: "thu-2026", content: "b-1" })
  })
})

describe("withUtm / firstLinkWithUtm", () => {
  const u = { campaign: "c" }
  const Q = "utm_source=facebook&utm_medium=social&utm_campaign=c"
  it("gắn đúng như máy chủ: query, #fragment, dấu câu, link đã có utm_", () => {
    expect(withUtm("Xem https://a.vn/x?id=1#f, nhé.", "facebook", u)).toBe(`Xem https://a.vn/x?id=1&${Q}#f, nhé.`)
    expect(withUtm("https://a.vn/?utm_source=z", "facebook", u)).toBe("https://a.vn/?utm_source=z")
    expect(withUtm("a@b.vn shop.vn", "facebook", u)).toBe("a@b.vn shop.vn")
    expect(withUtm("https://a.vn", "facebook", null)).toBe("https://a.vn")
  })
  it("liên kết đầu tiên; không có ⇒ null", () => {
    expect(firstLinkWithUtm("x https://a.vn. y https://b.vn", "facebook", u)).toBe(`https://a.vn?${Q}`)
    expect(firstLinkWithUtm("không có", "facebook", u)).toBeNull()
  })
})

describe("khôi phục từ nháp", () => {
  it("lấy UTM từ options của kênh", () => {
    expect(utmChoiceFromTargets([{ options: {} }, { options: { utm: { campaign: "c", content: "k" } } }])).toEqual({ on: true, campaign: "c", content: "k" })
    expect(utmChoiceFromTargets([{ options: {} }])).toBeNull()
    const d = { id: 1, title: null, content: "x", media: [], targets: [{ account_id: 3, options: { utm: { campaign: "c" } } }], scheduled_at: null, ui: null, source: "mcp", created_at: "", updated_at: "" }
    expect(composerStateFrom(d).utm).toEqual({ on: true, campaign: "c", content: "" })
  })
  it("nháp lưu từ web: giữ nguyên utm trong ui", () => {
    const d = { id: 1, title: null, content: "x", media: [], targets: [], scheduled_at: null, source: "web", created_at: "", updated_at: "", ui: { content: "x", selected: [], utm: { on: true, campaign: "k", content: "" } } }
    expect(composerStateFrom(d).utm).toEqual({ on: true, campaign: "k", content: "" })
  })
})

describe("ô soạn — Gắn UTM", () => {
  beforeEach(() => {
    state.create.mockReset().mockResolvedValue({ id: 5, scheduled_at: null })
    state.saveDraft.mockReset()
  })
  const box = () => screen.getByLabelText("Nội dung bài đăng") as HTMLTextAreaElement

  it("tắt mặc định, bật ⇒ hiện ô chiến dịch với tên mặc định từ nội dung", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    expect(screen.queryByLabelText("Tên chiến dịch (utm_campaign)")).toBeNull()
    fireEvent.change(box(), { target: { value: "Ưu đãi mùa thu https://shop.vn/sp" } })
    fireEvent.click(screen.getByLabelText("Gắn UTM vào liên kết"))
    expect(screen.getByLabelText("Tên chiến dịch (utm_campaign)")).toHaveAttribute("placeholder", "uu-dai-mua-thu")
    expect(screen.getByLabelText("utm_content")).toBeInTheDocument()
  })

  it("xem trước liên kết đầu tiên theo kênh đầu; chưa chọn kênh ⇒ nhắc chọn; không có liên kết ⇒ báo", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fireEvent.change(box(), { target: { value: "Xem https://shop.vn/sp." } })
    fireEvent.click(screen.getByLabelText("Gắn UTM vào liên kết"))
    expect(screen.getByTestId("utm-preview")).toHaveTextContent(/Chọn kênh/)
    fireEvent.click(screen.getByRole("checkbox", { name: /Fanpage/ }))
    fireEvent.change(screen.getByLabelText("Tên chiến dịch (utm_campaign)"), { target: { value: "thu 2026" } })
    expect(screen.getByTestId("utm-preview")).toHaveTextContent("https://shop.vn/sp?utm_source=facebook&utm_medium=social&utm_campaign=thu-2026")
    fireEvent.change(box(), { target: { value: "Không có link" } })
    expect(screen.getByTestId("utm-preview")).toHaveTextContent(/chưa có liên kết/)
  })

  it("đăng ⇒ gửi utm (tên mặc định khi để trống); tắt ⇒ không gửi utm", async () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fireEvent.change(box(), { target: { value: "Chào bạn https://a.vn" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Fanpage/ }))
    fireEvent.click(screen.getByLabelText("Gắn UTM vào liên kết"))
    fireEvent.click(screen.getByRole("button", { name: /Đăng ngay/ }))
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled())
    expect(state.create.mock.calls[0][0].utm).toEqual({ campaign: "chao-ban" })
    expect(state.create.mock.calls[0][0].content).toBe("Chào bạn https://a.vn")
  })

  it("không bật UTM ⇒ body không có utm", async () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fireEvent.change(box(), { target: { value: "Chào" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Fanpage/ }))
    fireEvent.click(screen.getByRole("button", { name: /Đăng ngay/ }))
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled())
    expect("utm" in state.create.mock.calls[0][0]).toBe(false)
  })

  it("giới hạn ký tự tính sau UTM: vừa đủ trước, quá sau khi bật", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    const url = "https://shop.vn/sp"
    fireEvent.change(box(), { target: { value: `${"x".repeat(1500 - url.length - 1)} ${url}` } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Quán/ }))
    expect(screen.getByRole("button", { name: /Đăng ngay/ })).toBeEnabled()
    fireEvent.click(screen.getByLabelText("Gắn UTM vào liên kết"))
    expect(screen.getByRole("button", { name: /Đăng ngay/ })).toBeDisabled()
  })

  it("lưu nháp ⇒ utm ở thân nháp và trong ui; tắt ⇒ utm null", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fireEvent.change(box(), { target: { value: "Nội dung https://a.vn" } })
    fireEvent.click(screen.getByLabelText("Gắn UTM vào liên kết"))
    fireEvent.change(screen.getByLabelText("Tên chiến dịch (utm_campaign)"), { target: { value: "k" } })
    fireEvent.click(screen.getByRole("button", { name: /Lưu nháp/ }))
    const body = state.saveDraft.mock.calls[0][0].body
    expect(body.utm).toEqual({ campaign: "k" })
    expect(body.ui.utm).toEqual({ on: true, campaign: "k", content: "" })
    fireEvent.click(screen.getByLabelText("Gắn UTM vào liên kết"))
    fireEvent.click(screen.getByRole("button", { name: /Lưu nháp/ }))
    expect(state.saveDraft.mock.calls[1][0].body.utm).toBeNull()
  })

  it("mở từ nháp có UTM ⇒ checkbox bật sẵn với tên đã lưu", () => {
    const draft = { id: 9, title: null, content: "Nháp", media: [], targets: [{ account_id: 3, options: { utm: { campaign: "da-luu" } } }], scheduled_at: null, ui: null, source: "mcp", created_at: "", updated_at: "" }
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} draft={draft} />)
    expect(screen.getByLabelText("Gắn UTM vào liên kết")).toBeChecked()
    expect(screen.getByLabelText("Tên chiến dịch (utm_campaign)")).toHaveValue("da-luu")
  })
})
