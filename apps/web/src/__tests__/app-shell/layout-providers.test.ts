/**
 * Toàn bộ cây route dashboard PHẢI sống trong CÙNG `app/(dashboard)/layout.tsx`:
 * provider dùng chung là ĐÚNG 1 instance, `children` nằm ở ĐÚNG 1 nhánh render
 * dưới CÙNG cặp element — rẽ nhánh TYPE của element bọc `children` khiến React
 * huỷ trọn fiber ⇒ remount cả cây con.
 *
 * Đọc SOURCE thay vì render: layout kéo theo socket, không dựng nổi trong jsdom.
 */
import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
const read = (p: string) => readFileSync(join(SRC, p), "utf8")
// Bỏ comment DÒNG trước, rồi mới bỏ block: một `/*` nằm trong comment `//`
// sẽ bị regex block coi là mở `/*` và nuốt tới `*/` xa bên dưới (đúng lỗi làm
// bản đầu của test này đỏ oan).
const stripComments = (s: string) =>
  s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")

const LAYOUT = "app/(dashboard)/layout.tsx"
const layout = read(LAYOUT)
const layoutCode = stripComments(layout)

/** Mọi `layout.tsx` dưới `app/` (đệ quy). */
function listLayouts(dir: string, rel = ""): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    if (statSync(abs).isDirectory()) out.push(...listLayouts(abs, r))
    else if (name === "layout.tsx") out.push(r)
  }
  return out
}

/** Thứ tự xuất hiện của các thẻ mở provider trong 1 file layout. */
function providerOrder(code: string): string[] {
  return ["SidebarProvider"]
    .map((name) => ({ name, at: code.indexOf(`<${name}`) }))
    .filter((x) => x.at > -1)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.name)
}

describe("1 layout DUY NHẤT mang cây provider dùng chung", () => {
  it("🔴 KHÔNG tồn tại route group `app/(v2)` — group anh em = cây provider thứ 2", () => {
    expect(existsSync(join(SRC, "app/(v2)"))).toBe(false)
  })

  it("🔴 chỉ ĐÚNG 1 layout.tsx trong app/ mount SidebarProvider", () => {
    const layouts = listLayouts(join(SRC, "app"))
    const hosting = layouts.filter((p) => {
      const code = stripComments(read(`app/${p}`))
      return /<SidebarProvider/.test(code)
    })
    expect(hosting).toEqual(["(dashboard)/layout.tsx"])
  })

  it("provider mở ĐÚNG 1 lần trong layout (1 instance)", () => {
    expect((layoutCode.match(/<SidebarProvider/g) ?? []).length).toBe(1)
  })

  it("thứ tự lồng provider giữ nguyên", () => {
    expect(providerOrder(layoutCode)).toEqual(["SidebarProvider"])
  })
})

describe("`children` KHÔNG bị bọc bởi element rẽ nhánh type", () => {
  it("🔴 render `children` ĐÚNG 1 lần, dưới cặp element cố định `<SidebarInset> > <main>`", () => {
    expect((layoutCode.match(/\{children\}/g) ?? []).length).toBe(1)
    expect(layoutCode).toMatch(
      /<SidebarInset[^>]*>[\s\S]*?<main[^>]*>\s*(?:<SetupGate>\s*)?(?:<FeatureRouteGate>\{children\}<\/FeatureRouteGate>|\{children\})\s*(?:<\/SetupGate>\s*)?<\/main>[\s\S]*?<\/SidebarInset>/,
    )
    // `SetupGate` (chưa dựng quy trình ⇒ về /bat-dau) cũng là wrapper type CỐ ĐỊNH bọc ngoài FeatureRouteGate.
    // `FeatureRouteGate` là wrapper type CỐ ĐỊNH (không rẽ nhánh type
    // của chính `{children}`), nên không phá bất biến "không remount cả trang".
    expect(layoutCode).toContain('<FeatureRouteGate>{children}</FeatureRouteGate>')
  })

  it("🔴 KHÔNG có ternary/&& nào mà nhánh của nó bọc trực tiếp `{children}`", () => {
    // `{cond ? <A>{children}</A> : <B>{children}</B>}` là 2 element KHÁC TYPE ở
    // cùng vị trí fiber ⇒ React remount cả trang mỗi lần cờ lật.
    expect(layoutCode).not.toMatch(/\?\s*<[A-Za-z][^>]*>\s*\{children\}/)
    expect(layoutCode).not.toMatch(/:\s*<[A-Za-z][^>]*>\s*\{children\}/)
    expect(layoutCode).not.toMatch(/&&\s*<[A-Za-z][^>]*>\s*\{children\}/)
  })

  it("KHÔNG rẽ nhánh điều kiện quanh cây provider", () => {
    expect(layoutCode).not.toMatch(/\?\s*<SidebarProvider/)
    expect(layoutCode).not.toMatch(/&&\s*<SidebarProvider/)
  })

  it("khung gắn cố định: 1 SidebarProvider, sidebar + topbar không rẽ nhánh", () => {
    expect((layoutCode.match(/<SidebarProvider/g) ?? []).length).toBe(1)
    expect(layoutCode).toContain("<ShellSidebar />")
    expect(layoutCode).toContain("<ShellTopbar />")
    // Khung cũ của v1 đã gỡ — quay lại 2 khung song song là dựng lại đúng
    // nguồn bug remount cần tránh.
    expect(layoutCode).not.toMatch(/<AppSidebar|<Header\s*\/>/)
  })

  it("sidebar controlled theo navMini, vẫn giữ `defaultOpen`", () => {
    expect(layoutCode).toMatch(/defaultOpen=\{getSidebarDefaultOpen\(\)\}/)
    expect(layoutCode).toMatch(/open=\{!navMini\}/)
  })

  it("giữ widget toàn cục (notification) ở tầng layout", () => {
    expect(layoutCode).toContain("<NotificationSocket />")
  })
})

