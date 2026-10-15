/**
 * contrast của lớp token v2 phải ĐẠT WCAG AA.
 *
 * Vì sao test này TỰ TÍNH thay vì so hex cố định (đã có `v2-tokens.test.ts` làm
 * việc đó): so hex chỉ khoá "màu đúng như hôm nay chốt", nó KHÔNG biết màu đó có
 * đọc được không. Đổi 1 token sang giá trị sáng hơn thì test hex kia chỉ cần sửa
 * kỳ vọng là xanh lại — còn test này sẽ ĐỎ, vì nó áp đúng công thức WCAG.
 *
 * Bài học ở dạng thi hành được: `oklch(0.985 0 0)` từng bị đọc là
 * "gần 1 nên coi như trắng", công bố 4,53:1 trong khi đo thật chỉ 4,34:1. Không
 * ước lượng — convert sang sRGB tuyến tính rồi tính.
 *
 * Trạng thái khi viết (sau đợt hạ sáng cho AA):
 *   nút chính 4,53 · nút nguy hiểm 4,51 · chữ mờ/nền mờ 4,50 ·
 *   sidebar mục đang mở 4,53 · gradient mục-menu-đang-mở chặng sáng nhất 4,54
 */
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { buttonVariants } from "@/components/ui/button-variants"

const TOKENS_CSS = join(__dirname, "../../styles/app-tokens.css")
const css = readFileSync(TOKENS_CSS, "utf8")

/** Chuẩn AA cho chữ thường (< 18pt / < 14pt bold). */
const AA_TEXT = 4.5
/** Chuẩn AA cho thành phần ĐỒ HOẠ (icon, viền ô nhập, ring). */
const AA_NON_TEXT = 3

// ── công thức WCAG 2.1 ──────────────────────────────────────────────────────
function channelToLinear(value255: number): number {
  const c = value255 / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "")
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  )
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Giá trị token trong khối `html:root[data-ui="app"] { … }` ĐẦU TIÊN.
 *
 * Đọc từ khối đó chứ không regex cả file: cuối file còn vài rule khác cũng
 * chứa hex (gradient sidebar, `.app-nav-active`), lấy lẫn vào là so sai cặp.
 */
function tokenHex(name: string): string {
  const start = css.indexOf('html:root[data-ui="app"]')
  const block = css.slice(start, css.indexOf("\n}", start))
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block)
  if (!match) throw new Error(`không tìm thấy token ${name} trong khối v2`)
  return match[1].toLowerCase()
}

