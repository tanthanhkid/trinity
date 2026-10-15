/**
 * Thực thể tuỳ biến — trang chi tiết (chỉ-xem vs sửa/xoá theo quyền, bản ghi liên quan ngược) và ô chọn liên kết
 * (danh sách thả inline, chọn một/nhiều, khách hàng cần ≥2 ký tự).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import type { CustomObjectDef, CustomRecord } from "@/types/custom-objects"

const get = vi.fn()
const del = vi.fn()
const push = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: (...a: unknown[]) => del(...a) },
  getApiErrorMessage: (_e: unknown, fb: string) => fb,
}))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isLoading: false }) }))
vi.mock("next/navigation", () => ({
  useParams: () => ({ objectKey: "du_an", id: "5" }),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/x/du_an/5",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { useAuthStore } from "@/store/auth"
import RecordPage from "@/app/(dashboard)/x/[objectKey]/[id]/page"
import { RelationCombobox } from "@/components/custom-objects/relation-combobox"

const INITIAL = useAuthStore.getState()
const DEF = {
  id: 2, key: "du_an", label: "Dự án", label_plural: "Dự án", icon: null, description: null, show_in_nav: true, nav_order: 1, visible_role_ids: [], is_active: true,
  created_at: "", updated_at: "",
  fields: [
    { id: 1, key: "ten", label: "Họ tên", type: "text", required: true, is_unique: false, is_title: true, show_in_list: true, sort_order: 0, options: {}, help_text: null },
    { id: 2, key: "sdt", label: "SĐT", type: "phone", required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 1, options: {}, help_text: null },
  ],
} as CustomObjectDef
const REC: CustomRecord = { id: 5, title: "Dự án Alpha", owner_id: 3, owner_name: "Nguyễn Văn B", created_by: 3, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T03:00:00Z", data: { ten: "Dự án Alpha", sdt: "***123" }, relations: {} }

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  get.mockReset(); del.mockReset(); push.mockReset()
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/custom-objects/du_an")) return { data: DEF }
    if (url.endsWith("/records/5")) return { data: REC }
    if (url.endsWith("/related")) return { data: [{ object: { key: "hop_dong", label_plural: "Hợp đồng" }, field: { key: "du_an", label: "Dự án" }, total: 2, items: [{ id: 11, title: "Hợp đồng A" }, { id: 12, title: "Hợp đồng B" }] }] }
    return { data: [] }
  })
})
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("/x/[objectKey]/[id]", () => {
  it("chỉ có quyền xem: giá trị thuần (SĐT như BE trả), KHÔNG có Lưu/Xoá; có bản ghi liên quan ngược dạng liên kết", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    wrap(<RecordPage />)
    expect((await screen.findAllByText("Dự án Alpha")).length).toBeGreaterThan(0)
    expect(screen.getByText("***123")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Lưu thay đổi/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Xoá dự án/ })).toBeNull()
    expect(screen.queryByLabelText(/Họ tên/)).toBeNull() // không có ô nhập
    const an = await screen.findByRole("link", { name: "Hợp đồng A" })
    expect(an.getAttribute("href")).toBe("/x/hop_dong/11")
  })

  it("có manage + delete: form sửa được; Xoá cần xác nhận rồi gọi DELETE và quay về danh sách", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all", "custom_records.manage": "all", "custom_records.delete": "all" } as never })
    del.mockResolvedValue({ data: { ok: true } })
    wrap(<RecordPage />)
    expect(await screen.findByLabelText(/Họ tên/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Lưu thay đổi/ })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Xoá dự án/ }))
    expect(del).not.toHaveBeenCalled() // chưa xác nhận
    // hộp thoại xác nhận mở: phần còn lại của trang bị inert nên chỉ còn nút xác nhận của hộp thoại
    fireEvent.click(await screen.findByRole("button", { name: /Xoá dự án/ }))
    await waitFor(() => expect(del).toHaveBeenCalledWith("/custom-objects/du_an/records/5"))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/x/du_an"))
  })

  it("bản ghi 404 → 'Không tìm thấy bản ghi'", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    get.mockImplementation(async (url: string) => {
      if (url.endsWith("/custom-objects/du_an")) return { data: DEF }
      throw { response: { status: 404 } }
    })
    wrap(<RecordPage />)
    expect(await screen.findByText(/Không tìm thấy bản ghi/)).toBeTruthy()
  })
})

describe("RelationCombobox", () => {
  function Harness({ kind, multiple }: { kind: string; multiple?: boolean }) {
    const [v, setV] = useState<number | number[] | undefined>(undefined)
    return (
      <>
        <RelationCombobox kind={kind} multiple={multiple} value={v} onChange={setV} />
        <output data-testid="val">{JSON.stringify(v ?? null)}</output>
      </>
    )
  }
  const lookup = (q: string) => get.mock.calls.filter((c) => String(c[0]).includes("/lookup")).map((c) => (c[1] as { params: { q?: string } }).params.q ?? "")

  it("mở → tìm trong phạm vi (chỉ {id,title}) → chọn một: đóng lại và hiện tên", async () => {
    get.mockResolvedValue({ data: [{ id: 5, title: "Dự án Alpha" }, { id: 6, title: "Dự án Beta" }] })
    wrap(<Harness kind="du_an" />)
    fireEvent.click(screen.getByRole("button", { name: /Chọn…/ }))
    fireEvent.click(await screen.findByRole("button", { name: /Dự án Alpha/ }))
    expect(screen.getByTestId("val").textContent).toBe("5")
    expect(screen.queryByPlaceholderText("Gõ để tìm…")).toBeNull()
    expect(screen.getByText("Dự án Alpha")).toBeTruthy()
  })

  it("chọn nhiều: giữ danh sách mở, bỏ chọn bằng nút ×", async () => {
    get.mockResolvedValue({ data: [{ id: 5, title: "Dự án Alpha" }, { id: 6, title: "Dự án Beta" }] })
    wrap(<Harness kind="du_an" multiple />)
    fireEvent.click(screen.getByRole("button", { name: /Chọn…/ }))
    fireEvent.click(await screen.findByRole("button", { name: /Dự án Alpha/ }))
    fireEvent.click(screen.getByRole("button", { name: /Dự án Beta/ }))
    expect(screen.getByTestId("val").textContent).toBe("[5,6]")
    fireEvent.click(screen.getByRole("button", { name: "Bỏ Dự án Alpha" }))
    expect(screen.getByTestId("val").textContent).toBe("[6]")
  })

  it("khách hàng: dưới 2 ký tự hiện gợi ý; gọi đúng endpoint lookup/contacts", async () => {
    get.mockResolvedValue({ data: [] })
    wrap(<Harness kind="__contacts" />)
    fireEvent.click(screen.getByRole("button", { name: /Chọn…/ }))
    expect(await screen.findByText(/ít nhất 2 ký tự/)).toBeTruthy()
    await waitFor(() => expect(get.mock.calls.some((c) => c[0] === "/custom-objects/lookup/contacts")).toBe(true))
    expect(lookup("").length).toBeGreaterThan(0)
  })
})
