/**
 * Trang thiếu quyền phải hiện <Forbidden/> và
 * KHÔNG bắn request nào (không 403 ở console). Khoá cổng `PermissionGate` của
 * /kanban (kanban.view), /products (products.view), /pos (pos.sell).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"

const get = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: () => "",
}))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isLoading: false }) }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}))
vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }))

import { useAuthStore } from "@/store/auth"
import KanbanPage from "../../app/(dashboard)/kanban/page"
import ProductsPage from "../../app/(dashboard)/products/page"
import PosPage from "../../app/(dashboard)/pos/page"

const INITIAL = useAuthStore.getState()

function renderPage(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ data: { data: [], pagination: { total: 0 } } })
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

// Quản lý nhân sự: không có kanban/products/pos
const HR_MANAGER = { "users.view": "all", "payroll.view": "all", "contacts.view": "all" } as never

const PAGES: Array<[string, () => ReactNode, string]> = [
  ["/kanban", () => <KanbanPage />, "kanban.view"],
  ["/products", () => <ProductsPage />, "products.view"],
  ["/pos", () => <PosPage />, "pos.sell"],
]

describe("trang thiếu quyền → Forbidden + 0 request", () => {
  it.each(PAGES)("%s: thiếu quyền → Forbidden, không gọi API", async (_n, page) => {
    useAuthStore.setState({ permissions: HR_MANAGER })
    renderPage(page())
    expect(screen.getByText(/không có quyền/i)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 40))
    expect(get).not.toHaveBeenCalled()
  })

  it.each(PAGES)("%s: có quyền → không Forbidden và có gọi API", async (_n, page, perm) => {
    useAuthStore.setState({ permissions: { [perm]: "all" } as never })
    renderPage(page())
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByText(/Bạn không có quyền truy cập trang này/i)).toBeNull()
  })
})

describe("/payroll theo quyền", () => {
  it("thiếu payroll.view → Forbidden, không gọi API", async () => {
    const { default: PayrollPage } = await import("../../app/(dashboard)/payroll/page")
    useAuthStore.setState({ permissions: { "users.view": "all" } as never })
    renderPage(<PayrollPage />)
    expect(screen.getByText(/không có quyền/i)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 40))
    expect(get).not.toHaveBeenCalled()
  })

  it("payroll.view không có payroll.manage → ẩn tab cấu hình/báo cáo", async () => {
    const { default: PayrollPage } = await import("../../app/(dashboard)/payroll/page")
    useAuthStore.setState({ permissions: { "payroll.view": "all" } as never })
    renderPage(<PayrollPage />)
    expect(screen.getByText("Phiếu lương")).toBeTruthy()
    expect(screen.queryByText("Báo cáo")).toBeNull()
    expect(screen.queryByText("Thuế TNCN")).toBeNull()
  })
})
