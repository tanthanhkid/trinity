import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
}))
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  default: { get: api.get, put: api.put, patch: api.patch, post: vi.fn(), delete: vi.fn() },
}))

import { EmployeeRolesCard, permissionText } from "@/app/(dashboard)/management/employees/_components/employee-roles"
import { buildWorkPatch, workDraftOf } from "@/app/(dashboard)/management/employees/_components/work-editor"
import { EmployeeDetail, dialablePhone, groups } from "@/app/(dashboard)/management/employees/_components/employee-detail"
import type { Employee } from "@/hooks/use-employees"

const emp = {
  id: 1, user_id: 9, employee_code: "NV012", full_name: "Nguyễn Thị Lan", email: "lan@congty.vn",
  phone: null, avatar_url: null, position: "Nhân viên bán hàng", job_title_id: 3, department: "Kinh doanh",
  status: "on_leave", user_status: "active", team_id: 5, team_name: "Quận 1", manager_id: 7, manager_name: "Tùng",
  office_id: 2, office_name: "Cửa hàng Quận 1", registered_device_id: null, joined_at: "2025-02-02T17:00:00.000Z",
  id_card_number: "079198001234", bank_account_number: "0071001234567", created_at: "2025-02-03T09:10:00Z",
} as unknown as Employee

const ROLES = [
  { id: 1, name: "Quản trị", description: "Toàn quyền", is_system: true, member_count: 1 },
  { id: 2, name: "Bán hàng", description: "Khách hàng và đơn của mình", is_system: false, member_count: 3 },
  { id: 3, name: "Thu ngân", description: "Bán tại quầy", is_system: false, member_count: 1 },
]

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  api.get.mockReset()
  api.put.mockClear()
  api.get.mockImplementation((url: string) => {
    if (url === "/roles") return Promise.resolve({ data: ROLES })
    if (url === "/users/9") return Promise.resolve({ data: { id: 9, roles: ["Bán hàng"] } })
    return Promise.reject(new Error(`không mong đợi ${url}`))
  })
})