describe("attribute `data-ui` đặt trên <html>", () => {
  const shellHookCode = stripComments(read("hooks/use-app-shell.ts"))

  it('gắn `documentElement.dataset.ui = "app"`, KHÔNG gắn vào div bọc', () => {
    // Dialog/Select/Popover của Base-UI portal ra `document.body` — scope token
    // ở div sẽ để overlay thoát ra ngoài và mất token.
    expect(shellHookCode).toMatch(/document\.documentElement/)
    expect(shellHookCode).toMatch(/root\.dataset\.ui\s*=\s*"app"/)
  })

  it("🔴 attribute gắn VÔ ĐIỀU KIỆN — nó là PHẠM VI của phần vá tương phản WCAG", () => {
    // 2 khối override cuối `styles/app-tokens.css` nằm dưới `html:root[data-ui="app"]`.
    // Thêm lại cờ bật/tắt ở đây là mất phần vá đó ở nhánh tắt.
    expect(shellHookCode).toMatch(/useAppDocumentTheme\(fontClassName: string\)/)
    expect(shellHookCode).not.toMatch(/if \(!enabled\) return/)
    expect(layoutCode).toMatch(/useAppDocumentTheme\(appFont\.variable\)/)
  })

  it("🔴 cleanup gỡ attribute khi unmount", () => {
    expect(shellHookCode).toMatch(/return \(\) => \{[\s\S]*?delete root\.dataset\.ui/)
  })
})

describe("layout không tự quyết điều hướng", () => {
  it("🔴 layout KHÔNG tự viết luật redirect riêng (router.replace tại chỗ)", () => {
    expect(layoutCode).not.toMatch(/router\.(replace|push)\(/)
  })

  it("KHÔNG đưa quyết định giao diện vào middleware (nó decode JWT không verify)", () => {
    const middleware = read("proxy.ts")
    expect(middleware).not.toMatch(/ui_version|ui-v2|data-ui/)
  })
})

describe("Tổng quan — widget theo quyền, nguồn dữ liệu không đổi", () => {
  it("`dashboard/page.tsx` là wrapper mỏng, import thân trang từ `_components` CỦA CHÍNH NÓ", () => {
    const page = read("app/(dashboard)/dashboard/page.tsx")
    expect(page).toContain("DashboardWidgets")
    expect(page).toContain("./_components/dashboard-widgets")
    expect(page).not.toContain("dashboard-router")
  })

  it("danh sách widget khai đúng quyền nguồn + không còn router rẽ theo vai trò", () => {
    const dir = "app/(dashboard)/dashboard/_components"
    const widgets = read(`${dir}/widgets.ts`)
    expect(widgets).toMatch(/key: 'overview', permission: 'reports\.overview'/)
    expect(widgets).toMatch(/key: 'recent-customers', permission: 'contacts\.view'/)
    expect(existsSync(join(SRC, "app/(dashboard)/dashboard/_components/dashboard-router.tsx"))).toBe(false)
  })

  it("khối Tổng quan gọi đúng endpoint (dashboard-overview + dashboard-tasks)", () => {
    const hook = read("app/(dashboard)/dashboard/_components/use-dashboard-overview.ts")
    expect(hook).toMatch(/\/reports\/dashboard-overview/)
    expect(hook).toMatch(/\/reports\/dashboard-tasks/)
  })
})
