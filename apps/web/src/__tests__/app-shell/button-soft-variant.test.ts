/**
 * variant `soft` = tông nhạt cho trạng thái ĐANG CHỌN, KHÔNG nền đặc.
 * Khoá: có tông nhạt, KHÔNG chứa `bg-primary` đặc (nếu có, e2e `design` đếm nhầm nó
 * là nút chính), chữ dùng token ink đạt tương phản, và link dạng soft không ăn
 * rule hover đặc của `a[class*="bg-primary"]`.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buttonVariants } from "@/components/ui/button-variants"

describe("buttonVariants — soft", () => {
  const cls = buttonVariants({ variant: "soft" })

  it("nền nhạt primary/10, hover/pressed primary/15", () => {
    expect(cls).toContain("bg-primary/10")
    expect(cls).toContain("hover:bg-primary/15")
    expect(cls).toContain("aria-pressed:bg-primary/15")
  })

  it("không có nền đặc `bg-primary` (token đơn, không alpha)", () => {
    expect(cls.split(/\s+/)).not.toContain("bg-primary")
  })

  it("chữ dùng --color-app-primary-ink (text-primary trên primary/10 chỉ 4,49:1)", () => {
    expect(cls).toContain("text-[var(--color-app-primary-ink)]")
  })

  it("rule hover link v2 loại trừ soft (bg-primary/10) nhưng KHÔNG loại default (chứa `[a]:hover:bg-primary/80`)", () => {
    const css = readFileSync(join(__dirname, "../../styles/app-tokens.css"), "utf8")
    expect(css).toContain('a[class*="bg-primary"]:not([class*="bg-primary/10"])')
  })
})

describe("hover link v2 vẫn áp cho default", () => {
  it("class default không chứa bg-primary/10 nên không bị loại trừ", () => {
    expect(buttonVariants({ variant: "default" })).not.toContain("bg-primary/10")
  })
})
