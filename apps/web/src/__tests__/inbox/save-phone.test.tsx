import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

/**
 * «Lưu SĐT vào hồ sơ» dưới bong bóng khách (Zalo OA): số do máy chủ dò (`phones`), bấm = POST /zalo-oa/threads/:id/save-phone,
 * hội thoại chưa ghép khách mới có nút, khách đã mang đúng số thì «Đã lưu», khách mang số khác thì không hiện gì.
 */
const mockGet = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a), patch: vi.fn() } }))
const undoToast = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: undoToast }))
const toastError = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }))
const perms = vi.hoisted(() => ({ update: true }))
vi.mock("@/lib/rbac", () => ({
  usePermissions: () => ({ can: (k: string) => k === "contacts.view" || (k === "contacts.update" && perms.update), isAdmin: false }),
}))
vi.mock("@/hooks/use-settings-options", () => ({ useSettingsOptions: () => ({ data: [] }) }))

import { SavePhoneAction, samePhone, savePhoneState } from "@/components/inbox/save-phone"
import { ZaloThreadView } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-inbox"
import type { ZaloOaThread } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-types"

const thread = (over: Partial<ZaloOaThread> = {}): ZaloOaThread => ({
  id: 5, zalo_user_id: "U5", display_name: "Hạnh", avatar_url: null, phone: null, contact_id: null,
  last_message_preview: "x", last_message_at: new Date().toISOString(), last_inbound_at: new Date().toISOString(), unread_count: 0, ...over,
})
const msg = (id: string, text: string, phones: string[], direction: "in" | "out" = "in") => ({
  id, direction, kind: "text", text, status: "received", error: null, created_at: new Date().toISOString(), phones,
})

function mount(t: ZaloOaThread, messages: unknown[], contact?: Record<string, unknown>) {
  mockGet.mockImplementation(async (url: string) => {
    if (url.startsWith("/zalo-oa/threads/5/messages")) return { data: { data: messages } }
    if (url.startsWith("/contacts/") && contact) return { data: contact }
    return { data: {} }
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ZaloThreadView thread={t} onBack={() => {}} /></QueryClientProvider>)
}

describe("samePhone / savePhoneState", () => {
  it("so theo 9 số cuối, bỏ qua định dạng", () => {
    expect(samePhone("0912345678", "84912345678")).toBe(true)
    expect(samePhone("+84 912 345 678", "0912.345.678")).toBe(true)
    expect(samePhone("0912345678", "0987654321")).toBe(false)
    expect(samePhone(null, "0912345678")).toBe(false)
    expect(samePhone("", "")).toBe(false)
  })
  it("offer chỉ khi chưa ghép khách và được sửa khách; saved khi khách mang đúng số; số khác ⇒ none", () => {
    const base = { phone: "0912345678", profilePhone: null as string | null }
    expect(savePhoneState({ ...base, linked: false, canUpdate: true })).toBe("offer")
    expect(savePhoneState({ ...base, linked: false, canUpdate: false })).toBe("none")
    expect(savePhoneState({ ...base, linked: true, profilePhone: "84912345678", canUpdate: true })).toBe("saved")
    expect(savePhoneState({ ...base, linked: true, profilePhone: "0987654321", canUpdate: true })).toBe("none")
  })
})

describe("<SavePhoneAction>", () => {
  it("nhãn có số định dạng, bấm gọi onSave, đang lưu thì khoá", () => {
    const onSave = vi.fn()
    const { rerender } = render(<SavePhoneAction phone="0912345678" state="offer" onSave={onSave} />)
    fireEvent.click(screen.getByRole("button", { name: "Lưu 0912 345 678 vào hồ sơ" }))
    expect(onSave).toHaveBeenCalledTimes(1)
    rerender(<SavePhoneAction phone="0912345678" state="offer" pending onSave={onSave} />)
    expect(screen.getByRole("button", { name: "Đang lưu…" })).toBeDisabled()
    rerender(<SavePhoneAction phone="0912345678" state="saved" onSave={onSave} />)
    expect(screen.getByText("Đã lưu số này vào hồ sơ")).toBeTruthy()
  })
})

describe("<ZaloThreadView> + lưu SĐT", () => {
  beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); undoToast.mockReset(); toastError.mockReset(); perms.update = true })

  it("bấm nút ⇒ POST save-phone đúng tin + số, toast báo đã tạo khách", async () => {
    mockPost.mockResolvedValue({ data: { thread: thread({ contact_id: 9 }), contact_id: 9, phone: "0912345678", created: true, already: false } })
    mount(thread(), [msg("77", "SĐT chị 0912 345 678", ["0912345678"]), msg("78", "báo giá giúp chị", [])])
    const btn = await screen.findByRole("button", { name: "Lưu 0912 345 678 vào hồ sơ" })
    expect(screen.getAllByRole("button", { name: /vào hồ sơ/ })).toHaveLength(1)
    fireEvent.click(btn)
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/zalo-oa/threads/5/save-phone", { message_id: "77", phone: "0912345678" }))
    await waitFor(() => expect(undoToast).toHaveBeenCalledWith("Đã lưu số điện thoại và tạo khách mới"))
  })

  it("tin có hai số ⇒ hai nút, mỗi nút gửi đúng số của nó; tin của nhân viên không có nút", async () => {
    mockPost.mockResolvedValue({ data: { thread: thread({ contact_id: 9 }), contact_id: 9, phone: "0987654321", created: false, already: false } })
    mount(thread(), [msg("1", "0912 345 678 hoặc 0987 654 321", ["0912345678", "0987654321"]), msg("2", "em gọi 0912 345 678", ["0912345678"], "out")])
    expect(await screen.findAllByRole("button", { name: /vào hồ sơ/ })).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Lưu 0987 654 321 vào hồ sơ" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/zalo-oa/threads/5/save-phone", { message_id: "1", phone: "0987654321" }))
    await waitFor(() => expect(undoToast).toHaveBeenCalledWith("Đã lưu số điện thoại vào hồ sơ"))
  })

  it("lỗi từ máy chủ ⇒ toast lỗi, không toast thành công", async () => {
    mockPost.mockRejectedValue({ response: { data: { message: "Hồ sơ khách đã có số điện thoại khác" } } })
    mount(thread(), [msg("1", "0912345678", ["0912345678"])])
    fireEvent.click(await screen.findByRole("button", { name: /vào hồ sơ/ }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(undoToast).not.toHaveBeenCalled()
  })

  it("khách đã ghép mang đúng số ⇒ «Đã lưu», không nút; mang số khác hoặc thiếu quyền ⇒ không hiện gì", async () => {
    const m = [msg("1", "0912345678", ["0912345678"])]
    const a = mount(thread({ contact_id: 9, phone: "84912345678" }), m, { id: 9, phone: "0912345678", full_name: "Hạnh" })
    expect(await screen.findAllByText("Đã lưu số này vào hồ sơ")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Lưu .* vào hồ sơ/ })).toBeNull()
    a.unmount()
    const b = mount(thread({ contact_id: 9, phone: "84987654321" }), m, { id: 9, phone: "0987654321", full_name: "Hạnh" })
    await waitFor(() => expect(screen.getAllByText("Hạnh").length).toBeGreaterThan(0))
    expect(screen.queryByText("Đã lưu số này vào hồ sơ")).toBeNull()
    expect(screen.queryByRole("button", { name: /Lưu .* vào hồ sơ/ })).toBeNull()
    b.unmount()
    perms.update = false
    mount(thread(), m)
    await waitFor(() => expect(screen.getAllByText("0912345678").length).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: /Lưu .* vào hồ sơ/ })).toBeNull()
  })
})
