/**
 * mục menu "Sản phẩm" đúng vị trí #2 (ngay sau "Tổng
 * quan" — anchor có sẵn trong `nav-config.ts`) + hiện theo quyền
 * `products.view` (khớp `GET /products`).
 *
 * 🔴 RBAC quyền + phạm vi — chuyển từ `deniedRoles` sang
 * `permission`/`anyOf`; `isItemVisible` nay nhận `Grants` thay vì role.
 */
import { describe, expect, it } from "vitest"
import { EXTRA_MENU_ITEMS, withExtraMenuItems } from "@/components/app-shell/menu-extra"
import { menuItems } from "@/components/nav-config"
import { isItemVisible } from "@/components/nav-visibility"

describe("EXTRA_MENU_ITEMS — 'Sản phẩm', theo quyền products.view", () => {
  it("khai permission products.view + badgeLabel 'Mới'", () => {
    const products = EXTRA_MENU_ITEMS.find((i) => i.key === "products")
    expect(products?.permission).toBe("products.view")
    expect(products?.anyOf).toBeUndefined()
    expect(products?.badgeLabel).toBe("Mới")
  })

  // Bước 4a giao diện mới: "Hộp thư" chen giữa (đúng vị trí bản demo) ⇒ "Sản phẩm" lùi xuống sau "Hộp thư".
  it("chèn sau 'Tổng quan' › 'Hộp thư' trong danh sách hiển thị", () => {
    const merged = withExtraMenuItems(menuItems)
    const dashboardIdx = merged.findIndex((i) => i.key === "dashboard")
    expect(merged[dashboardIdx + 1]?.key).toBe("inbox")
    expect(merged[dashboardIdx + 2]?.key).toBe("products")
  })

  it("ẨN với grants RỖNG (fail-closed)", () => {
    const products = EXTRA_MENU_ITEMS.find((i) => i.key === "products")!
    expect(isItemVisible(products, {})).toBe(false)
  })

  it("ẨN với quyền không liên quan", () => {
    const products = EXTRA_MENU_ITEMS.find((i) => i.key === "products")!
    expect(isItemVisible(products, { "contacts.view": "own" })).toBe(false)
  })

  it("HIỆN khi có products.view", () => {
    const products = EXTRA_MENU_ITEMS.find((i) => i.key === "products")!
    expect(isItemVisible(products, { "products.view": true })).toBe(true)
  })
})
