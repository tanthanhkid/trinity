/**
 * Danh bạ theo QUYỀN (không so tên vai trò). Fixture = grants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

const toastWarning = vi.fn()
vi.mock("sonner", () => ({
  toast: { warning: (m: string) => void toastWarning(m), error: vi.fn(), success: vi.fn() },
}))
vi.mock("@/hooks/use-settings-options", () => ({ useSettingsOptions: () => ({ data: [] }) }))
vi.mock("@/hooks/use-projects", () => ({ useActiveProjects: () => ({ data: [], isLoading: false }) }))
vi.mock("@/hooks/use-contact-assignable-users", () => ({
  useContactAssignableUsers: ({ enabled }: { enabled?: boolean } = {}) => ({
    data: enabled === false ? [] : [{ id: 7, full_name: "Sale Bảy", email: "s7@x.vn" }],
    isLoading: false,
  }),
}))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, isLoading: false }) }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/lib/api-client", () => ({ default: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() } }))

import { ContactsFilters } from "@/app/(dashboard)/contacts/_components/contacts-filters"
import { ContactCard } from "@/app/(dashboard)/contacts/_components/contact-row"
import NewContactPage from "@/app/(dashboard)/contacts/new/page"
import ContactsPage from "@/app/(dashboard)/contacts/page"
import ContactDetailPage from "@/app/(dashboard)/contacts/[id]/page"
import type { Contact } from "@/hooks/use-contacts"

const INITIAL = useAuthStore.getState()
const grant = (permissions: Record<string, string>) =>
  useAuthStore.setState({ permissions: permissions as never })

beforeEach(() => {
  toastWarning.mockClear()
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

const filterProps = {
  searchInput: "",
  onSearch: vi.fn(),
  onFilterChange: () => vi.fn(),
  onApply: vi.fn(),
  onReset: vi.fn(),
}

describe("ContactsFilters — dropdown người theo phạm vi, không cascade theo vai trò", () => {
  it("showAssigneeFilter → 1 ô 'Phụ trách' (nguồn assignable-users); KHÔNG Phòng KD/Team/Admin/Marketing", () => {
    render(<ContactsFilters {...filterProps} showAssigneeFilter />)
    expect(screen.getAllByText("Phụ trách").length).toBeGreaterThan(0)
    for (const label of ["Phòng kinh doanh", "Team Lead"]) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it("không showAssigneeFilter (phạm vi own) → không có ô 'Phụ trách'", () => {
    render(<ContactsFilters {...filterProps} />)
    expect(screen.queryByText("Phụ trách")).toBeNull()
  })

  it("chip điều kiện 'Phụ trách' lấy tên từ danh sách assignable-users", () => {
    render(
      <ContactsFilters
        {...filterProps}
        showAssigneeFilter
        assignedTo="7"
        applied={{ assignedTo: "7" }}
        onRemoveApplied={vi.fn()}
      />,
    )
    expect(screen.getAllByText("Phụ trách: Sale Bảy").length).toBeGreaterThan(0)
  })
})

const contact = {
  id: "1", full_name: "Khách A", phone: "***968", assignee_name: "X", created_at: "2026-10-01T00:00:00Z",
  stage: "Mới", stage_source: "stage", stage_option: null, contact_status: null, source: null,
} as unknown as Contact

describe("ContactCard — SĐT đúng chuỗi BE trả", () => {
  it("không tự che/mở SĐT: chuỗi BE đã che hiển thị nguyên (kể cả người có contacts.phone_full)", () => {
    grant({ "contacts.phone_full": "all" })
    render(<ContactCard contact={contact} onNavigate={vi.fn()} showSelection={false} selected={false} onToggleSelected={vi.fn()} />)
    expect(screen.getByText("***968")).toBeInTheDocument()
  })
})

function renderNew() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewContactPage />
    </QueryClientProvider>,
  )
}

describe("/contacts/new — theo contacts.create + deals.manage", () => {
  it("thiếu contacts.create → <Forbidden />, không có form", () => {
    renderNew()
    expect(screen.getByText("Bạn không có quyền truy cập trang này")).toBeInTheDocument()
    expect(screen.queryByText("Thêm khách hàng mới")).toBeNull()
  })

  it("có contacts.create nhưng thiếu deals.manage → form, KHÔNG ô gán thương vụ cho sale", () => {
    grant({ "contacts.create": "own" })
    renderNew()
    expect(screen.getByText("Thêm khách hàng mới")).toBeInTheDocument()
    expect(screen.queryByText("Gán thương vụ cho sale phụ trách")).toBeNull()
  })

  it("có deals.manage → hiện ô tìm người nhận thương vụ (không còn cascade theo cấp quản lý)", () => {
    grant({ "contacts.create": "own", "deals.manage": "subtree" })
    renderNew()
    expect(screen.getByText("Gán thương vụ cho sale phụ trách")).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Gõ tên hoặc email nhân viên/)).toBeInTheDocument()
    expect(screen.queryByText("Chọn trưởng phòng")).toBeNull()
  })
})

describe("Cổng quyền contacts.view — danh sách + chi tiết", () => {
  it("/contacts thiếu contacts.view → <Forbidden />", () => {
    renderNew2(<ContactsPage />)
    expect(screen.getByText("Bạn không có quyền truy cập trang này")).toBeInTheDocument()
  })

  it("/contacts/:id thiếu contacts.view → <Forbidden /> (không gọi API chi tiết)", () => {
    renderNew2(<ContactDetailPage params={Promise.resolve({ id: "1" })} />)
    expect(screen.getByText("Bạn không có quyền truy cập trang này")).toBeInTheDocument()
  })
})

function renderNew2(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
  )
}
