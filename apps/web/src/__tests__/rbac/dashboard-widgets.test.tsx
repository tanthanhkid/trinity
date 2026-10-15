/**
 * Tổng quan render widget THEO QUYỀN (thay router rẽ 7 biến thể theo vai trò).
 * Fixture = grants (`useAuthStore.permissions`), KHÔNG có tên vai trò.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, renderHook, screen } from "@testing-library/react"
import { PERMISSIONS } from "@trinity/rbac"
import { useAuthStore } from "@/store/auth"

let authState: { user: { email: string } | null; isLoading: boolean } = { user: { email: "a@x.vn" }, isLoading: false }
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => authState }))
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
// Widget nặng (gọi API) → thay bằng thẻ đánh dấu; chỉ kiểm cơ chế gate.
vi.mock("@/app/(dashboard)/dashboard/_components/dashboard-overview", () => ({
  DashboardOverview: () => <div data-testid="w-overview" />,
}))
vi.mock("@/app/(dashboard)/dashboard/_components/dashboard-recent-customers", () => ({
  DashboardRecentCustomers: () => <div data-testid="w-recent-inner" />,
  DashboardRecentCustomersStandalone: () => <div data-testid="w-recent" />,
}))

import { DASHBOARD_WIDGETS } from "@/app/(dashboard)/dashboard/_components/widgets"
import { DashboardWidgets } from "@/app/(dashboard)/dashboard/_components/dashboard-widgets"
import { useCanSeeReportsCenter } from "@/app/(dashboard)/dashboard/_components/dashboard-reports-button"

const INITIAL = useAuthStore.getState()
const grant = (permissions: Record<string, string>) =>
  useAuthStore.setState({ permissions: permissions as never })

beforeEach(() => {
  authState = { user: { email: "a@x.vn" }, isLoading: false }
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("DASHBOARD_WIDGETS — khai báo", () => {
  it("mọi widget khai quyền CÓ trong danh mục @trinity/rbac, key không trùng", () => {
    for (const w of DASHBOARD_WIDGETS) expect(w.permission in PERMISSIONS).toBe(true)
    const keys = DASHBOARD_WIDGETS.map((w) => w.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("<DashboardWidgets> — gate theo quyền", () => {
  it("không quyền nào → không widget, không link báo cáo", () => {
    const { container } = render(<DashboardWidgets />)
    expect(container.textContent).toBe("")
  })

  it("reports.overview → khối Tổng quan + link báo cáo", () => {
    grant({ "reports.overview": "own" })
    render(<DashboardWidgets />)
    expect(screen.getByTestId("w-overview")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Xem báo cáo chi tiết/ })).toHaveAttribute("href", "/reports")
  })

  it("contacts.view → widget khách gần đây; không link báo cáo nếu thiếu reports.*", () => {
    grant({ "contacts.view": "own" })
    render(<DashboardWidgets />)
    expect(screen.getByTestId("w-recent")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /báo cáo/ })).toBeNull()
  })

  it("đang tải /auth/me → skeleton, KHÔNG widget dù đã có grants cache", () => {
    authState = { user: null, isLoading: true }
    grant({ "reports.overview": "all" })
    render(<DashboardWidgets />)
    expect(screen.queryByTestId("w-overview")).toBeNull()
  })
})

describe("useCanSeeReportsCenter", () => {
  it("true khi có BẤT KỲ quyền reports.* (kể cả chỉ reports.export)", () => {
    grant({ "reports.export": "own" })
    expect(renderHook(() => useCanSeeReportsCenter()).result.current).toBe(true)
  })

  it("false khi không có quyền reports.* nào", () => {
    grant({ "contacts.view": "all" })
    expect(renderHook(() => useCanSeeReportsCenter()).result.current).toBe(false)
  })
})
