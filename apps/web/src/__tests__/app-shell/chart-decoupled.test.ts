import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/* =============================================================================
 * Khoá bất biến: component biểu đồ DÙNG CHUNG không gõ tay hex bảng màu.
 * Màu phải đi qua token hoặc `chart-colors.ts` để đổi bảng màu chỉ sửa
 * một chỗ.
 *
 * ⚠️ Phạm vi có CHỦ ĐÍCH: các tab báo cáo (`reports/_components/report-*`)
 * CHƯA nằm trong danh sách kiểm màu vì sẽ được viết lại bằng bộ primitive
 * mới; tokenize bây giờ là làm rồi bỏ. Khi hoàn tất thì thêm thư mục tương
 * ứng vào `COLOR_CHECKED_DIRS` bên dưới.
 * ========================================================================== */

const DASHBOARD_ROOT = join(__dirname, "../../app/(dashboard)")

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const DASHBOARD_FILES = collect(DASHBOARD_ROOT)

/**
 * Bỏ comment để không bắt nhầm câu văn nhắc tới đường dẫn v1 một cách hợp lệ.
 *
 * 🔴 Bản trước xoá `//…` KHÔNG phân biệt chuỗi: một dòng như
 * `const HELP = "https://x"; const BAD = { color: "#123456" }` bị cắt từ
 * `//x"…` trở đi ⇒ vi phạm NẰM CÙNG DÒNG biến mất khỏi tầm quét. Nay đi từng
 * ký tự, bỏ qua nội dung chuỗi/template khi tìm dấu mở comment.
 */
