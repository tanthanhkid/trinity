import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { EmployeeDetail, EmployeeListItem, tenureText } from "@/app/(dashboard)/management/employees/_components/employee-detail"
import type { Employee } from "@/hooks/use-employees"

const emp = {
  id: 1, user_id: 9, employee_code: "NV012", full_name: "Nguyễn Thị Lan", email: "lan@congty.vn",
  phone: "0912 345 678", avatar_url: null, position: "Nhân viên bán hàng", department: null, status: "active",
  user_status: "active", team_name: "Quận 1", registered_device_id: "dev", joined_at: null, created_at: "2025-02-03T09:10:00Z",
} as unknown as Employee

describe("giao diện Ánh xanh — nhân viên", () => {
  it("tenureText trả null khi chưa có ngày vào làm", () => {
    expect(tenureText(null)).toBeNull()
    expect(tenureText("2999-01-01")).toBe("Chưa vào làm")
  })

  it("hàng danh sách hiện tên, mã và trạng thái; bấm gọi onSelect", () => {
    const onSelect = vi.fn()
    render(<EmployeeListItem emp={emp} current={false} onSelect={onSelect} />)
    expect(screen.getByText("Nguyễn Thị Lan")).toBeTruthy()
    expect(screen.getByText("Đang làm việc")).toBeTruthy()
    fireEvent.click(screen.getByRole("button"))
    expect(onSelect).toHaveBeenCalled()
  })

  it("hồ sơ: nút Sửa / Đặt lại thiết bị chỉ hiện khi có quyền", () => {
    const base = { emp, canLock: false, canDelete: false, isAdmin: false, onEdit: vi.fn(), onLock: vi.fn(), onDelete: vi.fn(), onResetDevice: vi.fn() }
    const { unmount } = render(<EmployeeDetail {...base} canEdit={false} canResetDevice={false} />)
    expect(screen.queryAllByText("Sửa")).toHaveLength(0)
    expect(screen.queryAllByText("Đặt lại thiết bị")).toHaveLength(0)
    unmount()
    render(<EmployeeDetail {...base} canEdit canResetDevice />)
    expect(screen.getAllByText("Sửa").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Đặt lại thiết bị").length).toBeGreaterThan(0)
  })
})
