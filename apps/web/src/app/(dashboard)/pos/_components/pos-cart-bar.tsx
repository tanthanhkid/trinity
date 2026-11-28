"use client"

import { ChevronUp, ShoppingCart } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cartCount, cartTotals, type CartState } from "@/lib/pos-cart"
import { vnd } from "@/lib/pos-format"

interface Props {
  cart: CartState
  busy: boolean
  onOpen: () => void
  onSave: () => void
  onPay: () => void
}

/**
 * Thanh dính đáy của tab Bán hàng TRÊN ĐIỆN THOẠI — khối nhấn «Ánh xanh» bo 22 phía trên:
 * "N món · Tổng" (chạm mở giỏ) + "Thanh toán" (chính, cuối) + "Lưu đơn" (phụ). Chỉ là lớp tóm tắt —
 * giỏ chi tiết vẫn là `PosCartPanel` (bảng trượt đáy), các nút gọi đúng handler của `PosSell`.
 * Giỏ rỗng: thanh gọn một nút "Chạm món để thêm" (vẫn mở được giỏ để chọn bàn/mang đi).
 * Dòng đệm cuối giữ nội dung danh sách không bị thanh che.
 */
export function PosCartBar({ cart, busy, onOpen, onSave, onPay }: Props) {
  const count = cartCount(cart.lines)
  const shell = "fixed inset-x-0 bottom-0 z-40 rounded-t-[22px] border-t border-[var(--ax-hero-border)] ax-grad-hero text-white shadow-[var(--ax-shadow-hero)]"
  if (cart.lines.length === 0) {
    return (
      <>
        <div aria-hidden className="h-24" />
        <div data-slot="pos-cart-bar" className={`${shell} px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3.5`}>
          <Button type="button" variant="ax-on-hero-secondary" className="h-14 w-full justify-between" onClick={onOpen} aria-label="Mở giỏ hàng">
            <span className="flex items-center gap-2"><ShoppingCart aria-hidden /> Chạm món để thêm</span>
            <ChevronUp aria-hidden />
          </Button>
        </div>
      </>
    )
  }
  return (
    <>
      <div aria-hidden className="h-28" />
      <div data-slot="pos-cart-bar" className={`${shell} flex items-center gap-2.5 py-3.5 pl-5 pr-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]`}>
        <button
          type="button" onClick={onOpen} aria-label={`Mở giỏ hàng, ${count} món`}
          className="flex min-h-14 min-w-0 flex-1 flex-col items-start justify-center rounded-lg text-left focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]"
        >
          <span className="ax-amount flex items-center gap-1 text-[13px] text-[var(--ax-on-hero-ink-2)]"><ShoppingCart className="size-3.5" aria-hidden />{count} món<ChevronUp className="size-3.5" aria-hidden /></span>
          <span className="ax-amount max-w-full truncate text-[28px] font-bold leading-[1.15] text-white">{vnd(cartTotals(cart).total)}</span>
        </button>
        <Button type="button" variant="ax-on-hero-secondary" className="h-14 px-4" disabled={busy} onClick={onSave}>Lưu đơn</Button>
        <Button type="button" variant="ax-on-hero" className="h-14 px-5 text-[17px]" disabled={busy} onClick={onPay}>Thanh toán</Button>
      </div>
    </>
  )
}
