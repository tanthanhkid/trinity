// Đo tương phản chữ/nền (WCAG 2.x) cho các cặp màu mà màn A–C dùng. Đọc thẳng token từ styles/app-tokens.css
// (khối sáng = phần trước, khối tối = `html:root[data-ui="app"].dark`), lớp màu Tailwind cố định ghi tay bên dưới.
// Chạy: node e2e/premium/contrast.mjs  — in bảng Markdown; mã thoát 1 nếu có cặp chữ < 4,5:1 (hoặc biểu tượng < 3:1).
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const css = readFileSync(fileURLToPath(new URL("../../src/styles/app-tokens.css", import.meta.url)), "utf8")
const darkStart = css.search(/html:root\[data-ui="app"\]\.dark\s*\{/)
const pick = (src) => Object.fromEntries([...src.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]))
const light = pick(css.slice(0, darkStart))
const dark = { ...light, ...pick(css.slice(darkStart)) }

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
/** Nền có độ trong (vd bg-muted/30) phủ lên nền dưới. */
const over = (top, alpha, under) => "#" + hex(top).map((c, i) => Math.round(c * alpha + hex(under)[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("")

// Lớp Tailwind cố định (bảng màu Tailwind v4 đã quy về hex sRGB).
const TW = { "amber-50": "#fffbeb", "amber-900": "#7b3306", "amber-100": "#fef3c6", "amber-950": "#461901" }

/** [tên, chữ, nền, loại] — loại "text" cần 4,5:1, "icon" (thành phần giao diện) cần 3:1. */
const pairs = (t, mode) => [
  ["Chữ chính trên thẻ", t.foreground, t.card, "text"],
  ["Chữ phụ (muted) trên thẻ", t["muted-foreground"], t.card, "text"],
  ["Chữ phụ (muted) trên nền trang", t["muted-foreground"], t.background, "text"],
  ["Chữ phụ trong ErrorState/EmptyState (nền muted/30)", t["muted-foreground"], over(t.muted, 0.3, t.card), "text"],
  ["ink-2 trên thẻ (mô tả, tóm tắt)", t["color-app-ink-2"], t.card, "text"],
  // Màu ring chỉ dùng cho biểu tượng ở màn A–C (chữ link màu ring duy nhất nằm ở home-ai-hub.tsx — file của PR #48).
  ["Biểu tượng màu ring trên thẻ", t.ring, t.card, "icon"],
  ["Link primary-ink trên thẻ", t["color-app-primary-ink"], t.card, "text"],
  ["Nút chính: chữ trên primary", t["primary-foreground"], t.primary, "text"],
  // Bản tối: `.text-destructive` được đổi sang mực đỏ của nhãn (app-tokens.css) — đo đúng màu đang hiện.
  ["Chữ lỗi text-destructive trên thẻ (đăng bài lỗi)", mode === "light" ? t.destructive : t["color-app-tag-red-ink"], t.card, "text"],
  ["StatusTag Chờ duyệt / Cần kết nối lại", t["color-app-tag-amber-ink"], t["color-app-tag-amber-bg"], "text"],
  ["StatusTag Đang chạy", t["color-app-tag-green-ink"], t["color-app-tag-green-bg"], "text"],
  ["StatusTag Lỗi", t["color-app-tag-red-ink"], t["color-app-tag-red-bg"], "text"],
  ["StatusTag Đã tắt", t["color-app-tag-slate-ink"], t["color-app-tag-slate-bg"], "text"],
  ["ReconnectNotice: chữ đậm", t.foreground, t["color-app-tag-amber-bg"], "text"],
  ["ReconnectNotice: lý do (ink-2)", t["color-app-ink-2"], t["color-app-tag-amber-bg"], "text"],
  ["Gợi ý soạn bài khi mất kênh (amber-ink trên thẻ)", t["color-app-tag-amber-ink"], t.card, "text"],
  mode === "light"
    ? ["Dải mất mạng (amber-900 / amber-50)", TW["amber-900"], TW["amber-50"], "text"]
    : ["Dải mất mạng (amber-100 / amber-950·40%)", TW["amber-100"], over(TW["amber-950"], 0.4, t.background), "text"],
  ["Biểu tượng cảnh báo ErrorState (amber-ink / muted)", t["color-app-tag-amber-ink"], t.muted, "icon"],
  ["Viền ô nhập (input) trên thẻ", t.input, t.card, "icon"],
]

let failed = 0
for (const [mode, t] of [["light", light], ["dark", dark]]) {
  console.log(`\n### Chế độ ${mode === "light" ? "sáng" : "tối"}\n\n| Cặp | Chữ | Nền | Tỉ lệ | Đạt |\n|---|---|---|---|---|`)
  for (const [name, fg, bg, kind] of pairs(t, mode)) {
    const r = ratio(fg, bg)
    const ok = r >= (kind === "text" ? 4.5 : 3)
    if (!ok) failed++
    console.log(`| ${name} | \`${fg}\` | \`${bg}\` | ${r.toFixed(2).replace(".", ",")}:1 | ${ok ? "✅" : `❌ (cần ${kind === "text" ? "4,5" : "3"})`} |`)
  }
}
process.exitCode = failed ? 1 : 0
