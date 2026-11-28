import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const post = vi.fn()
const patch = vi.fn()
const del = vi.fn()
const get = vi.fn()
const undoToast = vi.fn()
const perms = { list: ["contacts.update", "contacts.phone_full"] }
vi.mock("@/lib/api-client", () => ({
  default: {
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
    get: (...a: unknown[]) => get(...a),
  },
}))
vi.mock("@/components/app-shell/hover-link", () => ({
  HoverLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: (...a: unknown[]) => undoToast(...a) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: (p: string) => perms.list.includes(p) }) }))

import { QuickNoteCard } from "@/app/(dashboard)/contacts/[id]/_components/quick-note-card"
import { MissingInfoScreen } from "@/app/(dashboard)/contacts/[id]/_components/missing-info-sheet"
import type { ContactData } from "@/app/(dashboard)/contacts/[id]/_components/contact-info-form"
import { genderLabel } from "@/lib/contact-gender"
import { ContactHero } from "@/app/(dashboard)/contacts/[id]/_components/contact-hero"

const base: ContactData = {
  id: 7, phone: "0912345678", full_name: "Trần Thu Hà", source_id: null, stage_id: null, contact_status_id: null,
  job_title: null, birthday: null, reminder_at: null, reminder_notes: null, assigned_to: null, team_id: null,
  gender: null, email: null, current_address: null, company_name: null,
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient()
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe("Ghi nhanh cuộc gọi", () => {
  beforeEach(() => { post.mockReset(); post.mockResolvedValue({ data: { id: 1 } }) })

  it("desktop: nhãn + gợi ý của thiết kế; ô trống thì «Lưu ghi chú» bị khoá", () => {
    wrap(<QuickNoteCard contactId={7} variant="desktop" />)
    expect(screen.getByLabelText("Ghi nhanh cuộc gọi")).toBeTruthy()
    expect(screen.getByText("Lưu vào dòng thời gian của khách")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Lưu ghi chú" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Ghi nhanh cuộc gọi"), { target: { value: "   " } })
    expect((screen.getByRole("button", { name: "Lưu ghi chú" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("mobile: lưu gửi POST /contacts/:id/notes với ghi chú đã cắt khoảng trắng rồi xoá ô", async () => {
    wrap(<QuickNoteCard contactId={7} variant="mobile" />)
    const box = screen.getByLabelText("Ghi nhanh") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "  Khách hẹn chiều mai gọi lại  " } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu ghi chú" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith("/contacts/7/notes", { note: "Khách hẹn chiều mai gọi lại" })
    await waitFor(() => expect(box.value).toBe(""))
  })

  it("lưu xong toast «Đã lưu ghi chú» có Hoàn tác = DELETE /contacts/:id/notes/:noteId, trả chữ về ô", async () => {
    undoToast.mockReset()
    del.mockReset(); del.mockResolvedValue({ data: { revoked: true } })
    post.mockResolvedValueOnce({ data: { id: 55 } })
    wrap(<QuickNoteCard contactId={7} variant="desktop" />)
    const box = screen.getByLabelText("Ghi nhanh cuộc gọi") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "Hẹn gọi lại" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu ghi chú" }))
    await waitFor(() => expect(undoToast).toHaveBeenCalledTimes(1))
    const [msg, opts] = undoToast.mock.calls[0] as [string, { onUndo?: () => void }]
    expect(msg).toBe("Đã lưu ghi chú")
    expect(box.value).toBe("")
    opts.onUndo?.()
    await waitFor(() => expect(del).toHaveBeenCalledWith("/contacts/7/notes/55"))
    await waitFor(() => expect(box.value).toBe("Hẹn gọi lại"))
  })

  it("lưu lỗi thì giữ nguyên chữ đã gõ", async () => {
    post.mockRejectedValueOnce(new Error("x"))
    wrap(<QuickNoteCard contactId={7} variant="desktop" />)
    const box = screen.getByLabelText("Ghi nhanh cuộc gọi") as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "Ghi chú" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu ghi chú" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(box.value).toBe("Ghi chú")
  })
})

describe("Bổ sung thông tin (màn toàn phần)", () => {
  beforeEach(() => { patch.mockReset(); patch.mockResolvedValue({ data: {} }) })

  it("giới tính có «Khác»; nhãn hiển thị đủ ba giá trị", () => {
    expect(genderLabel("khac")).toBe("Khác")
    expect(genderLabel("nu")).toBe("Nữ")
    expect(genderLabel("nam")).toBe("Nam")
    expect(genderLabel("x")).toBeNull()
    wrap(<MissingInfoScreen contact={base} open onOpenChange={() => {}} />)
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Nữ", "Nam", "Khác"])
  })

  it("đầu màn Huỷ · tiêu đề · Lưu; khối nhấn đếm thông tin còn thiếu; Lưu chỉ sáng khi có thay đổi", async () => {
    const onOpenChange = vi.fn()
    wrap(<MissingInfoScreen contact={base} open onOpenChange={onOpenChange} />)
    expect(screen.getByRole("heading", { name: "Bổ sung thông tin" })).toBeTruthy()
    expect(screen.getByText("Trần Thu Hà còn thiếu 5 thông tin")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Huỷ" })).toBeTruthy()
    expect((screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "Khác" }))
    fireEvent.change(screen.getByLabelText("Nghề nghiệp"), { target: { value: "Giáo viên" } })
    const save = screen.getByRole("button", { name: "Lưu (2)" })
    fireEvent.click(save)
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith("/contacts/7", { gender: "khac", job_title: "Giáo viên" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

describe("Khối nhấn — «+ Thêm số điện thoại»", () => {
  beforeEach(() => {
    patch.mockReset(); patch.mockResolvedValue({ data: {} })
    undoToast.mockReset()
    perms.list = ["contacts.update", "contacts.phone_full"]
  })

  it("khách chưa có SĐT: nút mở ô nhập tại chỗ, Enter lưu PATCH phone, toast «Đã lưu» KHÔNG Hoàn tác", async () => {
    wrap(<ContactHero contactId={7} name="Hà" phone="" withActions />)
    expect(screen.queryByText("—")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Thêm số điện thoại" }))
    const input = screen.getByLabelText("Số điện thoại") as HTMLInputElement
    fireEvent.change(input, { target: { value: " 0912 345 678 " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/contacts/7", { phone: "0912 345 678" }))
    await waitFor(() => expect(undoToast).toHaveBeenCalledTimes(1))
    const [msg, opts] = undoToast.mock.calls[0] as [string, { onUndo?: () => void }]
    expect(msg).toBe("Đã lưu")
    expect(opts.onUndo).toBeUndefined()
  })

  it("lỗi máy chủ (trùng số) hiện dưới ô, giữ ô đang sửa", async () => {
    patch.mockRejectedValueOnce(new Error("Số điện thoại đã tồn tại"))
    wrap(<ContactHero contactId={7} name="Hà" phone="" withActions />)
    fireEvent.click(screen.getByRole("button", { name: "Thêm số điện thoại" }))
    const input = screen.getByLabelText("Số điện thoại") as HTMLInputElement
    fireEvent.change(input, { target: { value: "0912345678" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByLabelText("Số điện thoại")).toBeTruthy()
    expect(undoToast).not.toHaveBeenCalled()
  })

  it("thiếu contacts.phone_full: không có nút, chỉ hiện «—»", () => {
    perms.list = ["contacts.update"]
    wrap(<ContactHero contactId={7} name="Hà" phone="" withActions />)
    expect(screen.queryByRole("button", { name: "Thêm số điện thoại" })).toBeNull()
    expect(screen.getByText("—")).toBeTruthy()
  })

  it("khách có hội thoại Messenger (người xem có quyền hộp thư Messenger): nút «Messenger» mở đúng hội thoại", async () => {
    perms.list = ["contacts.update", "contacts.phone_full", "integrations.webhooks"]
    get.mockReset()
    get.mockImplementation(async (url: string) => (url === "/facebook/conversations" ? { data: { data: [{ id: 42 }] } } : { data: {} }))
    wrap(<ContactHero contactId={7} name="Hà" phone="0912345678" withActions />)
    const link = await screen.findByRole("link", { name: "Messenger" })
    expect(link.getAttribute("href")).toBe("/inbox?kenh=facebook&hoi_thoai=42")
    expect(get).toHaveBeenCalledWith("/facebook/conversations", { params: { contact_id: 7, limit: 1 } })
  })

  it("không có quyền hộp thư Messenger: không hỏi máy chủ, không có nút", () => {
    get.mockReset()
    wrap(<ContactHero contactId={7} name="Hà" phone="0912345678" withActions />)
    expect(screen.queryByRole("link", { name: "Messenger" })).toBeNull()
    expect(get).not.toHaveBeenCalledWith("/facebook/conversations", expect.anything())
  })

  it("đã có số (desktop): bấm số để sửa lại", () => {
    wrap(<ContactHero contactId={7} name="Hà" phone="0912345678" withActions />)
    fireEvent.click(screen.getByRole("button", { name: "Sửa số điện thoại" }))
    expect((screen.getByLabelText("Số điện thoại") as HTMLInputElement).value).toBe("0912345678")
  })
})
