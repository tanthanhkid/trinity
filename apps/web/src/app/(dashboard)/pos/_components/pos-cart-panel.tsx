"use client"

import type { Dispatch, SetStateAction } from "react"
import { Armchair, Minus, Plus, Printer, Receipt, ShoppingBag, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HeroCard } from "@/components/ui/hero-card"
import { useOffline } from "@/components/offline-banner"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { vnd } from "@/lib/pos-format"
import { cartCount, cartTotals, changeQty, lineTotal, lineUnitPrice, removeLine, type CartState } from "@/lib/pos-cart"
import type { PosDiscountType } from "@/types/pos"
import { MoneyInput } from "./money-input"

interface Props {
  cart: CartState
  setCart: Dispatch<SetStateAction<CartState>>
  tableName: string | null
  busy: boolean
  onEditLine: (key: string) => void
  onOpenTable: () => void
  onPay: () => void
  onSave: () => void
  onProvisional: () => void
  onVoid: () => void
  onNew: () => void
}

const DISCOUNT_TABS: Array<{ v: PosDiscountType; label: string }> = [
  { v: "none", label: "Không" }, { v: "percent", label: "%" }, { v: "amount", label: "₫" },
]

/** Giỏ hàng bên phải: loại đơn/bàn, dòng món (+/−), giảm giá, ghi chú, tổng (xem trước) và các nút thao tác. */
export function PosCartPanel(p: Props) {
  const { cart, setCart } = p
  const t = cartTotals(cart)
  const empty = cart.lines.length === 0
  // Mất mạng: lưu / thu tiền / huỷ không tới được máy chủ — khoá nút, giỏ hàng vẫn giữ nguyên.
  const offline = useOffline()
  const setOrderType = (orderType: "dine_in" | "takeaway") =>
    setCart((c) => ({ ...c, orderType, tableId: orderType === "takeaway" ? null : c.tableId }))

  return (
    <aside aria-label="Giỏ hàng" className="flex min-h-0 w-full flex-col rounded-ax-sheet border border-ax-line bg-ax-surface ax-grad-card shadow-ax-card overflow-hidden lg:w-[420px] lg:shrink-0">
      <div className="flex items-center justify-between gap-2 border-b border-ax-divider px-4 py-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[17px] font-bold tracking-[-0.011em] text-ax-ink">{cart.orderCode ? `Đơn ${cart.orderCode}` : "Đơn mới"}</h2>
          <p className="ax-amount text-[13px] text-ax-ink-2">{cartCount(cart.lines)} món</p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ax-secondary" size="ax" className="min-h-11 text-ax-ink-2" onClick={p.onNew}>Đơn mới</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-ax-divider px-4 py-3">
        <Button type="button" variant={cart.orderType === "dine_in" ? "soft" : "ax-secondary"} aria-pressed={cart.orderType === "dine_in"} className="h-12 gap-1.5 text-[15px]" onClick={p.onOpenTable}>
          <Armchair aria-hidden /> {cart.tableId && p.tableName ? `Bàn ${p.tableName}` : "Chọn bàn"}
        </Button>
        <Button type="button" variant={cart.orderType === "takeaway" ? "soft" : "ax-secondary"} aria-pressed={cart.orderType === "takeaway"} className="h-12 gap-1.5 text-[15px]" onClick={() => setOrderType("takeaway")}>
          <ShoppingBag aria-hidden /> Mang đi
        </Button>
      </div>

      <ul className="min-h-[120px] flex-1 divide-y divide-ax-divider overflow-y-auto">
        {empty && <li className="px-6 py-12 text-center text-[15px] leading-normal text-ax-ink-2"><span aria-hidden className="mx-auto mb-3 grid size-[72px] place-items-center rounded-full ax-grad-empty"><Receipt className="size-7 text-ax-ink-3" strokeWidth={1.75} /></span>Đơn chưa có món.<br />Chạm vào món để thêm vào đơn.</li>}
        {cart.lines.map((l) => (
          <li key={l.key} className="flex items-start gap-2 px-4 py-2.5 max-sm:flex-wrap">
            <button type="button" onClick={() => p.onEditLine(l.key)} className="min-h-11 min-w-0 flex-1 rounded-md text-left max-sm:basis-full focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]" aria-label={`Sửa ${l.name}`}>
              <div className="text-[15px] font-semibold tracking-[-0.011em] text-ax-ink">{l.name}</div>
              {(l.options.length > 0 || l.note) && (
                <div className="text-[13px] text-ax-ink-2">{[...l.options.map((o) => o.name), l.note].filter(Boolean).join(" · ")}</div>
              )}
              <div className="ax-amount text-[13px] text-ax-ink-2">{vnd(lineUnitPrice(l))}</div>
            </button>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ax-secondary" className="size-11" aria-label={`Giảm ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: changeQty(c.lines, l.key, -1) }))}><Minus /></Button>
              <span className="ax-amount w-7 text-center text-[17px] font-bold">{l.quantity}</span>
              <Button type="button" variant="ax-secondary" className="size-11" aria-label={`Tăng ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: changeQty(c.lines, l.key, 1) }))}><Plus /></Button>
            </div>
            <div className="flex w-20 flex-col items-end gap-1 max-sm:ml-auto max-sm:w-auto max-sm:flex-row max-sm:items-center">
              <span className="ax-amount text-[15px] font-bold text-ax-ink">{vnd(lineTotal(l))}</span>
              <button type="button" aria-label={`Xoá ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: removeLine(c.lines, l.key) }))} className="grid size-8 place-items-center rounded-md text-ax-danger hover:bg-ax-danger-soft max-sm:size-11"><Trash2 className="size-4" /></button>
            </div>
          </li>
        ))}
      </ul>

      <div className="space-y-2.5 border-t border-ax-divider px-4 pb-4 pt-3">
        <div className="flex items-center gap-2 max-sm:flex-wrap">
          <span className="w-[72px] text-sm text-ax-ink-2">Giảm giá</span>
          <div className="flex gap-1.5" role="group" aria-label="Loại giảm giá">
            {DISCOUNT_TABS.map((d) => (
              <button key={d.v} type="button" aria-pressed={cart.discountType === d.v}
                onClick={() => setCart((c) => ({ ...c, discountType: d.v, discountValue: d.v === c.discountType ? c.discountValue : 0 }))}
                className={cn("min-h-11 min-w-14 rounded-ax-field border-[1.5px] px-3 text-sm font-semibold focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]", cart.discountType === d.v ? "border-ax-primary bg-ax-primary-soft text-ax-primary-ink" : "border-ax-line bg-ax-surface text-ax-ink hover:bg-ax-hover")}>
                {d.label}
              </button>
            ))}
          </div>
          {cart.discountType !== "none" && (
            <MoneyInput className="flex-1 max-sm:basis-full" value={cart.discountValue || null} placeholder={cart.discountType === "percent" ? "0-100" : "0"}
              onChange={(v) => setCart((c) => ({ ...c, discountValue: Math.min(v ?? 0, c.discountType === "percent" ? 100 : 1_000_000_000) }))} />
          )}
        </div>
        <Input variant="ax" value={cart.note} maxLength={500} onChange={(e) => setCart((c) => ({ ...c, note: e.target.value }))} placeholder="Ghi chú đơn…" aria-label="Ghi chú đơn" className="h-11" />
        <HeroCard compact className="flex flex-col gap-3.5 p-4">
          <dl className="space-y-1.5 text-sm text-[var(--ax-on-hero-ink-2)]">
            <div className="flex justify-between"><dt>Tạm tính</dt><dd className="ax-amount">{vnd(t.subtotal)}</dd></div>
            {t.discount > 0 && <div className="flex justify-between"><dt>Giảm giá</dt><dd className="ax-amount">-{vnd(t.discount)}</dd></div>}
            <div className="flex items-baseline justify-between text-white">
              <dt className="text-base font-semibold tracking-[-0.011em]">Tổng cộng</dt>
              <dd className="ax-amount text-[34px] font-bold leading-[1.1]">{vnd(t.total)}</dd>
            </div>
          </dl>
          <Button type="button" variant="ax-on-hero" className="h-[58px] text-lg" disabled={empty || p.busy || offline} onClick={p.onPay}>Thanh toán</Button>
        </HeroCard>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button type="button" variant="ax-secondary" className="min-h-11" disabled={empty || p.busy || offline} onClick={p.onSave}>Lưu đơn</Button>
          <Button type="button" variant="ax-secondary" className="size-11" aria-label="In tạm tính" disabled={empty} onClick={p.onProvisional}><Printer /></Button>
        </div>
        {offline && <p role="status" className="text-sm text-[var(--color-app-tag-amber-ink)]">Đang mất mạng — chưa lưu / thu tiền được. Giỏ hàng vẫn giữ nguyên, có mạng lại thì bấm tiếp.</p>}
        {cart.orderId != null && (
          <Button type="button" variant="ax-danger" className="min-h-11 w-full" disabled={p.busy || offline} onClick={p.onVoid}>Huỷ đơn này</Button>
        )}
      </div>
    </aside>
  )
}
