/**
 * cùng 1 mục menu trái phải hiện CÙNG 1 icon (lucide nét viền
 * 16px) ở MỌI nhóm: "Đã ghim", "Tất cả" (mục cha lẫn mục con), chế độ thu
 * gọn, command palette.
 *
 * Trước fix: `sidebar-items.tsx` (`NavIcon`, dùng RIÊNG cho nhóm "Tất cả")
 * ưu tiên `getFillIcon(item.key)` — bộ icon TÔ ĐẶC port từ 1 bản demo cũ
 * (`nav-icon.tsx`) — trước icon lucide khai ở `nav-config.ts`. "Đã ghim"
 * (`sidebar-pinned-group.tsx`) và command palette (`sidebar-command-palette.tsx`)
 * luôn render thẳng `entry.icon`/`n.icon` (lucide) — không đi qua `NavIcon` nên
 * không dính bộ icon tô đặc. Kết quả: 2 nhóm hiện 2 KIỂU VẼ khác nhau cho
 * CÙNG 1 mục (vd "Khách hàng"/"Báo cáo"/"Công việc"). Mục con (children của
 * `ShellGroupItem`) thì KHÔNG render icon nào cả (thiếu hẳn).
 *
 * Fix: `NavIcon` bỏ hẳn nhánh `getFillIcon` — LUÔN render `item.icon` (nguồn
 * DUY NHẤT là `nav-config.ts`/`menu-extra.ts`), dùng cho CẢ
 * leaf item, mục cha VÀ mục con. `nav-icon.tsx` bị xoá hẳn (không còn nơi nào
 * import) — test dưới khoá luôn việc không được khôi phục file/nhánh đó.
 */
import type { LucideIcon } from "lucide-react"
import { beforeAll, describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar"
import { ShellGroupItem, ShellLeafItem } from "@/components/app-shell/sidebar-items"
import type { ChildMenuItem, MenuItem } from "@/components/nav-config"

// `SidebarProvider` dùng `useIsMobile()` (`hooks/use-mobile.ts`) → gọi
// `window.matchMedia` — jsdom KHÔNG tự có API này. Chỉ 2 test render component
// bên dưới cần; các test đọc source (không render) không đụng tới.
beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
})

const SRC = join(__dirname, "../..")
const read = (p: string) => readFileSync(join(SRC, p), "utf8")
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "")

const IconA = (({ className }: { className?: string }) => (
  <svg data-testid="icon-a" className={className} />
)) as unknown as LucideIcon
const IconB = (({ className }: { className?: string }) => (
  <svg data-testid="icon-b" className={className} />
)) as unknown as LucideIcon

function renderWithSidebar(children: React.ReactNode) {
  return render(
    <SidebarProvider>
      <SidebarMenu>{children}</SidebarMenu>
    </SidebarProvider>,
  )
}

describe("nav-icon.tsx (bộ icon tô đặc thứ 2) đã bị xoá hẳn", () => {
  it("file không còn tồn tại", () => {
    expect(existsSync(join(SRC, "components/app-shell/nav-icon.tsx"))).toBe(false)
  })

  it("sidebar-items.tsx KHÔNG còn import/dùng getFillIcon/nav-icon", () => {
    const src = stripComments(read("components/app-shell/sidebar-items.tsx"))
    expect(src).not.toMatch(/getFillIcon|hasFillIcon|nav-icon/)
  })

  it("grep toàn repo: không còn nơi nào tham chiếu getFillIcon/hasFillIcon", () => {
    // Không dùng `execSync grep` (phụ thuộc binary hệ thống) — đọc trực tiếp
    // 2 file duy nhất từng có liên quan, đủ để khoá bất biến này trong CI.
    const items = stripComments(read("components/app-shell/sidebar-items.tsx"))
    const sidebar = stripComments(read("components/app-shell/sidebar.tsx"))
    for (const src of [items, sidebar]) {
      expect(src).not.toMatch(/getFillIcon|hasFillIcon/)
    }
  })
})

describe("NavIcon render ĐÚNG icon đã khai ở nav-config, không hardcode theo key", () => {
  // "contacts" là 1 trong các key TỪNG có icon tô đặc riêng trong nav-icon.tsx
  // (map sang path "user") — dùng đúng key này để khoá việc không còn ai được
  // phép "ghi đè thầm lặng" icon theo key nữa.
  const leafItem: MenuItem = {
    key: "contacts",
    title: "Khách hàng",
    icon: IconA,
    href: "/contacts",
    iconColor: "text-emerald-600",
  }

  it("ShellLeafItem (nhóm 'Tất cả') render ĐÚNG icon truyền vào, không phải icon khác", () => {
    const { queryByTestId } = renderWithSidebar(
      <ShellLeafItem
        item={leafItem}
        activeHref={null}
        onNavigate={() => {}}
      />,
    )
    expect(queryByTestId("icon-a")).toBeInTheDocument()
    expect(queryByTestId("icon-b")).not.toBeInTheDocument()
  })

  it("ShellGroupItem: mục CHA lẫn mục CON đều render icon riêng của chính nó (mục con trước đây KHÔNG có icon nào)", () => {
    const child: ChildMenuItem = {
      key: "management_employees",
      title: "Nhân viên",
      icon: IconB,
      href: "/management/employees",
    }
    const groupItem: MenuItem & { children: readonly ChildMenuItem[] } = {
      key: "management",
      title: "Quản lý",
      icon: IconA,
      iconColor: "text-cyan-600",
      children: [child],
    }
    const { getAllByTestId } = renderWithSidebar(
      <ShellGroupItem
        item={groupItem}
        activeHref={null}
        grants={{}}
        isExpanded
        onToggle={() => {}}
        onNavigate={() => {}}
      />,
    )
    // Mục cha "Quản lý" dùng IconA, mục con "Nhân viên" dùng IconB — cả 2 PHẢI
    // xuất hiện đúng 1 lần, không bị lệch/thiếu.
    expect(getAllByTestId("icon-a")).toHaveLength(1)
    expect(getAllByTestId("icon-b")).toHaveLength(1)
  })
})

describe("'Đã ghim' + command palette vẫn render icon lucide trực tiếp (KHÔNG đổi hành vi, chỉ 'Tất cả'/mục con thay đổi)", () => {
  it("sidebar-pinned-group.tsx render thẳng `entry.icon`", () => {
    const src = stripComments(read("components/app-shell/sidebar-pinned-group.tsx"))
    expect(src).toMatch(/<entry\.icon\s*\/>/)
  })

  it("sidebar-command-palette.tsx render thẳng `n.icon`", () => {
    const src = stripComments(read("components/app-shell/sidebar-command-palette.tsx"))
    expect(src).toMatch(/<n\.icon\b/)
  })
})

describe("CSS mục con có size/màu icon riêng, mirror mục cha (styles/app-sidebar.css)", () => {
  it("khai `> svg:first-child` cho `sidebar-menu-sub-button` (trước đây chỉ có ở sidebar-menu-button)", () => {
    const css = read("styles/app-sidebar.css")
    expect(css).toMatch(
      /\[data-slot="sidebar-menu-sub-button"\]\s*>\s*svg:first-child/,
    )
    expect(css).toMatch(
      /\[data-slot="sidebar-menu-sub-button"\]\[data-active\]\s*>\s*svg:first-child/,
    )
  })
})
