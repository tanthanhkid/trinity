import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Extension, ExtensionVersion } from "@/lib/extensions"

/**
 * Chương trình con (trợ lý AI viết, NGƯỜI duyệt): danh sách, xem mã + quyền xin bằng lời thường, Duyệt/Từ chối/Chạy/Tắt/Bật lại/Quay lui,
 * nhật ký chạy; lỗi BE hiện nguyên văn; nội dung do AI soạn chỉ là text; tính năng tắt (404) ⇒ thông báo; KHÔNG chữ MCP/API/OAuth/token.
 */
const mockGet = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) } }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
const search = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock("next/navigation", () => ({ useSearchParams: () => search.value, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))

import { ExtensionsScreen } from "@/components/extensions/extensions-screen"

const ext = (id: number, over: Partial<Extension> = {}): Extension => ({
  id, key: `dong-bo-${id}`, kind: "job", name: `Đồng bộ Sheet ${id}`, description: "Kéo khách mới từ Google Sheet về mỗi sáng", status: "draft",
  active_version: null, latest_version: 1, disabled_reason: null, consecutive_failures: 0, created_at: "2026-10-09T01:00:00.000Z", updated_at: "2026-10-09T02:00:00.000Z", ...over,
})
const ver = (version: number, over: Partial<ExtensionVersion> = {}): ExtensionVersion => ({
  version, review_status: "draft", review_note: null, note: null, created_at: "2026-10-09T01:00:00.000Z", reviewed_at: null,
  manifest: { net: ["sheets.googleapis.com"], tables: { read: ["khach_hang"], write: ["khach_hang"] }, schedule: "0 8 * * *" }, ...over,
})
const CODE = 'export default async function (ctx) { ctx.log("<script>alert(1)</script>") }'

function route(e: Extension, versions: ExtensionVersion[], runs: unknown[] = []) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/extensions") return { data: { data: [e] } }
    if (url.endsWith("/logs")) return { data: { runs, next_cursor: null } }
    if (/\/versions\/\d+$/.test(url)) return { data: { version: { ...versions.find((v) => url.endsWith(`/${v.version}`))!, code: CODE } } }
    return { data: { extension: e, versions } }
  })
}
function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ExtensionsScreen /></QueryClientProvider>)
}
const open = async () => { fireEvent.click(await screen.findByRole("button", { name: /Xem/ })); return screen.findByRole("dialog") }

beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); toast.success.mockReset(); search.value = new URLSearchParams() })
afterEach(() => { vi.clearAllMocks() })

