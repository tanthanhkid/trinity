/**
 * khoá chuẩn "một hành động chính mỗi màn" ở mức mã nguồn
 * (e2e `design` khoá ở mức giao diện): không hardcode màu nút chính cũ,
 * không ghi đè nền primary lên `<Button>` (trùng variant default), không
 * dùng `window.confirm`/`confirm()` (dùng `ConfirmDialog`).
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
    return p.endsWith(".tsx") ? [p] : []
  })
}

// Nơi ĐỊNH NGHĨA biến thể nút (không phải chỗ dùng) — được phép khai màu nền.
const DEFINITIONS = new Set(["components/app-shell/button.tsx"])

const files = walk(SRC)
  // Đường dẫn dùng "/" và bỏ CR trên mọi hệ điều hành (Windows: dấu "\" + CRLF từ core.autocrlf).
  .map((p) => ({ path: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8").replace(/\r\n/g, "\n") }))
  .filter(({ path }) => !DEFINITIONS.has(path))

function offenders(re: RegExp) {
  return files.flatMap(({ path, text }) =>
    text.split("\n").flatMap((line, i) => (re.test(line) ? [`${path}:${i + 1}`] : [])),
  )
}

describe("chuẩn CTA — mã nguồn", () => {
  it("không còn màu nút xanh lá cũ #198754/#146c43", () => {
    expect(offenders(/bg-\[#(198754|146c43)\]/)).toEqual([])
  })

  it("không ghi đè nền primary + chữ trắng lên nút (dùng variant default)", () => {
    expect(offenders(/bg-\[var\(--color-app-primary\)\][^"'`]*text-white/)).toEqual([])
  })

  it("không dùng confirm() của trình duyệt — dùng ConfirmDialog", () => {
    expect(offenders(/(^|[^\w.])(window\.)?confirm\(/)).toEqual([])
  })
})
