import { describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => false }) }))
vi.mock("@/lib/api-client", () => ({
  default: {
    get: vi.fn(async (_url: string, cfg?: { params?: { category?: string } }) => ({
      data: { count: cfg?.params?.category === "message" ? 0 : 7 },
    })),
    patch: vi.fn(),
  },
}))

import { NotificationsBell } from "@/components/notifications-bell"

describe("chuông thông báo theo Arc", () => {
  it("huy hiệu hiện số chưa đọc thật, tin nhắn 0 thì không có huy hiệu", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <NotificationsBell />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(container.querySelector(".bg-destructive .sr-only")?.textContent).toBe("7"))
    expect(container.querySelectorAll(".bg-destructive")).toHaveLength(1)
    expect(container.querySelectorAll(".bg-blue-600")).toHaveLength(0)
  })
})
