/** /reports: không có quyền xem báo cáo nào → <Forbidden/>, KHÔNG render tab (không gọi API). */
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

const probe = vi.fn()
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isLoading: false }) }))
vi.mock("../../app/(dashboard)/reports/_components/report-tabs-config", () => ({
  DEFAULT_REPORT_TAB: "a",
  REPORT_TAB_GROUPS: [
    {
      key: "g",
      label: "Nhóm",
      tabs: [
        {
          value: "a",
          label: "A",
          permission: "reports.channels",
          Component: () => {
            probe()
            return <div>tab-a</div>
          },
        },
      ],
    },
  ],
}))

import { useAuthStore } from "@/store/auth"
import ReportsPage from "../../app/(dashboard)/reports/page"

const INITIAL = useAuthStore.getState()
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
  probe.mockClear()
})

describe("/reports theo quyền", () => {
  it("Sale không có reports.* → Forbidden, tab không mount", () => {
    useAuthStore.setState({ permissions: { "contacts.view": "own" } as never })
    render(<ReportsPage />)
    expect(screen.getByText(/không có quyền/i)).toBeTruthy()
    expect(probe).not.toHaveBeenCalled()
  })

  it("có reports.channels → thấy tab", () => {
    useAuthStore.setState({ permissions: { "reports.channels": "all" } as never })
    render(<ReportsPage />)
    expect(screen.getByText("tab-a")).toBeTruthy()
  })
})
