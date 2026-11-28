import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const post = vi.fn()
const patch = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a) },
}))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: vi.fn() }))

import { QuickNoteCard } from "@/app/(dashboard)/contacts/[id]/_components/quick-note-card"
import { MissingInfoScreen } from "@/app/(dashboard)/contacts/[id]/_components/missing-info-sheet"
import type { ContactData } from "@/app/(dashboard)/contacts/[id]/_components/contact-info-form"
import { genderLabel } from "@/lib/contact-gender"

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
