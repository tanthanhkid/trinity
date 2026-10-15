import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mutate = vi.fn()
vi.mock("@/hooks/use-contact-transfer", () => ({
  useTransferContact: () => ({ mutate, isPending: false }),
  useAssignableContactSales: () => ({
    isLoading: false,
    data: [
      { id: 5, full_name: "Sale Một", email: "s5@x.vn" },
      { id: 9, full_name: "Sale Chín", email: "s9@x.vn" },
    ],
  }),
}))

let canTransfer = true
vi.mock("@/lib/rbac", () => ({
  usePermissions: () => ({ can: (p: string) => p === "contacts.transfer" && canTransfer }),
}))

import {
  ReassignContactSaleButton,
  buildSaleOptions,
} from "@/app/(dashboard)/contacts/[id]/_components/reassign-contact-sale"

function renderBtn() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <ReassignContactSaleButton
        contactId="2" contactName="Hùng" assignedTo={5} assigneeName="Sale Một"
      />
    </QueryClientProvider>,
  )
}

describe("Chuyển khách hàng", () => {
  beforeEach(() => {
    mutate.mockClear()
    canTransfer = true
  })

  it("chỉ người có quyền contacts.transfer thấy nút (không dựa tên vai trò)", () => {
    canTransfer = false
    renderBtn()
    expect(screen.queryByRole("button", { name: /Chuyển khách hàng/ })).toBeNull()
  })

  it("có quyền contacts.transfer → thấy nút", () => {
    renderBtn()
    expect(screen.getByRole("button", { name: /Chuyển khách hàng/ })).toBeTruthy()
  })

  it("mở dialog: mặc định chọn sale đang phụ trách, nút Chuyển bị khoá", () => {
    renderBtn()
    fireEvent.click(screen.getByRole("button", { name: /Chuyển khách hàng/ }))
    expect(screen.getAllByText(/Sale Một \(đang phụ trách\)/).length).toBeGreaterThan(0)
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Chuyển khách hàng" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("đổi sang sale khác rồi Chuyển gọi mutate với đúng id", () => {
    renderBtn()
    fireEvent.click(screen.getByRole("button", { name: /Chuyển khách hàng/ }))
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: /Sale Chín/ }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Chuyển khách hàng" }))
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0][0].new_assigned_to).toBe(9)
  })

  it("buildSaleOptions thêm người đang phụ trách khi họ ngoài danh sách", () => {
    const opts = buildSaleOptions([{ id: 9, full_name: "B", email: "b@x" }], 1, "Admin")
    expect(opts[0].value).toBe(1)
    expect(opts[0].label).toContain("Admin")
  })
})
