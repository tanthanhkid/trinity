/**
 * RBAC quyền + phạm vi — `<Can>` thay mọi `role === '...'` /
 * `ROLES.includes(role)` cũ trong JSX.
 */
import { afterEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { Can } from "@/lib/rbac"
import { useAuthStore } from "@/store/auth"

const INITIAL_STATE = useAuthStore.getState()

afterEach(() => {
  useAuthStore.setState(INITIAL_STATE, true)
})

describe("<Can>", () => {
  it("perm — render children khi có quyền", () => {
    useAuthStore.setState({ permissions: { "contacts.export": "own" } })
    render(
      <Can perm="contacts.export">
        <button>Xuất Excel</button>
      </Can>,
    )
    expect(screen.getByText("Xuất Excel")).toBeInTheDocument()
  })

  it("perm — KHÔNG render khi thiếu quyền (mặc định fallback null)", () => {
    render(
      <Can perm="contacts.export">
        <button>Xuất Excel</button>
      </Can>,
    )
    expect(screen.queryByText("Xuất Excel")).not.toBeInTheDocument()
  })

  it("perm — render fallback khi thiếu quyền", () => {
    render(
      <Can perm="contacts.export" fallback={<span>Không có quyền</span>}>
        <button>Xuất Excel</button>
      </Can>,
    )
    expect(screen.getByText("Không có quyền")).toBeInTheDocument()
    expect(screen.queryByText("Xuất Excel")).not.toBeInTheDocument()
  })

  it("any — render khi có ÍT NHẤT MỘT quyền trong danh sách", () => {
    useAuthStore.setState({ permissions: { "contacts.update": "own" } })
    render(
      <Can any={["contacts.update", "contacts.delete"]}>
        <button>Sửa/Xoá</button>
      </Can>,
    )
    expect(screen.getByText("Sửa/Xoá")).toBeInTheDocument()
  })

  it("any — không render khi KHÔNG có quyền nào trong danh sách", () => {
    render(
      <Can any={["contacts.update", "contacts.delete"]}>
        <button>Sửa/Xoá</button>
      </Can>,
    )
    expect(screen.queryByText("Sửa/Xoá")).not.toBeInTheDocument()
  })

  it("không truyền perm lẫn any — fail-closed, không render gì", () => {
    useAuthStore.setState({ isAdmin: true, permissions: { "contacts.view": "all" } })
    render(
      <Can>
        <button>Luôn ẩn</button>
      </Can>,
    )
    expect(screen.queryByText("Luôn ẩn")).not.toBeInTheDocument()
  })
})
