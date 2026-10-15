"use client"

import { useState } from "react"
import { useForm, useWatch, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useCloseShift, useOpenShift } from "@/hooks/pos/use-pos"
import { formatDateTimeVn } from "@/lib/format"
import { posErrorMessage, vnd } from "@/lib/pos-format"
import type { PosShift, PosShiftSummary } from "@/types/pos"
import { MoneyInput } from "./money-input"

const openSchema = z.object({ opening_cash: z.number({ message: "Nhập tiền đầu ca (nhập 0 nếu không có)" }).int().min(0) })
type OpenForm = z.infer<typeof openSchema>

/** Mở ca: nhập tiền đầu ca (tiền lẻ để sẵn trong két). Chưa có ca thì không bán được. */
export function PosOpenShiftCard() {
  const open = useOpenShift()
  const { control, handleSubmit, formState: { errors } } = useForm<OpenForm>({ resolver: zodResolver(openSchema) })
  const submit = handleSubmit(({ opening_cash }) =>
    open.mutate(opening_cash, {
      onSuccess: () => toast.success("Đã mở ca"),
      onError: (e) => toast.error(posErrorMessage(e, "Không mở được ca")),
    }),
  )
  return (
    <form onSubmit={submit} className="mx-auto max-w-sm space-y-4 rounded-[var(--radius)] border bg-card p-5">
      <h2 className="text-lg font-bold text-foreground">Mở ca làm việc</h2>
      <p className="text-sm text-muted-foreground">Nhập số tiền mặt có trong két lúc bắt đầu ca để cuối ca đối soát.</p>
      <div className="space-y-1.5">
        <Label htmlFor="pos-opening-cash">Tiền đầu ca (đ)</Label>
        <Controller control={control} name="opening_cash" render={({ field }) => (
          <MoneyInput id="pos-opening-cash" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} autoFocus />
        )} />
        {errors.opening_cash && <p role="alert" className="text-sm text-destructive">{errors.opening_cash.message}</p>}
      </div>
      <MobileActionBar className="mb-0">
        <Button type="submit" className="min-h-11 w-full text-base" disabled={open.isPending}>Mở ca</Button>
      </MobileActionBar>
    </form>
  )
}

const closeSchema = z.object({
  counted: z.number({ message: "Nhập số tiền mặt đã đếm" }).int().min(0),
  note: z.string().trim().max(500).optional(),
})
type CloseForm = z.infer<typeof closeSchema>

/** Đóng ca: nhập tiền mặt đếm thực tế → hiện chênh lệch so với dự kiến (thừa/thiếu) trước khi xác nhận. */
export function PosCloseShiftDialog({ shift, summary, onClose }: { shift: PosShift; summary: PosShiftSummary; onClose: () => void }) {
  const close = useCloseShift()
  const { control, register, handleSubmit, formState: { errors } } = useForm<CloseForm>({ resolver: zodResolver(closeSchema) })
  const counted = useWatch({ control, name: "counted" })
  const diff = typeof counted === "number" ? counted - summary.expected_cash : null
  const submit = handleSubmit((f) =>
    close.mutate({ id: shift.id, closing_cash_counted: f.counted, note: f.note || undefined }, {
      onSuccess: (r) => { toast.success(`Đã đóng ca. Chênh lệch: ${vnd(r.shift.cash_diff)}`); onClose() },
      onError: (e) => toast.error(posErrorMessage(e, "Không đóng được ca")),
    }),
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader><DialogTitle>Đóng ca</DialogTitle></DialogHeader>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt>Tiền đầu ca</dt><dd className="tabular-nums">{vnd(shift.opening_cash)}</dd></div>
            <div className="flex justify-between"><dt>Thu tiền mặt</dt><dd className="tabular-nums">{vnd(summary.cash_sales)}</dd></div>
            <div className="flex justify-between font-bold"><dt>Tiền mặt dự kiến trong két</dt><dd className="tabular-nums">{vnd(summary.expected_cash)}</dd></div>
          </dl>
          <div className="space-y-1.5">
            <Label htmlFor="pos-counted">Tiền mặt đếm được (đ)</Label>
            <Controller control={control} name="counted" render={({ field }) => (
              <MoneyInput id="pos-counted" value={field.value ?? null} onChange={(v) => field.onChange(v ?? undefined)} autoFocus />
            )} />
            {errors.counted && <p role="alert" className="text-sm text-destructive">{errors.counted.message}</p>}
            {diff != null && (
              <p className="text-sm font-semibold text-foreground" aria-live="polite">
                {diff === 0 ? "Khớp" : diff > 0 ? `Thừa ${vnd(diff)}` : `Thiếu ${vnd(-diff)}`}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pos-close-note">Ghi chú (nếu có chênh lệch)</Label>
            <Input id="pos-close-note" className="h-11" {...register("note")} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>Quay lại</Button>
            <Button type="submit" className="min-h-11" disabled={close.isPending}>Xác nhận đóng ca</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PosCurrentShiftCard({ shift, summary }: { shift: PosShift; summary: PosShiftSummary }) {
  const [closing, setClosing] = useState(false)
  const stat = (label: string, value: string) => (
    <div className="rounded-lg border bg-background p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-lg font-bold tabular-nums text-foreground">{value}</dd></div>
  )
  return (
    <div className="space-y-3 rounded-[var(--radius)] border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-base font-bold text-foreground">Ca đang mở</h2><p className="text-xs text-muted-foreground">Từ {formatDateTimeVn(shift.opened_at)}</p></div>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => setClosing(true)}>Đóng ca</Button>
      </div>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {stat("Tiền đầu ca", vnd(shift.opening_cash))}
        {stat("Thu tiền mặt", vnd(summary.cash_sales))}
        {stat("Thu chuyển khoản", vnd(summary.transfer_sales))}
        {stat("Tiền mặt dự kiến", vnd(summary.expected_cash))}
        {stat("Số đơn đã thu", String(summary.paid_orders))}
      </dl>
      {closing && <PosCloseShiftDialog shift={shift} summary={summary} onClose={() => setClosing(false)} />}
    </div>
  )
}
