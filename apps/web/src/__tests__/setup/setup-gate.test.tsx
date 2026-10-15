/**
 * CRM "mở ra trống": chưa dựng quy trình thì chỉ Bắt đầu · Hoạt động AI · Cài đặt; mọi route khác về /bat-dau.
 * Chế độ `da_dung` giữ menu, thêm Bắt đầu ở cuối; người mới đi wizard bắt đầu (layout) trước khi tới cổng này.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { resolveOrgFeatures, type OrgFeatures, type SetupStatus } from "@trinity/rbac"

let status: SetupStatus = "da_dung"
let loading = false
let features: OrgFeatures = resolveOrgFeatures(undefined)
let pathname = "/dashboard"
const replace = vi.fn()
vi.mock("@/hooks/use-setup-status", () => ({ useSetupStatus: () => ({ status, isLoading: loading, data: undefined }) }))
vi.mock("@/hooks/use-org-features", () => ({ useOrgFeatures: () => ({ features, isResolved: true, isLoading: false, locked: {} }) }))
vi.mock("@/hooks/custom-objects/use-custom-objects", () => ({ useCustomNav: () => ({ data: [{ key: "khach_hang", label: "Khách mới", label_plural: "Khách mới", icon: null, nav_order: 1, href: "/x/khach_hang/v/kanban" }] }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => true, grants: {} }) }))
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ replace, push: vi.fn() }) }))

import { SetupGate } from "@/components/setup-gate"
import { withSetupMenu } from "@/components/app-shell/menu-setup"
import { isAllowedBeforeSetup } from "@/lib/setup-routes"
import { menuItems } from "@/components/nav-config"
import { withExtraMenuItems } from "@/components/app-shell/menu-extra"

beforeEach(() => {
  status = "da_dung"; loading = false; features = resolveOrgFeatures(undefined); pathname = "/dashboard"; replace.mockClear()
})

describe("SetupGate", () => {
  it("da_dung: hiện trang như cũ, không chuyển hướng", () => {
    render(<SetupGate><p>NỘI DUNG</p></SetupGate>)
    expect(screen.getByText("NỘI DUNG")).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
  it("chua_dung + /contacts ⇒ không mount trang, chuyển về /bat-dau", () => {
    status = "chua_dung"; pathname = "/contacts"
    render(<SetupGate><p>NỘI DUNG</p></SetupGate>)
    expect(screen.queryByText("NỘI DUNG")).toBeNull()
    expect(replace).toHaveBeenCalledWith("/bat-dau")
  })
  it("chua_dung vẫn vào được Bắt đầu, Hoạt động AI, Cài đặt", () => {
    status = "chua_dung"
    for (const p of ["/bat-dau", "/ai-actions", "/settings"]) {
      pathname = p
      const { unmount } = render(<SetupGate><p>OK {p}</p></SetupGate>)
      expect(screen.getByText(`OK ${p}`)).toBeTruthy()
      unmount()
    }
    expect(replace).not.toHaveBeenCalled()
  })
  it("gói dựng tắt Tổng quan ⇒ /dashboard chuyển sang menu đầu của gói", () => {
    status = "dang_dung"; features = resolveOrgFeatures({ dashboard: false })
    render(<SetupGate><p>NỘI DUNG</p></SetupGate>)
    expect(replace).toHaveBeenCalledWith("/x/khach_hang/v/kanban")
  })
  it("không còn tự chuyển /dashboard sang /bat-dau — người mới đi wizard ở layout", () => {
    render(<SetupGate><p>NỘI DUNG</p></SetupGate>)
    expect(screen.getByText("NỘI DUNG")).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
  it("đang tải lần đầu ⇒ chờ, không nháy trang", () => {
    loading = true
    render(<SetupGate><p>NỘI DUNG</p></SetupGate>)
    expect(screen.queryByText("NỘI DUNG")).toBeNull()
  })
})

describe("withSetupMenu", () => {
  const all = withExtraMenuItems(menuItems)
  it("chua_dung ⇒ đúng 3 mục: Bắt đầu · Hoạt động AI · Cài đặt", () => {
    const m = withSetupMenu(all, "chua_dung")
    expect(m.map((i) => i.title)).toEqual(["Bắt đầu", "Hoạt động AI", "Cài đặt"])
  })
  it("da_dung ⇒ giữ menu hiện có, thêm Bắt đầu ở cuối để mở lại hướng dẫn", () => {
    const m = withSetupMenu(all, "da_dung")
    expect(m.slice(0, -1)).toEqual(all)
    expect(m[m.length - 1].key).toBe("bat_dau")
  })
  it("dang_dung ⇒ thêm Bắt đầu lên đầu, giữ phần còn lại", () => {
    const m = withSetupMenu(all, "dang_dung")
    expect(m[0].key).toBe("bat_dau")
    expect(m.length).toBe(all.length + 1)
  })
  it("isAllowedBeforeSetup không khớp nhầm route anh em", () => {
    expect(isAllowedBeforeSetup("/settings?tab=x")).toBe(false) // pathname không có query
    expect(isAllowedBeforeSetup("/settings")).toBe(true)
    expect(isAllowedBeforeSetup("/bat-dau-x")).toBe(false)
  })
})
