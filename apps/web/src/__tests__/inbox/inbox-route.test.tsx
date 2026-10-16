import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Grants, OrgFeatures } from "@trinity/rbac"
import { resolveOrgFeatures } from "@trinity/rbac"
import { useAuthStore } from "@/store/auth"

/**
 * Hộp thư thành mục riêng `/inbox`: mục sidebar "Hộp thư" theo quyền + công tắc (giống hai hộp thư trong Cài đặt),
 * tab kênh theo quyền từng kênh, tab "Tất cả" gộp hai kênh ở phía client, không gọi API mới.
 */
const mockGet = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isLoading: false }) }))
const nav = vi.hoisted(() => ({ search: new URLSearchParams(), replace: vi.fn() }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.search,
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  usePathname: () => "/inbox",
}))

import { EXTRA_MENU_ITEMS, withExtraMenuItems } from "@/components/app-shell/menu-extra"
import { menuItems } from "@/components/nav-config"
import { isItemVisible } from "@/components/nav-visibility"
import { featureForPath } from "@/lib/org-feature-routes"
import { resolveBreadcrumb } from "@/lib/nav-breadcrumb"
import { inboxChannels, inboxTabs, pickInboxTab } from "@/app/(dashboard)/inbox/_components/inbox-access"
import { mergeConversations } from "@/app/(dashboard)/inbox/_components/all-inbox"
import { InboxScreen } from "@/app/(dashboard)/inbox/_components/inbox-screen"

const ALL_ON: OrgFeatures = resolveOrgFeatures(undefined)
const off = (k: keyof OrgFeatures): OrgFeatures => ({ ...ALL_ON, [k]: false })
const inbox = EXTRA_MENU_ITEMS.find((i) => i.key === "inbox")!

describe("Mục sidebar 'Hộp thư'", () => {
  it("đứng ngay dưới 'Tổng quan', trỏ /inbox, breadcrumb 'Hộp thư'", () => {
    const merged = withExtraMenuItems(menuItems)
    const i = merged.findIndex((m) => m.key === "dashboard")
    expect(merged[i + 1]?.key).toBe("inbox")
    expect(inbox.href).toBe("/inbox")
    expect(resolveBreadcrumb("/inbox").title).toBe("Tương tác")
  })

  it("hiện khi có quyền của ít nhất một kênh; ẩn khi không quyền hoặc tắt 'Hộp thư'", () => {
    expect(isItemVisible(inbox, {}, ALL_ON)).toBe(false)
    expect(isItemVisible(inbox, { "contacts.view": "all" }, ALL_ON)).toBe(false)
    expect(isItemVisible(inbox, { "contacts.update": "own" }, ALL_ON)).toBe(true)
    expect(isItemVisible(inbox, { "social.post": true }, ALL_ON)).toBe(true) // chỉ trả lời đánh giá Google
    expect(isItemVisible(inbox, { "integrations.webhooks": true }, ALL_ON)).toBe(true)
    expect(isItemVisible(inbox, { "contacts.update": "all" }, off("inbox"))).toBe(false)
    expect(isItemVisible(inbox, { "contacts.update": "all" }, off("integrations"))).toBe(true)
    expect(featureForPath("/inbox")).toBe("inbox")
  })
})

