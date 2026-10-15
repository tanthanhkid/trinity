/**
 * Hook/trang còn lại chỉ gọi API khi đủ
 * quyền BE yêu cầu; trang thiếu quyền → <Forbidden/>, 0 request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, renderHook, screen, waitFor } from "@testing-library/react"
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

import { useAuthStore } from "@/store/auth"
import { useActiveProjects } from "@/hooks/use-projects"
import { useAttendanceList, useOffices } from "@/hooks/use-attendance"
import { useBirthdayList, useHrStats } from "@/hooks/use-employees"
import { useContracts } from "@/hooks/use-contracts"
import ProjectsPage from "../../app/(dashboard)/projects/page"
import RecruitmentPage from "../../app/(dashboard)/management/recruitment/page"

const INITIAL = useAuthStore.getState()
const qcWrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}
beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ data: [] })
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

const NONE = { "contacts.view": "own" } as never

const HOOKS: Array<[string, () => unknown, string]> = [
  ["useActiveProjects", () => useActiveProjects(), "products.view"],
  ["useAttendanceList", () => useAttendanceList({} as never), "attendance.view"],
  ["useOffices", () => useOffices(), "attendance.view"],
  ["useHrStats", () => useHrStats({} as never), "employees.view"],
  ["useBirthdayList", () => useBirthdayList({ month: 1 } as never), "employees.view"],
  ["useContracts", () => useContracts({} as never), "contracts.view"],
]

describe("hook chỉ gọi khi có quyền BE", () => {
  it.each(HOOKS)("%s: thiếu quyền → KHÔNG gọi", async (_n, hook) => {
    useAuthStore.setState({ permissions: NONE })
    renderHook(hook, { wrapper: qcWrap() })
    await new Promise((r) => setTimeout(r, 30))
    expect(get).not.toHaveBeenCalled()
  })
  it.each(HOOKS)("%s: đủ quyền → gọi", async (_n, hook, perm) => {
    useAuthStore.setState({ permissions: { [perm]: "all" } as never })
    renderHook(hook, { wrapper: qcWrap() })
    await waitFor(() => expect(get).toHaveBeenCalled())
  })
})

const PAGES: Array<[string, () => ReactNode]> = [
  ["/projects", () => <ProjectsPage />],
  ["/management/recruitment", () => <RecruitmentPage />],
]

describe("trang thiếu quyền → Forbidden + 0 request", () => {
  it.each(PAGES)("%s", async (_n, page) => {
    useAuthStore.setState({ permissions: NONE })
    const Wrap = qcWrap()
    render(<Wrap>{page()}</Wrap>)
    expect(screen.getByText(/không có quyền/i)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 30))
    expect(get).not.toHaveBeenCalled()
  })
})
