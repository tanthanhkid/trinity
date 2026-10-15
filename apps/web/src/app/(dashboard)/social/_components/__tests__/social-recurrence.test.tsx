import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { SocialComposer } from "../social-composer"
import { SocialRecurrenceList } from "../social-recurrence"
import { emptyRecurrence, nextOccurrence, nextTimes, nextTimesLine, recurrenceError, recurrenceSchedule, ruleOf, ruleText } from "../social-recurrence-rules"

const vn = (iso: string) => Date.parse(`${iso}+07:00`)
const NOW = vn("2026-10-20T08:00:00") // Thứ Ba

describe("luật lặp phía trình duyệt (bản sao nextOccurrence)", () => {
  it("hằng ngày / mỗi 3 ngày / sau ngày bắt đầu", () => {
    expect(nextOccurrence({ freq: "daily", interval: 1, time: "09:00" }, NOW, "2026-10-01")).toBe(vn("2026-10-20T09:00:00"))
    expect(nextOccurrence({ freq: "daily", interval: 1, time: "07:00" }, NOW, "2026-10-01")).toBe(vn("2026-10-21T07:00:00"))
    expect(nextOccurrence({ freq: "daily", interval: 3, time: "09:00" }, vn("2026-10-02T10:00:00"), "2026-10-01")).toBe(vn("2026-10-04T09:00:00"))
    expect(nextOccurrence({ freq: "daily", interval: 1, time: "09:00" }, vn("2026-09-01T00:00:00"), "2026-10-05")).toBe(vn("2026-10-05T09:00:00"))
  })
  it("hằng tuần nhiều thứ và mỗi 2 tuần", () => {
    expect(nextOccurrence({ freq: "weekly", interval: 1, weekdays: [1, 4], time: "19:30" }, NOW, "2026-10-01")).toBe(vn("2026-10-22T19:30:00"))
    expect(nextOccurrence({ freq: "weekly", interval: 2, weekdays: [2], time: "09:00" }, vn("2026-10-20T10:00:00"), "2026-10-20")).toBe(vn("2026-11-03T09:00:00"))
  })
  it("hằng tháng: ngày 31 kẹp về cuối tháng ngắn", () => {
    const r = { freq: "monthly" as const, interval: 1, month_day: 31, time: "08:00" }
    expect(nextOccurrence(r, vn("2026-01-31T09:00:00"), "2026-01-01")).toBe(vn("2026-02-28T08:00:00"))
    expect(nextOccurrence(r, vn("2028-02-01T00:00:00"), "2026-01-01")).toBe(vn("2028-02-29T08:00:00"))
  })
  it("ruleText", () => {
    expect(ruleText({ freq: "weekly", interval: 2, weekdays: [1, 4], time: "09:00" })).toBe("Hằng tuần, mỗi 2 tuần vào Thứ Hai, Thứ Năm lúc 09:00")
    expect(ruleText({ freq: "monthly", interval: 1, month_day: 15, time: "08:00" })).toBe("Hằng tháng vào ngày 15 lúc 08:00")
  })
})

