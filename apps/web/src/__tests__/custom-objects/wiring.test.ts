/**
 * Thực thể tuỳ biến — khoá cách NỐI vào khung giao diện (bất biến 0B + nguồn menu RBAC duy nhất).
 */
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
const read = (p: string) => readFileSync(join(SRC, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "")

describe("nối vào khung", () => {
  it("trang /x/... nằm TRONG (dashboard) — KHÔNG có route group anh em (2 cây provider ⇒ chết cuộc đang gọi)", () => {
    for (const f of ["page.tsx", "new/page.tsx", "[id]/page.tsx"]) {
      expect(existsSync(join(SRC, "app/(dashboard)/x/[objectKey]", f)), f).toBe(true)
    }
    expect(existsSync(join(SRC, "app/x"))).toBe(false)
  })

  it("mọi trang /x đều qua PermissionGate (0 request khi thiếu quyền)", () => {
    for (const f of ["page.tsx", "new/page.tsx", "[id]/page.tsx"]) {
      expect(read(`app/(dashboard)/x/[objectKey]/${f}`), f).toContain("<PermissionGate")
    }
  })

  it("sidebar: các mục tuỳ biến cấp 1 đi qua withCustomObjectItems TRƯỚC khi lọc RBAC (isItemVisible) — không có đường tắt", () => {
    const sidebar = strip(read("components/app-shell/sidebar.tsx"))
    expect(sidebar).toMatch(/withCustomObjectItems\(/)
    expect(sidebar).toMatch(/useCustomNav\(can\("custom_records\.view"\)\)/)
    expect(sidebar.indexOf("withCustomObjectItems(")).toBeLessThan(sidebar.indexOf("isItemVisible("))
  })

  it("topbar: breadcrumb /x/... lấy từ menu tuỳ biến, rơi về bảng tra cũ", () => {
    const topbar = strip(read("components/app-shell/topbar.tsx"))
    expect(topbar).toMatch(/resolveCustomBreadcrumb\(pathname, customNav\) \?\? resolveBreadcrumb\(pathname\)/)
  })

  it("Cài đặt › Tính năng: tab vẫn gate bằng settings.features; khu tuỳ biến gate thêm custom_objects.manage", () => {
    const f = read("app/(dashboard)/settings/_components/settings-features.tsx")
    expect(f).toContain('can("custom_objects.manage")')
    expect(f).toContain("<CustomObjectsSection />")
  })

  it("không so mã vai trò ở FE tuỳ biến (gate theo QUYỀN)", () => {
    for (const p of ["components/custom-objects/custom-records-screen.tsx", "components/custom-objects/custom-record-detail.tsx"]) {
      expect(strip(read(p)), p).not.toMatch(/\brole\s*===|_ROLES\b/)
    }
  })
})
