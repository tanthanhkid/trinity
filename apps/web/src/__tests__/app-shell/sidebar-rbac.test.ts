/**
 * 🔴 — sidebar PHẢI lọc menu qua ĐÚNG RBAC dùng chung
 * (`nav-config.ts` + `nav-visibility.ts`), KHÔNG dùng lại lớp RBAC demo
 * client-side của UI kit gốc (`data-role-only`/`data-role-hide`, đổi vai trò
 * bằng `localStorage['mx-role']`) — port sang mà dùng lại lớp đó là mất toàn
 * bộ gate quyền thật.
 *
 * Hiển thị menu suy trực tiếp từ `usePermissions()`, không có bảng cấu hình
 * menu động.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
const read = (p: string) => readFileSync(join(SRC, p), "utf8")
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "")

const sidebar = read("components/app-shell/sidebar.tsx")
const items = read("components/app-shell/sidebar-items.tsx")

describe("ShellSidebar — nguồn menu + RBAC", () => {
  it("lấy menu từ `nav-config.ts` dùng chung, KHÔNG khai lại danh sách riêng", () => {
    expect(sidebar).toContain('import { menuItems } from "@/components/nav-config"')
  })

  it("lọc qua `isItemVisible` / `isChildVisible` của `nav-visibility.ts`", () => {
    expect(sidebar).toContain('from "@/components/nav-visibility"')
    expect(stripComments(sidebar)).toMatch(/isItemVisible\(/)
    expect(stripComments(items)).toMatch(/isChildVisible\(/)
  })

  it("đọc quyền qua `usePermissions()` (`@/lib/rbac`), KHÔNG còn bảng menu-visibility động", () => {
    expect(sidebar).toContain('from "@/lib/rbac"')
    expect(stripComments(sidebar)).toMatch(/usePermissions\(\)/)
    expect(sidebar).not.toContain("/settings/menu-visibility/my")
  })

  it("🔴 KHÔNG dùng RBAC demo của UI kit", () => {
    // Bỏ comment trước khi soi CODE: doc-comment của chính file có nhắc tên
    // `data-role-only`/`mx-role` một cách hợp lệ (giải thích vì sao KHÔNG dùng).
    for (const file of [sidebar, items]) {
      expect(stripComments(file)).not.toMatch(
        /mx-role|data-role-only|data-role-hide|MX_NAV|MX_ROLES/,
      )
    }
  })

  it("href dùng thẳng `rawHref` — KHÔNG còn tầng quy đổi tiền tố nào", () => {
    const src = stripComments(items)
    expect(src).not.toMatch(/toV2Href|toV1Path/)
    expect(src).toMatch(/const rawHref = /)
  })

  it("link NGOÀI (`external`) render bằng <a>, link trong bằng <Link>", () => {
    const src = stripComments(items)
    expect(src).toMatch(/item\.external \? \(/)
    expect(src).toMatch(/<a href=\{rawHref\} target="_blank"/)
    expect(src).toMatch(/<Link href=\{rawHref\}/)
  })

  it("Base-UI: dùng `render={<Link/>}`, KHÔNG dùng `asChild`", () => {
    expect(items).toMatch(/render=\{/)
    expect(items).not.toMatch(/asChild/)
  })

  it("KHÔNG hardcode hex brand xanh lá trong shell", () => {
    for (const file of [sidebar, items, read("components/app-shell/topbar.tsx")]) {
      expect(stripComments(file)).not.toMatch(/#198754|#146c43|#146C43/)
    }
  })
})

describe("khung `(dashboard)/layout.tsx` — cấu trúc", () => {
  const layout = read("app/(dashboard)/layout.tsx")

  it("dùng `SidebarInset` của components/ui/sidebar (không tự dựng layout riêng)", () => {
    expect(layout).toContain('from "@/components/ui/sidebar"')
    expect(layout).toContain("<SidebarInset")
  })

  it("mount `ShellSidebar` + `ShellTopbar`", () => {
    expect(stripComments(layout)).toContain("<ShellSidebar />")
    expect(stripComments(layout)).toContain("<ShellTopbar />")
  })

  it("giữ widget toàn cục (notification)", () => {
    expect(layout).toContain("<NotificationSocket />")
  })
})

describe("kích thước sidebar = 232px / 64px (demo giao diện mới)", () => {
  const layout = read("app/(dashboard)/layout.tsx")

  it("ghi đè `--sidebar-width` / `--sidebar-width-icon` (mặc định shadcn 16rem/3rem)", () => {
    expect(layout).toContain('"--sidebar-width": "232px"')
    expect(layout).toContain('"--sidebar-width-icon": "64px"')
  })

  it("sidebar collapsible=\"icon\" (thu về rail 64px, KHÔNG ẩn hẳn)", () => {
    expect(sidebar).toContain('collapsible="icon"')
  })

  it("trạng thái thu gọn nhớ qua localStorage, đọc kiểu SSR-safe", () => {
    const hook = read("hooks/use-app-shell.ts")
    expect(hook).toContain("APP_NAV_MINI_STORAGE_KEY")
    // `useSyncExternalStore` là cách duy nhất đọc localStorage mà KHÔNG vi phạm
    // 1 trong 2 điều: initializer `useState` chạy trên server (không có
    // localStorage → crash + hydration mismatch), hoặc setState-trong-effect
    // (cascading render, eslint react-hooks/set-state-in-effect chặn).
    expect(hook).toMatch(/useSyncExternalStore\(/)
    expect(hook).toMatch(/readNavMiniOnServer/)
    expect(hook).not.toMatch(/useState\([^)]*localStorage/)
  })

  it("ghi/đọc localStorage đều bọc try/catch (trình duyệt chặn site data)", () => {
    const hook = read("hooks/use-app-shell.ts")
    expect((hook.match(/try \{/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
