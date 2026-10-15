/**
 * Đo contrast THẬT (công thức WCAG, không ước lượng)
 * cho các cặp nền/chữ MỚI mà `ShellStatCard` (`components/app-shell/stat-card.tsx`)
 * dùng cho 5 tông green/amber/red/violet/pink. 2 tông primary/blue dùng lại
 * NGUYÊN cặp đã đo & khoá sẵn trong `contrast.test.ts` ("chip brand" +
 * "nhấn (điều hướng)") nên KHÔNG lặp lại ở đây.
 *
 * 🔴 File này CHỦ Ý không viết bất kỳ chuỗi class Tailwind hoàn chỉnh nào
 * (kể cả trong comment/tiêu đề `it()`) — Tailwind v4 content-scanner quét
 * TOÀN VĂN mọi file `.ts`/`.tsx` kể cả test. Một chuỗi tiện-ích-màu kèm ngoặc
 * vuông arbitrary-value mà bên trong có placeholder của `it.each` từng sinh
 * nhầm 1 rule CSS thật rồi vỡ `pnpm build` ở ký tự phần trăm.
 *
 * ⚠️ Và **đừng đánh vần lại chuỗi đó để minh hoạ**: comment cũng bị scanner
 * đọc, nên chính câu giải thích sẽ tái tạo lỗi.
 * Test dưới đây chỉ thao tác trên chuỗi HEX thuần, không đụng cú pháp lớp
 * Tailwind ở bất kỳ đâu trong file.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const AA_TEXT = 4.5

function channelToLinear(value255: number): number {
  const c = value255 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "")
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

const TOKENS_CSS = join(__dirname, "../../styles/app-tokens.css")
const css = readFileSync(TOKENS_CSS, "utf8")

/** Đọc giá trị token trong khối `html:root[data-ui="app"] { … }` ĐẦU TIÊN. */
function tokenHex(name: string): string {
  const start = css.indexOf('html:root[data-ui="app"]')
  const block = css.slice(start, css.indexOf("\n}", start))
  const re = new RegExp(name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + ":\\s*(#[0-9a-fA-F]{6})\\s*;")
  const match = re.exec(block)
  if (!match) throw new Error(`không tìm thấy token ${name} trong khối v2`)
  return match[1].toLowerCase()
}

// Icon của ShellStatCard cho 5 tông này dùng --foreground (navy) trên nền -soft
// của chính tông đó — xem docblock trong stat-card.tsx.
const NEW_TONE_BACKGROUNDS = ["green", "amber", "red", "violet", "pink"] as const

describe("ShellStatCard — 5 cặp màu MỚI (navy trên nền -soft từng tông)", () => {
  it.each(NEW_TONE_BACKGROUNDS)("nền -soft của tông %s + chữ --foreground ≥ 4,5:1", (tone) => {
    const bg = tokenHex(`--color-app-${tone}-soft`)
    const fg = tokenHex("--foreground")
    const ratio = contrast(fg, bg)
    expect(ratio, `--foreground trên --color-app-${tone}-soft = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_TEXT,
    )
  })
})

describe("ShellStatCard — 2 tông tái dùng cặp ĐÃ khoá (không phải cặp mới)", () => {
  it("primary: --color-app-primary-ink trên --color-app-primary-soft ≥ 4,5:1", () => {
    const ratio = contrast(tokenHex("--color-app-primary-ink"), tokenHex("--color-app-primary-soft"))
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it("blue: --accent-foreground trên --accent ≥ 4,5:1", () => {
    const ratio = contrast(tokenHex("--accent-foreground"), tokenHex("--accent"))
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT)
  })
})
