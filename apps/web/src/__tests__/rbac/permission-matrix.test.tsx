/**
 * Ma trận quyền (màn Cài đặt > Vai trò): tick → payload đúng; quyền
 * không scoped không có Select phạm vi; chọn cả nhóm; read-only; disabledKeys.
 */
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { Grants } from "@trinity/rbac"
import { PermissionMatrix } from "@/app/(dashboard)/settings/_components/roles/permission-matrix"
import type { RbacCatalog } from "@/app/(dashboard)/settings/_components/roles/use-roles-api"

const catalog: RbacCatalog = {
  groups: ["Khách hàng", "Hệ thống"],
  permissions: [
    { key: "contacts.view", group: "Khách hàng", label: "Xem khách hàng", scoped: true },
    { key: "contacts.create", group: "Khách hàng", label: "Thêm khách hàng", scoped: false },
    { key: "contacts.export", group: "Khách hàng", label: "Xuất Excel khách hàng", scoped: true, sensitive: true },
    { key: "roles.manage", group: "Hệ thống", label: "Quản lý vai trò", scoped: false, sensitive: true },
  ],
  scopes: [
    { value: "own", label: "Của mình" },
    { value: "team", label: "Cấp dưới trực tiếp" },
    { value: "subtree", label: "Toàn bộ cấp dưới" },
    { value: "all", label: "Toàn công ty" },
  ],
}

function setup(value: Grants, extra: Partial<React.ComponentProps<typeof PermissionMatrix>> = {}) {
  const onChange = vi.fn()
  render(<PermissionMatrix catalog={catalog} value={value} onChange={onChange} {...extra} />)
  return onChange
}

describe("<PermissionMatrix>", () => {
  it("tick quyền scoped → payload có scope mặc định 'own'", () => {
    const onChange = setup({})
    fireEvent.click(screen.getByLabelText("Xem khách hàng"))
    expect(onChange).toHaveBeenCalledWith({ "contacts.view": "own" })
  })

  it("tick quyền KHÔNG scoped → true, và không có Select phạm vi", () => {
    const onChange = setup({ "contacts.create": true })
    expect(screen.queryByLabelText("Phạm vi: Thêm khách hàng")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Quản lý vai trò"))
    expect(onChange).toHaveBeenCalledWith({ "contacts.create": true, "roles.manage": true })
  })

  it("bỏ tick → xoá khoá khỏi payload", () => {
    const onChange = setup({ "contacts.view": "team", "contacts.create": true })
    fireEvent.click(screen.getByLabelText("Xem khách hàng"))
    expect(onChange).toHaveBeenCalledWith({ "contacts.create": true })
  })

  it("quyền scoped đã tick hiện Select phạm vi với nhãn tiếng Việt; chưa tick thì không", () => {
    setup({ "contacts.view": "subtree" })
    expect(screen.getByLabelText("Phạm vi: Xem khách hàng")).toHaveTextContent("Toàn bộ cấp dưới")
    expect(screen.queryByLabelText("Phạm vi: Xuất Excel khách hàng")).not.toBeInTheDocument()
  })

  it("badge 'Nhạy cảm' cho quyền sensitive", () => {
    setup({})
    expect(screen.getAllByText("Nhạy cảm")).toHaveLength(2)
  })

  it("'Chọn cả nhóm' → tick mọi quyền của nhóm (scoped = own), giữ scope đã chọn", () => {
    const onChange = setup({ "contacts.view": "all" })
    fireEvent.click(screen.getByLabelText("Chọn cả nhóm Khách hàng"))
    expect(onChange).toHaveBeenCalledWith({
      "contacts.view": "all",
      "contacts.create": true,
      "contacts.export": "own",
    })
  })

  it("'Chọn cả nhóm' khi đã chọn hết → bỏ cả nhóm", () => {
    const onChange = setup({ "contacts.view": "own", "contacts.create": true, "contacts.export": "own", "roles.manage": true })
    fireEvent.click(screen.getByLabelText("Chọn cả nhóm Khách hàng"))
    expect(onChange).toHaveBeenCalledWith({ "roles.manage": true })
  })

  it("nhóm thu gọn được", () => {
    setup({})
    expect(screen.getByLabelText("Thêm khách hàng")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Khách hàng/ }))
    expect(screen.queryByLabelText("Thêm khách hàng")).not.toBeInTheDocument()
  })

  it("readOnly (vai trò hệ thống): checkbox khoá, không có 'Chọn cả nhóm'", () => {
    setup({ "contacts.view": "all" }, { readOnly: true })
    expect(screen.getByLabelText("Xem khách hàng")).toBeDisabled()
    expect(screen.queryByLabelText("Chọn cả nhóm Khách hàng")).not.toBeInTheDocument()
  })

  it("disabledKeys (quyền người sửa không có): khoá + 'Chọn cả nhóm' bỏ qua", () => {
    const onChange = setup({}, { disabledKeys: new Set(["contacts.export"]) })
    expect(screen.getByLabelText("Xuất Excel khách hàng")).toBeDisabled()
    fireEvent.click(screen.getByLabelText("Chọn cả nhóm Khách hàng"))
    expect(onChange).toHaveBeenCalledWith({ "contacts.view": "own", "contacts.create": true })
  })
})
