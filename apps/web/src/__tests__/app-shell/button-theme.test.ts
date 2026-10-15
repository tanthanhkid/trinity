/**
 * nút của giao diện v2 phải giống `.btn` của theme, và hover
 * KHÔNG được dùng ALPHA.
 *
 * Bối cảnh: một số nút v2 hover vào bị hỏng. Nguyên
 * nhân ở `components/ui/button-variants.ts` (file DÙNG CHUNG với v1, không sửa
 * được): hover đặt bằng alpha `bg-primary/80` → pha với nền phía sau nên nền
 * SÁNG LÊN lúc hover, chữ trắng tụt từ 4,53:1 xuống ~3,3:1. Alpha nằm NGOÀI
 * bảng token nên `contrast.test.ts` (so theo CẶP token) không thể bắt.
 *
 * File này khoá 3 thứ:
 *   1. Lớp CSS ghi đè trong phạm vi `[data-ui="app"]` còn nguyên (mất là các
 *      nút cũ quay về hover alpha, im lặng).
 *   2. `Button` dùng chung còn phát `data-variant` — nếu không, TOÀN BỘ lớp CSS
 *      trên thành INERT mà không lỗi nào phát ra (lỗi im lặng).
 *   3. Tập chỗ gọi `<Button>` trong v2 KHÔNG phát sinh mẫu màu nền MỚI nằm
 *      ngoài 3 dấu hiệu mà chuỗi `:not()` của CSS đang loại trừ — nếu có, hover
 *      của nút đó sẽ bị ghi đè sai màu (vd nút "Xoá" hover ra teal).
 */
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8")

/**
 * 🔴 Bắt buộc gỡ comment trước khi soi nội dung: docblock của `button.tsx`
 * NHẮC TÊN `bg-primary/80` một cách hợp lệ (để giải thích vì sao không dùng
 * alpha), soi chuỗi thô sẽ báo đỏ oan. Đã dính đúng lỗi này ở 2 test khác.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("nút v2 — lớp CSS ghi đè hover phải còn nguyên", () => {
  const css = read("styles/app-tokens.css")

  // CHỈ 2 biến thể này cần ghi đè. `secondary` cũng hover bằng alpha và có **66
  // chỗ gọi** trong cây v2 — nhưng ĐO ra nó vô hại: chữ SẪM `#101b46` trên nền
  // rất nhạt `#f4f8fd`, hover pha 80% chỉ đổi nền thành `#f6f9fd` ⇒ 15,54 →
  // 15,69. Alpha chỉ nguy hiểm khi nền SÁNG LÊN dưới chữ TRẮNG (ca `default`:
  // 4,53 → nền trong suốt/nhạt). `outline`/`ghost` CỐ Ý không có rule — xem
  // test "KHÔNG có rule nào ghi color/border-color" bên dưới.
  it.each(["default", "destructive"])(
    'có rule hover trong phạm vi v2 cho biến thể "%s"',
    (variant) => {
      expect(css).toContain(`[data-slot="button"][data-variant="${variant}"]`)
    },
  )

  it("rule nhắm biến thể `default` loại trừ ĐỦ 4 dấu hiệu màu do chỗ gọi tự đặt", () => {
    // Thiếu 1 dấu hiệu là đè lên ý định của chỗ gọi: nút "Xoá" (`bg-red-600`)
    // sẽ hover ra màu teal của nút chính.
    const rule = css.slice(
      css.indexOf('[data-slot="button"][data-variant="default"]'),
      css.indexOf('[data-slot="button"][data-variant="outline"]'),
    )
    for (const needle of ['bg-[', '-500', '-600', "destructive"]) {
      expect(rule, `rule default thiếu loại trừ ${needle}`).toContain(needle)
    }
  })

  it("🔴 KHÔNG có rule nào của v2 ghi `color`/`border-color` cho outline/ghost", () => {
    // Rule cũ làm đúng việc đó và **đảo ý nghĩa 57 nút** tự đặt màu chữ ngữ
    // nghĩa (nút "Thất bại"/"Xoá" hover ra XANH LAM) — nó nằm ngoài `@layer` nên
    // thắng mọi utility bất kể specificity, và KHÔNG loại trừ được bằng
    // `:not([class*="text-"])` vì chính chuỗi class của biến thể `outline` đã
    // chứa `hover:text-foreground`. 2 biến thể này vốn đã hover bằng màu ĐẶC
    // (`hover:bg-muted`) nên cũng chẳng có gì để sửa.
    for (const variant of ["outline", "ghost"]) {
      expect(
        css.includes(`[data-slot="button"][data-variant="${variant}"]`),
        `rule hover cho biến thể ${variant} đã quay lại — xem lý do trong app-tokens.css`,
      ).toBe(false)
    }
  })

  it("không dùng ALPHA trong màu nền/chữ của nút v2 (`ShellButton`)", () => {
    const btn = stripComments(read("components/app-shell/button.tsx"))
    // `bg-primary/80`-style: token + dấu gạch chéo + số. Alpha là nguồn hụt
    // tương phản sống ngoài bảng token — cả file này phải sạch.
    expect(btn).not.toMatch(/\b(?:bg|text|border)-[a-z-]+\/\d{1,3}\b/)
  })
})

describe("🔴 `Button` dùng chung phải còn phát `data-variant` (chống INERT)", () => {
  it("emit data-variant + data-size", () => {
    const btn = read("components/ui/button.tsx")
    expect(btn).toMatch(/data-variant=\{variant\}/)
    expect(btn).toMatch(/data-size=\{size\}/)
  })

  it("🔴 `button-variants.ts` VẪN đặt hover bằng alpha — lớp CSS trên còn cần thiết", () => {
    // Nếu test này ĐỎ: ai đó đã sửa biến thể dùng chung sang hover ĐẶC. Đó là
    // tin tốt — nhưng phải đọc lại lớp CSS ghi đè trong `app-tokens.css` xem còn
    // đúng nữa không, rồi cập nhật cả 2 nơi cùng lúc. KHÔNG xoá test này mà
    // không kiểm: đây là sợi dây duy nhất nối 2 file với nhau.
    const variants = read("components/ui/button-variants.ts")
    expect(variants).toContain("hover:bg-primary/80")
    expect(variants).toContain("hover:bg-secondary/80")
    expect(variants).toContain("hover:bg-destructive/20")
  })
})

/** Mọi file `.tsx` dưới `dir`. */
function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectTsx(full, out)
    else if (full.endsWith(".tsx")) out.push(full)
  }
  return out
}

