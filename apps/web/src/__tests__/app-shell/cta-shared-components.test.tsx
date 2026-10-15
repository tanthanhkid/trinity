/**
 * component dùng chung của chuẩn "một hành động chính mỗi màn":
 * Badge `soft`/`success` (không nền đặc, giữ nguyên `default`) và ConfirmDialog.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { Badge, badgeVariants } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"

describe("Badge variants", () => {
  it("default GIỮ NGUYÊN nền đặc bg-primary (không đổi toàn cục)", () => {
    expect(badgeVariants({ variant: "default" })).toContain("bg-primary text-primary-foreground")
  })

  it("soft: nền primary/10, chữ ink, không nền đặc", () => {
    const cls = badgeVariants({ variant: "soft" })
    expect(cls).toContain("bg-primary/10")
    expect(cls).toContain("text-[var(--color-app-primary-ink)]")
    expect(cls.split(/\s+/)).not.toContain("bg-primary")
  })

  it("success: nền tag-green-bg + chữ tag-green-ink, không nền đặc", () => {
    const cls = badgeVariants({ variant: "success" })
    expect(cls).toContain("bg-[var(--color-app-tag-green-bg)]")
    expect(cls).toContain("text-[var(--color-app-tag-green-ink)]")
    expect(cls.split(/\s+/)).not.toContain("bg-primary")
  })

  it("render gắn data-variant", () => {
    render(<Badge variant="success">Đã duyệt</Badge>)
    expect(screen.getByText("Đã duyệt")).toHaveAttribute("data-variant", "success")
  })
})

// Base-UI chèn `<span role="button" data-base-ui-focus-guard>` — chỉ lấy Button thật.
const realButtons = () =>
  screen.getAllByRole("button").filter((b) => b.getAttribute("data-slot") === "button")

describe("ConfirmDialog", () => {
  const base = { open: true, onOpenChange: () => {}, title: "Xoá nhân viên?", onConfirm: () => {} }

  it("render tiêu đề + mô tả; Huỷ (ghost) đứng TRƯỚC nút xác nhận", () => {
    render(<ConfirmDialog {...base} description="Không hoàn tác được" confirmLabel="Xoá nhân viên" />)
    expect(screen.getByText("Xoá nhân viên?")).toBeInTheDocument()
    expect(screen.getByText("Không hoàn tác được")).toBeInTheDocument()
    const buttons = realButtons()
    expect(buttons.map((b) => b.textContent)).toEqual(["Huỷ", "Xoá nhân viên"])
    expect(buttons[0]).toHaveAttribute("data-variant", "ghost")
  })

  it("tone mặc định = destructive → nút xác nhận data-variant destructive", () => {
    render(<ConfirmDialog {...base} />)
    expect(screen.getByRole("button", { name: "Xoá" })).toHaveAttribute("data-variant", "destructive")
  })

  it("tone default → nút xác nhận variant default, nhãn mặc định 'Xác nhận'", () => {
    render(<ConfirmDialog {...base} tone="default" />)
    expect(screen.getByRole("button", { name: "Xác nhận" })).toHaveAttribute("data-variant", "default")
  })

  it("bấm xác nhận gọi onConfirm; bấm Huỷ gọi onOpenChange(false)", () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Xoá" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Huỷ" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("pending khoá cả 2 nút", () => {
    render(<ConfirmDialog {...base} pending />)
    for (const b of realButtons()) expect(b).toBeDisabled()
  })
})
