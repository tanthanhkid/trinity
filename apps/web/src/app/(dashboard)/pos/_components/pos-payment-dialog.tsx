"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import QRCode from "react-qr-code"
import { toast } from "sonner"
import { Banknote, CheckCircle2, Landmark, Printer, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useOffline } from "@/components/offline-banner"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { fetchPosQr, usePayOrder } from "@/hooks/pos/use-pos"
import { cashSuggestions } from "@/lib/pos-cart"
import { posErrorMessage, vnd } from "@/lib/pos-format"
import type { PosOrder, PosPaymentInput, PosPaymentMethod } from "@/types/pos"
import { MoneyInput } from "./money-input"

interface Line { id: number; method: PosPaymentMethod; amount: number | null; tendered: number | null; confirmed: boolean }
let seq = 0

function QrBox({ orderId, amount }: { orderId: number; amount: number }) {
  const q = useQuery({ queryKey: ["pos", "qr", orderId, amount], queryFn: () => fetchPosQr(orderId, amount), staleTime: 60_000 })
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Đang tạo mã QR…</p>
  if (q.isError) return <p role="alert" className="text-sm text-destructive">{posErrorMessage(q.error, "Chưa cấu hình tài khoản nhận tiền")}</p>
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border bg-background p-3">
      <div className="rounded-md bg-white p-2"><QRCode value={q.data!.payload} size={176} /></div>
      <p className="text-center text-xs text-muted-foreground">{q.data!.account_name} · {q.data!.account_no}<br />Nội dung: <b className="text-foreground">{q.data!.content}</b></p>
    </div>
  )
}

interface Props { order: PosOrder; onClose: () => void; onPaid: (o: PosOrder) => void; onPrint: (o: PosOrder) => void }

/** Thanh toán: tiền mặt (gợi ý mệnh giá + tiền thối), chuyển khoản (QR VietQR), hoặc chia nhiều dòng. Tổng do BE tính lại và đối chiếu. */
export function PosPaymentDialog({ order, onClose, onPaid, onPrint }: Props) {
  const pay = usePayOrder()
  const offline = useOffline()
  const [paid, setPaid] = useState<PosOrder | null>(null)
  const [lines, setLines] = useState<Line[]>(() => (order.total > 0 ? [{ id: ++seq, method: "cash", amount: order.total, tendered: null, confirmed: false }] : []))
  const sum = lines.reduce((s, l) => s + (l.amount ?? 0), 0)
  const remaining = order.total - sum
  const patch = (id: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)))
  const add = (method: PosPaymentMethod) => remaining > 0 && setLines((ls) => [...ls, { id: ++seq, method, amount: remaining, tendered: null, confirmed: false }])
  const valid = remaining === 0 && lines.every((l) => (l.amount ?? 0) > 0 && (l.method === "bank_transfer" ? l.confirmed : (l.tendered ?? l.amount!) >= l.amount!))

  const submit = () => {
    const payments: PosPaymentInput[] = lines.map((l) => ({
      method: l.method, amount: l.amount!, ...(l.method === "cash" ? { tendered: l.tendered ?? l.amount! } : {}),
    }))
    pay.mutate({ id: order.id, payments }, {
      onSuccess: (o) => { setPaid(o); onPaid(o) },
      onError: (e) => toast.error(posErrorMessage(e, "Thanh toán thất bại")),
    })
  }

  if (paid) {
    const change = paid.payments.reduce((s, p) => s + p.change, 0)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><CheckCircle2 className="text-emerald-700" aria-hidden /> Đã thanh toán</DialogTitle></DialogHeader>
          <div className="space-y-1 text-center">
            <p className="text-sm text-muted-foreground">Đơn {paid.code}</p>
            <p className="text-2xl font-bold tabular-nums">{vnd(paid.total)}</p>
            {change > 0 && <p className="text-lg font-semibold text-foreground">Tiền thối: <span className="tabular-nums">{vnd(change)}</span></p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11 gap-1.5" onClick={() => onPrint(paid)}><Printer aria-hidden /> In hoá đơn</Button>
            <Button type="button" className="min-h-11" onClick={onClose}>Xong</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pay.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Thanh toán · {order.code}</DialogTitle></DialogHeader>
        <div className="flex items-baseline justify-between rounded-lg bg-muted px-3 py-2">
          <span className="text-sm font-medium">Cần thu</span>
          <span className="text-2xl font-bold tabular-nums text-foreground">{vnd(order.total)}</span>
        </div>
        {lines.map((l) => {
          const change = l.method === "cash" ? Math.max(0, (l.tendered ?? l.amount ?? 0) - (l.amount ?? 0)) : 0
          return (
            <div key={l.id} className="space-y-2 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  {l.method === "cash" ? <Banknote className="size-4" aria-hidden /> : <Landmark className="size-4" aria-hidden />}
                  {l.method === "cash" ? "Tiền mặt" : "Chuyển khoản"}
                </span>
                {lines.length > 1 && <button type="button" aria-label="Xoá dòng thanh toán" onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))} className="grid size-11 place-items-center rounded-md text-destructive hover:bg-muted"><Trash2 className="size-4" /></button>}
              </div>
              <MoneyInput value={l.amount} onChange={(v) => patch(l.id, { amount: v, confirmed: false })} />
              {l.method === "cash" && (l.amount ?? 0) > 0 && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant={l.tendered == null ? "soft" : "outline"} aria-pressed={l.tendered == null} className="min-h-11" onClick={() => patch(l.id, { tendered: null })}>Đủ tiền</Button>
                    {cashSuggestions(l.amount!).map((n) => (
                      <Button key={n} type="button" variant={l.tendered === n ? "soft" : "outline"} aria-pressed={l.tendered === n} className="min-h-11 tabular-nums" onClick={() => patch(l.id, { tendered: n })}>{vnd(n)}</Button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-sm text-foreground">Khách đưa</span>
                    <MoneyInput value={l.tendered ?? l.amount} onChange={(v) => patch(l.id, { tendered: v })} />
                  </div>
                  <p className={cn("text-sm font-semibold", (l.tendered ?? l.amount!) < l.amount! ? "text-destructive" : "text-foreground")}>
                    {(l.tendered ?? l.amount!) < l.amount! ? "Khách đưa chưa đủ" : `Tiền thối: ${vnd(change)}`}
                  </p>
                </>
              )}
              {l.method === "bank_transfer" && (l.amount ?? 0) > 0 && (
                <>
                  <QrBox orderId={order.id} amount={l.amount!} />
                  <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
                    <input type="checkbox" className="size-5" checked={l.confirmed} onChange={(e) => patch(l.id, { confirmed: e.target.checked })} />
                    Đã nhận đủ tiền chuyển khoản
                  </label>
                </>
              )}
            </div>
          )
        })}
        {remaining > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-destructive">Còn thiếu {vnd(remaining)}</span>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => add("cash")}>+ Tiền mặt</Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => add("bank_transfer")}>+ Chuyển khoản</Button>
          </div>
        )}
        {remaining < 0 && <p role="alert" className="text-sm font-medium text-destructive">Tổng thanh toán vượt {vnd(-remaining)} so với tổng đơn</p>}
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11" disabled={pay.isPending} onClick={onClose}>Quay lại</Button>
          <Button type="button" className="min-h-11 text-base" disabled={!valid || pay.isPending || offline} onClick={submit}>
            {pay.isPending ? "Đang xử lý…" : "Xác nhận thanh toán"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
