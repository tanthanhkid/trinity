/**
 * Pinned group sits at the top of the sidebar and the pin cap is 20
 * (same number as the server DTO). Reads sources like the other app-shell
 * tests — jsdom cannot measure layout.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
const read = (p: string) => readFileSync(join(SRC, p), "utf8")

describe("Đã ghim nằm đầu thanh bên", () => {
  const sidebar = read("components/app-shell/sidebar.tsx")
  const content = sidebar.slice(sidebar.indexOf("<SidebarContent"))

  it("nhóm Đã ghim render trước menu chính, bảng tuỳ chỉnh và gần đây", () => {
    const pinned = content.indexOf("<ShellPinnedGroup")
    expect(pinned).toBeGreaterThan(-1)
    expect(pinned).toBeLessThan(content.indexOf("mainItems.map"))
    expect(pinned).toBeLessThan(content.indexOf("customItems.map"))
    expect(pinned).toBeLessThan(content.indexOf("<ShellRecentGroup"))
  })

  it("giữ ẩn ở rail thu gọn (rail chỉ có icon menu chính); mobile là sheet đầy đủ nên vẫn hiện đầu", () => {
    expect(read("components/app-shell/sidebar-pinned-group.tsx")).toContain("group-data-[collapsible=icon]:hidden")
  })
})

describe("trần ghim 20", () => {
  const hook = read("hooks/use-pinned-menus.ts")
  it("MAX_PINS = 20 và câu báo dùng đúng số", () => {
    expect(hook).toMatch(/export const MAX_PINS = 20\b/)
    expect(hook).toContain("Chỉ ghim tối đa ${MAX_PINS} mục")
  })
})
