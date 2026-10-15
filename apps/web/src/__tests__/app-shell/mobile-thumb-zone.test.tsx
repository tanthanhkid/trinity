// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen } from "@testing-library/react"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"

const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8")

describe("MOBILE_FAB_CLASS", () => {
  it("mọi class đều có tiền tố max-sm: (desktop không đổi)", () => {
    const tokens = MOBILE_FAB_CLASS.split(/\s+/).filter(Boolean)
    expect(tokens.length).toBeGreaterThan(5)
    for (const t of tokens) expect(t.startsWith("max-sm:"), t).toBe(true)
    expect(MOBILE_FAB_CLASS).toContain("max-sm:fixed")
    expect(MOBILE_FAB_CLASS).toContain("env(safe-area-inset-bottom)")
  })
  it("z-index thấp hơn Dialog/Sheet (z-50)", () => {
    expect(MOBILE_FAB_CLASS).toContain("max-sm:z-40")
  })
})

describe("MobileActionBar", () => {
  it("desktop = footer căn phải; điện thoại = fixed đáy + spacer", () => {
    const { container } = render(
      <MobileActionBar>
        <button>Huỷ</button>
        <button>Lưu</button>
      </MobileActionBar>,
    )
    const bar = container.querySelector('[data-slot="mobile-action-bar"]') as HTMLElement
    expect(bar.className).toContain("flex justify-end gap-2")
    expect(bar.className).toContain("max-sm:fixed")
    expect(bar.className).toContain("max-sm:inset-x-0")
    expect(bar.className).toContain("env(safe-area-inset-bottom)")
    // mọi class "vị trí cố định" chỉ ở max-sm
    expect(bar.className.split(" ").filter((c) => /(^|:)fixed$/.test(c) && !c.startsWith("max-sm:"))).toEqual([])
    expect(container.querySelector('[data-slot="mobile-action-bar-spacer"]')?.className).toContain("max-sm:h-24")
    expect(screen.getByText("Lưu")).toBeTruthy()
  })
})

describe("MobileFilterSheet", () => {
  it("không phải phone → render children inline, không có nút Bộ lọc", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false, media: q, addEventListener() {}, removeEventListener() {},
    }))
    render(
      <MobileFilterSheet activeCount={2}>
        <span>Trường lọc A</span>
      </MobileFilterSheet>,
    )
    expect(screen.getByText("Trường lọc A")).toBeTruthy()
    expect(screen.queryByText(/Bộ lọc/)).toBeNull()
  })
  it("phone → nút 'Bộ lọc (n)', children chưa mount tới khi mở", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: true, media: q, addEventListener() {}, removeEventListener() {},
    }))
    render(
      <MobileFilterSheet activeCount={3}>
        <span>Trường lọc B</span>
      </MobileFilterSheet>,
    )
    expect(screen.getByRole("button", { name: /Bộ lọc \(3\)/ })).toBeTruthy()
    expect(screen.queryByText("Trường lọc B")).toBeNull()
  })
})

describe("nền tảng điện thoại — khoá mã nguồn", () => {
  it("DialogContent = bảng trượt đáy dưới 640px, DialogFooter xếp dọc nút chính cuối", () => {
    const s = src("components/ui/dialog.tsx")
    for (const c of ["max-sm:bottom-0", "max-sm:top-auto", "max-sm:w-full", "max-sm:max-h-[90dvh]", "max-sm:rounded-b-none", "slide-in-from-bottom"]) {
      expect(s, c).toContain(c)
    }
    expect(s).not.toContain("flex-col-reverse")
    expect(s).toContain("sm:flex-row sm:justify-end")
  })
  it("TabsList một hàng cuộn ngang dưới 640px", () => {
    const s = src("components/ui/tabs.tsx")
    expect(s).toContain("max-sm:flex-nowrap")
    expect(s).toContain("max-sm:overflow-x-auto")
    expect(s).toContain("max-sm:min-h-11")
  })
  it("main có lề 16px + chừa đáy cho FAB/thanh đáy", () => {
    const s = src("app/(dashboard)/layout.tsx")
    expect(s).toContain("max-sm:px-4")
    expect(s).toContain("max-sm:pb-28")
  })
  it("CSS vùng chạm 44px nằm trong @media (max-width: 639px)", () => {
    const css = src("app/globals.css")
    const i = css.indexOf("@media (max-width: 639px)")
    expect(i).toBeGreaterThan(0)
    expect(css.slice(i)).toContain("min-height: 44px")
  })
  it("CSS vùng chạm iPad: (pointer: coarse) + >=640px chỉ dùng ::after, không min-height", () => {
    const css = src("app/globals.css")
    const m = "@media (pointer: coarse) and (min-width: 640px)"
    const i = css.lastIndexOf(m)
    expect(i).toBeGreaterThan(0)
    const block = css.slice(i, css.indexOf("\n}\n", i))
    expect(block).toContain("max(100%, 44px)")
    expect(block).not.toContain("min-height")
  })
  it("CSS vùng chạm iPad: nút/tab THÔ cũng được ::after, trừ phần tử đã có after: riêng; không đụng <640px", () => {
    const css = src("app/globals.css")
    const i = css.lastIndexOf("@media (pointer: coarse) and (min-width: 640px)")
    const block = css.slice(i, css.indexOf("\n}\n", i))
    expect(block).toContain(':is(button, [role="button"], [role="tab"], a[class*="group/button"]):not([class*="after:"])::after')
    expect(block).toContain(".touch-target::after")
    // nhánh <640px không có selector nút thô (không đổi hành vi điện thoại)
    const phone = css.slice(css.indexOf("@media (max-width: 639px)"), i)
    expect(phone).not.toContain(':is(button, [role="button"], [role="tab"], a[class*="group/button"]):not([class*="after:"])')
  })
})
