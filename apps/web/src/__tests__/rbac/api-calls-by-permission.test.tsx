/**
 * FE gọi API mà user không có quyền ⇒ 4xx.
 * Khoá: mỗi query chạm `/users`, `/management/employees`, `/kanban/cards` chỉ
 * chạy khi đủ điều kiện (quyền BE yêu cầu / board hợp lệ).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const get = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: () => "",
}))

import { useAuthStore } from "@/store/auth"
import { useActiveUsers, useUsersByManager } from "@/hooks/use-filter-users"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"
import { useAllEmployees, useEmployees } from "@/hooks/use-employees"
import { useKanbanCardsByBoard, useKanbanCardsByColumn } from "@/hooks/kanban/use-kanban-cards"

const INITIAL = useAuthStore.getState()

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ data: { data: [], pagination: { total: 0 } } })
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

const SALE = { "contacts.view": "own", "kanban.view": "own" } as never

describe("/users chỉ gọi khi có users.view", () => {
  const hooks: Array<[string, () => unknown]> = [
    ["useActiveUsers", () => useActiveUsers()],
    ["useUsersByManager", () => useUsersByManager(5)],
    ["useKanbanUserRoster", () => useKanbanUserRoster()],
  ]

  it.each(hooks)("%s: Sale (không users.view) → KHÔNG gọi", async (_n, hook) => {
    useAuthStore.setState({ permissions: SALE })
    renderHook(hook, { wrapper: wrapper() })
    await new Promise((r) => setTimeout(r, 30))
    expect(get).not.toHaveBeenCalled()
  })

  it.each(hooks)("%s: có users.view → gọi /users", async (_n, hook) => {
    useAuthStore.setState({ permissions: { "users.view": "all" } as never })
    renderHook(hook, { wrapper: wrapper() })
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(String(get.mock.calls[0][0])).toContain("/users")
  })
})

describe("/management/employees chỉ gọi khi có employees.view", () => {
  it("Sale → useAllEmployees / useEmployees KHÔNG gọi", async () => {
    useAuthStore.setState({ permissions: SALE })
    renderHook(() => useAllEmployees(), { wrapper: wrapper() })
    renderHook(() => useEmployees({} as never), { wrapper: wrapper() })
    await new Promise((r) => setTimeout(r, 30))
    expect(get).not.toHaveBeenCalled()
  })

  it("có employees.view → gọi", async () => {
    useAuthStore.setState({ permissions: { "employees.view": "all" } as never })
    renderHook(() => useAllEmployees(), { wrapper: wrapper() })
    await waitFor(() => expect(get).toHaveBeenCalled())
  })
})

describe("/kanban/cards không gọi với board_id=0", () => {
  it("boardId=0 → không gọi; boardId>0 → gọi", async () => {
    useAuthStore.setState({ permissions: { "kanban.view": "own" } as never })
    renderHook(() => useKanbanCardsByBoard(0), { wrapper: wrapper() })
    renderHook(() => useKanbanCardsByColumn(0, 3), { wrapper: wrapper() })
    await new Promise((r) => setTimeout(r, 30))
    expect(get).not.toHaveBeenCalled()
    renderHook(() => useKanbanCardsByBoard(7), { wrapper: wrapper() })
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(String(get.mock.calls[0][0])).toContain("board_id=7")
  })
})