describe("inboxChannels / tab", () => {
  const both: Grants = { "contacts.update": "own", "integrations.webhooks": true }
  it("theo quyền từng kênh + công tắc", () => {
    expect(inboxChannels(both, ALL_ON)).toEqual(["zalo", "facebook"])
    expect(inboxChannels({ "contacts.update": "own" }, ALL_ON)).toEqual(["zalo"])
    expect(inboxChannels({ "integrations.webhooks": true }, ALL_ON)).toEqual(["facebook"])
    expect(inboxChannels(both, off("facebook_page"))).toEqual(["zalo"])
    expect(inboxChannels(both, off("zalo_oa"))).toEqual(["facebook"])
    expect(inboxChannels(both, off("inbox"))).toEqual([])
    expect(inboxChannels(both, off("integrations"))).toEqual(["zalo", "facebook"])
    expect(inboxChannels({}, ALL_ON)).toEqual([])
  })
  it("'Tất cả' chỉ khi có từ 2 kênh; ?kenh= lạ hoặc không quyền ⇒ tab đầu", () => {
    expect(inboxTabs(["zalo", "facebook"])).toEqual(["interactions", "all", "zalo", "facebook"])
    expect(inboxTabs(["zalo"])).toEqual(["interactions", "zalo"])
    expect(pickInboxTab(null, ["interactions", "zalo"])).toBe("interactions")
    expect(pickInboxTab("tuong-tac", ["interactions", "zalo"])).toBe("interactions")
    expect(pickInboxTab("facebook", ["all", "zalo", "facebook"])).toBe("facebook")
    expect(pickInboxTab("facebook", ["zalo"])).toBe("zalo")
    expect(pickInboxTab("xyz", ["all", "zalo"])).toBe("all")
    expect(pickInboxTab(null, [])).toBeNull()
  })
  it("đánh giá Google: cần social.post + công tắc social_posting + đã liên kết địa điểm; luôn là tab riêng", () => {
    const g: Grants = { ...both, "social.post": true }
    expect(inboxChannels(g, ALL_ON)).toEqual(["zalo", "facebook"])
    expect(inboxChannels(g, ALL_ON, { hasGoogle: true })).toEqual(["zalo", "facebook", "google"])
    expect(inboxChannels(both, ALL_ON, { hasGoogle: true })).toEqual(["zalo", "facebook"])
    expect(inboxChannels(g, off("social_posting"), { hasGoogle: true })).toEqual(["zalo", "facebook"])
    expect(inboxTabs(["zalo", "google"])).toEqual(["interactions", "zalo", "google"])
    expect(inboxTabs(["zalo", "facebook", "google"])).toEqual(["interactions", "all", "zalo", "facebook", "google"])
    expect(inboxTabs(["google"])).toEqual(["google"])
    expect(pickInboxTab("google", ["zalo", "google"])).toBe("google")
  })
})

const zt = (id: number, at: string, over: Record<string, unknown> = {}) => ({
  id, zalo_user_id: `U${id}`, display_name: `Zalo ${id}`, avatar_url: null, phone: null, contact_id: null,
  last_message_preview: `tin zalo ${id}`, last_message_at: at, last_inbound_at: at, unread_count: 0, ...over,
})
const fc = (id: number, at: string, over: Record<string, unknown> = {}) => ({
  id, page_id: "P", page_name: "Tiệm Hoa", psid: `PS000${id}`, customer_name: `Messenger ${id}`, last_inbound_at: at,
  last_message_at: at, last_message_preview: `tin fb ${id}`, unread_count: 0, can_reply: true, ...over,
})

describe("mergeConversations", () => {
  it("gộp hai kênh, mới nhất lên đầu; tìm lọc Messenger ở client", () => {
    const rows = mergeConversations(
      [zt(1, "2026-10-12T02:00:00Z"), zt(2, "2026-10-12T00:00:00Z")],
      [fc(9, "2026-10-12T01:00:00Z")],
    )
    expect(rows.map((r) => r.key)).toEqual(["zalo-1", "facebook-9", "zalo-2"])
    expect(mergeConversations([], [fc(9, "2026-10-12T01:00:00Z"), fc(8, "2026-10-12T01:00:00Z", { customer_name: "Chị Lan" })], "lan").map((r) => r.key)).toEqual(["facebook-8"])
  })
})

