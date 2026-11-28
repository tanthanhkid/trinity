"use client"

import { useRef, type Dispatch, type SetStateAction } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Armchair, ChevronLeft, MoreHorizontal, Minus, Plus, Printer, Receipt, ShoppingBag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOffline } from "@/components/offline-banner"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { vnd } from "@/lib/pos-format"
import { cartCount, cartTotals, changeQty, lineTotal, lineUnitPrice, type CartState } from "@/lib/pos-cart"
import { MoneyInput } from "./money-input"

interface Props {
  cart: CartState
  setCart: Dispatch<SetStateAction<CartState>>
  tableName: string | null
  busy: boolean
  /** Màn đơn đang hiện. */
  open: boolean
  /** Một hộp thoại con (bàn/sửa món/thanh toán/huỷ) đang mở — màn đơn tạm ẩn (vẫn gắn: giữ cuộn, trạng thái) và không trả tiêu điểm về thanh giỏ. */
  yielding: boolean
  /** Chế độ «Khác» của giảm giá — giữ ở `PosSell` vì màn này tạm gỡ khi một hộp thoại con mở. */
  customDiscount: boolean
  setCustomDiscount: (v: boolean) => void
  onBack: () => void
  onEditLine: (key: string) => void
  onOpenTable: () => void
  onPay: () => void
  onSave: () => void
  onProvisional: () => void
  onVoid: () => void
  onNew: () => void
}

/** Chip giảm giá nhanh theo thiết kế (pos-mobile2); «Khác» mở ô nhập % / ₫ tuỳ ý — giữ nguyên logic giảm giá của giỏ. */
const QUICK = [5, 10] as const

/**
 * Màn đơn TOÀN PHẦN trên điện thoại (thiết kế pos-mobile2): «‹ Thêm món» + «Bàn · mã đơn» trên đầu, dòng món có −/+,
 * khối đáy xanh «Giảm giá / Tổng cộng / Thu sau / Thanh toán». Thay bảng trượt giỏ hàng; cùng `CartState` và cùng
 * handler với `PosCartPanel` (lưu/thanh toán/huỷ/in tạm tính không đổi). «Thu sau» = lưu đơn mở.
 */
