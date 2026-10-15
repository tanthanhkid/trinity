import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { SocialImportPlan } from "@/hooks/use-social"
import { SocialImportDialog, importWhen } from "../social-import"
import { buildCsvTemplate, csvCell } from "../social-csv-template"

const state = vi.hoisted(() => ({
  plan: vi.fn(),
  run: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: state.toastError, info: vi.fn() } }))
vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialAccounts: () => ({ data: [{ id: 3, network: "facebook", name: "Fanpage Quán", avatar_url: null, status: "active", last_error: null }] }),
  // mutate(body, { onSuccess, onError }) — gọi bất đồng bộ như react-query.
  useSocialImport: () => ({
    plan: { isPending: false, mutate: (b: unknown, o: { onSuccess: (v: unknown) => void; onError: (e: unknown) => void }) => state.plan(b).then(o.onSuccess, o.onError) },
    run: { isPending: false, mutate: (b: unknown, o: { onSuccess: (v: unknown) => void; onError: (e: unknown) => void }) => state.run(b).then(o.onSuccess, o.onError) },
  }),
}))

const PLAN: SocialImportPlan = {
  mode: "schedule",
  plan_hash: "h".repeat(64),
  total: 3,
  ok_count: 2,
  error_count: 1,
  rows: [
    { row: 2, ok: true, errors: [], warnings: ["Có 2 tệp tên \"logo.png\" — dùng tệp mới nhất."], preview: { channels: [{ account_id: 3, name: "Fanpage Quán", network: "facebook" }], scheduled_at: "2030-01-01T02:00:00.000Z", use_queue: false, content_excerpt: "Bài một" } },
    { row: 3, ok: true, errors: [], warnings: [], preview: { channels: [{ account_id: 3, name: "Fanpage Quán", network: "facebook" }], scheduled_at: "2030-01-02T02:00:00.000Z", use_queue: true, content_excerpt: "Bài hai" } },
    { row: 4, ok: false, errors: ["Cần giờ đăng hoặc 'hàng đợi'."], warnings: [], preview: { channels: [], scheduled_at: null, use_queue: false, content_excerpt: "Bài ba" } },
  ],
}
const CSV = "noi_dung,kenh,gio_dang\nBài một,Fanpage Quán,2030-01-01 09:00"

function open() {
  render(<SocialImportDialog open onOpenChange={vi.fn()} />)
  fireEvent.change(screen.getByLabelText("Nội dung CSV"), { target: { value: CSV } })
}