describe("<ExtensionsScreen>", () => {
  it("liệt kê, lọc Chờ duyệt / Đang chạy; rỗng ⇒ hướng dẫn nhờ trợ lý AI", async () => {
    route(ext(1), [ver(1)])
    renderIt()
    expect(await screen.findAllByTestId("extension-card")).toHaveLength(1)
    expect(screen.getByText("Chờ duyệt", { selector: "span,div" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Đang chạy" }))
    await screen.findByText(/Không có chương trình con nào trong mục này/)
  })

  it("tính năng tắt (404) ⇒ thông báo chưa bật", async () => {
    mockGet.mockRejectedValue({ response: { status: 404 } })
    renderIt()
    await screen.findByText(/chưa được bật trên hệ thống này/)
  })

  it("xem bản nháp: quyền xin bằng lời thường + mã dạng TEXT (không chạy HTML); Duyệt ⇒ POST approve; chưa chạy cho tới khi bấm Chạy", async () => {
    route(ext(3), [ver(1)])
    mockPost.mockResolvedValue({ data: {} })
    renderIt()
    const dialog = await open()
    const perms = await within(dialog).findByTestId("extension-permissions")
    expect(perms.textContent).toContain("sheets.googleapis.com")
    expect(perms.textContent).toContain("ĐỌC dữ liệu các bảng: khach_hang")
    expect(perms.textContent).toContain("GHI dữ liệu vào các bảng: khach_hang")
    expect(perms.textContent).toContain("0 8 * * *")
    await waitFor(() => expect(within(dialog).getByTestId("extension-code").textContent).toBe(CODE))
    expect(dialog.querySelector("script")).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: "Duyệt bản 1" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/extensions/3/versions/1/approve"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("bấm Chạy")))
  })

  it("Từ chối cần lý do (hiện ô nhập trước), gửi lý do cho BE", async () => {
    route(ext(4), [ver(1)])
    mockPost.mockResolvedValue({ data: {} })
    renderIt()
    const dialog = await open()
    fireEvent.click(await within(dialog).findByRole("button", { name: "Từ chối" }))
    expect(mockPost).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Xin ghi quá nhiều bảng" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Từ chối" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/extensions/4/versions/1/reject", { reason: "Xin ghi quá nhiều bảng" }))
  })

  it("bản đã duyệt chưa chạy ⇒ nút Chạy bản N; bản cũ hơn bản đang chạy ⇒ Quay lui; đang chạy ⇒ Tắt", async () => {
    route(ext(5, { status: "active", active_version: 2, latest_version: 2 }), [ver(2, { review_status: "approved" }), ver(1, { review_status: "approved" })])
    mockPost.mockResolvedValue({ data: {} })
    renderIt()
    const dialog = await open()
    await within(dialog).findByRole("button", { name: "Tắt chương trình con" })
    fireEvent.click(within(dialog).getByRole("button", { name: /Bản 1 · Đã duyệt/ }))
    fireEvent.click(await within(dialog).findByRole("button", { name: "Quay lui về bản 1" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/extensions/5/rollback", { version: 1 }))
  })

  it("đã tắt (tự tắt vì lỗi) ⇒ hiện lý do + nút Bật lại", async () => {
    route(ext(6, { status: "disabled", active_version: 1, disabled_reason: "Tự tắt sau 3 lần lỗi liên tiếp. Lỗi cuối: timeout" }), [ver(1, { review_status: "approved" })])
    mockPost.mockResolvedValue({ data: {} })
    renderIt()
    const dialog = await open()
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Tự tắt sau 3 lần lỗi liên tiếp")
    fireEvent.click(within(dialog).getByRole("button", { name: "Bật lại" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/extensions/6/enable"))
  })

  it("lỗi từ BE hiện NGUYÊN VĂN; tab Nhật ký liệt kê các lần chạy", async () => {
    route(ext(7), [ver(1)], [{ id: 1, mode: "dry_run", outcome: "ok", duration_ms: 12, started_at: "2026-10-09T03:00:00.000Z", log: "xong 3 dòng" }])
    mockPost.mockRejectedValue({ response: { data: { message: "Phiên bản 1 đã được xử lý (approved)." } } })
    renderIt()
    const dialog = await open()
    fireEvent.click(await within(dialog).findByRole("button", { name: "Duyệt bản 1" }))
    expect((await within(dialog).findByText(/đã được xử lý/)).textContent).toContain("Phiên bản 1")
    fireEvent.click(within(dialog).getByRole("button", { name: "Nhật ký chạy" }))
    expect((await within(dialog).findByTestId("extension-runs")).textContent).toContain("Chạy thử")
    expect(within(dialog).getByText("xong 3 dòng")).toBeTruthy()
  })

  it("chữ hiển thị không dùng thuật ngữ MCP/API/OAuth/token", async () => {
    route(ext(8, { status: "disabled", active_version: 1, disabled_reason: "Đã tắt" }), [ver(1, { review_status: "approved" })])
    renderIt()
    const dialog = await open()
    await within(dialog).findByTestId("extension-permissions")
    expect(document.body.textContent).not.toMatch(/\b(MCP|API|OAuth|token)\b/i)
  })

  it("?id= mở thẳng chương trình con (link từ thông báo)", async () => {
    search.value = new URLSearchParams("id=9")
    route(ext(9), [ver(1)])
    renderIt()
    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith("/extensions/9")
  })
})