describe("form Lặp lại", () => {
  const form = { ...emptyRecurrence("2026-10-20"), freq: "daily" as const }
  it("3 lần đăng tới; kết thúc theo ngày và theo số lần", () => {
    expect(nextTimes(form, 3, NOW)).toEqual([vn("2026-10-20T09:00:00"), vn("2026-10-21T09:00:00"), vn("2026-10-22T09:00:00")])
    expect(nextTimes({ ...form, endMode: "date", endsOn: "2026-10-21" }, 3, NOW)).toHaveLength(2)
    expect(nextTimes({ ...form, endMode: "count", maxCount: 1 }, 3, NOW)).toHaveLength(1)
    expect(nextTimesLine(form, NOW)).toBe("3 lần đăng tới: 09:00 Thứ Ba 20/10 · 09:00 Thứ Tư 21/10 · 09:00 Thứ Năm 22/10")
  })
  it("báo lỗi: tuần chưa chọn thứ, giờ sai, ngày kết thúc trước ngày bắt đầu, hết lần", () => {
    expect(recurrenceError({ ...form, freq: "weekly", weekdays: [] }, NOW)).toMatch(/ít nhất một thứ/)
    expect(recurrenceError({ ...form, time: "" }, NOW)).toMatch(/giờ/)
    expect(recurrenceError({ ...form, endMode: "date", endsOn: "2026-10-01" }, NOW)).toMatch(/sau ngày bắt đầu/)
    expect(recurrenceError({ ...form, endMode: "date", endsOn: "2026-10-20", time: "07:00" }, NOW)).toMatch(/không còn lần đăng/)
    expect(recurrenceError(form, NOW)).toBeNull()
  })
  it("thân gửi máy chủ", () => {
    expect(recurrenceSchedule({ ...form, freq: "weekly", weekdays: [4, 1], endMode: "count", maxCount: 5 })).toEqual({
      rule: { freq: "weekly", interval: 1, time: "09:00", weekdays: [1, 4] }, starts_on: "2026-10-20", ends_on: null, max_count: 5,
    })
    expect(ruleOf({ ...form, freq: "monthly", monthDay: 31 })).toEqual({ freq: "monthly", interval: 1, time: "09:00", month_day: 31 })
  })
})

const state = vi.hoisted(() => ({
  createRecurrence: vi.fn(),
  list: [] as unknown[],
  pause: vi.fn(),
  resume: vi.fn(),
  remove: vi.fn(),
}))

vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useQueueSlots: () => ({ data: [], isLoading: false, isSuccess: true }),
  useQueueNext: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSocialAccounts: () => ({ data: [{ id: 3, network: "facebook", name: "Fanpage", avatar_url: null, status: "active", last_error: null }], isLoading: false }),
  useSocialSnippets: () => ({ data: [], isLoading: false, isSuccess: true }),
  useSnippetMutations: () => ({ save: { isPending: false, mutate: vi.fn() }, remove: { isPending: false, mutate: vi.fn() } }),
  useTiktokCreatorInfos: () => ({}),
  useSocialMutations: () => ({
    create: { isPending: false, mutateAsync: vi.fn() },
    createRecurrence: { isPending: false, mutateAsync: state.createRecurrence },
    saveDraft: { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() },
    publishDraft: { isPending: false, mutateAsync: vi.fn() },
  }),
  useSocialRecurrences: () => ({ data: state.list, isLoading: false }),
  useRecurrenceMutations: () => ({ pause: { isPending: false, mutate: state.pause }, resume: { isPending: false, mutate: state.resume }, remove: { isPending: false, mutate: state.remove } }),
}))

describe("ô soạn: Lặp lại", () => {
  beforeEach(() => {
    state.createRecurrence.mockReset()
    state.createRecurrence.mockResolvedValue({ id: 1, title: "Xin chào", last_error: null })
  })
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Nội dung bài đăng"), { target: { value: "Xin chào" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /Fanpage/ }))
  }
  it("chọn Lặp lại ⇒ hiện các ô và dòng '3 lần đăng tới'", () => {
    render(<SocialComposer onCreated={vi.fn()} onGoChannels={vi.fn()} />)
    expect(screen.queryByTestId("recurrence-fields")).toBeNull()
    fireEvent.click(screen.getByRole("radio", { name: "Lặp lại" }))
    expect(screen.getByTestId("recurrence-fields")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Tần suất"), { target: { value: "daily" } })
    expect(screen.getByTestId("recurrence-next")).toHaveTextContent(/^3 lần đăng tới: /)
  })
  it("hằng tuần chưa chọn thứ ⇒ báo lỗi và khoá nút; chọn thứ ⇒ tạo lịch (không tạo bài)", async () => {
    const onCreated = vi.fn()
    render(<SocialComposer onCreated={onCreated} onGoChannels={vi.fn()} />)
    fill()
    fireEvent.click(screen.getByRole("radio", { name: "Lặp lại" }))
    expect(screen.getByTestId("recurrence-error")).toHaveTextContent(/ít nhất một thứ/)
    expect(screen.getByRole("button", { name: /Tạo bài lặp lại/ })).toBeDisabled()
    const group = screen.getByRole("group", { name: "Các thứ đăng" })
    fireEvent.click(within(group).getByRole("button", { name: "T2" }))
    fireEvent.click(within(group).getByRole("button", { name: "T5" }))
    fireEvent.change(screen.getByLabelText("Khoảng lặp"), { target: { value: "2" } })
    fireEvent.change(screen.getByLabelText("Cách kết thúc"), { target: { value: "count" } })
    fireEvent.change(screen.getByLabelText("Số lần đăng"), { target: { value: "6" } })
    fireEvent.click(screen.getByRole("button", { name: /Tạo bài lặp lại/ }))
    await vi.waitFor(() => expect(state.createRecurrence).toHaveBeenCalled())
    const body = state.createRecurrence.mock.calls[0][0]
    expect(body).toMatchObject({
      title: "Xin chào",
      template: { content: "Xin chào", targets: [{ account_id: 3 }] },
      rule: { freq: "weekly", interval: 2, weekdays: [1, 4], time: "09:00" },
      ends_on: null,
      max_count: 6,
    })
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith("recurring"))
  })
})

