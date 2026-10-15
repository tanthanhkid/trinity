/**
 * token v2 phải THẬT SỰ tới được trình duyệt.
 *
 * 🔴 Vì sao cần test này bên cạnh `contrast.test.ts`: file đó đọc token bằng
 * regex trên VĂN BẢN THÔ của `app-tokens.css`, nên nó vẫn "thấy" một token đang
 * nằm TRONG COMMENT và công bố contrast của một màu mà trình duyệt chưa từng
 * nhận. Lớp lỗi này từng xảy ra:
 *
 *   khối comment "🔴 HẠ SÁNG 5 token" THIẾU dấu đóng, dấu `*​/`
 *   gần nhất lại là dấu đóng của comment cuối dòng `--color-app-bg` bên dưới ⇒
 *   `--color-app-primary-deep`, `--color-app-primary-soft`,
 *   `--color-app-primary-ink`, `--color-app-bg` bị nuốt trọn. Đo trên CSS ĐÃ
 *   BUILD: cả 4 KHÔNG có trong `.next/static/chunks/*.css`.
 *
 *   Hậu quả: ~100 chỗ gọi `hover:bg-[var(--color-app-primary-deep)]` cho ra
 *   `background-color` KHÔNG HỢP LỆ ⇒ nền nút TRONG SUỐT lúc hover (đo thật
 *   trên Chrome: `rgb(9,133,119)` → `rgba(0,0,0,0)`, tương phản chữ trắng về
 *   **1:1**). Nút hover vào bị hỏng.
 *
 * Cách kiểm: GỠ COMMENT TRƯỚC, rồi đối chiếu 2 chiều —
 *   (1) mọi `var(--color-app-*)` được dùng trong source phải ĐƯỢC KHAI BÁO;
 *   (2) khai báo phải nằm NGOÀI comment (hệ quả trực tiếp của (1) sau khi gỡ).
 */
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(__dirname, "../..")
const TOKENS = join(SRC, "styles/app-tokens.css")

/** Gỡ comment CSS — đây là điểm khác biệt cốt lõi so với `contrast.test.ts`. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

/**
 * Gỡ comment của TS/TSX trước khi quét chỗ dùng token.
 * Docblock hay viết tên token dạng mẫu (`var(--color-app-chart-N)`) — soi chuỗi
 * thô sẽ báo thiếu một token không ai dùng thật.
 */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/**
 * Vị trí các comment KHÔNG ĐÓNG. Đếm thô `/*` so với dấu đóng là SAI: prose
 * trong comment hoàn toàn có thể chứa `/` + `*` (mô tả pattern, đường dẫn
 * glob), và CSS KHÔNG có comment lồng nhau — nên phải quét theo trạng thái.
 */
function unclosedComments(css: string): number[] {
  const out: number[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf("/*", i)
    if (open === -1) break
    const close = css.indexOf("*/", open + 2)
    if (close === -1) {
      out.push(css.slice(0, open).split("\n").length)
      break
    }
    i = close + 2
  }
  return out
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSources(full, out)
    else if (/\.(tsx?|css)$/.test(full)) out.push(full)
  }
  return out
}

const declared = new Set(
  [...stripCssComments(readFileSync(TOKENS, "utf8")).matchAll(/(--color-app-[a-z0-9-]+)\s*:/g)].map(
    (m) => m[1],
  ),
)

describe("token v2 — khai báo phải NGOÀI comment (tới được trình duyệt)", () => {
  it("4 token từng bị comment nuốt nay đã được khai báo thật", () => {
    // Đây là 4 token của ca đã ship. Giữ danh sách tường minh để nếu ai đó
    // mở lại comment thì đỏ NGAY, với thông báo chỉ đúng chỗ.
    for (const t of [
      "--color-app-primary-deep",
      "--color-app-primary-soft",
      "--color-app-primary-ink",
      "--color-app-bg",
    ]) {
      expect(declared.has(t), `${t} không được khai báo NGOÀI comment`).toBe(true)
    }
  })

  it("🔴 mọi `var(--color-app-*)` dùng trong source đều có khai báo", () => {
    const used = new Map<string, string[]>()
    for (const file of collectSources(SRC)) {
      const raw = readFileSync(file, "utf8")
      const body = file.endsWith(".css") ? stripCssComments(raw) : stripTsComments(raw)
      for (const m of body.matchAll(/var\((--color-app-[a-z0-9-]+)/g)) {
        const rel = file.split("/src/")[1] ?? file
        const list = used.get(m[1]) ?? []
        if (!list.includes(rel)) list.push(rel)
        used.set(m[1], list)
      }
    }
    expect(used.size, "không quét được chỗ dùng token nào — regex đã vỡ").toBeGreaterThan(30)
    const missing = [...used.entries()]
      .filter(([token]) => !declared.has(token))
      .map(([token, files]) => `${token} (dùng ở ${files.length} file, vd ${files[0]})`)
    expect(
      missing,
      "Token được dùng nhưng KHÔNG khai báo (hoặc khai báo đang nằm trong comment). " +
        "`var()` rỗng làm thuộc tính thành giá trị không hợp lệ: nền thành TRONG SUỐT, " +
        "màu chữ thành kế thừa — không lỗi nào phát ra.",
    ).toEqual([])
  })

  it("không file .css nào trong `src/` còn comment hở dấu đóng", () => {
    // Quét CẢ `globals.css` chứ không riêng `app-tokens.css`: lớp lỗi này không
    // thuộc riêng file nào, và `globals.css` cũng là một file dài toàn comment
    // giải thích quyết định màu.
    const offenders = collectSources(SRC)
      .filter((f) => f.endsWith(".css"))
      .flatMap((f) => {
        const lines = unclosedComments(readFileSync(f, "utf8"))
        return lines.map((l) => `${f.split("/src/")[1]}:${l}`)
      })
    expect(
      offenders,
      "comment mở ở các vị trí trên không có dấu đóng — MỌI khai báo sau đó tới " +
        "dấu đóng kế tiếp sẽ bị nuốt, im lặng (build xanh, test token vẫn xanh).",
    ).toEqual([])
  })
})
