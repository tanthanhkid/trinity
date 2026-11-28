/**
 * Token «Ánh xanh» (`--ax-*`, khai ở `app/globals.css`):
 *  1. mọi `var(--ax-…)` dùng trong source đều được KHAI (ngoài comment) — token thiếu = nền
 *     trong suốt/chữ mặc định mà không lỗi nào phát ra;
 *  2. giá trị gốc khớp bảng hệ thiết kế (màu chính, gradient nút chính + khối nhấn, màu giai đoạn);
 *  3. tương phản chữ ≥ 4,5:1 đo theo công thức WCAG — kể cả điểm SÁNG nhất của khối nhấn
 *     (quầng sáng góc phải trên) và cả bản tối;
 *  4. token CŨ của `app-tokens.css` đã map về cùng giá trị token mới.
 */
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../../..")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const globals = strip(readFileSync(join(SRC, "app/globals.css"), "utf8"))
const appTokens = readFileSync(join(SRC, "styles/app-tokens.css"), "utf8")

/** Khối `:root { … }` chứa token «Ánh xanh» (bản sáng) và khối `.dark` ngay sau nó. */
const anchor = globals.indexOf("--ax-bg: #fbfbfa;")
function block(selector: ":root" | ".dark"): string {
  expect(anchor, "không thấy token «Ánh xanh» trong globals.css").toBeGreaterThan(-1)
  const start = selector === ":root" ? globals.lastIndexOf(":root {", anchor) : globals.indexOf(".dark {", anchor)
  expect(start, `không thấy khối ${selector} của «Ánh xanh»`).toBeGreaterThan(-1)
  return globals.slice(start, globals.indexOf("\n}", start))
}
const light = block(":root")
const dark = block(".dark")

function decl(src: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(src)
  return m ? m[1].trim() : null
}
const ax = (name: string) => {
  const v = decl(light, name)
  if (v === null) throw new Error(`thiếu token ${name}`)
  return v
}
const axDark = (name: string) => decl(dark, name) ?? ax(name)

// ── WCAG ────────────────────────────────────────────────────────────────────
type Rgb = [number, number, number]
const hex = (h: string): Rgb => {
  const x = h.replace("#", "")
  return [0, 2, 4].map((i) => Number.parseInt(x.slice(i, i + 2), 16)) as Rgb
}
const lin = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const mix = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  top.map((t, i) => alpha * t + (1 - alpha) * bottom[i]) as Rgb
const WHITE: Rgb = [255, 255, 255]

