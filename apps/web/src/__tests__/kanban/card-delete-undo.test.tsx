import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { AxiosError, AxiosHeaders } from "axios"
import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ del: vi.fn(), post: vi.fn() }))
const undo = vi.hoisted(() => ({ list: [] as { message: string; onUndo: () => void }[] }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  default: { delete: api.del, post: api.post, get: vi.fn() },
}))
vi.mock("@/lib/undo", () => ({ toastWithUndo: (t: { message: string; onUndo: () => void }) => undo.list.push(t) }))
vi.mock("sonner", () => ({ toast: toasts }))

import { useDeleteKanbanCardWithUndo } from "@/hooks/kanban/use-kanban-cards"

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
)

describe("xoá card — Hoàn tác phía máy chủ", () => {
  beforeEach(() => {
    api.del.mockReset().mockResolvedValue({})
    api.post.mockReset().mockResolvedValue({})
    undo.list = []
    toasts.success.mockReset()
    toasts.error.mockReset()
  })

  it("xoá gửi ngay; Hoàn tác gọi POST /kanban/cards/:id/restore", async () => {
    const { result } = renderHook(() => useDeleteKanbanCardWithUndo(), { wrapper })
    act(() => result.current(42, "Gọi lại chị Hoa"))
    expect(api.del).toHaveBeenCalledWith("/kanban/cards/42")
    await waitFor(() => expect(undo.list).toHaveLength(1))
    expect(undo.list[0].message).toBe("Đã xoá card “Gọi lại chị Hoa”")
    await act(async () => undo.list[0].onUndo())
    expect(api.post).toHaveBeenCalledWith("/kanban/cards/42/restore")
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Đã khôi phục card"))
  })

  it("xoá lỗi ⇒ không có toast Hoàn tác, báo lỗi", async () => {
    api.del.mockRejectedValue(new AxiosError("x", "ERR_BAD_RESPONSE", undefined, undefined, { data: {}, status: 500, statusText: "", headers: {}, config: { headers: new AxiosHeaders() } }))
    const { result } = renderHook(() => useDeleteKanbanCardWithUndo(), { wrapper })
    act(() => result.current(7))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(undo.list).toHaveLength(0)
    expect(toasts.error.mock.calls[0][0]).toContain("Không xoá được card")
  })

  it("khôi phục quá hạn (410) ⇒ báo lỗi rõ", async () => {
    api.post.mockRejectedValue(new AxiosError("x", "ERR_BAD_REQUEST", undefined, undefined, { data: { message: "Đã quá thời gian hoàn tác — card này không khôi phục được nữa" }, status: 410, statusText: "", headers: {}, config: { headers: new AxiosHeaders() } }))
    const { result } = renderHook(() => useDeleteKanbanCardWithUndo(), { wrapper })
    act(() => result.current(9))
    await waitFor(() => expect(undo.list).toHaveLength(1))
    await act(async () => undo.list[0].onUndo())
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Đã quá thời gian hoàn tác — card này không khôi phục được nữa"))
  })
})
