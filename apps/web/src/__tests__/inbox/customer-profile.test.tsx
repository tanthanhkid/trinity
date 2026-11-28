import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * Hồ sơ khách cạnh hội thoại (Ánh xanh): dữ liệu + ghi dùng đúng API chi tiết khách (GET/PATCH /contacts/:id),
 * lưu ngay + toast Hoàn tác, không API mới.
 */
const mockGet = vi.fn()
const mockPatch = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), patch: (...a: unknown[]) => mockPatch(...a) } }))
const undoToast = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: undoToast }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const perms = vi.hoisted(() => ({ update: true, admin: false }))
vi.mock("@/lib/rbac", () => ({
  usePermissions: () => ({ can: (k: string) => k === "contacts.view" || (k === "contacts.update" && perms.update), isAdmin: perms.admin }),
}))
vi.mock("@/hooks/use-settings-options", () => ({
  useSettingsOptions: (group: string) => ({
    data:
      group === "contact_stage"
        ? [{ id: 1, value: "new", label: "Mới" }, { id: 2, value: "follow_up_2", label: "Đang tư vấn" }, { id: 3, value: "won", label: "Chốt" }]
        : [{ id: 10, value: "wait_quote", label: "Chờ báo giá" }],
  }),
}))

import { CustomerProfile, reminderPresets, stageToneOf } from "@/components/inbox/customer-profile"

const CONTACT = {
  id: 7, phone: "0912345678", full_name: "Nguyễn Thị Hạnh", stage_id: 1, contact_status_id: null,
  stage_option: { id: 1, value: "new", label: "Mới" }, reminder_at: null, assigned_user: { full_name: "Linh" }, created_at: "2026-11-27T13:40:00Z",
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CustomerProfile contactId={7} fallbackName="Hạnh" channelLabel="Zalo OA" />
    </QueryClientProvider>,
  )
}

describe("stageToneOf / reminderPresets", () => {
  it("giai đoạn theo mã bền; mã lạ = trung tính", () => {
    expect(stageToneOf("new")).toBe("new")
    expect(stageToneOf("follow_up_2")).toBe("consult")
    expect(stageToneOf("won")).toBe("won")
    expect(stageToneOf("tuy_bien")).toBe("neutral")
    expect(stageToneOf(null)).toBe("neutral")
  })

  it("hẹn nhanh: hôm nay 17:00 chỉ khi chưa qua, sáng mai 09:00, thứ Hai tới 09:00 (giờ VN)", () => {
    // Thứ Bảy 28/11/2026 10:00 giờ VN
    const sat = reminderPresets(new Date("2026-11-28T10:00:00+07:00"))
    expect(sat.map((p) => p.label)).toEqual(["Hôm nay 17:00", "Sáng mai 09:00", "Thứ Hai 30/11 09:00"])
    expect(sat[0].at.toISOString()).toBe("2026-11-28T10:00:00.000Z")
    expect(sat[2].at.toISOString()).toBe("2026-11-30T02:00:00.000Z")
    // Chiều muộn: bỏ mốc 17:00 đã qua
    expect(reminderPresets(new Date("2026-11-28T18:00:00+07:00")).map((p) => p.label)).toEqual(["Sáng mai 09:00", "Thứ Hai 30/11 09:00"])
    // Thứ Hai: "thứ Hai tới" là tuần sau
    expect(reminderPresets(new Date("2026-11-30T08:00:00+07:00")).at(-1)?.label).toBe("Thứ Hai 07/12 09:00")
  })
})

describe("CustomerProfile", () => {
  beforeEach(() => {
    mockGet.mockReset(); mockPatch.mockReset(); undoToast.mockReset()
    perms.update = true; perms.admin = false
    mockGet.mockResolvedValue({ data: CONTACT })
    mockPatch.mockResolvedValue({ data: {} })
  })

  it("hiện khối nhấn có tên + giai đoạn · phụ trách, SĐT, link hồ sơ đầy đủ", async () => {
    wrap()
    expect(await screen.findByText("Mới · Phụ trách Linh")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Hồ sơ đầy đủ" }).getAttribute("href")).toBe("/contacts/7")
    expect(screen.getByText(/0912/)).toBeTruthy()
  })

  it("đổi giai đoạn: PATCH stage_id, toast có Hoàn tác trả lại giai đoạn cũ", async () => {
    wrap()
    fireEvent.click(await screen.findByRole("button", { name: "Đang tư vấn" }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/contacts/7", { stage_id: 2 }))
    await waitFor(() => expect(undoToast).toHaveBeenCalled())
    expect(undoToast.mock.calls[0][0]).toBe("Đã lưu giai đoạn")
    undoToast.mock.calls[0][1].onUndo()
    await waitFor(() => expect(mockPatch).toHaveBeenLastCalledWith("/contacts/7", { stage_id: 1 }))
  })

  it("trạng thái chi tiết trước đó trống: lưu được nhưng KHÔNG có Hoàn tác (BE không cho xoá)", async () => {
    wrap()
    fireEvent.click(await screen.findByRole("button", { name: /Sửa trạng thái chi tiết/ }))
    fireEvent.click(screen.getByRole("button", { name: "Chờ báo giá" }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/contacts/7", { contact_status_id: 10 }))
    await waitFor(() => expect(undoToast).toHaveBeenCalled())
    expect(undoToast.mock.calls[0][1].onUndo).toBeUndefined()
  })

  it("hẹn nhắc: chọn mốc ghi reminder_at ISO; Hoàn tác trả về null", async () => {
    wrap()
    fireEvent.click(await screen.findByRole("button", { name: /^Sáng mai 09:00$/ }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalled())
    const [, body] = mockPatch.mock.calls[0]
    expect(typeof body.reminder_at).toBe("string")
    await waitFor(() => expect(undoToast).toHaveBeenCalled())
    undoToast.mock.calls[0][1].onUndo()
    await waitFor(() => expect(mockPatch).toHaveBeenLastCalledWith("/contacts/7", { reminder_at: null }))
  })

  it("không có quyền sửa khách: chip giai đoạn khoá, không có nút hẹn nhắc", async () => {
    perms.update = false
    wrap()
    const chip = await screen.findByRole("button", { name: "Đang tư vấn" })
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole("button", { name: /^Sáng mai 09:00$/ })).toBeNull()
    fireEvent.click(chip)
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it("họ tên chỉ Quản trị sửa được (luật BE): Enter lưu full_name", async () => {
    perms.admin = true
    wrap()
    fireEvent.click(await screen.findByRole("button", { name: /Sửa họ tên/ }))
    const input = screen.getByLabelText("Họ tên")
    fireEvent.change(input, { target: { value: "Nguyễn Hạnh" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/contacts/7", { full_name: "Nguyễn Hạnh" }))
  })

  it("chưa ghép khách: chỉ thông tin từ hội thoại, không gọi API khách", async () => {
    const qc = new QueryClient()
    render(<QueryClientProvider client={qc}><CustomerProfile contactId={null} fallbackName="Hạnh" fallbackPhone="0912345678" channelLabel="Zalo OA" /></QueryClientProvider>)
    expect(screen.getByText("Chưa ghép với khách nào trong CRM.")).toBeTruthy()
    expect(mockGet).not.toHaveBeenCalled()
  })
})
