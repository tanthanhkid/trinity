/**
 * hình vẽ trong thẻ chỉ số của màn Tổng quan.
 *
 * Nguyên tắc: chỉ số nào cũng đi kèm hình — không có ô số trần.
 *
 * 3 bất biến của hình vẽ (đều là cách "hình nói dối" nếu làm sai):
 *   1. Cả 2 mốc bằng 0 ⇒ 2 cột BẰNG NHAU. Vẽ lệch khi không có dữ liệu là dựng
 *      ra một chênh lệch không tồn tại.
 *   2. Giá trị > 0 KHÔNG được ra cột 0px — "có ít" phải khác "không có".
 *   3. `aria-label` đọc đủ CẢ 2 số: hình không phải đường đọc số duy nhất.
 */
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { render, screen } from "@testing-library/react"
import { ShellMiniBars } from "@/components/app-shell/charts/mini-bars"
import { ShellAvatar, shellInitials } from "@/components/app-shell/avatar"

function barHeights(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[aria-hidden][style*='height']")].map(
    (el) => el.style.height,
  )
}

describe("ShellMiniBars", () => {
  it("đọc được đủ 2 mốc qua aria-label", () => {
    render(<ShellMiniBars today={86} yesterday={74} fill="var(--color-app-blue)" />)
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Hôm qua 74, hôm nay 86",
    )
  })

  it("🔴 cả 2 mốc = 0 ⇒ 2 cột bằng nhau (không bịa chênh lệch)", () => {
    const { container } = render(
      <ShellMiniBars today={0} yesterday={0} fill="var(--color-app-blue)" />,
    )
    const [a, b] = barHeights(container)
    expect(a).toBe(b)
  })

  it("🔴 giá trị > 0 không bao giờ ra cột 0% (có ít ≠ không có)", () => {
    const { container } = render(
      <ShellMiniBars today={1} yesterday={100000} fill="var(--color-app-blue)" />,
    )
    const [, today] = barHeights(container)
    expect(Number.parseFloat(today)).toBeGreaterThan(0)
  })

  it("mốc = 0 giữa 2 mốc lệch nhau ⇒ cột 0%, phân biệt với ca cả-hai-bằng-0", () => {
    const { container } = render(
      <ShellMiniBars today={0} yesterday={12} fill="var(--color-app-blue)" />,
    )
    const [yesterday, today] = barHeights(container)
    expect(Number.parseFloat(yesterday)).toBe(100)
    expect(Number.parseFloat(today)).toBe(0)
  })

  it("số âm / NaN do BE trả bất thường ⇒ coi như 0, không vỡ layout", () => {
    const { container } = render(
      <ShellMiniBars today={Number.NaN} yesterday={-5} fill="var(--color-app-blue)" />,
    )
    const [a, b] = barHeights(container)
    expect(a).toBe(b)
  })
})

describe("shellInitials", () => {
  it.each([
    ["Nguyễn Văn An", "NA"],
    ["Trần Thị Bé", "TB"],
    ["An", "A"],
    ["  Lê   Minh   Cường  ", "LC"],
    ["", "?"],
  ])("%s → %s", (name, expected) => {
    expect(shellInitials(name)).toBe(expected)
  })

  it("null/undefined ⇒ `?`", () => {
    expect(shellInitials(null)).toBe("?")
    expect(shellInitials(undefined)).toBe("?")
  })

  it("🔴 giữ nguyên dấu tiếng Việt (cắt theo code point, không theo UTF-16)", () => {
    expect(shellInitials("Ẩn Danh")).toBe("ẨD")
    expect(shellInitials("Đặng Kim Phi")).toBe("ĐP")
  })

  it("cùng một tên ⇒ cùng một dải màu ở mọi lần render", () => {
    const a = render(<ShellAvatar name="Nguyễn Văn An" />).container.firstElementChild
    const b = render(<ShellAvatar name="Nguyễn Văn An" />).container.firstElementChild
    expect(a?.className).toBe(b?.className)
  })
})

/* ========================================================================== */

describe("🔴 màn Tổng quan v2 — KHÔNG còn thẻ chỉ số nào là ô số trần", () => {
  const DIR = join(__dirname, "../../app/(dashboard)/dashboard/_components")

  it("mọi chỗ gọi `<KpiCard>` đều cấp đủ 2 mốc để vẽ được hình", () => {
    // Thẻ thiếu `previousValue` sẽ rơi về nhánh không-có-hình, tức quay lại
    // đúng lỗi test này chặn. 3 biến thể dựng thẻ bằng mảng cấu hình
    // (`{...kpi}`) nên phải soi CẢ MẢNG, không chỉ soi thẻ JSX.
    const offenders: string[] = []
    for (const file of readdirSync(DIR).filter((f) => f.startsWith("dashboard-"))) {
      const src = readFileSync(join(DIR, file), "utf8")
      // `[\s\S]` thay cờ `/s`: `tsconfig` để `target: ES2017`, cờ `/s` ném TS1501.
      const direct = [...src.matchAll(/<KpiCard\b([\s\S]*?)\/>/g)].map((m) => m[1])
      for (const tag of direct) {
        const spread = /\{\.\.\.\w+\}/.test(tag)
        if (spread) {
          // Dựng từ mảng: đếm cặp trong CẢ FILE — mỗi `currentValue` phải có
          // đúng 1 `previousValue` đi kèm.
          const cur = (src.match(/currentValue:/g) ?? []).length
          const prev = (src.match(/previousValue:/g) ?? []).length
          if (cur === 0 || cur !== prev) offenders.push(`${file} (mảng: ${cur}/${prev})`)
          continue
        }
        // Có hình khi: đủ 2 mốc hôm qua/hôm nay, HOẶC caller cấp chuỗi thật (`sparkValues`),
        // HOẶC khai tường minh `plot={false}` (chỉ số tồn kho — đã đổi cách trình bày).
        if (!/previousValue|sparkValues|plot=\{false\}/.test(tag)) {
          const title = /title="([^"]*)"/.exec(tag)?.[1] ?? "?"
          offenders.push(`${file} → thẻ "${title}"`)
        }
      }
    }
    expect(
      offenders,
      'Thẻ chỉ số thiếu mốc "hôm qua" ⇒ không vẽ được hình ⇒ về lại ô số trần. ' +
        "Cấp `previousValue`, hoặc nếu là chỉ số TỒN KHO thì đặt `plot={false}` " +
        "tường minh và đổi cách trình bày (bản thiết kế: không có ô số trần).",
    ).toEqual([])
  })

  it("`KpiCard` thật sự vẽ hình (còn dùng `ShellMiniBars`) — chống gỡ oan", () => {
    const shared = readFileSync(join(DIR, "dashboard-stats-shared.tsx"), "utf8")
    expect(shared).toContain("ShellMiniBars")
    expect(shared).toMatch(/min-h-\[150px\]/)
  })
})
