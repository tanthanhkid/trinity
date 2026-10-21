import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ patch: vi.fn(() => Promise.resolve({ data: { ok: true } })) }))
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  default: { patch: api.patch, get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

import { useUnlockEmployee } from "@/hooks/use-employees"

describe("mở khoá tài khoản nhân viên", () => {
  it("gọi PATCH /management/employees/:id/unlock và làm mới danh sách nhân viên", async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useUnlockEmployee(42), { wrapper })
    await act(async () => { await result.current.mutateAsync() })
    expect(api.patch).toHaveBeenCalledWith("/management/employees/42/unlock", {})
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["employees"] }))
  })
})