describe("<InboxScreen>", () => {
  const INITIAL = useAuthStore.getState()
  const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InboxScreen /></QueryClientProvider>)
  const grant = (g: Grants) => useAuthStore.setState({ permissions: g as never })
  beforeEach(() => {
    mockGet.mockReset(); mockPost.mockReset(); nav.replace.mockReset(); nav.search = new URLSearchParams()
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/settings/org-features") return { data: {} }
      if (url === "/zalo-oa/threads") return { data: { data: [zt(1, new Date().toISOString(), { unread_count: 2 })], meta: { next_cursor: null } } }
      if (url === "/facebook/conversations") return { data: { data: [fc(9, new Date(Date.now() - 60_000).toISOString())] } }
      return { data: { data: [] } }
    })
  })
  afterEach(() => { useAuthStore.setState(INITIAL, true) })

  it("mặc định mở Tương tác (gộp bình luận + tin nhắn): gọi /interactions, có số hôm nay", async () => {
    grant({ "contacts.update": "own", "integrations.webhooks": true })
    wrap()
    expect(await screen.findByTestId("interactions")).toBeTruthy()
    await waitFor(() => expect(mockGet.mock.calls.some(([u]) => u === "/interactions")).toBe(true))
    expect(mockGet.mock.calls.some(([u]) => u === "/interactions/stats")).toBe(true)
  })

  it("đủ hai kênh: tab Tương tác / Tất cả hội thoại / Zalo / Facebook, danh sách gộp; bấm tab ghi ?kenh=", async () => {
    grant({ "contacts.update": "own", "integrations.webhooks": true })
    nav.search = new URLSearchParams("kenh=tat-ca")
    wrap()
    const tabs = screen.getByRole("tablist", { name: "Kênh" })
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Tương tác", "Tất cả hội thoại", "Zalo", "Facebook"])
    expect(await screen.findByText("Zalo 1")).toBeTruthy()
    expect(await screen.findByText("Messenger 9")).toBeTruthy()
    fireEvent.click(within(tabs).getByRole("tab", { name: "Facebook" }))
    expect(nav.replace).toHaveBeenCalledWith("/inbox?kenh=facebook", { scroll: false })
  })

  it("chỉ quyền Zalo: tab Tương tác + Zalo, không gọi API Messenger", async () => {
    grant({ "contacts.update": "own" })
    nav.search = new URLSearchParams("kenh=zalo")
    wrap()
    expect(await screen.findByText("Zalo 1")).toBeTruthy()
    expect(within(screen.getByRole("tablist", { name: "Kênh" })).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Tương tác", "Zalo"])
    expect(mockGet.mock.calls.some(([u]) => u === "/facebook/conversations")).toBe(false)
  })

  it("không quyền kênh nào: báo chưa có quyền, không gọi API hộp thư", () => {
    grant({ "contacts.view": "all" })
    wrap()
    expect(screen.getByText(/chưa có quyền xem hộp thư/)).toBeTruthy()
    expect(mockGet.mock.calls.some(([u]) => String(u).startsWith("/zalo-oa") || String(u).startsWith("/facebook"))).toBe(false)
  })

  it("kênh tắt (BE trả 403): trạng thái trống, KHÔNG hiện chữ đỏ, kênh còn lại vẫn hiện", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), { response: { status: 403 } })
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/settings/org-features") return { data: {} }
      if (url === "/zalo-oa/threads") throw forbidden
      if (url === "/facebook/conversations") return { data: { data: [fc(9, new Date().toISOString())] } }
      return { data: { data: [] } }
    })
    grant({ "contacts.update": "own", "integrations.webhooks": true })
    nav.search = new URLSearchParams("kenh=tat-ca")
    wrap()
    expect(await screen.findByText("Messenger 9")).toBeTruthy()
    expect(screen.queryByText(/Không tải được/)).toBeNull()
  })

  it("tab Zalo khi Zalo OA tắt (403): báo kênh chưa bật thay vì 'Không tải được danh sách hội thoại'", async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/settings/org-features") return { data: {} }
      throw Object.assign(new Error("Forbidden"), { response: { status: 403 } })
    })
    grant({ "contacts.update": "own" })
    nav.search = new URLSearchParams("kenh=zalo")
    wrap()
    expect(await screen.findByText(/Kênh Zalo OA chưa bật/)).toBeTruthy()
    expect(screen.queryByText(/Không tải được/)).toBeNull()
  })

  it("tab Facebook khi Fanpage tắt (403): báo kênh chưa bật, không chữ đỏ", async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/settings/org-features") return { data: {} }
      throw Object.assign(new Error("Forbidden"), { response: { status: 403 } })
    })
    grant({ "integrations.webhooks": true })
    nav.search = new URLSearchParams("kenh=facebook")
    wrap()
    expect(await screen.findByText(/Kênh Fanpage Facebook chưa bật/)).toBeTruthy()
    expect(screen.queryByText(/Không tải được/)).toBeNull()
  })

  it("lỗi thật (500) vẫn báo đỏ như cũ", async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/settings/org-features") return { data: {} }
      throw Object.assign(new Error("boom"), { response: { status: 500 } })
    })
    grant({ "contacts.update": "own" })
    nav.search = new URLSearchParams("kenh=zalo")
    wrap()
    expect(await screen.findByText("Không tải được danh sách hội thoại.")).toBeTruthy()
  })
})

describe("awaitingReply (lọc Chưa trả lời)", () => {
  it("tin cuối là của khách ⇒ chờ trả lời; đã có tin ra sau đó ⇒ không", async () => {
    const { awaitingReply } = await import("@/app/(dashboard)/inbox/_components/all-inbox")
    const t = "2026-10-14T09:00:00.000Z"
    expect(awaitingReply({ last_inbound_at: t, last_message_at: t })).toBe(true)
    expect(awaitingReply({ last_inbound_at: t, last_message_at: "2026-10-14T09:00:05.000Z" })).toBe(false)
    expect(awaitingReply({ last_inbound_at: null, last_message_at: t })).toBe(false)
  })
})