describe("«Ánh xanh» — token được khai đủ", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === "__tests__" || name === "node_modules") continue
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(tsx?|css)$/.test(name)) out.push(p)
    }
    return out
  }

  it("mọi var(--ax-…) dùng trong src đều có khai báo ngoài comment", () => {
    const used = new Set<string>()
    for (const file of walk(SRC)) {
      for (const m of strip(readFileSync(file, "utf8")).matchAll(/var\((--ax-[\w-]+)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(20)
    // `var(--ax-stage-${tone}-…)` dựng bằng template ⇒ tên kết thúc bằng `-`, kiểm riêng bằng 5 tông.
    const missing = [...used].filter((t) => !t.endsWith("-") && decl(light, t) === null)
    expect(missing).toEqual([])
  })

  it("utility Tailwind `bg-ax-*`/`shadow-ax-*`/`rounded-ax-*` trỏ về token có thật", () => {
    for (const m of globals.matchAll(/--(?:color|shadow|radius)-ax-[\w-]+:\s*var\((--ax-[\w-]+)\)/g)) {
      expect(decl(light, m[1]), m[1]).not.toBeNull()
    }
  })

  it("body dùng Inter với cv11/ss01/ss03 + số tabular", () => {
    expect(ax("--ax-font-features")).toBe('"cv11", "ss01", "ss03"')
    expect(globals).toContain("font-feature-settings: var(--ax-font-features);")
    expect(globals).toContain("font-variant-numeric: tabular-nums;")
  })
})

describe("«Ánh xanh» — giá trị khớp bảng hệ thiết kế", () => {
  it.each([
    ["--ax-bg", "#fbfbfa"],
    ["--ax-ink", "#17181c"],
    ["--ax-ink-2", "#4a4d57"],
    ["--ax-ink-3", "#6b6f7b"],
    ["--ax-line", "#ebebe8"],
    ["--ax-field-border", "#8a8d96"],
    ["--ax-primary", "#3a75a6"],
    ["--ax-primary-hover", "#2f6491"],
    ["--ax-primary-press", "#285680"],
    ["--ax-primary-soft", "#eef4fa"],
    ["--ax-danger", "#c2413b"],
    ["--ax-warn", "#a15c07"],
    ["--ax-success", "#2f7a4f"],
    ["--ax-radius-field", "8px"],
    ["--ax-radius-card", "12px"],
    ["--ax-radius-sheet", "16px"],
    ["--ax-radius-chip", "999px"],
  ])("%s = %s", (name, value) => {
    expect(ax(name)).toBe(value)
  })

  it("nút chính: gradient dọc #3A75A6 → #326A97 → #2C5F8B", () => {
    expect(ax("--ax-grad-primary")).toBe("linear-gradient(180deg, #3a75a6 0%, #326a97 55%, #2c5f8b 100%)")
  })

  it("khối nhấn: nền 140° 3 chặng + quầng + 2 vòng cung 120/190px", () => {
    const g = ax("--ax-grad-hero")
    expect(g).toContain("linear-gradient(140deg, #33699a 0%, #28567f 42%, #1a3c5d 100%)")
    expect(g).toContain("radial-gradient(340px 230px at 100% 0%, rgba(125, 180, 228, 0.2), transparent 70%)")
    expect(g).toContain("rgba(255, 255, 255, 0.09) 120px 121px")
    expect(g).toContain("rgba(255, 255, 255, 0.06) 190px 191px")
  })

  it("5 tông giai đoạn: chấm · nền · chữ", () => {
    const stages: Record<string, [string, string, string]> = {
      new: ["#3a75a6", "#eef4fa", "#285680"],
      consult: ["#b7791f", "#fbf3e4", "#7a4f0e"],
      quote: ["#7c5cbf", "#f3effa", "#553c8f"],
      won: ["#2f7a4f", "#eaf6ef", "#1f5a39"],
      care: ["#5b6170", "#f1f2f4", "#3e4350"],
    }
    for (const [k, [dot, bg, ink]] of Object.entries(stages)) {
      expect([ax(`--ax-stage-${k}-dot`), ax(`--ax-stage-${k}-bg`), ax(`--ax-stage-${k}-ink`)]).toEqual([dot, bg, ink])
    }
  })
})

describe("«Ánh xanh» — tương phản chữ ≥ 4,5:1", () => {
  const surface = hex(ax("--ax-surface"))
  const pairs: [string, string, string][] = [
    ["chữ chính / bề mặt", "--ax-ink", "--ax-surface"],
    ["chữ phụ / nền phụ", "--ax-ink-2", "--ax-sunken"],
    ["chữ nhạt / bề mặt", "--ax-ink-3", "--ax-surface"],
    ["chữ nhạt / nền phụ", "--ax-ink-3", "--ax-sunken"],
    ["chữ nhạt / hover hàng", "--ax-ink-3", "--ax-hover"],
    ["chữ gợi ý ô nhập / bề mặt", "--ax-placeholder", "--ax-surface"],
    ["chữ lỗi / bề mặt", "--ax-danger", "--ax-surface"],
    ["chữ nút nguy hiểm lúc hover", "--ax-danger-ink", "--ax-danger-soft"],
    ["chữ nút nguy hiểm lúc nhấn", "--ax-danger-ink", "--ax-danger-press"],
    ["chữ cảnh báo / nền cảnh báo", "--ax-warn", "--ax-warn-soft"],
    ["chữ thành công / nền thành công", "--ax-success", "--ax-success-soft"],
    ["xanh đậm / xanh nhạt (hàng chọn)", "--ax-primary-ink", "--ax-primary-soft"],
    ["avatar khách", "--ax-avatar-customer-ink", "--ax-primary-soft-2"],
    ["chữ phụ / nền trống", "--ax-ink-2", "--ax-primary-soft"],
    ["nút trên khối nhấn", "--ax-on-hero-primary-ink", "--ax-on-hero-primary-bg"],
    ["nút trên khối nhấn (hover)", "--ax-on-hero-primary-ink", "--ax-on-hero-primary-hover"],
    ...(["new", "consult", "quote", "won", "care"].map((k) => [`giai đoạn ${k}`, `--ax-stage-${k}-ink`, `--ax-stage-${k}-bg`]) as [string, string, string][]),
  ]

  it.each(pairs)("%s (bản sáng)", (_, fg, bg) => {
    expect(ratio(hex(ax(fg)), hex(ax(bg)))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(pairs.filter(([, fg, bg]) => !fg.includes("on-hero") && !bg.includes("on-hero")))("%s (bản tối)", (_, fg, bg) => {
    expect(ratio(hex(axDark(fg)), hex(axDark(bg)))).toBeGreaterThanOrEqual(4.5)
  })

  it("chữ trắng trên chặng sáng nhất của nút chính (#3A75A6)", () => {
    expect(ratio(WHITE, hex(ax("--ax-primary")))).toBeGreaterThanOrEqual(4.5)
  })

  it("khối nhấn: chữ trắng + chữ phụ trắng-alpha trên điểm SÁNG nhất (chặng #33699A + quầng 20%)", () => {
    const brightest = mix([125, 180, 228], 0.2, hex(ax("--ax-hero-1")))
    expect(ratio(WHITE, brightest)).toBeGreaterThanOrEqual(4.5)
    const alpha = Number(/rgba\(255, 255, 255, ([\d.]+)\)/.exec(ax("--ax-on-hero-ink-2"))![1])
    expect(ratio(mix(WHITE, alpha, brightest), brightest)).toBeGreaterThanOrEqual(4.5)
  })

  it("toast: chữ trắng + nút Hoàn tác trên chặng sáng của nền tối (#26282E)", () => {
    const toastTop = hex("#26282e")
    expect(ratio(WHITE, toastTop)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(hex(ax("--ax-toast-action")), toastTop)).toBeGreaterThanOrEqual(4.5)
  })

  it("viền ô nhập ≥ 3:1 (thành phần đồ hoạ)", () => {
    expect(ratio(hex(ax("--ax-field-border")), surface)).toBeGreaterThanOrEqual(3)
  })
})

describe("«Ánh xanh» — token cũ map sang giá trị mới (màn chưa chuyển vẫn đồng bộ)", () => {
  const v2 = appTokens.slice(appTokens.indexOf('html:root[data-ui="app"] {'), appTokens.indexOf("\n}", appTokens.indexOf('html:root[data-ui="app"] {')))
  it.each([
    ["--color-app-primary", "--ax-primary"],
    ["--color-app-primary-deep", "--ax-primary-hover"],
    ["--color-app-primary-ink", "--ax-primary-ink"],
    ["--color-app-primary-soft", "--ax-primary-soft"],
    ["--color-app-primary-soft-hover", "--ax-primary-soft-2"],
    ["--shadow-card", "--ax-shadow-card"],
    ["--shadow-pop", "--ax-shadow-float"],
  ])("%s = %s", (oldName, newName) => {
    expect(decl(v2, oldName)?.replace(/\s*\/\*.*$/, "")).toBe(ax(newName))
  })

  it("nền khung dashboard dùng quầng xanh nhạt (desktop + điện thoại)", () => {
    expect(globals).toMatch(/html\[data-ui="app"\] \[data-slot="sidebar-inset"\] \{\s*background: var\(--ax-grad-page-mobile\)/)
    expect(globals).toMatch(/@media \(min-width: 1024px\) \{\s*html\[data-ui="app"\] \[data-slot="sidebar-inset"\] \{\s*background: var\(--ax-grad-page\)/)
  })
})
