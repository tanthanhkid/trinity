import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SocialSnippetsDialog, insertSnippet, signaturePrefill } from "../social-snippets"
import { SocialComposer } from "../social-composer"
import type { SocialSnippet } from "@/hooks/use-social"

const snip = (o: Partial<SocialSnippet>): SocialSnippet => ({ id: 1, kind: "hashtags", name: "Khai giảng", content: "#a #b", is_default: false, position: 0, ...o })

const state = vi.hoisted(() => ({
  snippets: [] as SocialSnippet[],
  save: vi.fn(),
  remove: vi.fn(),
}))

vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialSnippets: () => ({ data: state.snippets, isLoading: false, isSuccess: true }),
  useSnippetMutations: () => ({ save: { isPending: false, mutate: state.save }, remove: { isPending: false, mutate: state.remove } }),
  useQueueSlots: () => ({ data: [], isLoading: false, isSuccess: true }),
  useQueueNext: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSocialAccounts: () => ({ data: [{ id: 3, network: "facebook", name: "Fanpage", avatar_url: null, status: "active", last_error: null }], isLoading: false }),
  useTiktokCreatorInfos: () => ({}),
  useSocialMutations: () => ({
    create: { isPending: false, mutateAsync: vi.fn() },
    saveDraft: { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() },
    publishDraft: { isPending: false, mutateAsync: vi.fn() },
  }),
}))

describe("insertSnippet", () => {
  it("nối xuống dòng ở cuối nội dung", () => {
    expect(insertSnippet("Xin chào", "#a #b")).toBe("Xin chào\n#a #b")
    expect(insertSnippet("Xin chào\n\n", "#a #b")).toBe("Xin chào\n#a #b")
  })
  it("nội dung trống thì chỉ có mẫu", () => {
    expect(insertSnippet("", "#a")).toBe("#a")
    expect(insertSnippet("  \n", "#a")).toBe("#a")
  })
  it("không chèn lặp khi đúng mẫu đã ở cuối", () => {
    const once = insertSnippet("Xin chào", "#a #b")
    expect(insertSnippet(once, "#a #b")).toBe(once)
    expect(insertSnippet(`${once}\n`, "#a #b")).toBe(`${once}\n`)
  })
})

describe("signaturePrefill", () => {
  it("có chữ ký mặc định ⇒ \\n\\n + chữ ký; không có ⇒ rỗng", () => {
    expect(signaturePrefill([snip({ id: 2, kind: "signature", content: "Trân trọng", is_default: true })])).toBe("\n\nTrân trọng")
    expect(signaturePrefill([snip({ kind: "signature", is_default: false }), snip({ is_default: true })])).toBe("")
    expect(signaturePrefill(undefined)).toBe("")
  })
})

describe("ô soạn với mẫu chữ", () => {
  beforeEach(() => {
    state.snippets = []
  })
  const box = () => screen.getByLabelText("Nội dung bài đăng") as HTMLTextAreaElement
  it("bài mới trống + có chữ ký mặc định ⇒ điền sẵn ở cuối", async () => {
    state.snippets = [snip({ id: 2, kind: "signature", name: "KS", content: "Trân trọng", is_default: true })]
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    await vi.waitFor(() => expect(box().value).toBe("\n\nTrân trọng"))
  })
  it("mở từ nháp ⇒ không điền chữ ký", () => {
    state.snippets = [snip({ id: 2, kind: "signature", content: "Trân trọng", is_default: true })]
    const draft = { id: 9, title: null, content: "Nháp", media: [], targets: [], scheduled_at: null, ui: null, source: "web", created_at: "", updated_at: "" }
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} draft={draft} />)
    expect(box().value).toBe("Nháp")
  })
  it("menu Chèn: bấm một bộ hashtag ⇒ chèn cuối nội dung, bấm lại không lặp", async () => {
    state.snippets = [snip({ name: "Khai giảng", content: "#a #b" })]
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fireEvent.change(box(), { target: { value: "Xin chào" } })
    fireEvent.click(screen.getByRole("button", { name: /Chèn/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Khai giảng/ }))
    expect(box().value).toBe("Xin chào\n#a #b")
    fireEvent.click(screen.getByRole("button", { name: /Chèn/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Khai giảng/ }))
    expect(box().value).toBe("Xin chào\n#a #b")
  })
})

describe("hộp thoại quản lý mẫu", () => {
  beforeEach(() => {
    state.snippets = []
    state.save.mockClear()
    state.remove.mockClear()
  })
  it("rỗng ⇒ câu hướng dẫn", () => {
    render(<SocialSnippetsDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByTestId("snippets-empty")).toHaveTextContent(/Chưa có mẫu nào/)
  })
  it("thêm bộ hashtag ⇒ gửi kind, name, content", () => {
    render(<SocialSnippetsDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Thêm mẫu" }))
    expect(screen.getByRole("button", { name: "Lưu mẫu" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Tên mẫu"), { target: { value: "Khai giảng" } })
    fireEvent.change(screen.getByLabelText("Nội dung mẫu"), { target: { value: "khaigiang hoc" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu mẫu" }))
    expect(state.save.mock.calls[0][0]).toEqual({ id: undefined, body: { kind: "hashtags", name: "Khai giảng", content: "khaigiang hoc" } })
  })
  it("đặt chữ ký làm mặc định ⇒ PATCH is_default", () => {
    state.snippets = [snip({ id: 5, kind: "signature", name: "KS", content: "Trân trọng" })]
    render(<SocialSnippetsDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Đặt KS làm mặc định" }))
    expect(state.save.mock.calls[0][0]).toEqual({ id: 5, body: { is_default: true } })
  })
  it("xoá cần xác nhận", () => {
    state.snippets = [snip({ id: 7 })]
    render(<SocialSnippetsDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Xoá Khai giảng" }))
    expect(state.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Xoá" }))
    expect(state.remove.mock.calls[0][0]).toBe(7)
  })
})
