import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { Switch } from "@/components/ui/switch"

// helper WCAG contrast thuần (sRGB hex, không phụ thuộc DOM/CSS)
// để khoá bất biến "trạng thái tắt PHẢI đạt ≥3:1 trên nền trắng" — hồi quy về
// lại 1 màu quá nhạt (vd bg-muted-foreground/30 cũ) sẽ làm test này đỏ ngay,
// không cần chờ audit thủ công lại.
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hexToRgb(hex1))
  const l2 = relativeLuminance(hexToRgb(hex2))
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (lighter + 0.05) / (darker + 0.05)
}

describe("Switch — (công tắc dùng chung)", () => {
  it("render role=switch + aria-checked đúng trạng thái", () => {
    const { rerender } = render(<Switch checked={false} onCheckedChange={vi.fn()} />)
    const el = screen.getByRole("switch")
    expect(el.getAttribute("aria-checked")).toBe("false")

    rerender(<Switch checked onCheckedChange={vi.fn()} />)
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true")
  })

  it("click gọi onCheckedChange với giá trị đảo ngược", () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} onCheckedChange={onCheckedChange} />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it("disabled → không gọi onCheckedChange khi click", () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} onCheckedChange={onCheckedChange} disabled />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it("mặc định TẮT dùng #8b919f (KHÔNG dùng bg-muted-foreground/30 cũ)", () => {
    render(<Switch checked={false} onCheckedChange={vi.fn()} />)
    const el = screen.getByRole("switch")
    expect(el.className).toContain("bg-[#8b919f]")
    expect(el.className).not.toContain("muted-foreground")
  })

  it("mặc định BẬT dùng màu thương hiệu --color-app-primary", () => {
    render(<Switch checked onCheckedChange={vi.fn()} />)
    const el = screen.getByRole("switch")
    expect(el.className).toContain("bg-[var(--color-app-primary)]")
  })

  it("có focus ring rõ ràng (focus-visible:ring)", () => {
    render(<Switch checked={false} onCheckedChange={vi.fn()} />)
    const el = screen.getByRole("switch")
    expect(el.className).toContain("focus-visible:ring-2")
    expect(el.className).toContain("focus-visible:ring-ring")
  })

  it("size='sm' áp dụng track/thumb nhỏ hơn", () => {
    const { container } = render(
      <Switch checked={false} onCheckedChange={vi.fn()} size="sm" />,
    )
    const el = screen.getByRole("switch")
    expect(el.className).toContain("h-5 w-9")
    const thumb = container.querySelector("span[aria-hidden]")
    expect(thumb?.className).toContain("size-4")
  })

  it("trackOnClassName/trackOffClassName override được", () => {
    const { rerender } = render(
      <Switch
        checked={false}
        onCheckedChange={vi.fn()}
        trackOnClassName="bg-fuchsia-500"
        trackOffClassName="bg-slate-300"
      />,
    )
    expect(screen.getByRole("switch").className).toContain("bg-slate-300")

    rerender(
      <Switch
        checked
        onCheckedChange={vi.fn()}
        trackOnClassName="bg-fuchsia-500"
        trackOffClassName="bg-slate-300"
      />,
    )
    expect(screen.getByRole("switch").className).toContain("bg-fuchsia-500")
  })

  it("WCAG: #8b919f (trạng thái tắt) đạt ≥3:1 trên nền trắng (1.4.11)", () => {
    expect(contrastRatio("#8b919f", "#ffffff")).toBeGreaterThanOrEqual(3)
  })

  it("WCAG: bg-muted-foreground/30 cũ (~1,5:1) KHÔNG đạt 3:1 — lý do phải đổi", () => {
    // #636b7f (--muted-foreground) pha 30% lên nền trắng, tính thủ công màu hiệu dụng.
    const muted: [number, number, number] = [0x63 / 255, 0x6b / 255, 0x7f / 255]
    const white: [number, number, number] = [1, 1, 1]
    const eff: [number, number, number] = [
      0.3 * muted[0] + 0.7 * white[0],
      0.3 * muted[1] + 0.7 * white[1],
      0.3 * muted[2] + 0.7 * white[2],
    ]
    const l1 = relativeLuminance(eff)
    const l2 = relativeLuminance(white)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    expect(ratio).toBeLessThan(3)
  })
})