export function PosOrderScreen(p: Props) {
  const { cart, setCart } = p
  const t = cartTotals(cart)
  const empty = cart.lines.length === 0
  const offline = useOffline()
  const isQuick = cart.discountType === "percent" && (QUICK as readonly number[]).includes(cart.discountValue)
  const setCustom = p.setCustomDiscount
  const showCustom = p.customDiscount || (cart.discountType !== "none" && !isQuick)
  /** «Khác» bật nhưng chưa nhập: mặc định giảm theo ₫ (chỉ ghi vào giỏ khi gõ số). */
  const customType = cart.discountType === "none" ? "amount" : cart.discountType
  const quickOn = (n: number) => !showCustom && isQuick && cart.discountValue === n
  const setDiscount = (discountType: CartState["discountType"], discountValue: number) => setCart((c) => ({ ...c, discountType, discountValue }))
  const chip = (on: boolean) =>
    cn("min-h-11 min-w-16 rounded-ax-field border-[1.5px] px-4 text-[15px] font-semibold focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
      on
        ? "border-[var(--ax-on-hero-primary-ink)] bg-[var(--ax-on-hero-primary-hover)] text-[var(--ax-on-hero-primary-ink)]"
        : "border-[var(--ax-on-hero-primary-bg)] bg-[var(--ax-on-hero-primary-bg)] text-[var(--ax-on-hero-primary-ink)]")
  const where = cart.orderType === "takeaway" ? "Mang đi" : cart.tableId && p.tableName ? `Bàn ${p.tableName}` : "Chọn bàn"
  const title = cart.orderCode ? `${where} · ${cart.orderCode}` : where

  // Màn toàn phần dựng trên Dialog base-ui (như bảng trượt cũ): giữ tiêu điểm trong màn, Esc = «‹ Thêm món», khoá cuộn nền.
  // `keepMounted`: hộp thoại con mở thì màn chỉ ẩn, không gỡ — giữ vị trí cuộn danh sách món.
  const backRef = useRef<HTMLButtonElement>(null)

  return (
    <DialogPrimitive.Root open={p.open} onOpenChange={(o) => { if (!o) p.onBack() }}>
      <DialogPrimitive.Portal keepMounted>
        <DialogPrimitive.Popup aria-label="Đơn hàng" data-slot="pos-order-screen" initialFocus={backRef} finalFocus={() => !p.yielding}
          className="fixed inset-0 z-50 flex flex-col ax-page text-ax-ink outline-none data-[closed]:hidden">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-1 border-b border-ax-line ax-grad-bar px-2 pt-[env(safe-area-inset-top)]">
        <Button ref={backRef} type="button" variant="ax-ghost" size="ax" className="gap-0.5 pl-1 text-ax-primary" onClick={p.onBack}><ChevronLeft aria-hidden /> Thêm món</Button>
        <div className="flex min-w-0 items-center">
          <Button type="button" variant="ax-ghost" size="ax" className="min-w-0 max-w-[48vw] gap-1.5 text-[16px] font-bold" aria-label={`${title}, đổi bàn`} onClick={p.onOpenTable}>
            {cart.orderType === "takeaway" ? <ShoppingBag aria-hidden /> : <Armchair aria-hidden />}
            <span className="ax-amount truncate">{title}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ax-ghost" size="ax-icon" aria-label="Thao tác khác" disabled={p.busy} />}>
              <MoreHorizontal aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {cart.orderType === "dine_in" && (
                <DropdownMenuItem className="min-h-11" onClick={() => setCart((c) => ({ ...c, orderType: "takeaway", tableId: null }))}>Mang đi</DropdownMenuItem>
              )}
              <DropdownMenuItem className="min-h-11" onClick={p.onNew}>Đơn mới</DropdownMenuItem>
              <DropdownMenuItem className="min-h-11" disabled={empty} onClick={p.onProvisional}><Printer aria-hidden /> In tạm tính</DropdownMenuItem>
              {cart.orderId != null && <DropdownMenuItem variant="destructive" className="min-h-11" disabled={offline} onClick={p.onVoid}>Huỷ đơn này</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <ul aria-label="Món trong đơn" className="divide-y divide-ax-divider">
          {empty && (
            <li className="px-6 py-12 text-center text-[15px] leading-normal text-ax-ink-2">
              <span aria-hidden className="mx-auto mb-3 grid size-[72px] place-items-center rounded-full ax-grad-empty"><Receipt className="size-7 text-ax-ink-3" strokeWidth={1.75} /></span>
              Đơn chưa có món.<br />Bấm Thêm món để quay lại thực đơn.
            </li>
          )}
          {cart.lines.map((l) => (
            <li key={l.key} className="flex items-center gap-3 px-4 py-3">
              <button type="button" onClick={() => p.onEditLine(l.key)} aria-label={`Sửa ${l.name}`} className="min-h-11 min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-[17px] font-semibold tracking-[-0.011em] text-ax-ink">{l.name}</span>
                  <span className="ax-amount shrink-0 text-[17px] font-semibold text-ax-ink">{vnd(lineTotal(l))}</span>
                </div>
                <div className="text-[14px] text-ax-ink-2">
                  {[...l.options.map((o) => o.name), l.note].filter(Boolean).join(" · ") || `${vnd(lineUnitPrice(l))} / món`}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" variant="ax-secondary" className="size-11" aria-label={`Giảm ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: changeQty(c.lines, l.key, -1) }))}><Minus /></Button>
                <span className="ax-amount w-6 text-center text-[17px] font-bold">{l.quantity}</span>
                <Button type="button" variant="ax-secondary" className="size-11" aria-label={`Tăng ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: changeQty(c.lines, l.key, 1) }))}><Plus /></Button>
              </div>
            </li>
          ))}
        </ul>
        <div className="px-4 py-3">
          <Input variant="ax" value={cart.note} maxLength={500} onChange={(e) => setCart((c) => ({ ...c, note: e.target.value }))} placeholder="Ghi chú đơn…" aria-label="Ghi chú đơn" className="h-11" />
        </div>
      </div>

      <div data-slot="pos-order-total" className="flex shrink-0 flex-col gap-3.5 rounded-t-[22px] border-t border-[var(--ax-hero-border)] ax-grad-hero px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4 text-white shadow-[var(--ax-shadow-hero)]">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Giảm giá">
          <span className="mr-1 text-[15px] text-[var(--ax-on-hero-ink-2)]">Giảm giá</span>
          <button type="button" aria-pressed={cart.discountType === "none"} className={chip(cart.discountType === "none")} onClick={() => { setCustom(false); setDiscount("none", 0) }}>Không</button>
          {QUICK.map((n) => (
            <button key={n} type="button" aria-pressed={quickOn(n)} className={chip(quickOn(n))} onClick={() => { setCustom(false); setDiscount("percent", n) }}>{n}%</button>
          ))}
          <button type="button" aria-pressed={showCustom} className={chip(showCustom)} onClick={() => setCustom(true)}>Khác</button>
        </div>
        {showCustom && (
          <div className="flex items-center gap-2">
            {(["percent", "amount"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={customType === k} aria-label={k === "percent" ? "Giảm theo phần trăm" : "Giảm theo số tiền"} className={chip(customType === k)} onClick={() => setDiscount(k, cart.discountType === k ? cart.discountValue : 0)}>{k === "percent" ? "%" : "₫"}</button>
            ))}
            <MoneyInput className="flex-1" value={cart.discountValue || null} placeholder={customType === "percent" ? "0-100" : "0"}
              onChange={(v) => setCart((c) => {
                const type = c.discountType === "none" ? "amount" : c.discountType
                return { ...c, discountType: type, discountValue: Math.min(v ?? 0, type === "percent" ? 100 : 1_000_000_000) }
              })} />
          </div>
        )}
        <div className="flex items-baseline justify-between">
          <span className="text-[16px] font-semibold tracking-[-0.011em]">Tổng cộng <span className="ax-amount text-[13px] font-normal text-[var(--ax-on-hero-ink-2)]">· {cartCount(cart.lines)} món{t.discount > 0 ? ` · giảm ${vnd(t.discount)}` : ""}</span></span>
          <span className="ax-amount text-[40px] font-bold leading-[1.1]">{vnd(t.total)}</span>
        </div>
        {offline && <p role="status" className="text-sm text-white">Đang mất mạng — chưa lưu / thu tiền được. Giỏ hàng vẫn giữ nguyên, có mạng lại thì bấm tiếp.</p>}
        <div className="flex gap-2.5">
          <Button type="button" variant="ax-on-hero-secondary" className="h-14 shrink-0 px-5 text-[16px]" aria-label="Thu sau (lưu đơn)" disabled={empty || p.busy || offline} onClick={p.onSave}>Thu sau</Button>
          <Button type="button" variant="ax-on-hero" className="h-14 flex-1 text-[17px]" disabled={empty || p.busy || offline} onClick={p.onPay}>Thanh toán</Button>
        </div>
      </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
