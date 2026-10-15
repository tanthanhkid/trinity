"use client"

import type { Dispatch, SetStateAction } from "react"
import { Armchair, MoreHorizontal, Minus, Plus, Printer, ShoppingBag, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  /** Điện thoại: giỏ nằm trong bảng trượt đáy (CÙNG component này, không nhân bản) — bỏ viền, "Huỷ đơn" vào menu "⋯", chừa chỗ nút đóng của bảng. */
  inSheet?: boolean
}

const DISCOUNT_TABS: Array<{ v: PosDiscountType; label: string }> = [
  { v: "none", label: "Không" }, { v: "percent", label: "%" }, { v: "amount", label: "đ" },
]

/** Giỏ hàng bên phải: loại đơn/bàn, dòng món (+/−), giảm giá, ghi chú, tổng (xem trước) và các nút thao tác. */
export function PosCartPanel(p: Props) {
  const { cart, setCart } = p
  const t = cartTotals(cart)
  const empty = cart.lines.length === 0
  const setOrderType = (orderType: "dine_in" | "takeaway") =>
    setCart((c) => ({ ...c, orderType, tableId: orderType === "takeaway" ? null : c.tableId }))

  return (
    <aside aria-label="Giỏ hàng" className={cn("flex min-h-0 w-full flex-col bg-card lg:w-[390px] lg:shrink-0", p.inSheet ? "flex-1" : "rounded-xl border")}>
      <div className={cn("flex items-center justify-between gap-2 border-b p-3", p.inSheet && "pr-14")}>
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-foreground">{cart.orderCode ? `Đơn ${cart.orderCode}` : "Đơn mới"}</h2>
          <p className="text-xs text-muted-foreground">{cartCount(cart.lines)} món</p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" className="min-h-11" onClick={p.onNew}>{p.inSheet ? "Mới" : "Đơn mới"}</Button>
          {p.inSheet && cart.orderId != null && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="Thao tác khác" disabled={p.busy} />}>
                <MoreHorizontal aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" className="min-h-11" onClick={p.onVoid}>Huỷ đơn này</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b p-3">
        <Button type="button" variant={cart.orderType === "dine_in" ? "soft" : "outline"} aria-pressed={cart.orderType === "dine_in"} className="min-h-11 gap-1.5" onClick={p.onOpenTable}>
          <Armchair aria-hidden /> {cart.tableId && p.tableName ? `Bàn ${p.tableName}` : "Chọn bàn"}
        </Button>
        <Button type="button" variant={cart.orderType === "takeaway" ? "soft" : "outline"} aria-pressed={cart.orderType === "takeaway"} className="min-h-11 gap-1.5" onClick={() => setOrderType("takeaway")}>
          <ShoppingBag aria-hidden /> Mang đi
        </Button>
      </div>

      <ul className="min-h-[120px] flex-1 divide-y overflow-y-auto">
        {empty && <li className="p-6 text-center text-sm text-muted-foreground">Chạm vào món để thêm vào đơn.</li>}
        {cart.lines.map((l) => (
          <li key={l.key} className="flex items-start gap-2 p-3 max-sm:flex-wrap">
            <button type="button" onClick={() => p.onEditLine(l.key)} className="min-w-0 flex-1 rounded-md text-left max-sm:basis-full focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Sửa ${l.name}`}>
              <div className="text-sm font-semibold text-foreground">{l.name}</div>
              {(l.options.length > 0 || l.note) && (
                <div className="text-xs text-muted-foreground">{[...l.options.map((o) => o.name), l.note].filter(Boolean).join(" · ")}</div>
              )}
              <div className="text-xs tabular-nums text-muted-foreground">{vnd(lineUnitPrice(l))}</div>
            </button>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" className="size-11" aria-label={`Giảm ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: changeQty(c.lines, l.key, -1) }))}><Minus /></Button>
              <span className="w-7 text-center text-sm font-bold tabular-nums">{l.quantity}</span>
              <Button type="button" variant="outline" className="size-11" aria-label={`Tăng ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: changeQty(c.lines, l.key, 1) }))}><Plus /></Button>
            </div>
            <div className="flex w-20 flex-col items-end gap-1 max-sm:ml-auto max-sm:w-auto max-sm:flex-row max-sm:items-center">
              <span className="text-sm font-bold tabular-nums text-foreground">{vnd(lineTotal(l))}</span>
              <button type="button" aria-label={`Xoá ${l.name}`} onClick={() => setCart((c) => ({ ...c, lines: removeLine(c.lines, l.key) }))} className="grid size-8 place-items-center rounded-md text-destructive hover:bg-muted max-sm:size-11"><Trash2 className="size-4" /></button>
            </div>
          </li>
        ))}
      </ul>

      <div className={cn("space-y-2 border-t p-3", p.inSheet && "pb-[calc(0.75rem+env(safe-area-inset-bottom))]")}>
        <div className="flex items-center gap-2 max-sm:flex-wrap">
          <span className="text-sm font-medium text-foreground">Giảm giá</span>
          <div className="flex overflow-hidden rounded-lg border" role="group" aria-label="Loại giảm giá">
            {DISCOUNT_TABS.map((d) => (
              <button key={d.v} type="button" aria-pressed={cart.discountType === d.v}
                onClick={() => setCart((c) => ({ ...c, discountType: d.v, discountValue: d.v === c.discountType ? c.discountValue : 0 }))}
                className={cn("min-h-11 min-w-11 px-3 text-sm font-semibold", cart.discountType === d.v ? "bg-primary/10 text-[var(--color-app-primary-ink)]" : "bg-background text-foreground hover:bg-muted")}>
                {d.label}
              </button>
            ))}
          </div>
          {cart.discountType !== "none" && (
            <MoneyInput className="flex-1 max-sm:basis-full" value={cart.discountValue || null} placeholder={cart.discountType === "percent" ? "0-100" : "0"}
              onChange={(v) => setCart((c) => ({ ...c, discountValue: Math.min(v ?? 0, c.discountType === "percent" ? 100 : 1_000_000_000) }))} />
          )}
        </div>
        <Input value={cart.note} maxLength={500} onChange={(e) => setCart((c) => ({ ...c, note: e.target.value }))} placeholder="Ghi chú đơn…" aria-label="Ghi chú đơn" className="h-11" />
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between text-muted-foreground"><dt>Tạm tính</dt><dd className="tabular-nums">{vnd(t.subtotal)}</dd></div>
          {t.discount > 0 && <div className="flex justify-between text-muted-foreground"><dt>Giảm giá</dt><dd className="tabular-nums">-{vnd(t.discount)}</dd></div>}
          <div className="flex justify-between text-lg font-bold text-foreground"><dt>Tổng cộng</dt><dd className="tabular-nums">{vnd(t.total)}</dd></div>
        </dl>
        <div className="grid grid-cols-[auto_auto_1fr] gap-2">
          <Button type="button" variant="outline" className="size-11" aria-label="In tạm tính" disabled={empty} onClick={p.onProvisional}><Printer /></Button>
          <Button type="button" variant="outline" className="min-h-11" disabled={empty || p.busy} onClick={p.onSave}>Lưu đơn</Button>
          <Button type="button" className="min-h-11 text-base" disabled={empty || p.busy} onClick={p.onPay}>Thanh toán</Button>
        </div>
        {cart.orderId != null && !p.inSheet && (
          <Button type="button" variant="destructive" className="min-h-11 w-full" disabled={p.busy} onClick={p.onVoid}>Huỷ đơn này</Button>
        )}
      </div>
    </aside>
  )
}
