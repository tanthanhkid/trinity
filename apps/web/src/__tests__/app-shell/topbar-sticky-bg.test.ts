import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * header dính (`sticky top-0`) từng để `bg-transparent` → cuộn trang thì nội dung lộ qua header.
 * Khoá: header phải có nền (trắng mờ + blur, bản dark dùng nền card) — không quay lại trong suốt.
 */
const src = readFileSync(join(__dirname, "../../components/app-shell/topbar.tsx"), "utf8")
const header = src.match(/<header className="([^"]+)"/)?.[1] ?? ""

describe("topbar sticky có nền", () => {
  it("tìm thấy header sticky", () => {
    expect(header).toContain("sticky top-0")
  })
  it("không trong suốt, có nền + blur + bản dark", () => {
    expect(header).not.toContain("bg-transparent")
    expect(header).toMatch(/\bbg-white\/\d+/)
    expect(header).toContain("backdrop-blur")
    expect(header).toMatch(/\bdark:bg-/)
  })
})
