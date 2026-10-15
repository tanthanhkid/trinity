"use client"

import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useIsPhone } from "@/hooks/use-is-phone"
import apiClient from "@/lib/api-client"
import {
  useCreateOrder, usePosAreas, usePosMenu, usePosModifiers, usePosTables, useUpdateOrder,
} from "@/hooks/pos/use-pos"
import {
  addLine, cartFromOrder, EMPTY_CART, editLine, toWritePayload, type CartState,
} from "@/lib/pos-cart"
import { posErrorMessage } from "@/lib/pos-format"
import { receiptFromCart, receiptFromOrder } from "@/lib/pos-receipt"
import type { PosMenuProduct, PosOrder, PosTable } from "@/types/pos"
import { PosCartBar } from "./pos-cart-bar"
import { PosCartPanel } from "./pos-cart-panel"
import { PosItemDialog } from "./pos-item-dialog"
import { PosMenuGrid } from "./pos-menu-grid"
import { PosOpenOrdersBar } from "./pos-open-orders-bar"
import { PosPaymentDialog } from "./pos-payment-dialog"
import { usePosPrint } from "./pos-receipt"
import { PosTableDialog } from "./pos-table-dialog"
import { PosVoidDialog } from "./pos-void-dialog"

/** Màn bán hàng: lưới món (trái) + giỏ (phải). Giỏ là bản nháp cục bộ; "Lưu đơn"/"Thanh toán" ghi lên BE (BE tính lại tiền). */
export function PosSell() {
  const menuQ = usePosMenu()
  const modsQ = usePosModifiers()
  const tablesQ = usePosTables()
  const areasQ = usePosAreas()
  const create = useCreateOrder()
  const update = useUpdateOrder()
  const print = usePosPrint()
  const isPhone = useIsPhone()
  const [cartOpen, setCartOpen] = useState(false)

  const [cart, setCart] = useState<CartState>(EMPTY_CART)
  // Bản chụp giỏ ở lần nạp/lưu gần nhất — lệch với giỏ hiện tại = còn thay đổi chưa lưu.
  const baseline = useRef(JSON.stringify(EMPTY_CART))
  /** Thay giỏ bằng bản mới (đơn đã lưu/giỏ trống) và coi đó là mốc "chưa sửa gì". */
  const loadCart = (next: CartState) => { baseline.current = JSON.stringify(next); setCart(next) }
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null)
  /** Thay giỏ có thể làm mất thay đổi chưa lưu → hỏi trước (ConfirmDialog); giỏ chưa sửa thì chạy luôn. */
  const guardDiscard = (action: () => void) => {
    if (JSON.stringify(cart) === baseline.current) action()
    else setPendingDiscard(() => action)
  }
  const [picking, setPicking] = useState<PosMenuProduct | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const [payOrder, setPayOrder] = useState<PosOrder | null>(null)
  const [voiding, setVoiding] = useState(false)

  const mods = useMemo(() => (modsQ.data ?? []).filter((m) => m.is_active), [modsQ.data])
  const tables = useMemo(() => tablesQ.data ?? [], [tablesQ.data])
  const tableName = tables.find((t) => t.id === cart.tableId)?.name ?? null
  const busy = create.isPending || update.isPending

  const pick = (p: PosMenuProduct) => {
    if (mods.length === 0) setCart((c) => ({ ...c, lines: addLine(c.lines, p) }))
    else setPicking(p)
  }

  /** Lưu (tạo mới hoặc sửa đơn đang mở) rồi nạp lại giỏ từ số liệu BE. Trả đơn hoặc null nếu lỗi. */
  const save = async (): Promise<PosOrder | null> => {
    try {
      const body = toWritePayload(cart)
      const order = cart.orderId == null ? await create.mutateAsync(body) : await update.mutateAsync({ id: cart.orderId, body })
      loadCart(cartFromOrder(order))
      return order
    } catch (e) {
      toast.error(posErrorMessage(e, "Không lưu được đơn"))
      return null
    }
  }

  const fetchOrderIntoCart = async (id: number) => {
    try {
      const { data } = await apiClient.get<PosOrder>(`/pos/orders/${id}`)
      loadCart(cartFromOrder(data))
    } catch (e) {
      toast.error(posErrorMessage(e))
    }
  }
  const loadOrderById = (id: number) => guardDiscard(() => { void fetchOrderIntoCart(id) })

  const pickTable = (t: PosTable) => {
    setTableOpen(false)
    if (t.open_order && t.open_order.id !== cart.orderId) {
      if (cart.lines.length > 0 && cart.orderId == null) {
        toast.error(`Bàn ${t.name} đang có đơn ${t.open_order.code}. Lưu hoặc thanh toán đơn hiện tại trước, hoặc chọn đơn từ dải "Đơn đang mở".`)
        return
      }
      loadOrderById(t.open_order.id)
      return
    }
    setCart((c) => ({ ...c, tableId: t.id, orderType: "dine_in" }))
  }

  const doSave = async () => { if (await save()) toast.success("Đã lưu đơn") }
  const doPay = async () => { const o = await save(); if (o) setPayOrder(o) }
  const editing = editKey ? cart.lines.find((l) => l.key === editKey) : undefined

  if (menuQ.isLoading) return <div className="flex justify-center p-10"><Loader2 className="animate-spin" aria-label="Đang tải" /></div>
  if (menuQ.isError || !menuQ.data) return <p role="alert" className="p-6 text-sm text-destructive">Không tải được thực đơn. Thử tải lại trang.</p>

  const cartPanel = (inSheet: boolean) => (
    <PosCartPanel
      cart={cart} setCart={setCart} tableName={tableName} busy={busy} inSheet={inSheet}
      onEditLine={setEditKey} onOpenTable={() => setTableOpen(true)} onNew={() => guardDiscard(() => loadCart(EMPTY_CART))}
      onSave={doSave} onPay={doPay}
      onProvisional={() => print(receiptFromCart(cart, tableName))}
      onVoid={() => setVoiding(true)}
    />
  )

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-15rem)] lg:min-h-[520px]">
      <PosOpenOrdersBar currentId={cart.orderId} tables={tables} onPick={(o) => guardDiscard(() => loadCart(cartFromOrder(o)))} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <PosMenuGrid menu={menuQ.data} onPick={pick} />
        {!isPhone && cartPanel(false)}
      </div>
      {isPhone && (
        <>
          <PosCartBar cart={cart} busy={busy} onOpen={() => setCartOpen(true)} onSave={doSave} onPay={doPay} />
          {/* Một hộp thoại con (chọn bàn/sửa món/thanh toán/huỷ) mở thì nhường chỗ — đóng xong giỏ hiện lại. */}
          <Sheet open={cartOpen && !payOrder && !tableOpen && !editing && !voiding} onOpenChange={setCartOpen}>
            <SheetContent side="bottom" className="max-h-[90dvh] gap-0 rounded-t-2xl">
              <SheetTitle className="sr-only">Giỏ hàng</SheetTitle>
              {cartPanel(true)}
            </SheetContent>
          </Sheet>
        </>
      )}

      {picking && (
        <PosItemDialog
          title={picking.name} basePrice={picking.price} modifiers={mods}
          onClose={() => setPicking(null)}
          onConfirm={(r) => { setCart((c) => ({ ...c, lines: addLine(c.lines, picking, r.options, r.quantity, r.note) })); setPicking(null) }}
        />
      )}
      {editing && (
        <PosItemDialog
          title={editing.name} basePrice={editing.unit_price} modifiers={mods}
          initial={{ optionIds: editing.options.map((o) => o.id), quantity: editing.quantity, note: editing.note }}
          onClose={() => setEditKey(null)}
          onConfirm={(r) => {
            setCart((c) => ({ ...c, lines: editLine(c.lines, editing.key, {
              note: r.note, quantity: r.quantity,
              options: r.options.map((o) => ({ id: o.id, group_name: o.group_name, name: o.name, price_delta: o.price_delta })),
            }) }))
            setEditKey(null)
          }}
        />
      )}
      {tableOpen && (
        <PosTableDialog
          areas={areasQ.data ?? []} tables={tables} currentTableId={cart.tableId}
          onPickTable={pickTable} onClose={() => setTableOpen(false)}
          onTakeaway={() => { setCart((c) => ({ ...c, orderType: "takeaway", tableId: null })); setTableOpen(false) }}
        />
      )}
      {payOrder && (
        <PosPaymentDialog
          order={payOrder}
          onClose={() => { const done = payOrder.status === "paid"; setPayOrder(null); if (done) loadCart(EMPTY_CART) }}
          onPaid={(o) => { setPayOrder(o); loadCart(EMPTY_CART); setCartOpen(false) }}
          onPrint={(o) => print(receiptFromOrder(o, tables.find((t) => t.id === o.table_id)?.name ?? null))}
        />
      )}
      <ConfirmDialog
        open={pendingDiscard !== null}
        onOpenChange={(o) => !o && setPendingDiscard(null)}
        tone="destructive"
        title="Bỏ thay đổi chưa lưu?"
        description="Giỏ hàng hiện tại có thay đổi chưa lưu. Tiếp tục sẽ mất các thay đổi đó."
        confirmLabel="Bỏ thay đổi"
        onConfirm={() => { const run = pendingDiscard; setPendingDiscard(null); run?.() }}
      />
      {voiding && cart.orderId != null && (
        <PosVoidDialog orderId={cart.orderId} code={cart.orderCode ?? ""} onClose={() => setVoiding(false)} onVoided={() => { setVoiding(false); loadCart(EMPTY_CART) }} />
      )}
    </div>
  )
}
