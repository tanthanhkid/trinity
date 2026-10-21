/**
 * Khoá "chữ lỗi" ở mức mã nguồn (docs/TRANG-THAI.md mục "Chữ lỗi"): mọi câu lỗi hiện cho người dùng phải đi qua
 * bảng thông điệp chung `lib/error-messages.ts` (`errorMessage` / `getApiErrorMessage` / `ErrorState`), để
 * không lộ chữ tiếng Anh, mã lỗi hay `error.message` thô của máy chủ/trình duyệt.
 * Bắt: tự đọc `response.data.message`; in `error.message`/`err.message` ra giao diện hoặc toast; câu chung chung.
 */
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(__dirname, "../..")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === "__tests__" || name === "node_modules") return []
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(tsx?|mts)$/.test(p) && !p.endsWith(".d.ts") ? [p] : []
  })
}

/** Ngoại lệ có lý do — KHÔNG thêm vào đây để né lỗi mới. Đường dẫn dùng "/" trên mọi hệ điều hành. */
const ALLOW: Record<string, string> = {
  // Nơi định nghĩa bảng thông điệp — được đọc câu gốc của máy chủ.
  "lib/error-messages.ts": "bảng thông điệp chung",
  "lib/api-client.ts": "getApiErrorMessage gọi bảng chung",
  // Đọc câu máy chủ để RẼ NHÁNH (biết có upload trực tiếp được không), không hiện ra giao diện.
  "hooks/use-social.ts": "chỉ dùng để rẽ nhánh luồng tải lên",
  // `error.message` ở đây là câu ĐÃ qua getApiErrorMessage ở products-screen.tsx (prop { message, conflict }).
  "app/(dashboard)/products/_components/product-delete-dialog.tsx": "message đã qua bảng chung",
  // Đoạn xoá/khôi phục hàng loạt đang được viết lại trong PR #58 (đã qua bảng chung) — gỡ dòng này khi #58 gộp.
  "app/(dashboard)/contacts/page.tsx": "chờ PR #58",
  // File của PR #48 (khối Trợ lý AI/Kênh) — sửa sau khi #48 gộp.
  "app/(dashboard)/dashboard/_components/home-ai-hub.tsx": "chờ PR #48",
}

const files = walk(SRC)
  .map((p) => ({ path: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }))
  .filter(({ path }) => !(path in ALLOW))

function offenders(re: RegExp) {
  return files.flatMap(({ path, text }) =>
    text.split("\n").flatMap((line, i) => (re.test(line) && !/^\s*(\/\/|\*)/.test(line) ? [`${path}:${i + 1}`] : [])),
  )
}

describe("chữ lỗi — mã nguồn", () => {
  it("không tự đọc response.data.message (dùng errorMessage / getApiErrorMessage)", () => {
    expect(offenders(/response\??\.data\??\.message/)).toEqual([])
  })

  it("không in error.message / err.message thô ra giao diện hoặc toast", () => {
    expect(offenders(/\{\s*(e|err|error|reason)\.message\s*\}/)).toEqual([])
    expect(offenders(/toast\.(error|warning|message)\([^)]*\b(e|err|error|reason)\??\.message\b/)).toEqual([])
    expect(offenders(/instanceof Error\s*(&&[^?]*)?\?\s*(e|err|error)\.message/)).toEqual([])
  })

  it("onError không vứt lỗi thật: toast câu cố định phải qua errorMessage(err, …)", () => {
    expect(offenders(/onError: \(\w*\) => (\{ *)?toast\.error\(["'`]/)).toEqual([])
  })

  it("không còn câu lỗi chung chung không nói chuyện gì / cách sửa", () => {
    expect(offenders(/["'`](Có lỗi xảy ra|Đã xảy ra lỗi|Lỗi không xác định|Something went wrong|An error occurred)/)).toEqual([])
  })
})