describe("SocialImportDialog", () => {
  beforeEach(() => {
    state.plan.mockReset().mockResolvedValue(PLAN)
    state.run.mockReset().mockResolvedValue({ mode: "schedule", created: [{ row: 2, id: 11 }, { row: 3, id: 12 }], skipped: [{ row: 4, errors: ["Cần giờ đăng hoặc 'hàng đợi'."] }] })
    state.toastError.mockReset()
  })

  it("chưa có chữ ⇒ Kiểm tra bị khoá; chưa kiểm ⇒ không tạo được", () => {
    render(<SocialImportDialog open onOpenChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: /Kiểm tra/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Tạo 0 bài/ })).toBeDisabled()
  })

  it("luồng đủ: chọn Hẹn đăng → dán → Kiểm tra (bảng, lỗi đỏ, cảnh báo vàng) → Tạo 2 bài gửi plan_hash → tóm tắt", async () => {
    open()
    fireEvent.click(screen.getByRole("radio", { name: "Hẹn đăng" }))
    fireEvent.click(screen.getByRole("button", { name: /Kiểm tra/ }))
    await screen.findByTestId("import-plan")
    expect(state.plan).toHaveBeenCalledWith({ csv: CSV, mode: "schedule" })
    const rows = screen.getAllByTestId("import-row")
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText(/2 tệp tên "logo.png"/)).toHaveClass("text-[var(--color-app-tag-amber-ink)]")
    expect(within(rows[1]).getByText(/Hàng đợi/)).toBeInTheDocument()
    expect(within(rows[2]).getByText("Cần giờ đăng hoặc 'hàng đợi'.")).toHaveClass("text-destructive")
    expect(screen.getByText(/2/, { selector: "b" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Tạo 2 bài/ }))
    await screen.findByTestId("import-result")
    expect(state.run).toHaveBeenCalledWith({ csv: CSV, mode: "schedule", plan_hash: PLAN.plan_hash })
    const res = screen.getByTestId("import-result")
    expect(res).toHaveTextContent(/Đã hẹn 2 bài, bỏ qua 1 dòng/)
    expect(res).toHaveTextContent(/Dòng 4: Cần giờ đăng hoặc/)
  })

  it("sửa chữ hoặc đổi chế độ sau khi kiểm ⇒ không tạo được cho tới khi kiểm lại", async () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: /Kiểm tra/ }))
    await screen.findByTestId("import-plan")
    fireEvent.change(screen.getByLabelText("Nội dung CSV"), { target: { value: `${CSV}\nthêm,Fanpage Quán,` } })
    expect(screen.getByRole("button", { name: /Tạo 0 bài/ })).toBeDisabled()
    expect(screen.getByText(/Nội dung đã đổi/)).toBeInTheDocument()
    expect(state.run).not.toHaveBeenCalled()
  })

  it("không dòng nào hợp lệ ⇒ không tạo; lỗi 409 khi tạo ⇒ báo và bỏ bản kiểm cũ", async () => {
    state.plan.mockResolvedValue({ ...PLAN, ok_count: 0, error_count: 3, rows: PLAN.rows.map((r) => ({ ...r, ok: false, errors: ["lỗi"] })) })
    open()
    fireEvent.click(screen.getByRole("button", { name: /Kiểm tra/ }))
    await screen.findByTestId("import-plan")
    expect(screen.getByRole("button", { name: /Tạo 0 bài/ })).toBeDisabled()

    state.plan.mockResolvedValue(PLAN)
    state.run.mockRejectedValue({ isAxiosError: true, response: { data: { message: "Dữ liệu đã đổi" } } })
    fireEvent.click(screen.getByRole("button", { name: /Kiểm tra/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: /Tạo 2 bài/ })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: /Tạo 2 bài/ }))
    await waitFor(() => expect(state.toastError).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId("import-plan")).not.toBeInTheDocument())
  })

  it("chọn tệp CSV ⇒ nội dung đổ vào ô văn bản", async () => {
    render(<SocialImportDialog open onOpenChange={vi.fn()} />)
    const file = new File([CSV], "bai.csv", { type: "text/csv" })
    fireEvent.change(screen.getByTestId("csv-file"), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText("Nội dung CSV")).toHaveValue(CSV))
  })

  it("Tải file mẫu tạo tệp CSV tiếng Việt có tên kênh của người dùng", async () => {
    let blob: Blob | undefined
    const createObjectURL = vi.fn((b: Blob) => ((blob = b), "blob:x"))
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    render(<SocialImportDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /Tải file mẫu/ }))
    expect(click).toHaveBeenCalled()
    const text = await new Promise<string>((res) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.readAsText(blob!)
    })
    expect(text).toContain("noi_dung,kenh,gio_dang,tep,binh_luan_dau,tieu_de_youtube,utm")
    expect(text).toContain("Fanpage Quán")
    click.mockRestore()
  })
})

describe("importWhen / buildCsvTemplate", () => {
  it("cột giờ: hàng đợi, giờ cụ thể, không có", () => {
    expect(importWhen({ channels: [], scheduled_at: null, use_queue: true, content_excerpt: "" })).toBe("Hàng đợi")
    expect(importWhen({ channels: [], scheduled_at: null, use_queue: false, content_excerpt: "" })).toBe("—")
    expect(importWhen({ channels: [], scheduled_at: "2030-01-01T02:00:00.000Z", use_queue: false, content_excerpt: "" })).toMatch(/09:00/)
  })
  it("mẫu có BOM, tiêu đề tiếng Việt, 2 dòng ví dụ; giờ ví dụ là giờ Việt Nam", () => {
    const t = buildCsvTemplate(["Fanpage Quán", "Kênh YT"], new Date("2026-10-15T00:00:00Z"))
    const lines = t.trim().split("\r\n")
    expect(t.charCodeAt(0)).toBe(0xfeff)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("2026-10-17 09:00")
    expect(lines[1]).toContain("Fanpage Quán")
    expect(lines[2]).toContain('"Fanpage Quán; Kênh YT"')
    expect(lines[2]).toContain("hàng đợi")
    expect(buildCsvTemplate([]).split("\r\n")[1]).toContain("Tên kênh")
  })
  it("csvCell bọc ngoặc kép và nhân đôi dấu nháy", () => {
    expect(csvCell('nói "hi", ok')).toBe('"nói ""hi"", ok"')
    expect(csvCell("thường")).toBe("thường")
  })
})