describe("khối Vai trò ở hồ sơ nhân viên", () => {
  it("thiếu users.view ⇒ không hiện, không gọi API nào", () => {
    const { container } = render(wrap(
      <EmployeeRolesCard userId={9} name="Lan" canView={false} canAssign={false} isAdmin={false} variant="desktop" />,
    ))
    expect(container.textContent).toBe("")
    expect(api.get).not.toHaveBeenCalled()
  })

  it("chỉ users.view ⇒ xem vai trò đang giữ, không gọi /roles, chip không bấm được", async () => {
    render(wrap(<EmployeeRolesCard userId={9} name="Lan" canView canAssign={false} isAdmin={false} variant="desktop" />))
    const chip = await screen.findByRole("button", { name: "Bán hàng" })
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    expect(api.get).toHaveBeenCalledWith("/users/9")
    expect(api.get).not.toHaveBeenCalledWith("/roles")
  })

  it("users.manage: bấm thêm vai trò gửi CẢ tập (giữ vai trò cũ + vai trò mới)", async () => {
    render(wrap(<EmployeeRolesCard userId={9} name="Lan" canView canAssign isAdmin={false} variant="desktop" />))
    const thuNgan = await screen.findByRole("button", { name: "Thu ngân" })
    await waitFor(() => expect((thuNgan as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(thuNgan)
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/users/9/roles", { roleIds: [2, 3] }))
  })

  it("bỏ vai trò đang giữ gửi tập còn lại; vai trò hệ thống khoá với người không phải Quản trị", async () => {
    render(wrap(<EmployeeRolesCard userId={9} name="Lan" canView canAssign isAdmin={false} variant="mobile" />))
    const banHang = await screen.findByRole("button", { name: "Bán hàng" })
    await waitFor(() => expect((banHang as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByRole("button", { name: "Quản trị" }) as HTMLButtonElement).disabled).toBe(true)
    expect(banHang.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(banHang)
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/users/9/roles", { roleIds: [] }))
  })

  it("tên vai trò không ánh xạ được ⇒ khoá chip (tránh xoá mất vai trò khác)", async () => {
    api.get.mockImplementation((url: string) =>
      url === "/roles"
        ? Promise.resolve({ data: ROLES })
        : Promise.resolve({ data: { id: 9, roles: ["Vai trò lạ"] } }),
    )
    render(wrap(<EmployeeRolesCard userId={9} name="Lan" canView canAssign isAdmin variant="desktop" />))
    const thuNgan = await screen.findByRole("button", { name: "Thu ngân" })
    expect((thuNgan as HTMLButtonElement).disabled).toBe(true)
  })

  it("câu «Được phép…» lấy từ mô tả vai trò thật", () => {
    expect(permissionText(["Bán hàng", "Thu ngân"], ROLES)).toBe("Được phép: Khách hàng và đơn của mình; Bán tại quầy.")
    expect(permissionText([], ROLES)).toBeNull()
  })
})

describe("khay Sửa công việc — chỉ gửi trường đã đổi", () => {
  const name = (id: number) => (id === 4 ? "Thu ngân" : undefined)

  it("không đổi gì ⇒ patch rỗng; trạng thái «Tạm nghỉ» không bị ghi đè", () => {
    const r = buildWorkPatch(emp, workDraftOf(emp), name)
    expect(r).toEqual({ patch: {}, undo: {} })
  })

  it("đổi trạng thái + văn phòng ⇒ chỉ hai trường đó, hoàn tác về giá trị cũ", () => {
    const r = buildWorkPatch(emp, { ...workDraftOf(emp), status: "active", office_id: null }, name)
    expect(r).toEqual({ patch: { status: "active", office_id: null }, undo: { status: "on_leave", office_id: 2 } })
  })

  it("đổi chức danh gửi job_title_id + position", () => {
    const r = buildWorkPatch(emp, { ...workDraftOf(emp), job_title_id: 4 }, name)
    expect("patch" in r && r.patch).toEqual({ job_title_id: 4, position: "Thu ngân" })
  })

  it("đổi team ⇒ không gửi quản lý/phòng ban (máy chủ suy theo team), không hoàn tác", () => {
    const r = buildWorkPatch(emp, { ...workDraftOf(emp), team_id: 6, manager_id: 8, department: "Kho" }, name)
    expect(r).toEqual({ patch: { team_id: 6 }, undo: null })
  })

  it("đổi quản lý trực tiếp khi giữ team", () => {
    const r = buildWorkPatch(emp, { ...workDraftOf(emp), manager_id: null }, name)
    expect("patch" in r && r.patch).toEqual({ manager_id: null })
  })

  it("xoá trắng chức danh / ngày vào làm ⇒ lỗi (máy chủ bỏ qua null), không báo «Đã lưu» giả", () => {
    expect("error" in buildWorkPatch(emp, { ...workDraftOf(emp), job_title_id: null }, name)).toBe(true)
    expect("error" in buildWorkPatch({ ...emp, job_title_id: null }, { ...workDraftOf({ ...emp, job_title_id: null }), position: " " }, name)).toBe(true)
    expect("error" in buildWorkPatch(emp, { ...workDraftOf(emp), joined: "" }, name)).toBe(true)
  })

  it("ngày vào làm sai dạng ⇒ lỗi, không gửi", () => {
    expect(buildWorkPatch(emp, { ...workDraftOf(emp), joined: "31/02" }, name)).toEqual({
      error: "Nhập ngày vào làm dạng dd/mm/yyyy.",
    })
  })
})

describe("hồ sơ nhân viên theo thiết kế", () => {
  const base = {
    emp, canLock: false, canDelete: false, isAdmin: false, canEdit: true, canResetDevice: false,
    onEdit: vi.fn(), onLock: vi.fn(), onDelete: vi.fn(), onResetDevice: vi.fn(),
  }

  it("Gọi/Nhắn/Email luôn đủ ba ô; thiếu SĐT thì Gọi/Nhắn không bấm được", () => {
    render(<EmployeeDetail {...base} />)
    expect(screen.getByText("Gọi").closest("[aria-disabled]")).toBeTruthy()
    expect(screen.getByText("Nhắn").closest("[aria-disabled]")).toBeTruthy()
    expect(screen.getByText("Email").closest("a")?.getAttribute("href")).toBe("mailto:lan@congty.vn")
  })

  it("SĐT bị che không dùng để gọi", () => {
    expect(dialablePhone("0912 345 678")).toBe("0912345678")
    expect(dialablePhone("0912***678")).toBeNull()
  })

  it("Sửa nhóm Công việc mở khay công việc, nhóm khác mở hộp thoại hồ sơ", () => {
    const onEdit = vi.fn()
    const onEditWork = vi.fn()
    render(<EmployeeDetail {...base} onEdit={onEdit} onEditWork={onEditWork} />)
    fireEvent.click(screen.getAllByRole("button", { name: "Sửa Công việc" })[0])
    expect(onEditWork).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole("button", { name: "Sửa Liên hệ và cá nhân" })[0])
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("CCCD và số tài khoản che mặc định, bấm Hiện mới thấy đủ", () => {
    const g = groups(emp).find((x) => x.title === "Giấy tờ và ngân hàng")
    expect(g?.rows.find((r) => r.label === "Số CCCD")?.value).toBe("079 ••• ••• 234")
    render(<EmployeeDetail {...base} />)
    expect(screen.queryByText("079198001234")).toBeNull()
    fireEvent.click(screen.getAllByRole("button", { name: "Hiện số CCCD và tài khoản" })[0])
    expect(screen.getAllByText("079198001234").length).toBeGreaterThan(0)
  })

  it("khối Vai trò dựng ở cả hai bố cục qua renderRoles", () => {
    const renderRoles = vi.fn((v: "desktop" | "mobile") => <div>vai-trò-{v}</div>)
    render(<EmployeeDetail {...base} renderRoles={renderRoles} />)
    expect(screen.getByText("vai-trò-desktop")).toBeTruthy()
    expect(screen.getByText("vai-trò-mobile")).toBeTruthy()
  })
})
