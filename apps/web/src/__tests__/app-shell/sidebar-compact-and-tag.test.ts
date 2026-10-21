/**
 * khoá (1) nhãn "Mới" nhường chỗ nút ghim, (2) sidebar
 * thu gọn (rail) dùng được: a11y nút toggle, "Tất cả" + nút nhanh không bị ẩn,
 * mục cha bấm ở rail thì mở rộng sidebar. Đọc source (cùng kiểu các test
 * app-shell khác) — jsdom không đo được layout/hover.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
// Bỏ CR: Windows (core.autocrlf) lấy tệp về với CRLF, còn chuỗi so sánh nhiều dòng trong test dùng LF.
const read = (p: string) => readFileSync(join(SRC, p), "utf8").replace(/\r\n/g, "\n")

describe("nhãn Mới không bị nút ghim đè", () => {
  const css = read("styles/app-sidebar.css")
  it("dịch nhãn sang trái khi hover / focus bàn phím / mục đã ghim", () => {
    expect(css).toMatch(/sidebar-menu-item"\]:hover \.app-nav-tag/)
    expect(css).toMatch(/:has\(> button:focus-visible\) \.app-nav-tag/)
    expect(css).toMatch(/sidebar-menu-item"\]\[data-pinned\] \.app-nav-tag/)
    expect(css).toMatch(/margin-right: 22px/)
  })
  it("ShellLeafItem gắn data-pinned và nút ghim hiện khi focus bàn phím", () => {
    const items = read("components/app-shell/sidebar-items.tsx")
    expect(items).toContain('data-pinned={isPinned ? "" : undefined}')
    expect(items).toContain("focus-visible:opacity-100")
  })
})

describe("thu gọn sidebar", () => {
  const topbar = read("components/app-shell/topbar.tsx")
  const sidebar = read("components/app-shell/sidebar.tsx")
  const quick = read("components/app-shell/sidebar-quick-actions.tsx")
  it("nút toggle có aria-expanded + aria-label theo trạng thái", () => {
    expect(topbar).toContain("aria-expanded={navExpanded}")
    expect(topbar).toContain('"Thu gọn menu" : "Mở rộng menu"')
  })
  it("menu chính vẫn hiện ở rail (không ẩn theo collapsible=icon), nhãn nhóm thì ẩn", () => {
    // Giao diện mới: menu chính không còn nút gập "TẤT CẢ" — luôn hiện, kể cả rail.
    expect(sidebar).toContain("<SidebarGroup>\n          <SidebarGroupContent>\n            <SidebarMenu>{mainItems.map(renderItem)}</SidebarMenu>")
    expect(read("components/app-shell/sidebar-group-label.tsx")).toContain("group-data-[collapsible=icon]:hidden")
  })
  it("rail vẫn cuộn được khi danh sách dài (SidebarContent không bị overflow-hidden)", () => {
    expect(sidebar).toContain('<SidebarContent className="group-data-[collapsible=icon]:overflow-auto">')
  })
  it("bấm mục cha ở rail thì mở rộng sidebar", () => {
    expect(sidebar).toMatch(/if \(compact\) \{\s*setOpen\(true\)/)
  })
  it("nút nhanh Tìm/Thêm khách không bị ẩn ở rail và có aria-label", () => {
    expect(quick).not.toMatch(/px-2 py-1\.5 group-data-\[collapsible=icon\]:hidden"/)
    expect(quick).toContain('aria-label="Tìm kiếm"')
  })
})
