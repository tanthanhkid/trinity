/**
 * lớp token `[data-ui="app"]`.
 *
 * 3 nhóm bất biến:
 *  1. **Đủ token shadcn.** Bỏ sót 1 token = màn v2 lẫn 1 mảng màu v1, không
 *     lỗi nào phát ra (bug im lặng, chỉ phát hiện bằng mắt trên từng màn).
 *  2. **Specificity thắng cả `:root` LẪN `:root[data-ds="v2"]`.** `@import`
 *     bắt buộc ở đầu file nên khối v2 luôn đứng TRƯỚC 2 khối kia trong source
 *     order — bằng specificity thì ds-v2 thắng.
 *  3. **Giá trị KHỚP theme.** Không quy hex→oklch bằng mắt (`oklch(0.985 0 0)` không phải trắng, contrast tụt dưới AA mà không ai thấy).
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const css = readFileSync(join(__dirname, "../../styles/app-tokens.css"), "utf8")
/** Bỏ comment: chính comment giải thích có nhắc `oklch(...)` một cách hợp lệ. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "")
const globals = readFileSync(join(__dirname, "../../app/globals.css"), "utf8")

/** Giá trị token khai trong khối `html:root[data-ui="app"]`. */
function tokenValue(name: string): string | null {
  const block = css.slice(
    css.indexOf('html:root[data-ui="app"] {'),
    css.indexOf("\n}", css.indexOf('html:root[data-ui="app"] {')),
  )
  const m = block.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"))
  return m ? m[1].trim() : null
}

const SHADCN_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
]

describe("app-tokens.css — phủ ĐỦ token shadcn", () => {
  it.each(SHADCN_TOKENS)("khai %s", (token) => {
    expect(tokenValue(token)).not.toBeNull()
  })

  it("KHÔNG bỏ sót token nào mà `:root` của globals.css đang khai", () => {
    const rootBlock = globals.slice(globals.indexOf("\n:root {"), globals.indexOf("\n}", globals.indexOf("\n:root {")))
    const rootTokens = Array.from(rootBlock.matchAll(/^\s*(--[\w-]+):/gm))
      .map((m) => m[1])
      // Token brand/shadow của lớp ds-v2 là hệ RIÊNG của v1, v2 có
      // hệ màu khác hẳn — cố ý KHÔNG mirror.
      .filter((t) => !t.startsWith("--brand-") && !t.startsWith("--surface-green"))
      .filter((t) => t !== "--shadow-card" && t !== "--shadow-pop" && t !== "--shadow-brand-glow")
    const missing = rootTokens.filter((t) => tokenValue(t) === null)
    expect(missing).toEqual([])
  })
})

describe("app-tokens.css — specificity + phạm vi", () => {
  it("selector là `html:root[data-ui=\"v2\"]` (0,2,1) — thắng cả khối ds-v2 (0,2,0)", () => {
    expect(css).toContain('html:root[data-ui="app"] {')
    expect(globals).toContain(':root[data-ds="v2"]')
  })

  it("🔴 MỌI rule trong file đều nằm dưới `[data-ui=\"v2\"]` — inert với v1", () => {
    // CSS không lồng nhau nên mọi `{` đều đứng sau 1 danh sách selector gồm
    // ký tự không phải dấu ngoặc — bắt đúng như vậy, không bắt theo dòng.
    const selectors = Array.from(cssCode.matchAll(/([^{}]+)\{/g))
      .map((m) => m[1].trim())
      .filter(Boolean)
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim().startsWith('html:root[data-ui="app"]'), part).toBe(true)
      }
    }
  })

  it("globals.css import file này", () => {
    expect(globals).toContain('@import "../styles/app-tokens.css"')
  })
})

