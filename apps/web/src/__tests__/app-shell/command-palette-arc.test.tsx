import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Home, Users } from "lucide-react"
import type { FlatMenuEntry } from "@/components/app-shell/menu-resolve"

// cmdk đo chiều cao danh sách bằng ResizeObserver; jsdom không có.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => false }) }))
vi.mock("@/hooks/use-org-features", () => ({ useOrgFeature: () => false }))
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }))
vi.mock("@/lib/api-client", () => ({ default: { get: vi.fn(async () => ({ data: { data: [] } })) } }))

import { ShellCommandPalette } from "@/components/app-shell/sidebar-command-palette"

const nav = [
  { key: "home", title: "Trang chủ", href: "/", icon: Home },
  { key: "contacts", title: "Khách hàng", href: "/contacts", icon: Users },
] as unknown as FlatMenuEntry[]

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ShellCommandPalette open onOpenChange={() => {}} navEntries={nav} />
    </QueryClientProvider>,
  )
}

describe("bảng lệnh ⌘K theo Arc", () => {
  it("dòng đang chọn có ô sáng, gõ thì hiện nút xoá chữ", () => {
    renderPalette()
    expect(document.querySelectorAll('[cmdk-item] span.bg-accent')).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Xoá chữ đã gõ" })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText(/Tìm khách/), { target: { value: "khach" } })
    expect(screen.getByText("Khách hàng")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Xoá chữ đã gõ" }))
    expect((screen.getByPlaceholderText(/Tìm khách/) as HTMLInputElement).value).toBe("")
  })

  it("không khớp gì → màn trống có hướng dẫn", () => {
    renderPalette()
    fireEvent.change(screen.getByPlaceholderText(/Tìm khách/), { target: { value: "zzzz" } })
    expect(screen.getByText("Không tìm thấy")).toBeTruthy()
    expect(screen.getByText(/Thử từ khác/)).toBeTruthy()
  })
})
