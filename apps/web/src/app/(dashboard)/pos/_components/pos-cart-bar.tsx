"use client"

import { ChevronUp, ShoppingCart } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
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
 * Thanh dính đáy của tab Bán hàng TRÊN ĐIỆN THOẠI: "N món · Tổng" (chạm mở giỏ)
 * + "Lưu đơn" (phụ) + "Thanh toán" (chính, cuối). Chỉ là lớp tóm tắt — giỏ chi tiết vẫn là
 * `PosCartPanel` (mở trong bảng trượt đáy), các nút gọi đúng handler của `PosSell`.
 * Giỏ rỗng: thanh gọn một nút "Chạm món để thêm" (vẫn mở được giỏ để chọn bàn/mang đi).
 */
export function PosCartBar({ cart, busy, onOpen, onSave, onPay }: Props) {
  const count = cartCount(cart.lines)
  if (cart.lines.length === 0) {
    return (
      <MobileActionBar className="mb-0">
        <Button type="button" variant="outline" className="justify-between" onClick={onOpen} aria-label="Mở giỏ hàng">
          <span className="flex items-center gap-2"><ShoppingCart aria-hidden /> Chạm món để thêm</span>
          <ChevronUp aria-hidden />
        </Button>
      </MobileActionBar>
    )
  }
  return (
    <MobileActionBar className="mb-0">
      <Button type="button" variant="outline" disabled={busy} onClick={onSave}>Lưu đơn</Button>
      <button
        type="button" onClick={onOpen} aria-label={`Mở giỏ hàng, ${count} món`}
        className="flex min-h-11 min-w-0 flex-[1.6] flex-col items-start justify-center rounded-lg px-1 text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="flex items-center gap-1 text-xs text-muted-foreground"><ShoppingCart className="size-3.5" aria-hidden />{count} món<ChevronUp className="size-3.5" aria-hidden /></span>
        <span className="max-w-full truncate text-base font-bold tabular-nums text-foreground">{vnd(cartTotals(cart).total)}</span>
      </button>
      <Button type="button" className="text-base" disabled={busy} onClick={onPay}>Thanh toán</Button>
    </MobileActionBar>
  )
}