const rec = (o: Record<string, unknown> = {}) => ({
  id: 4, title: "Chào tuần mới", template: { content: "Nội dung", media_keys: [], targets: [{ account_id: 3 }] }, rule: { freq: "weekly", interval: 1, weekdays: [2], time: "09:00" },
  starts_on: "2026-10-01", ends_on: null, max_count: null, count: 2, next_run_at: "2026-10-27T02:00:00Z", active: true, last_error: null,
  next_times: ["2026-10-20T02:00:00Z", "2026-10-27T02:00:00Z"], posts: [], ...o,
})

describe("Bài lặp lại ở tab Lịch", () => {
  beforeEach(() => {
    state.pause.mockReset()
    state.resume.mockReset()
    state.remove.mockReset()
  })
  it("rỗng ⇒ hướng dẫn", () => {
    state.list = []
    render(<SocialRecurrenceList />)
    expect(screen.getByTestId("recurrence-empty")).toHaveTextContent(/Lặp lại/)
  })
  it("hàng đang chạy: luật, kênh, lần tới giờ VN; Tạm dừng gọi pause", () => {
    state.list = [rec()]
    render(<SocialRecurrenceList />)
    const row = screen.getByTestId("recurrence-row")
    expect(row).toHaveTextContent("Hằng tuần vào Thứ Ba lúc 09:00")
    expect(row).toHaveTextContent("Fanpage")
    expect(screen.getByTestId("recurrence-times")).toHaveTextContent("09:00 Thứ Ba 20/10")
    fireEvent.click(within(row).getByRole("button", { name: /Tạm dừng/ }))
    expect(state.pause.mock.calls[0][0]).toBe(4)
    expect(screen.queryByTestId("recurrence-last-error")).toBeNull()
  })
  it("tạm dừng vì lỗi: hiện lỗi màu đỏ, nút Tiếp tục, không hiện lần tới", () => {
    state.list = [rec({ active: false, last_error: 'Kênh "Fanpage" cần liên kết lại trước khi đăng.', next_times: [] })]
    render(<SocialRecurrenceList />)
    const err = screen.getByTestId("recurrence-last-error")
    expect(err).toHaveTextContent("cần liên kết lại")
    expect(err.className).toMatch(/destructive/)
    expect(screen.queryByTestId("recurrence-times")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Tiếp tục/ }))
    expect(state.resume.mock.calls[0][0]).toBe(4)
  })
  it("Xoá hỏi xác nhận rồi gọi remove", () => {
    state.list = [rec()]
    render(<SocialRecurrenceList />)
    fireEvent.click(screen.getByRole("button", { name: "Xoá Chào tuần mới" }))
    // Mở hộp xác nhận, chưa xoá
    expect(state.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Xoá lịch lặp" }))
    expect(state.remove.mock.calls[0][0]).toBe(4)
  })
})
