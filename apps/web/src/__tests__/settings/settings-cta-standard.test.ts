import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/** Chuẩn "một hành động chính mỗi màn": không ghi đè màu nút, không confirm() trình duyệt. */
const ROOT = join(__dirname, "../../app/(dashboard)/settings")
const SKIP = new Set<string>()

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(f) && !SKIP.has(f) ? [p] : []
  })
}

describe("Cài đặt — chuẩn CTA", () => {
  const files = walk(ROOT)
  it("không ghi đè màu nền nút bằng token primary / màu cứng", () => {
    const bad = files.filter((f) =>
      /<Button[^>]*className="[^"]*(bg-\[var\(--color-app-primary\)\]|bg-red-[5-7]00|bg-orange-[5-7]00)/.test(
        readFileSync(f, "utf8"),
      ),
    )
    expect(bad).toEqual([])
  })
  it("không dùng confirm()/window.confirm", () => {
    const bad = files.filter((f) => /(^|[^.\w])(window\.)?confirm\(/.test(readFileSync(f, "utf8")))
    expect(bad).toEqual([])
  })
})