describe("v2 contrast — chữ trên nền phải đạt AA 4,5:1", () => {
  it.each([
    ["nút chính", "--primary-foreground", "--primary"],
    ["nút nguy hiểm", "--primary-foreground", "--destructive"],
    ["nền app / chữ", "--foreground", "--background"],
    ["thẻ / chữ", "--card-foreground", "--card"],
    ["popover / chữ", "--popover-foreground", "--popover"],
    ["nền phụ / chữ", "--secondary-foreground", "--secondary"],
    ["chữ mờ trên nền mờ", "--muted-foreground", "--muted"],
    ["nhấn (điều hướng)", "--accent-foreground", "--accent"],
    // 🔴 Cặp HOVER: `text-muted-foreground` + `hover:bg-accent` dùng ở 6 chỗ
    // (combobox, employee-picker, dialog). Bị bỏ sót vì
    // nền hover KHÔNG phải nền "chính" của chữ đó nên dễ bị bỏ sót khi đo.
    ["chữ mờ trên nền nhấn (lúc hover)", "--muted-foreground", "--accent"],
    ["sidebar / chữ", "--sidebar-foreground", "--sidebar"],
    ["sidebar mục đang mở", "--sidebar-primary-foreground", "--sidebar-primary"],
    ["chip brand", "--color-app-primary-ink", "--color-app-primary-soft"],
    ["chữ brand trên trắng", "--color-app-primary-ink", "--card"],
    ["chữ phụ trên nền app", "--color-app-ink-2", "--background"],
    // 8 tông nhãn `.badge`. 5/8 cặp CHỮ của bản thiết
    // kế trượt AA (3,37–4,18) nên đã hạ sáng phần chữ, giữ nguyên nền.
    ["nhãn lam", "--color-app-tag-blue-ink", "--color-app-tag-blue-bg"],
    ["nhãn lục", "--color-app-tag-green-ink", "--color-app-tag-green-bg"],
    ["nhãn hổ phách", "--color-app-tag-amber-ink", "--color-app-tag-amber-bg"],
    ["nhãn đỏ", "--color-app-tag-red-ink", "--color-app-tag-red-bg"],
    ["nhãn tím", "--color-app-tag-violet-ink", "--color-app-tag-violet-bg"],
    ["nhãn lam ngọc", "--color-app-tag-teal-ink", "--color-app-tag-teal-bg"],
    ["nhãn xám xanh", "--color-app-tag-slate-ink", "--color-app-tag-slate-bg"],
    ["nhãn hồng", "--color-app-tag-pink-ink", "--color-app-tag-pink-bg"],
    // Trạng thái HOVER dạng ĐẶC của nút — alpha `bg-primary/80` của
    // `button-variants.ts` pha với nền phía sau nên nằm NGOÀI bảng token và
    // không kiểm được ở đây; 3 cặp dưới là bản thay thế đo được.
    ["nút mềm lúc hover", "--color-app-primary-ink", "--color-app-primary-soft-hover"],
    ["nút nguy hiểm mềm lúc hover", "--color-app-tag-red-ink", "--color-app-red-soft-hover"],
    ["nút nguy hiểm đặc", "--color-app-ava-ink", "--color-app-red-deep"],
    ["nút nguy hiểm đặc lúc hover", "--color-app-ava-ink", "--color-app-red-deep-hover"],
    // Viên "đang chọn" của cụm Kanban|Danh sách + nút "Bộ lọc" lúc mở. Cặp theme
    // khai (`--color-app-blue` trên `--color-app-blue-soft`) đo được **4,35** —
    // dưới AA và trước đây KHÔNG có trong bảng này nên không ai thấy.
    ["viên đang chọn trong cụm nút", "--color-app-blue-deep", "--color-app-blue-soft"],
  ])("%s: %s trên %s ≥ 4,5:1", (_name, fg, bg) => {
    const ratio = contrast(tokenHex(fg), tokenHex(bg))
    expect(ratio, `${fg} trên ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it("🔴 thang brand ĐƠN ĐIỆU: nền < hover < chữ (theo contrast trên trắng)", () => {
    // Thiếu bất biến này thì hover có thể SÁNG hơn trạng thái thường (đợt hạ
    // sáng cho AA rất dễ vô tình đảo thứ tự: chỉ sửa `--color-app-primary` mà
    // quên `-deep` là hover nhạt hơn nền).
    const white = "#ffffff"
    const fill = contrast(tokenHex("--color-app-primary"), white)
    const hover = contrast(tokenHex("--color-app-primary-deep"), white)
    const ink = contrast(tokenHex("--color-app-primary-ink"), white)
    expect(fill).toBeGreaterThanOrEqual(AA_TEXT)
    expect(hover).toBeGreaterThan(fill)
    expect(ink).toBeGreaterThan(hover)
  })

  it("🔴 mục-menu-ĐANG-MỞ: nền PHẲNG qua token, chữ/icon đạt AA", () => {
    // Trước đây (sidebar tối): gradient chéo 3 chặng, chữ #eafeff
    // (2/3 chặng dưới AA — đánh đổi có chủ đích theo demo). Sidebar kiểu
    // Notion mới KHÔNG còn gradient — `.app-nav-active` nay là 1 rule PHẲNG
    // đọc token `--sidebar-primary`/`--sidebar-primary-foreground`, đã đo AA
    // ở bộ `it.each` phía trên (cặp "sidebar mục đang mở"). Test này chỉ khoá
    // ĐÚNG CƠ CHẾ (đọc token, không hardcode hex, không còn gradient) — đổi
    // màu thật thì sửa token ở `app-tokens.css`, không sửa hex ở đây.
    const rule = /\.app-nav-active\s*\{([\s\S]*?)\}/.exec(css)
    expect(rule, "không tìm thấy rule .app-nav-active").not.toBeNull()
    const body = rule![1]
    expect(body).toMatch(/background-color:\s*var\(--sidebar-primary\)/)
    expect(body).toMatch(/color:\s*var\(--sidebar-primary-foreground\)/)
    expect(body).not.toMatch(/linear-gradient/)
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/)
  })

  it("🔴 ảnh đại diện chữ-cái: chữ trắng đạt AA ở CẢ HAI chặng của 6 gradient", () => {
    // Bản thiết kế dùng 6 gradient SÁNG — đo ra 1,58 · 1,70 · 1,80 · 2,23 ·
    // 2,91 với chữ trắng, tức chữ gần như mất hẳn. Chặng SÁNG NHẤT là chặng
    // phải đo; kiểm mỗi chặng đầu (hoặc trung bình) là bỏ sót đúng chỗ hỏng.
    const ink = tokenHex("--color-app-ava-ink")
    for (let i = 1; i <= 6; i++) {
      for (const end of ["a", "b"]) {
        const stop = tokenHex(`--color-app-ava-${i}-${end}`)
        const ratio = contrast(ink, stop)
        expect(ratio, `chữ ${ink} trên chặng ${stop} (dải ${i}${end}) = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(AA_TEXT)
      }
    }
  })

  it("🔴 thang nút nguy hiểm ĐƠN ĐIỆU: nền < hover (theo contrast với chữ trắng)", () => {
    // Cùng bất biến với thang brand ở trên: hover phải ĐẬM hơn nền, nếu không
    // trạng thái hover nhạt đi và tương phản tụt đúng lúc con trỏ đang ở trên nút.
    const ink = tokenHex("--color-app-ava-ink")
    const fill = contrast(ink, tokenHex("--color-app-red-deep"))
    const hover = contrast(ink, tokenHex("--color-app-red-deep-hover"))
    expect(fill).toBeGreaterThanOrEqual(AA_TEXT)
    expect(hover).toBeGreaterThan(fill)
  })

  it("🔴 cột biểu đồ trong thẻ chỉ số đạt chuẩn ĐỒ HOẠ 3:1 trên nền thẻ", () => {
    // Hình biểu đồ phải ĐỌC ĐƯỢC. Bản đầu
    // lấy thẳng token TÔNG của ô icon — tông đó được phép sáng vì có chữ trắng
    // đè lên, nhưng đặt lên thẻ TRẮNG thì amber 2,17 · coral 2,54 · sky 2,70,
    // dưới chuẩn 1.4.11. Nay ánh xạ sang bảng màu DANH
    // MỤC. Test đọc thẳng `TONE_FILL` để đổi tông là phải đo lại.
    const src = readFileSync(
      join(__dirname, "../../app/(dashboard)/dashboard/_components/dashboard-stats-shared.tsx"),
      "utf8",
    )
    const block = /const TONE_FILL[^{]*\{([\s\S]*?)\n\}/.exec(src)
    expect(block, "không tìm thấy TONE_FILL").not.toBeNull()
    const tokens = [...block![1].matchAll(/var\((--color-app-[a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(tokens.length, "TONE_FILL rỗng — regex đã vỡ").toBeGreaterThanOrEqual(7)
    const card = tokenHex("--card")
    for (const token of tokens) {
      const ratio = contrast(tokenHex(token), card)
      expect(ratio, `cột ${token} trên nền thẻ = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      )
    }
    // Cột "hôm qua" CỐ Ý nhạt (1,46) — nhận ra nhờ VIỀN, nên viền phải đạt 3:1.
    const border = contrast(tokenHex("--color-app-chart-seq-6"), card)
    expect(border, `viền cột hôm qua = ${border.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NON_TEXT)
  })

  it("🔴 sidebar: chữ mờ (--color-app-sidebar-muted) đạt AA 4,5:1 trên --sidebar VÀ --card", () => {
    // tiêu đề nhóm/dòng phụ "Tên · Vai trò"/icon ghim/chevron dùng
    // #9b9a95 trên --sidebar (#f7f7f5) chỉ 2,62:1; chữ nút "Tìm"/kbd ⌘K dùng
    // #787774 trên nền trắng (--card) chỉ 4,47:1 — CẢ HAI dưới AA. 1 token
    // DUY NHẤT (#6b6a66) phủ được cả 2 nền nên test đo cả 2, không tách 2 token.
    for (const bg of ["--sidebar", "--card"]) {
      const ratio = contrast(tokenHex("--color-app-sidebar-muted"), tokenHex(bg))
      expect(ratio, `--color-app-sidebar-muted trên ${bg} = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it("🔴 sidebar: viền nút Tìm/Thêm khách (--color-app-sidebar-edge) đạt chuẩn ĐỒ HOẠ 3:1 trên --sidebar", () => {
    // viền cũ #ebebe8 trên --sidebar (#f7f7f5) chỉ ~1,1:1 — nút tan vào nền.
    const ratio = contrast(tokenHex("--color-app-sidebar-edge"), tokenHex("--sidebar"))
    expect(ratio, `--color-app-sidebar-edge trên --sidebar = ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(AA_NON_TEXT)
  })

  it("🔴 viền Ô NHẬP (--input) đạt 3:1 trên CẢ nền app lẫn nền thẻ", () => {
    // --input từng = --line (#e9eef6) → 1,10:1 trên nền app, 1,17:1 trên
    // trắng — ô lọc tan vào nền. Ô nhập nằm được ở cả 2 nền nên đo cả 2.
    for (const surface of ["--background", "--card"]) {
      const ratio = contrast(tokenHex("--input"), tokenHex(surface))
      expect(ratio, `--input trên ${surface} = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })

  it("viền / ring đạt chuẩn ĐỒ HOẠ 3:1 trên nền app", () => {
    const bg = tokenHex("--background")
    for (const token of ["--ring", "--color-app-primary"]) {
      const ratio = contrast(tokenHex(token), bg)
      expect(ratio, `${token} trên nền app = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(AA_NON_TEXT)
    }
  })
})

/**
 * 8 token CHỈ ĐƯỢC dùng làm nền/viền. Đo trên nền `-soft`/trắng tương ứng
 * chúng chỉ 1,90–4,12:1, nên dùng làm CHỮ là chắc chắn dưới AA.
 *
 * Hiện KHÔNG chỗ nào dùng sai (đã grep: `amber`/`red` chỉ xuất hiện dạng `bg-`,
 * 6 token còn lại chưa được dùng ở đâu). Đây là rào chặn TRƯỚC — cần chữ cùng
 * tông thì thêm bậc `-ink` mới rồi ĐO, đúng cách `--color-app-primary-ink` làm.
 */
const FILL_ONLY_TOKENS = [
  "green",
  "amber",
  "red",
  "violet",
  "pink",
  "faint",
  "gold",
  "sky",
  // 16 token biểu đồ. Chúng là màu TÔ của thanh/cung tròn; nhãn chữ
  // của biểu đồ đi qua `--color-app-ink-2`/`--color-app-navy`. Trước đây
  // `app-tokens.css` KHẲNG ĐỊNH chúng nằm trong danh sách này nhưng thực tế
  // không — trước đây là "lời hứa rỗng"; nay khai đúng.
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-seq-1",
  "chart-seq-2",
  "chart-seq-3",
  "chart-seq-4",
  "chart-seq-5",
  "chart-seq-6",
  "chart-seq-7",
  "chart-good",
  "chart-warn",
  "chart-bad",
  // 8 nền nhãn `.badge` + 12 chặng gradient ảnh đại diện. Chúng là
  // màu NỀN; cần chữ cùng tông thì dùng bậc `-ink` tương ứng (đã đo ở trên).
  "tag-blue-bg",
  "tag-green-bg",
  "tag-amber-bg",
  "tag-red-bg",
  "tag-violet-bg",
  "tag-teal-bg",
  "tag-slate-bg",
  "tag-pink-bg",
  "ava-1-a",
  "ava-1-b",
  "ava-2-a",
  "ava-2-b",
  "ava-3-a",
  "ava-3-b",
  "ava-4-a",
  "ava-4-b",
  "ava-5-a",
  "ava-5-b",
  "ava-6-a",
  "ava-6-b",
  "primary-soft-hover",
  "red-soft-hover",
  "red-deep",
  "red-deep-hover",
] as const

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSourceFiles(full, out)
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("v2 contrast — token chỉ-làm-nền không được dùng làm CHỮ", () => {
  // 🔴 KHÔNG viết chuỗi class Tailwind ở dạng HOÀN CHỈNH vào file này — kể cả
  // trong tiêu đề test hay trong comment. **Content scanner của Tailwind quét
  // văn bản THÔ của cả file test và không phân biệt comment**: nó thấy một
  // class arbitrary-value hợp lệ thì sinh rule thật vào `globals.css`. Nếu chuỗi
  // đó chứa placeholder của `it.each` (dấu phần trăm + s) thì CSS sinh ra có ký
  // tự đó nguyên văn và PostCSS vỡ:
  //   ./apps/web/src/app/globals.css:4172:27 → ELIFECYCLE exit code 1
  // Nguy hiểm ở chỗ **test vẫn XANH** (vitest không dựng CSS) — chỉ `pnpm build`
  // chết. Tôi đã mắc đúng lỗi này ở bản đầu; đừng "làm tiêu đề rõ hơn" bằng cách
  // đưa nguyên dạng class vào lại. Mẫu cần dò được ghép runtime ở `needle` bên
  // dưới nên không tạo ra candidate nào cho scanner.
  it.each(FILL_ONLY_TOKENS)("token %s không được dùng làm màu CHỮ", (name) => {
    const needle = new RegExp(
      `\\b(?:text|placeholder|caret|decoration)-\\[var\\(--color-app-${name}\\)\\]`,
    )
    const offenders = collectSourceFiles(join(__dirname, "../.."))
      .filter((file) => needle.test(readFileSync(file, "utf8")))
      .map((file) => file.split("/src/")[1])
    expect(
      offenders,
      `--color-app-${name} là token NỀN (contrast làm chữ dưới AA). Cần chữ cùng tông thì thêm bậc \`-ink\` rồi đo.`,
    ).toEqual([])
  })
})

describe('nút variant="outline" dùng cặp viền/nền đạt AA', () => {
  // `border-border` (--border, #e9eef6) + `bg-background` (--background,
  // #f4f9fc) chỉ 1,10:1 trên nền trang / 1,17:1 trên thẻ trắng — nút "outline"
  // + chip/toggle cùng kiểu tan vào nền. Đổi sang `border-input` (--input,
  // #7d8ba0 — cùng token đã hạ sáng, ĐÃ khoá 3,26:1/3,46:1 ở test
  // "viền Ô NHẬP" phía trên) + `bg-card` (--card, #ffffff) — test ở đây CHỈ
  // khoá snapshot class, KHÔNG tính lại WCAG (--input đã có test riêng).
  it("snapshot class: variant outline có border-input + bg-card, KHÔNG còn border-border/bg-background trần", () => {
    const cls = buttonVariants({ variant: "outline" })
    expect(cls).toContain("border-input")
    expect(cls).toContain("bg-card")
    expect(cls).not.toMatch(/\bborder-border\b/)
    expect(cls).not.toMatch(/\bbg-background\b/)
  })
})