describe("🔴 quét chỗ gọi `<Button>` trong v2 — không phát sinh mẫu màu nền MỚI", () => {
  it("mọi nút tự đặt nền đều khớp 1 trong 3 dấu hiệu CSS đang loại trừ", () => {
    const files = [
      ...collectTsx(join(SRC, "app/(dashboard)")),
      ...collectTsx(join(SRC, "components/app-shell")),
    ]
    const offenders: string[] = []
    let scanned = 0
    let withOwnBg = 0
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      // 🔴 `[^>]*?` dừng ở dấu `>` ĐẦU TIÊN — kể cả dấu `>` của `=>` trong
      // `onClick={() => …}`. Đo thật: **479/832** tag bị cắt trước khi tới
      // `className` ⇒ guard mù với mọi nút có handler đứng trước class (vòng
      // mutation cũ chỉ xanh vì probe không có arrow fn).
      // `(?:=>|[^>])` cho phép nuốt trọn `=>`. Dùng `[\s\S]` thay cờ `/s`:
      // `apps/web/tsconfig.json` để `target: ES2017`, cờ `/s` ném TS1501.
      for (const m of src.matchAll(/<Button\b(?:=>|[^>])*?>/g)) {
        scanned += 1
        const tag = m[0]
        const classes = [...tag.matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(" ")
        // Nền do CHỖ GỌI đặt: bỏ qua `hover:bg-*` (đó là chủ đích của chỗ gọi)
        // và bỏ qua tên semantic của chính biến thể (`bg-primary`,
        // `bg-background`, `bg-secondary`…) vì chúng đến từ `buttonVariants`.
        const own = [...classes.matchAll(/(?<!hover:)\bbg-(\[[^\]]*\]|[a-z]+-\d{2,3})/g)].map(
          (x) => x[1],
        )
        if (own.length === 0) continue
        withOwnBg += 1
        const excluded = own.every(
          (c) => c.startsWith("[") || c.includes("-500") || c.includes("-600") || c.includes("destructive"),
        )
        if (!excluded) {
          offenders.push(`${file.split("/src/")[1]} → ${own.join(", ")}`)
        }
      }
    }
    // Chốt quy mô quét: nếu regex vỡ (đổi cách viết JSX, prettier bẻ dòng khác)
    // thì vòng lặp chạy 0 lần và test XANH mà chẳng kiểm gì — đúng lớp "guard
    // chỉ in ra chứ không chặn". Số đo lúc viết: hàng trăm chỗ gọi.
    // Ngưỡng hạ theo số chỗ gọi <Button> hiện có, vẫn giữ đủ margin để bắt regex vỡ (0 hoặc vài chục là chắc chắn hỏng).
    expect(scanned, "regex quét `<Button>` không còn khớp gì — guard đã INERT")
      .toBeGreaterThan(400)
    // chuẩn "một hành động chính" CẤM chỗ gọi tự đặt nền
    // nút — số nút tự đặt nền giảm về ~0 là ĐÚNG ý, nên bỏ ngưỡng
    // `withOwnBg > 50`; độ phủ của vòng quét vẫn khoá bằng `scanned` ở trên.
    void withOwnBg
    expect(
      offenders,
      "Nút đặt nền theo mẫu MỚI: thêm dấu hiệu đó vào chuỗi `:not()` của rule " +
        '`[data-variant="default"]` trong `styles/app-tokens.css`, hoặc đổi chỗ gọi sang `ShellButton`.',
    ).toEqual([])
  })
})