describe("app-tokens.css — giá trị KHỚP theme.css", () => {
  it("giữ HEX, KHÔNG tự quy sang oklch", () => {
    expect(cssCode).not.toMatch(/oklch\(/)
  })

  it.each([
    // Bảng màu demo giao diện mới (`trinity-giao-dien-demo`, Thanh duyệt 10/2026).
    ["--background", "#fbfbfa"], // demo --bg
    ["--foreground", "#17181c"], // demo --ink
    ["--card", "#ffffff"], // demo --panel
    ["--primary", "#3a75a6"], // demo --accent #3f7fb3 HẠ SÁNG cho AA với chữ trắng (4,29 → 4,91)
    ["--primary-foreground", "#ffffff"], // trắng TUYỆT ĐỐI
    ["--secondary", "#f5f5f3"], // demo --sunken
    ["--muted", "#f5f5f3"], // demo --sunken
    ["--muted-foreground", "#6b6f7b"], // demo --ink-3
    ["--accent", "#f5f5f3"], // demo: hover/đang chọn = nền --sunken
    ["--accent-foreground", "#17181c"], // demo --ink
    ["--destructive", "#c2413b"], // demo --danger
    ["--border", "#ebebe8"], // demo --line
    ["--ring", "#3f7fb3"], // demo --accent (xanh logo)
    ["--radius", "10px"], // demo --radius
    // Sidebar: nền panel trắng, mục đang mở = nền --sunken + chữ --ink (như demo).
    ["--sidebar", "#ffffff"],
    ["--sidebar-foreground", "#4a4d57"],
    ["--sidebar-primary", "#f5f5f3"],
    ["--sidebar-primary-foreground", "#17181c"],
    ["--sidebar-border", "#ebebe8"],
    ["--sidebar-ring", "#3f7fb3"],
  ])("%s = %s", (token, value) => {
    expect(tokenValue(token)).toBe(value)
  })

  it("🔴 hệ HAI VAI TRÒ: accent (điều hướng) KHÁC primary (hành động)", () => {
    // Gộp 2 vai trò về một màu thì tab/ô chọn/link đều hoá cùng màu primary.
    expect(tokenValue("--accent")).not.toBe(tokenValue("--primary"))
    expect(tokenValue("--ring")).not.toBe(tokenValue("--primary"))
  })

  it("🔴 sidebar KHÔNG còn dùng gradient — token cũ đã gỡ hẳn", () => {
    // Trước đây: `--color-app-sidebar-grad` + 3 selector `background-image`
    // (xem lịch sử `app-sidebar.css`). Nay nền PHẲNG đọc thẳng `--sidebar`
    // qua `bg-sidebar` mặc định — không còn lý do giữ token gradient riêng.
    const css = readFileSync(join(__dirname, "../../styles/app-sidebar.css"), "utf8")
    expect(tokenValue("--color-app-sidebar-grad")).toBeNull()
    expect(css).not.toMatch(/background-image/)
  })

  it.each([
    "--color-app-blue",
    "--color-app-azure",
    "--color-app-primary-soft",
    "--color-app-sea",
    "--color-app-gold",
    "--color-app-glow",
    "--color-app-zalo",
    "--color-app-green-soft",
    "--color-app-amber-soft",
    "--color-app-red-soft",
    "--color-app-violet-soft",
    "--color-app-pink-soft",
    "--color-app-sidebar-w",
    "--color-app-sidebar-mini",
    "--color-app-topbar-h",
    "--color-app-rail-w",
  ])("token riêng %s cho màu/số đo theme không có ô shadcn", (token) => {
    expect(tokenValue(token)).not.toBeNull()
  })

  it("số đo layout khớp theme (232 / 64 / 58 / 310)", () => {
    expect(tokenValue("--color-app-sidebar-w")).toBe("232px")
    expect(tokenValue("--color-app-sidebar-mini")).toBe("64px")
    expect(tokenValue("--color-app-topbar-h")).toBe("58px")
    expect(tokenValue("--color-app-rail-w")).toBe("310px")
  })
})
