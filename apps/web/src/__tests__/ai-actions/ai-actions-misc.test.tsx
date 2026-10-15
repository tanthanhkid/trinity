import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { aiActionResultLink } from "@/lib/ai-actions"
import { resolveNotificationHref } from "@/lib/notification-href"
import { DEFAULT_EVENT_CONFIG, EVENT_CONFIG } from "@/lib/notification-display"
import { EXTRA_MENU_ITEMS, withExtraMenuItems } from "@/components/app-shell/menu-extra"
import { menuItems } from "@/components/nav-config"
import { isItemVisible } from "@/components/nav-visibility"
import { resolveBreadcrumb } from "@/lib/nav-breadcrumb"

const mockGet = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a) } }))
import { AiActionsNavBadge } from "@/components/app-shell/ai-actions-nav-badge"

describe("thông báo ai_action.created (whitelist FE)", () => {
  it("có icon/màu riêng (không rơi về mặc định) và dẫn tới /ai-actions", () => {
    expect(EVENT_CONFIG["ai_action.created"]).toBeDefined()
    expect(EVENT_CONFIG["ai_action.created"]).not.toBe(DEFAULT_EVENT_CONFIG)
    expect(resolveNotificationHref(false, { event_type: "ai_action.created", action_url: "/ai-actions?id=5" })).toBe("/ai-actions?id=5")
    expect(resolveNotificationHref(false, { event_type: "ai_action.created", action_url: null })).toBe("/ai-actions")
    // action_url lạ (open redirect) bị bỏ, vẫn dẫn về trang đề xuất theo event_type
    expect(resolveNotificationHref(false, { event_type: "ai_action.created", action_url: "//evil.com" })).toBe("/ai-actions")
  })
})

describe("mục menu 'Hoạt động AI'", () => {
  const item = EXTRA_MENU_ITEMS.find((i) => i.key === "ai_actions")!
  it("khai quyền integrations.ai_connect; ẩn khi không có quyền (fail-closed), hiện khi có", () => {
    expect(item.permission).toBe("integrations.ai_connect")
    expect(item.href).toBe("/ai-actions")
    expect(isItemVisible(item, {})).toBe(false)
    expect(isItemVisible(item, { "contacts.view": "all" })).toBe(false)
    expect(isItemVisible(item, { "integrations.ai_connect": true })).toBe(true)
  })
  it("chèn sau 'Tổng quan' (cùng nhóm bổ sung) và breadcrumb đúng tên, không rơi về 'Tổng quan'", () => {
    const merged = withExtraMenuItems(menuItems)
    expect(merged.some((i) => i.key === "ai_actions")).toBe(true)
    expect(resolveBreadcrumb("/ai-actions").title).toBe("Hoạt động AI")
  })
})

describe("liên kết kết quả đề xuất", () => {
  it("chỉ khi đã duyệt, id số dương, đường dẫn nội bộ cố định", () => {
    expect(aiActionResultLink({ status: "approved", result: { contact_id: 5 } })).toEqual({ href: "/contacts/5", label: "Mở khách hàng" })
    expect(aiActionResultLink({ status: "executed", result: { contact_id: 6 } })).toEqual({ href: "/contacts/6", label: "Mở khách hàng" })
    expect(aiActionResultLink({ status: "approved", result: { card_id: 9 } })?.href).toBe("/kanban")
    expect(aiActionResultLink({ status: "pending", result: { contact_id: 5 } })).toBeNull()
    expect(aiActionResultLink({ status: "approved", result: { contact_id: "javascript:alert(1)" } })).toBeNull()
    expect(aiActionResultLink({ status: "approved", result: null })).toBeNull()
  })
})

describe("<AiActionsNavBadge>", () => {
  const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AiActionsNavBadge /></QueryClientProvider>)
  it("hiện số chờ duyệt; 0 / lỗi (tính năng tắt) ⇒ không hiện gì", async () => {
    mockGet.mockResolvedValueOnce({ data: { pending: 3 } })
    const a = wrap()
    expect((await screen.findByRole("status")).textContent).toBe("3")
    a.unmount()
    mockGet.mockResolvedValueOnce({ data: { pending: 0 } })
    const b = wrap()
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("status")).toBeNull()
    b.unmount()
    mockGet.mockRejectedValueOnce({ response: { status: 404 } })
    wrap()
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole("status")).toBeNull()
  })
})
