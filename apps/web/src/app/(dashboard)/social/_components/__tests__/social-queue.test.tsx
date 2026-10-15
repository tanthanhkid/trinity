import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { SocialQueueDialog, addSlot, minuteText, parseMinute, queueWhenLabel, removeSlot } from "../social-queue"
import { SocialComposer } from "../social-composer"

const state = vi.hoisted(() => ({
  slots: [] as Array<{ weekday: number; minute: number }>,
  next: [] as string[],
  setSlots: vi.fn(),
  create: vi.fn(),
  publishDraft: vi.fn(),
}))

vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useQueueSlots: () => ({ data: state.slots, isLoading: false, isSuccess: true }),
  useQueueNext: () => ({ data: state.next, isLoading: false, isSuccess: true }),
  useSocialAccounts: () => ({ data: [{ id: 3, network: "facebook", name: "Fanpage", avatar_url: null, status: "active", last_error: null }], isLoading: false }),
  useSocialSnippets: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSnippetMutations: () => ({ save: { isPending: false, mutate: vi.fn() }, remove: { isPending: false, mutate: vi.fn() } }),
  useTiktokCreatorInfos: () => ({}),
  useSocialMutations: () => ({
    create: { isPending: false, mutateAsync: state.create },
    createRecurrence: { isPending: false, mutateAsync: vi.fn() },
    saveDraft: { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn(async () => ({ id: 9, updated_at: "2026-10-15T00:00:00Z" })) },
    publishDraft: { isPending: false, mutateAsync: state.publishDraft },
    setQueueSlots: { isPending: false, mutate: state.setSlots },
  }),
}))

describe("hàm khung giờ", () => {
  it("minuteText / parseMinute", () => {
    expect(minuteText(570)).toBe("09:30")
    expect(minuteText(0)).toBe("00:00")
    expect(parseMinute("19:30")).toBe(1170)
    expect(parseMinute("24:00")).toBeNull()
    expect(parseMinute("abc")).toBeNull()
  })
  it("addSlot bỏ trùng và sắp xếp; removeSlot bỏ đúng khung", () => {
    const a = addSlot([{ weekday: 3, minute: 600 }], { weekday: 1, minute: 60 })
    expect(a).toEqual([{ weekday: 1, minute: 60 }, { weekday: 3, minute: 600 }])
    expect(addSlot(a, { weekday: 1, minute: 60 })).toBe(a)
    expect(removeSlot(a, { weekday: 1, minute: 60 })).toEqual([{ weekday: 3, minute: 600 }])
  })
  it("queueWhenLabel hiện giờ Việt Nam kèm thứ", () => {
    expect(queueWhenLabel("2026-10-20T02:00:00Z")).toBe("09:00 Thứ Ba 20/10")
    expect(queueWhenLabel("2026-10-24T18:30:00Z")).toBe("01:30 Chủ nhật 25/10")
  })
})

describe("hộp thoại khung giờ", () => {
  beforeEach(() => {
    state.slots = []
    state.setSlots.mockClear()
  })
  it("rỗng ⇒ giải thích hàng đợi là gì", () => {
    render(<SocialQueueDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByTestId("queue-empty")).toHaveTextContent(/khung trống kế tiếp/)
  })
  it("thêm giờ cho một thứ rồi lưu ⇒ gửi danh sách mới", () => {
    state.slots = [{ weekday: 1, minute: 540 }]
    render(<SocialQueueDialog open onOpenChange={vi.fn()} />)
    const row = screen.getAllByTestId("queue-weekday")[1] // Thứ Ba
    fireEvent.change(within(row).getByLabelText("Giờ thêm cho Thứ Ba"), { target: { value: "19:30" } })
    fireEvent.click(within(row).getByRole("button", { name: /Thêm giờ/ }))
    expect(within(row).getByText("19:30")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Lưu khung giờ/ }))
    expect(state.setSlots.mock.calls[0][0]).toEqual([{ weekday: 1, minute: 540 }, { weekday: 2, minute: 1170 }])
  })
  it("bỏ một giờ rồi lưu", () => {
    state.slots = [{ weekday: 1, minute: 540 }]
    render(<SocialQueueDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Bỏ 09:00 Thứ Hai" }))
    fireEvent.click(screen.getByRole("button", { name: /Lưu khung giờ/ }))
    expect(state.setSlots.mock.calls[0][0]).toEqual([])
  })
})

describe("ô soạn: Vào hàng đợi", () => {
  beforeEach(() => {
    state.slots = [{ weekday: 2, minute: 540 }]
    state.next = ["2026-10-20T02:00:00Z"]
    state.create.mockReset()
    state.create.mockResolvedValue({ id: 5, scheduled_at: "2026-10-20T02:00:00Z" })
  })
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Nội dung bài đăng"), { target: { value: "Xin chào" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Fanpage/ }))
  }
  it("hiện bốn lựa chọn; chọn hàng đợi ⇒ nêu khung trống gần nhất và gửi use_queue", async () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    expect(screen.getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual(["Đăng ngay", "Hẹn giờ", "Vào hàng đợi", "Lặp lại"])
    fill()
    fireEvent.click(screen.getByRole("radio", { name: "Vào hàng đợi" }))
    expect(screen.getByTestId("queue-next")).toHaveTextContent("Khung trống gần nhất: 09:00 Thứ Ba 20/10")
    fireEvent.click(screen.getByRole("button", { name: /Thêm vào hàng đợi/ }))
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled())
    expect(state.create.mock.calls[0][0]).toMatchObject({ content: "Xin chào", scheduled_at: null, use_queue: true })
  })
  it("chưa có khung ⇒ lựa chọn bị khoá kèm lời dẫn tới tab Lịch", () => {
    state.slots = []
    const go = vi.fn()
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} onGoCalendar={go} />)
    expect(screen.getByRole("radio", { name: "Vào hàng đợi" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: /Đặt khung giờ ở tab Lịch/ }))
    expect(go).toHaveBeenCalled()
  })
  it("Đăng ngay vẫn không gửi use_queue", async () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    fill()
    fireEvent.click(screen.getByRole("button", { name: /Đăng ngay/ }))
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled())
    expect(state.create.mock.calls[0][0]).not.toHaveProperty("use_queue")
    expect(state.create.mock.calls[0][0].scheduled_at).toBeNull()
  })
  it("nháp đang mở đăng vào hàng đợi ⇒ gửi use_queue qua endpoint đăng nháp, không gửi giờ", async () => {
    state.publishDraft.mockResolvedValue({ id: 6, scheduled_at: null })
    const draft = { id: 9, title: null, content: "Nháp", media: [], targets: [{ account_id: 3 }], scheduled_at: null, ui: null, source: "web", created_at: "", updated_at: "" }
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} draft={draft} />)
    fireEvent.click(screen.getByRole("radio", { name: "Vào hàng đợi" }))
    fireEvent.click(screen.getByRole("button", { name: /Thêm vào hàng đợi/ }))
    await vi.waitFor(() => expect(state.publishDraft).toHaveBeenCalled())
    expect(state.publishDraft.mock.calls[0][0]).toMatchObject({ id: 9, use_queue: true })
    expect(state.publishDraft.mock.calls[0][0]).not.toHaveProperty("scheduled_at")
  })
})
