/**
 * Component dùng chung «Ánh xanh» — mỗi component một nhóm test nhỏ: render đúng vai trò,
 * gắn đúng token/biến thể, hành vi tương tác (sửa, hoàn tác, đóng khay).
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { Users } from "lucide-react"
import { Toaster } from "sonner"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Avatar, AvatarFallback, PersonAvatar } from "@/components/ui/avatar"
import { BottomSheet, BottomSheetContent, BottomSheetFooter, BottomSheetTrigger } from "@/components/ui/bottom-sheet"
import { Button, buttonVariants } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { AxField } from "@/components/ui/field"
import { HeroCard, HeroCardLabel, HeroCardTile, HeroCardValue } from "@/components/ui/hero-card"
import { Input } from "@/components/ui/input"
import { StageChip, stageToneVars } from "@/components/ui/stage-chip"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { showUndoToast, UndoToast } from "@/components/ui/undo-toast"

describe("Button — biến thể «Ánh xanh»", () => {
  it("ax-primary: gradient + bóng màu, bo 8, KHÔNG nền đặc bg-primary", () => {
    const cls = buttonVariants({ variant: "ax-primary", size: "ax" })
    expect(cls).toContain("ax-grad-primary")
    expect(cls).toContain("hover:ax-grad-primary-hover")
    expect(cls).toContain("shadow-[var(--ax-shadow-primary)]")
    expect(cls).toContain("rounded-[var(--ax-radius-field)]")
    expect(cls).toContain("h-10")
    expect(cls.split(/\s+/)).not.toContain("bg-primary")
  })

  it("biến thể mặc định GIỮ NGUYÊN (không đổi diện mạo màn cũ)", () => {
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary")
    expect(buttonVariants({ variant: "default" })).not.toContain("ax-grad")
  })

  it("render gắn data-variant/data-size; class bo góc mới thắng bo góc gốc", () => {
    render(
      <Button variant="ax-primary" size="ax">
        Lưu khách
      </Button>,
    )
    const btn = screen.getByRole("button", { name: "Lưu khách" })
    expect(btn).toHaveAttribute("data-variant", "ax-primary")
    expect(btn).toHaveAttribute("data-size", "ax")
    expect(btn.className).toContain("rounded-[var(--ax-radius-field)]")
    expect(btn.className).not.toMatch(/(^|\s)rounded-(lg|full)(\s|$)/)
  })

  it.each(["ax-secondary", "ax-ghost", "ax-danger", "ax-on-hero", "ax-on-hero-secondary"] as const)(
    "%s có hover đặc (không alpha)",
    (variant) => {
      const hover = buttonVariants({ variant })
        .split(/\s+/)
        .filter((c) => c.startsWith("hover:bg-"))
      expect(hover.length).toBeGreaterThan(0)
      for (const c of hover) expect(c).not.toMatch(/\/\d+$/)
    },
  )
})

describe("Input / AxField — ô nhập", () => {
  it("Input variant=ax gắn dáng mới; mặc định không đổi", () => {
    render(
      <>
        <Input aria-label="cũ" />
        <Input aria-label="mới" variant="ax" />
      </>,
    )
    expect(screen.getByLabelText("cũ")).not.toHaveAttribute("data-variant")
    const next = screen.getByLabelText("mới")
    expect(next).toHaveAttribute("data-variant", "ax")
    expect(next.className).toContain("border-ax-field-border")
    expect(next.className).toContain("focus-visible:shadow-[var(--ax-field-focus)]")
  })

  it("AxField nối nhãn + gợi ý; lỗi thay chỗ gợi ý và bật aria-invalid", () => {
    const { rerender } = render(<AxField label="Số điện thoại" hint="10 chữ số" defaultValue="0907" />)
    const input = screen.getByLabelText("Số điện thoại")
    expect(input).toHaveAccessibleDescription("10 chữ số")
    expect(input).not.toHaveAttribute("aria-invalid")
    rerender(<AxField label="Số điện thoại" hint="10 chữ số" error="Số điện thoại cần đủ 10 chữ số" defaultValue="0907" />)
    expect(screen.getByLabelText("Số điện thoại")).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("alert").textContent).toBe("Số điện thoại cần đủ 10 chữ số")
    expect(screen.queryByText("10 chữ số")).toBeNull()
  })
})

describe("StageChip — chip giai đoạn", () => {
  it("tông có sẵn: span, chấm + nền + chữ theo token giai đoạn", () => {
    const { container } = render(<StageChip tone="quote">Báo giá</StageChip>)
    const chip = container.querySelector("[data-slot=stage-chip]") as HTMLElement
    expect(chip.tagName).toBe("SPAN")
    expect(chip).toHaveAttribute("data-tone", "quote")
    expect(chip.style.getPropertyValue("--chip-bg")).toBe("var(--ax-stage-quote-bg)")
    expect(chip.style.getPropertyValue("--chip-ink")).toBe("var(--ax-stage-quote-ink)")
  })

  it("màu tự do (cột Kanban): chấm theo màu đó, nền/chữ trung tính", () => {
    const { container } = render(<StageChip dotColor="#e11d48">Ưu tiên</StageChip>)
    const chip = container.querySelector("[data-slot=stage-chip]") as HTMLElement
    expect(chip).toHaveAttribute("data-tone", "custom")
    expect(chip.style.getPropertyValue("--chip-dot")).toBe("#e11d48")
    expect(chip.style.getPropertyValue("--chip-bg")).toBe(stageToneVars("neutral").bg)
  })

  it("có onClick ⇒ nút với aria-pressed theo selected", () => {
    const pick = vi.fn()
    render(
      <StageChip tone="won" selected onClick={pick}>
        Chốt đơn
      </StageChip>,
    )
    const btn = screen.getByRole("button", { name: "Chốt đơn" })
    expect(btn).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(btn)
    expect(pick).toHaveBeenCalledOnce()
  })
})

describe("Avatar — khách bo 30%, nhân viên tròn", () => {
  it("kind=customer bo 30% + gradient khách; kind=staff tròn + gradient trung tính", () => {
    const { container } = render(
      <>
        <PersonAvatar kind="customer" name="Nguyễn Tú" />
        <Avatar kind="staff">
          <AvatarFallback>LH</AvatarFallback>
        </Avatar>
      </>,
    )
    const [customer, staff] = [...container.querySelectorAll("[data-slot=avatar]")] as HTMLElement[]
    expect(customer).toHaveAttribute("data-kind", "customer")
    expect(customer.className).toContain("data-[kind=customer]:rounded-[30%]")
    expect(customer.textContent).toBe("NT")
    expect(staff).toHaveAttribute("data-kind", "staff")
    const fb = staff.querySelector("[data-slot=avatar-fallback]") as HTMLElement
    expect(fb.className).toContain("group-data-[kind=staff]/avatar:ax-grad-avatar-staff")
  })

  it("không truyền kind ⇒ không có data-kind (dáng cũ giữ nguyên)", () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>,
    )
    expect(container.querySelector("[data-slot=avatar]")).not.toHaveAttribute("data-kind")
  })
})

describe("HeroCard — khối nhấn", () => {
  it("gradient nhấn + nhãn/số/đơn vị + ô thông tin", () => {
    render(
      <HeroCard aria-label="Tổng thanh toán">
        <HeroCardLabel>Tổng cộng</HeroCardLabel>
        <HeroCardValue unit="₫">1.250.000</HeroCardValue>
        <HeroCardTile>3 món</HeroCardTile>
      </HeroCard>,
    )
    const hero = screen.getByRole("region", { name: "Tổng thanh toán" })
    expect(hero.className).toContain("ax-grad-hero")
    expect(hero.className).toContain("shadow-[var(--ax-shadow-hero)]")
    expect(hero.querySelector("[data-slot=hero-card-value]")?.textContent).toBe("1.250.000₫")
    expect(screen.getByText("3 món")).toHaveAttribute("data-slot", "hero-card-tile")
  })
})

describe("UndoToast — toast có Hoàn tác", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("trình bày: chữ + nút Hoàn tác gọi onUndo", () => {
    const undo = vi.fn()
    render(<UndoToast message="Đã lưu số điện thoại" onUndo={undo} />)
    fireEvent.click(screen.getByRole("button", { name: "Hoàn tác" }))
    expect(undo).toHaveBeenCalledOnce()
  })

  it("showUndoToast qua Toaster: bấm Hoàn tác gọi onUndo đúng MỘT lần", async () => {
    const undo = vi.fn()
    render(<Toaster />)
    act(() => {
      showUndoToast("Đã chuyển sang Báo giá", { onUndo: undo })
    })
    const btn = await screen.findByRole("button", { name: "Hoàn tác" })
    expect(screen.getByText("Đã chuyển sang Báo giá")).toBeTruthy()
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(undo).toHaveBeenCalledOnce()
  })
})

describe("EmptyState variant=ax — trạng thái trống", () => {
  it("nền trống có quầng + tiêu đề + lời nhắn + hành động", () => {
    const { container } = render(
      <EmptyState
        variant="ax"
        icon={Users}
        title="Chưa có khách nào trong giai đoạn Báo giá"
        message="Khi bạn chuyển khách sang Báo giá, họ sẽ hiện ở đây."
        action={<Button variant="ax-primary">Thêm khách</Button>}
      />,
    )
    const box = container.querySelector("[data-slot=empty-state]") as HTMLElement
    expect(box).toHaveAttribute("data-variant", "ax")
    expect(box.className).toContain("ax-grad-empty")
    expect(screen.getByText("Chưa có khách nào trong giai đoạn Báo giá")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Thêm khách" })).toBeTruthy()
  })
})

describe("BottomSheet — khay đáy điện thoại", () => {
  it("mở bằng trigger → dialog có tên; Esc đóng", async () => {
    render(
      <BottomSheet>
        <BottomSheetTrigger render={<button type="button" />}>Đổi giai đoạn</BottomSheetTrigger>
        <BottomSheetContent title="Đổi giai đoạn" description="Khách Nguyễn Tú">
          <p>Danh sách giai đoạn</p>
          <BottomSheetFooter>
            <Button variant="ax-primary">Lưu</Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>,
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Đổi giai đoạn" }))
    const dialog = await screen.findByRole("dialog", { name: "Đổi giai đoạn" })
    expect(dialog).toHaveAttribute("data-slot", "bottom-sheet-content")
    expect(dialog).toHaveAccessibleDescription("Khách Nguyễn Tú")
    fireEvent.keyDown(dialog, { key: "Escape" })
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})

describe("StickyActionBar — thanh hành động dính", () => {
  it("auto: dưới 1024px cố định đáy + khoảng đệm; từ 1024px nổi sticky", () => {
    const { container } = render(
      <StickyActionBar>
        <Button variant="ax-secondary">Bỏ sửa</Button>
        <Button variant="ax-primary">Lưu thay đổi</Button>
      </StickyActionBar>,
    )
    const bar = container.querySelector("[data-slot=sticky-action-bar]") as HTMLElement
    expect(bar.className).toContain("max-lg:fixed")
    expect(bar.className).toContain("lg:sticky")
    expect(bar.className).toContain("ax-grad-bar")
    expect(container.querySelector("[data-slot=sticky-action-bar-spacer]")).not.toBeNull()
  })

  it("desktop: không có khoảng đệm cho thanh đáy", () => {
    const { container } = render(
      <StickyActionBar layout="desktop">
        <Button variant="ax-primary">Duyệt</Button>
      </StickyActionBar>,
    )
    expect(container.querySelector("[data-slot=sticky-action-bar]")?.className).toContain("sticky")
    expect(container.querySelector("[data-slot=sticky-action-bar-spacer]")).toBeNull()
  })
})
