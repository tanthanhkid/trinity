import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Khối nhấn «Ánh xanh» (docs/design/anh-xanh.md) — gradient mức NHẤN MẠNH: xanh đậm 140°
 * (#33699A → #28567F → #1A3C5D), quầng sáng + hai vòng cung mảnh ở góc phải trên, bóng
 * góc trái dưới, viền #214A70. MỖI MÀN ĐÚNG MỘT khối, cho thông tin quan trọng nhất (tổng
 * tiền POS, thực nhận lương, đầu hồ sơ khách, trạng thái kết nối…).
 *
 * Chữ trên khối: trắng (`HeroCardValue`, tiêu đề) hoặc trắng 97% (`HeroCardLabel`; thiết kế ghi 92% — nâng để đạt 4,5:1 dưới quầng sáng). Nút đặt
 * trên khối dùng `<Button variant="ax-on-hero">` / `"ax-on-hero-secondary"`; ô thông tin
 * phụ dùng `HeroCardTile`.
 *
 * @example
 * <HeroCard>
 *   <HeroCardLabel>Thực nhận tháng 11</HeroCardLabel>
 *   <HeroCardValue unit="₫">{formatNumber(net)}</HeroCardValue>
 *   <div className="mt-4 flex gap-2"><Button variant="ax-on-hero" size="ax-lg">Duyệt phiếu này</Button></div>
 * </HeroCard>
 */
function HeroCard({
  className,
  compact = false,
  ...props
}: React.ComponentProps<"section"> & {
  /** `true` = bo 14 + đệm 12/14 cho khối nhỏ (ô tổng tiền trong panel). */
  compact?: boolean
}) {
  return (
    <section
      data-slot="hero-card"
      className={cn(
        "relative isolate overflow-hidden border border-[var(--ax-hero-border)] ax-grad-hero text-[var(--ax-on-hero-ink)] shadow-[var(--ax-shadow-hero)]",
        compact ? "rounded-[14px] px-3.5 py-3" : "rounded-[var(--ax-radius-hero)] p-6 max-sm:rounded-[var(--ax-radius-sheet)] max-sm:p-5",
        className,
      )}
      {...props}
    />
  )
}

/** Nhãn trên khối nhấn — trắng 97%, 14/500. */
function HeroCardLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="hero-card-label"
      className={cn("text-sm font-medium text-[var(--ax-on-hero-ink-2)]", className)}
      {...props}
    />
  )
}

/** Số lớn trên khối nhấn — trắng 700, -0.02em; `unit` (₫, khách…) nhỏ 0.6em trắng 97%. */
function HeroCardValue({
  className,
  unit,
  children,
  ...props
}: React.ComponentProps<"div"> & { unit?: React.ReactNode }) {
  return (
    <div
      data-slot="hero-card-value"
      className={cn("ax-amount text-[44px] leading-[1.1] font-bold text-white max-sm:text-[36px]", className)}
      {...props}
    >
      {children}
      {unit ? (
        <span className="ml-1 text-[0.6em] font-medium text-[var(--ax-on-hero-ink-2)]">{unit}</span>
      ) : null}
    </div>
  )
}

/** Ô thông tin phụ đặt trên khối nhấn — nền xanh thẫm trong, bo 10. */
function HeroCardTile({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="hero-card-tile"
      className={cn("rounded-[10px] bg-[var(--ax-on-hero-tile)] px-3 py-2.5 text-sm text-white", className)}
      {...props}
    />
  )
}

export { HeroCard, HeroCardLabel, HeroCardTile, HeroCardValue }
