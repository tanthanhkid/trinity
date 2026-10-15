/**
 * Các trang management/* thiếu quyền phải hiện <Forbidden/> và KHÔNG
 * bắn request nào. Quyền khớp `nav-config.ts` + controller BE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

const get = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: () => "",
}))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isLoading: false, user: null }) }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}))
vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }))

import { useAuthStore } from "@/store/auth"
import JobTitlesPage from "../../app/(dashboard)/management/job-titles/page"
import WorkdaysPage from "../../app/(dashboard)/management/workdays/page"
import ContractsPage from "../../app/(dashboard)/management/contracts/page"
import EmployeesPage from "../../app/(dashboard)/management/employees/page"
import EmployeeStatsPage from "../../app/(dashboard)/management/employees/stats/page"

const INITIAL = useAuthStore.getState()

function renderPage(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  get.mockReset()
  // Mảng có thêm `.data`/`.pagination` → vừa khớp hook trả mảng, vừa khớp hook trả {data, pagination}.
  const empty = Object.assign([] as unknown[], { data: [], pagination: { total: 0 } })
  get.mockResolvedValue({ data: empty })
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

// Role chỉ có vài quyền không liên quan (như tài khoản nhân sự/bán hàng trong e2e).
const OTHER = { "users.view": "all", "payroll.view": "all" } as never

const PAGES: Array<[string, () => ReactNode, string]> = [
  ["/management/job-titles", () => <JobTitlesPage />, "org.manage"],
  ["/management/workdays", () => <WorkdaysPage />, "attendance.config"],
  ["/management/contracts", () => <ContractsPage />, "contracts.view"],
  ["/management/employees", () => <EmployeesPage />, "employees.view"],
  ["/management/employees/stats", () => <EmployeeStatsPage />, "employees.view"],
]

describe("trang thiếu quyền → Forbidden + 0 request", () => {
  it.each(PAGES)("%s: thiếu quyền → Forbidden, không gọi API", async (_n, page) => {
    useAuthStore.setState({ permissions: OTHER })
    renderPage(page())
    expect(screen.getByText(/Bạn không có quyền truy cập trang này/i)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 40))
    expect(get).not.toHaveBeenCalled()
  })

  // /management/employees/stats cần payload thống kê thật để vẽ biểu đồ → chỉ kiểm nhánh thiếu quyền.
  it.each(PAGES.filter(([n]) => !n.endsWith("/stats")))("%s: có quyền → không Forbidden", async (_n, page, perm) => {
    useAuthStore.setState({ permissions: { [perm]: "all", "attendance.view": "all" } as never })
    renderPage(page())
    await new Promise((r) => setTimeout(r, 40))
    expect(screen.queryByText(/Bạn không có quyền truy cập trang này/i)).toBeNull()
  })
})
