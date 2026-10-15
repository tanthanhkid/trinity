/**
 * "Tính năng của tổ chức": công tắc BẬT/TẮT theo tổ chức, ĐỘC LẬP
 * với RBAC. Khoá: nav lọc AND với quyền, route gate, widget/tab số liệu gọi,
 * tab Cài đặt gate `settings.features`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { isOrgFeatureOn, resolveOrgFeatures, type OrgFeatures } from "@trinity/rbac"
import { useAuthStore } from "@/store/auth"

let features: OrgFeatures = resolveOrgFeatures(undefined)
let lockedReasons: Partial<Record<keyof OrgFeatures, string>> = {}
let loading = false
const mutate = vi.fn()
vi.mock("@/hooks/use-org-features", () => ({
  ORG_FEATURES_KEY: ["settings", "org-features"],
  useOrgFeatures: () => ({ features, isLoading: loading, locked: lockedReasons }),
  useOrgFeature: (k: Parameters<typeof isOrgFeatureOn>[1]) => isOrgFeatureOn(features, k),
  useUpdateOrgFeatures: () => ({ mutate, isPending: false }),
}))
let pathname = "/"
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
// Khối "gói & mức dùng" tự gọi API qua useQuery — test này chỉ kiểm công tắc tính năng nên mock khối đó.
vi.mock("@/app/(dashboard)/settings/_components/settings-plan-usage", () => ({
  SettingsPlanUsage: () => null,
}))
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

import { menuItems } from "@/components/nav-config"
import { EXTRA_MENU_ITEMS } from "@/components/app-shell/menu-extra"
import { isItemVisible } from "@/components/nav-visibility"
import { featureForPath, FEATURE_ROUTES } from "@/lib/org-feature-routes"
import { FeatureRouteGate } from "@/components/feature-route-gate"
import { SettingsFeatures } from "@/app/(dashboard)/settings/_components/settings-features"
import { ALL_TABS } from "@/app/(dashboard)/settings/page"

const INITIAL = useAuthStore.getState()
const off = (...keys: (keyof OrgFeatures)[]) => resolveOrgFeatures(Object.fromEntries(keys.map((k) => [k, false])))
const item = (key: string) => menuItems.find((m) => m.key === key)!
const ALL = { "kanban.view": "all", "reports.overview": "all" } as never

beforeEach(() => {
  features = resolveOrgFeatures(undefined)
  lockedReasons = {}
  loading = false
  pathname = "/"
  mutate.mockClear()
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("nav — tính năng AND quyền", () => {
  it("bật hết: mục hiện theo quyền như cũ", () => {
    expect(isItemVisible(item("kanban"), ALL, features)).toBe(true)
  })
  it("tắt kanban: ẩn menu Công việc dù có quyền; mục khác vẫn hiện", () => {
    const f = off("kanban")
    expect(isItemVisible(item("kanban"), ALL, f)).toBe(false)
    expect(isItemVisible(item("contacts"), { "contacts.view": "all" } as never, f)).toBe(true)
  })
  it("tắt management: ẩn cả nhóm Quản lý (mục cha có children)", () => {
    const g = { "employees.view": "all" } as never
    expect(isItemVisible(item("management"), g, features)).toBe(true)
    expect(isItemVisible(item("management"), g, off("management"))).toBe(false)
  })
  it("bật nhưng thiếu quyền vẫn ẩn (công tắc không cấp quyền)", () => {
    expect(isItemVisible(item("kanban"), {}, features)).toBe(false)
  })
  it("không truyền features = bật hết (tương thích)", () => {
    expect(isItemVisible(item("kanban"), ALL)).toBe(true)
  })
  it("mọi mục khai `feature` là khoá hợp lệ; Cài đặt KHÔNG tắt được (Tổng quan/Khách hàng tắt được)", () => {
    expect(item("settings").feature).toBeUndefined()
    expect(item("dashboard").feature).toBe("dashboard")
    expect(item("contacts").feature).toBe("contacts")
    expect(menuItems.filter((m) => m.feature).length).toBeGreaterThanOrEqual(8)
  })
})

describe("featureForPath — dùng isUnderRoute", () => {
  it("khớp route + route con, KHÔNG khớp anh em cùng tiền tố", () => {
    expect(featureForPath("/kanban")).toBe("kanban")
    expect(featureForPath("/management/employees")).toBe("management")
    expect(featureForPath("/kanbanx")).toBeNull()
    expect(featureForPath("/settings")).toBeNull()
    expect(featureForPath("/dashboard")).toBe("dashboard")
    expect(featureForPath("/contacts/12")).toBe("contacts")
  })
  it("mọi route trong bảng thuộc 1 mục menu cùng tính năng", () => {
    const all = [...menuItems, ...EXTRA_MENU_ITEMS]
    for (const r of FEATURE_ROUTES) expect(all.some((m) => m.feature === r.feature)).toBe(true)
  })
})

describe("<FeatureRouteGate>", () => {
  it("module bật → render children", () => {
    pathname = "/kanban"
    render(<FeatureRouteGate><div>trang-kanban</div></FeatureRouteGate>)
    expect(screen.getByText("trang-kanban")).toBeTruthy()
  })
  it("module tắt → màn 'đang tắt', children KHÔNG mount; admin thấy link bật lại", () => {
    pathname = "/kanban/settings"
    features = off("kanban")
    useAuthStore.setState({ permissions: { "settings.features": "all" } as never })
    render(<FeatureRouteGate><div>trang-kanban</div></FeatureRouteGate>)
    expect(screen.queryByText("trang-kanban")).toBeNull()
    expect(screen.getByText(/đang tắt/)).toBeTruthy()
    expect(screen.getByText(/Bật lại/).closest("a")?.getAttribute("href")).toBe("/settings?tab=features")
  })
  it("module tắt, người thường → không có link bật lại", () => {
    pathname = "/kanban"
    features = off("kanban")
    render(<FeatureRouteGate><div>z</div></FeatureRouteGate>)
    expect(screen.queryByText(/Bật lại/)).toBeNull()
  })
  it("đang tải cấu hình → fail-open: module vẫn mount", () => {
    loading = true
    pathname = "/kanban"
    render(<FeatureRouteGate><div>trang-kanban</div></FeatureRouteGate>)
    expect(screen.getByText("trang-kanban")).toBeTruthy()
  })
  it("route lõi không bao giờ bị chặn", () => {
    pathname = "/settings"
    features = off("kanban", "management", "reports")
    render(<FeatureRouteGate><div>cai-dat</div></FeatureRouteGate>)
    expect(screen.getByText("cai-dat")).toBeTruthy()
  })
})

describe("Cài đặt > Tính năng", () => {
  it("tab gate bằng quyền settings.features", () => {
    expect(ALL_TABS.find((t) => t.value === "features")).toMatchObject({ permission: "settings.features" })
  })
  it("bấm công tắc gửi đúng patch một khoá", () => {
    render(<SettingsFeatures />)
    fireEvent.click(screen.getByRole("switch", { name: "Công việc" }))
    expect(mutate.mock.calls[0][0]).toEqual({ kanban: false })
  })
})

describe("Sản phẩm / POS", () => {
  it("tắt products: ẩn menu Sản phẩm + route /products,/projects; pos: ẩn menu + route /pos", async () => {
    const { EXTRA_MENU_ITEMS } = await import("@/components/app-shell/menu-extra")
    const g = { "products.view": "all", "pos.sell": "all" } as never
    const find = (k: string) => EXTRA_MENU_ITEMS.find((m) => m.key === k)!
    expect(isItemVisible(find("products"), g, off("products"))).toBe(false)
    expect(isItemVisible(find("pos"), g, off("products"))).toBe(true)
    expect(isItemVisible(find("pos"), g, off("pos"))).toBe(false)
    expect(featureForPath("/products")).toBe("products")
    expect(featureForPath("/projects/3")).toBe("products")
    expect(featureForPath("/pos")).toBe("pos")
    expect(featureForPath("/posts")).toBeNull()
  })
})

describe("Tính năng bị khoá theo runtime", () => {
  it("FeatureRouteGate: module bị khoá hiện 'không khả dụng trên bản này' + lý do, không link bật lại", () => {
    features = off("pos")
    lockedReasons = { pos: "Cần tiến trình chạy liên tục." }
    pathname = "/pos"
    render(<FeatureRouteGate><div>NOI-DUNG-POS</div></FeatureRouteGate>)
    expect(screen.queryByText("NOI-DUNG-POS")).toBeNull()
    expect(screen.getByText(/không khả dụng trên bản này/)).toBeTruthy()
    expect(screen.getByText(/tiến trình chạy liên tục/)).toBeTruthy()
    expect(screen.queryByText(/Bật lại ở Cài đặt/)).toBeNull()
  })
  it("Cài đặt > Tính năng: công tắc bị khoá vô hiệu + hiện lý do; bấm không gọi mutate", () => {
    features = off("pos")
    lockedReasons = { pos: "Cần tiến trình chạy liên tục." }
    render(<SettingsFeatures />)
    const sw = document.getElementById("feature-switch-pos") as HTMLElement
    expect(sw.hasAttribute("disabled") || sw.getAttribute("data-disabled") !== null || sw.getAttribute("aria-disabled") === "true").toBe(true)
    expect(screen.getByText(/tiến trình chạy liên tục/)).toBeTruthy()
    fireEvent.click(sw)
    expect(mutate).not.toHaveBeenCalled()
  })
})
