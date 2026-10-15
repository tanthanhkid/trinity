/**
 * RBAC quyền + phạm vi — `usePermissions()` đọc thẳng `useAuthStore`
 * (nguồn permissions/isAdmin thật, không mock module) — mirror cách sidebar/
 * settings dùng hook này.
 */
import { afterEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { usePermissions } from "@/lib/rbac"
import { useAuthStore } from "@/store/auth"

const INITIAL_STATE = useAuthStore.getState()

afterEach(() => {
  useAuthStore.setState(INITIAL_STATE, true)
})

describe("usePermissions", () => {
  it("grants rỗng khi chưa đăng nhập — mọi can() đều false (fail-closed)", () => {
    const { result } = renderHook(() => usePermissions())
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.grants).toEqual({})
    expect(result.current.can("contacts.view")).toBe(false)
  })

  it("can() đúng quyền đơn giản (không scoped)", () => {
    useAuthStore.setState({ permissions: { "deals.manage": true } })
    const { result } = renderHook(() => usePermissions())
    expect(result.current.can("deals.manage")).toBe(true)
    expect(result.current.can("deals.view")).toBe(false)
  })

  it("can() với ngưỡng scope tối thiểu", () => {
    useAuthStore.setState({ permissions: { "contacts.view": "team" } })
    const { result } = renderHook(() => usePermissions())
    expect(result.current.can("contacts.view")).toBe(true)
    expect(result.current.can("contacts.view", "own")).toBe(true)
    expect(result.current.can("contacts.view", "team")).toBe(true)
    expect(result.current.can("contacts.view", "subtree")).toBe(false)
    expect(result.current.can("contacts.view", "all")).toBe(false)
  })

  it("canAny() — true nếu có ÍT NHẤT MỘT quyền", () => {
    useAuthStore.setState({ permissions: { "contacts.update": "own" } })
    const { result } = renderHook(() => usePermissions())
    expect(result.current.canAny("contacts.delete", "contacts.update")).toBe(true)
    expect(result.current.canAny("contacts.delete", "contacts.export")).toBe(false)
  })

  it("scopeOf() trả scope hiện có; null nếu không có quyền hoặc quyền không scoped", () => {
    useAuthStore.setState({ permissions: { "contacts.view": "subtree", "deals.manage": true } })
    const { result } = renderHook(() => usePermissions())
    expect(result.current.scopeOf("contacts.view")).toBe("subtree")
    expect(result.current.scopeOf("deals.manage")).toBeNull()
    expect(result.current.scopeOf("contacts.delete")).toBeNull()
  })

  it("isAdmin=true (vai trò Quản trị) — grants phản ánh đúng những gì store có (component đọc isAdmin riêng, không tự suy quyền)", () => {
    useAuthStore.setState({ isAdmin: true, permissions: { "contacts.view": "all" } })
    const { result } = renderHook(() => usePermissions())
    expect(result.current.isAdmin).toBe(true)
    expect(result.current.can("contacts.view")).toBe(true)
  })
})