export function stripComments(src: string): string {
  let out = ""
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Mọi CÁCH VIẾT một màu cứng mà vòng review đầu chỉ ra là regex cũ bỏ sót:
 * hex 3/6/8 ký tự · trong `{}` · qua ternary · gán vào biến · `stopColor` /
 * `floodColor` · màu đặt tên (`white`) · `rgb()`/`hsl()` · phần tử cuối mảng
 * không có dấu phẩy.
 *
 * Cố ý KHÔNG bắt chuỗi hex trần ở mọi nơi (id, hash, mã màu trong chú thích
 * đã bị `stripComments` cắt) — chỉ bắt khi nó ĐỨNG Ở VỊ TRÍ MỘT MÀU.
 */
const COLOR_LITERAL = new RegExp(
  [
    // gán cho thuộc tính/khoá mang nghĩa màu, kể cả trong {} và sau `?`/`:`
    String.raw`(?:color|colors|fill|stroke|stopColor|floodColor|backgroundColor|borderColor)\s*[:=]\s*\{?[^,;}\n]*?(?:#[0-9a-fA-F]{3,8}\b|\b(?:white|black|red|green|blue|orange|purple|pink|gray|grey)\b|\brgba?\(|\bhsla?\()`,
    // phần tử của một mảng màu
    String.raw`["']#[0-9a-fA-F]{3,8}["']\s*[,\]]`,
    // gán vào biến rồi mới dùng
    String.raw`(?:const|let|var)\s+\w*[Cc]olor\w*\s*=\s*["']#[0-9a-fA-F]{3,8}["']`,
  ].join("|"),
  "g",
)

describe("🔴 màu biểu đồ v2 đi qua token, không hex gõ tay", () => {
  /** Thư mục ĐÃ chuyển xong sang token (mở rộng dần theo từng đợt). */
  const COLOR_CHECKED_DIRS = [
    "reports/_components/charts",
    "attendance/_components",
    "management/employees/stats/_components",
    "management/contracts/_components",
  ]

  it.each(COLOR_CHECKED_DIRS)("%s — 0 hex màu gõ tay", (rel) => {
    const files = collect(join(DASHBOARD_ROOT, rel))
    const offenders: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"))
      const m = src.match(COLOR_LITERAL)
      if (m) offenders.push(`${f.replace(DASHBOARD_ROOT, "")}: ${m.join(" ")}`)
    }
    expect(offenders).toEqual([])
  })

  it("`chart-colors.ts` là nguồn màu duy nhất — chỉ dựng từ token, không hex", () => {
    const src = readFileSync(
      join(__dirname, "../../components/app-shell/charts/chart-colors.ts"),
      "utf8",
    )
    // Ngoại lệ DUY NHẤT: `#ffffff` làm màu CHỮ trên cột tối. Trắng thuần không
    // phải màu của bảng màu nên không có token nào mang nó (`--card` là "nền
    // thẻ", mượn sang làm màu chữ là đặt sai tên cho ý nghĩa).
    expect(stripComments(src).replace(/"#ffffff"/g, "")).not.toMatch(
      /#[0-9a-fA-F]{6}/,
    )
    expect(src).toMatch(/var\(--color-app-chart-good\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe("🔴 TEST CHÍNH CÁI TEST — bộ dò màu cứng phải bắt đủ 11 cách viết", () => {
  // Vòng review đầu chỉ ra bộ dò cũ XANH trong khi 9 chỗ màu cứng còn nguyên.
  // Xanh mà không bắt được gì thì tệ hơn không có test: nó cấp một bảo đảm giả.
  it.each([
    ['fill="#fff"', "hex 3 ký tự"],
    ['fill="#a1b2c3"', "hex 6 ký tự"],
    ['fill="#a1b2c3ff"', "hex 8 ký tự"],
    ['fill={"#a1b2c3"}', "hex trong {}"],
    ['fill={on ? "var(--x)" : "#a1b2c3"}', "hex ở nhánh ternary"],
    ['const barColor = "#a1b2c3"', "gán vào biến rồi mới dùng"],
    ['stopColor="#a1b2c3"', "stopColor của gradient"],
    ['floodColor="#a1b2c3"', "floodColor của filter"],
    ['fill="white"', "màu đặt tên"],
    ['color: "rgb(1,2,3)"', "rgb()"],
    ['const P = ["#a1b2c3"]', "phần tử cuối mảng, không dấu phẩy"],
  ])("bắt được: %s (%s)", (snippet) => {
    expect(snippet.match(new RegExp(COLOR_LITERAL.source, "g"))).not.toBeNull()
  })

  it.each([
    ['fill="var(--color-app-chart-1)"', "token"],
    ['fill={categoryColor(0)}', "qua hàm màu"],
    ['const id = "a1b2c3"', "chuỗi hex KHÔNG phải màu"],
    ['className="text-white"', "lớp Tailwind, không phải thuộc tính màu SVG"],
  ])("KHÔNG bắt nhầm: %s (%s)", (snippet) => {
    expect(snippet.match(new RegExp(COLOR_LITERAL.source, "g"))).toBeNull()
  })

  it("🔴 stripComments không bị URL đánh lừa — vi phạm CÙNG DÒNG vẫn lộ", () => {
    // Bản trước cắt từ `//` trong "https://" trở đi, nuốt luôn phần vi phạm
    // nằm sau nó trên cùng dòng.
    const src = 'const HELP = "https://x"; const BAD = { color: "#123456" }'
    expect(stripComments(src)).toContain("#123456")
    expect(stripComments(src).match(new RegExp(COLOR_LITERAL.source, "g"))).not.toBeNull()
  })

  it("stripComments vẫn cắt comment thật (kể cả comment nhắc tới màu hợp lệ)", () => {
    expect(stripComments('// đổi từ color: "#10b981" sang token\nconst a = 1')).not.toContain(
      "#10b981",
    )
    expect(stripComments('/* color: "#10b981" */ const a = 1')).not.toContain("#10b981")
  })
})

/*
 * Không có bất biến "cây v2 không đọc component biểu đồ từ cây v1": chỉ còn
 * một cây, `(dashboard)/reports/_components/charts` chính là bản đang dùng.
 */
