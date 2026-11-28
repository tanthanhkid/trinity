import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8")

/** Vòng 2 Ánh xanh câu 5: khung app (sidebar, topbar, tab) có vùng chạm desktop ≥ 40 px thật (không chỉ ::after). */
describe("vùng chạm desktop khung app ≥ 40 px", () => {
  const css = src("styles/app-sidebar.css")

  it("mục sidebar, mục con, nhóm, ô tìm, nút sáng/tối cao ≥ 40", () => {
    expect(css).toMatch(/\[data-slot="sidebar-menu-button"\] \{[^}]*height: 40px/)
    expect(css).toMatch(/\[data-slot="sidebar-menu-sub-button"\] \{[^}]*height: 40px/)
    expect(css).toMatch(/\.app-nav-group-head \{[^}]*height: 40px/)
    expect(css).toMatch(/\.app-side-search \{[^}]*min-height: 40px/)
    expect(css).toMatch(/\.app-side-theme \{[^}]*height: 40px/)
  })

  it("sidebar-content tự cuộn khi menu dài hơn màn", () => {
    expect(src("components/ui/sidebar.tsx")).toContain("flex min-h-0 flex-1 flex-col gap-0 overflow-auto")
  })

  it("topbar, chuông, tab, nút ghim ≥ 40", () => {
    const top = src("components/app-shell/topbar.tsx")
    expect(top).not.toMatch(/size-\[34px\]|size-7 |h-\[34px\]/)
    expect(top).toContain("hidden h-10 min-w-0")
    expect(src("components/notifications-bell.tsx")).not.toContain("inline-flex size-8 max-sm")
    expect(src("components/app-shell/tabs.tsx")).toContain('"h-10 flex-none')
    expect(src("components/ui/tabs.tsx")).toContain("group-data-horizontal/tabs:h-10")
    for (const f of ["sidebar-items.tsx", "sidebar-pinned-group.tsx"]) {
      expect(src(`components/app-shell/${f}`)).toContain("h-10 w-7")
    }
  })
})
