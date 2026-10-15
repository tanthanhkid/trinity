/**
 * Gắn thẻ @ — thành phần giao diện: gợi ý ↑↓/Enter, Backspace xoá thẻ, dán mã thành thẻ, thẻ bấm mở bản ghi, "Được nhắc tới ở".
 * API giả: /refs/suggest trả 2 khách mới, /refs/resolve trả theo mã.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import type { RefView } from "@/lib/refs/mentions"

const get = vi.fn()
const push = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => get(...a) }, getApiErrorMessage: (_e: unknown, fb: string) => fb }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }))

import { LinkInput } from "@/components/refs/link-input"
import { MentionEditor } from "@/components/refs/mention-editor"
import { MentionText } from "@/components/refs/mention-text"
import { MentionedIn } from "@/components/refs/mentioned-in"

const v = (id: number, code: string, title: string): RefView => ({ type: "record", id, ref: `record:${id}`, code, title, table: "Khách mới", table_key: "khach_hang", href: `/x/khach_hang/${id}` })
const AN = v(1, "SP001", "Nguyễn Văn An")
const BINH = v(2, "SP002", "Trần Bình")

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  get.mockImplementation(async (url: string, cfg?: { params?: { codes?: string; q?: string } }) => {
    if (url === "/refs/suggest") return { data: [AN, BINH] }
    if (url === "/refs/resolve") return { data: [AN, BINH].filter((x) => (cfg?.params?.codes ?? "").split(",").includes(x.code as string)).map((x) => ({ ...x, requested: x.code })) }
    if (url === "/refs/record/1/backlinks") return { data: [{ source: { ...v(7, "LH001", "Xem định kỳ"), table: "Lịch hẹn", href: "/x/lich_hen/7" }, fields: ["Ghi chú"] }] }
    return { data: [] }
  })
})
afterEach(() => { get.mockReset(); push.mockReset() })

function LinkHarness({ initial, spy }: { initial?: string[]; spy: (x: string[] | undefined) => void }) {
  const [val, setVal] = useState<string[] | undefined>(initial)
  return <LinkInput id="lk" value={val} onChange={(x) => { setVal(x); spy(x) }} />
}

describe("trường Liên kết", () => {
  it("gõ → gợi ý; ↓ rồi Enter chọn dòng 2 → lưu loại:id", async () => {
    const spy = vi.fn()
    wrap(<LinkHarness spy={spy} />)
    const input = screen.getByRole("combobox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "@HS" } })
    await waitFor(() => expect(screen.getAllByTestId("ref-suggestion")).toHaveLength(2))
    expect(screen.getAllByTestId("ref-suggestion")[0].textContent).toContain("SP001")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(spy).toHaveBeenLastCalledWith(["record:2"])
    expect(screen.getByTestId("ref-chip").textContent).toContain("Trần Bình")
  })
  it("Backspace ở ô trống bỏ thẻ cuối; dán 'SP001, SP002' thành 2 thẻ", async () => {
    const spy = vi.fn()
    wrap(<LinkHarness spy={spy} />)
    const input = screen.getByRole("combobox")
    fireEvent.paste(input, { clipboardData: { getData: () => "SP001, SP002" } })
    expect(spy).toHaveBeenLastCalledWith(["SP001", "SP002"])
    await waitFor(() => expect(screen.getAllByTestId("ref-chip")).toHaveLength(2))
    fireEvent.keyDown(input, { key: "Backspace" })
    expect(spy).toHaveBeenLastCalledWith(["SP001"])
  })
})

describe("ô soạn thảo có @", () => {
  it("gõ @HS → gợi ý; Enter chèn thẻ; giá trị lưu là chữ @SP001", async () => {
    const onChange = vi.fn()
    wrap(<MentionEditor id="ed" value={undefined} onChange={onChange} />)
    const ed = screen.getByTestId("mention-editor")
    ed.textContent = "Xem @HS"
    const sel = window.getSelection() as Selection
    const r = document.createRange()
    r.setStart(ed.firstChild as Text, 7)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    fireEvent.input(ed)
    await waitFor(() => expect(screen.getAllByTestId("ref-suggestion")).toHaveLength(2))
    fireEvent.keyDown(ed, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("Xem @SP001 ")
    expect(ed.querySelector("[data-code='SP001']")?.textContent).toContain("Nguyễn Văn An")
    // Backspace ngay sau thẻ (con trỏ sau khoảng trắng → xoá khoảng trắng là việc của trình duyệt; đặt con trỏ ngay sau thẻ):
    const chip = ed.querySelector("[data-code]") as HTMLElement
    const r2 = document.createRange()
    r2.setStart(ed, Array.from(ed.childNodes).indexOf(chip) + 1)
    r2.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r2)
    fireEvent.keyDown(ed, { key: "Backspace" })
    expect(ed.querySelector("[data-code]")).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith("Xem  ")
  })
  it("mở với giá trị có sẵn: thẻ có nhãn; bấm thẻ mở bản ghi", async () => {
    wrap(<MentionEditor value="Gặp @SP002 nhé" onChange={vi.fn()} />)
    const ed = screen.getByTestId("mention-editor")
    await waitFor(() => expect(ed.querySelector("[data-code='SP002']")?.textContent).toContain("Trần Bình"))
    fireEvent.click(ed.querySelector("[data-code='SP002']") as HTMLElement)
    expect(push).toHaveBeenCalledWith("/x/khach_hang/2")
  })
})

describe("hiển thị + truy ngược", () => {
  it("MentionText: thẻ có thật thành link, thẻ không thấy được thành thẻ xám chỉ có mã", async () => {
    wrap(<MentionText text={"Xem @SP001 và @SP999"} />)
    await waitFor(() => expect(screen.getByTestId("ref-chip").getAttribute("href")).toBe("/x/khach_hang/1"))
    expect(screen.getByTestId("ref-chip-missing").textContent).toBe("SP999")
  })
  it("rê chuột vào thẻ → xem nhanh vài trường", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    get.mockImplementation(async (url: string) => (url === "/refs/resolve" ? { data: [{ ...AN, requested: "SP001" }] } : url === "/refs/record/1/preview" ? { data: { ...AN, fields: [{ label: "Lớp", value: "5A" }] } } : { data: [] }))
    wrap(<MentionText text="@SP001" />)
    const chip = await screen.findByTestId("ref-chip")
    fireEvent.mouseEnter(chip.parentElement as HTMLElement)
    await act(async () => { vi.advanceTimersByTime(400) })
    await waitFor(() => expect(screen.getByTestId("ref-preview").textContent).toContain("Lớp:5A"))
    vi.useRealTimers()
  })
  it("Được nhắc tới ở: liệt kê nguồn + trường", async () => {
    wrap(<MentionedIn type="record" id={1} />)
    const box = await screen.findByTestId("mentioned-in")
    expect(box.textContent).toContain("LH001")
    expect(box.textContent).toContain("Lịch hẹn · Ghi chú")
  })
})
