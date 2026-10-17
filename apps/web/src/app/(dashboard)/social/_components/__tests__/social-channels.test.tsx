import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SocialChannels } from "../social-channels"

const state = vi.hoisted(() => ({ enable: vi.fn() }))
const base = { avatar_url: null, last_error: null }

vi.mock("@/lib/rbac/use-permissions", () => ({ usePermissions: () => ({ can: () => true }) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/hooks/use-social", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-social")>()),
  useSocialNetworks: () => ({ isLoading: false, data: [{ network: "facebook", label: "Facebook", supported: true, configured: true, env: [], scopes: [], redirect_uri: null }] }),
  useSocialAccounts: () => ({
    data: [
      { ...base, id: 1, network: "facebook", name: "Trang A", status: "active", inbox: "on" },
      { ...base, id: 2, network: "facebook", name: "Trang B", status: "disabled", removed: true, inbox: "off" },
      { ...base, id: 3, network: "facebook", name: "Trang C", status: "active", inbox: null },
    ],
  }),
  useSocialMutations: () => ({
    connect: { isPending: false, mutate: vi.fn() },
    disconnect: { isPending: false, mutateAsync: vi.fn() },
    enable: { isPending: false, mutate: state.enable },
  }),
}))

beforeEach(() => state.enable.mockReset())

describe("<SocialChannels> — Page Facebook", () => {
  it("mỗi Page có nhãn Nhận tin: đã nối / tắt / chưa nối", () => {
    render(<SocialChannels />)
    expect(screen.getByText("Nhận tin: đã nối")).toBeTruthy()
    expect(screen.getByText("Nhận tin: tắt")).toBeTruthy()
    expect(screen.getByText("Nhận tin: chưa nối")).toBeTruthy()
  })

  it("kênh đã gỡ hiện mờ, có nút Bật lại gọi enable đúng id", () => {
    render(<SocialChannels />)
    const removed = screen.getByTestId("social-account-removed")
    expect(removed.className).toMatch(/opacity-60/)
    fireEvent.click(screen.getByRole("button", { name: "Bật lại" }))
    expect(state.enable.mock.calls[0][0]).toBe(2)
  })
})
