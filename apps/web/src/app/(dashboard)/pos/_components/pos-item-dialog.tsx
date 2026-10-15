"use client"

import { useMemo, useState } from "react"
import { Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { vnd } from "@/lib/pos-format"
import { MAX_LINE_QTY } from "@/lib/pos-cart"
import type { PosModifier } from "@/types/pos"

export interface ItemDialogResult { options: PosModifier[]; quantity: number; note: string }

interface Props {
  title: string
  basePrice: number
  modifiers: PosModifier[]
  initial?: { optionIds: number[]; quantity: number; note: string }
  onConfirm: (r: ItemDialogResult) => void
  onClose: () => void
}

/**
 * Chọn tuỳ chọn (size / đá / đường / topping), số lượng và ghi chú cho 1 món. Mỗi NHÓM tuỳ chọn chọn tối đa 1
 * (bấm lại để bỏ) — đúng thói quen quán nước; giá cộng thêm hiển thị ngay, BE vẫn tính lại khi lưu đơn.
 */
export function PosItemDialog({ title, basePrice, modifiers, initial, onConfirm, onClose }: Props) {
  const [picked, setPicked] = useState<Record<string, number | null>>(() => {
    const init: Record<string, number | null> = {}
    for (const m of modifiers) if (initial?.optionIds.includes(m.id)) init[m.group_name] = m.id
    return init
  })
  const [qty, setQty] = useState(initial?.quantity ?? 1)
  const [note, setNote] = useState(initial?.note ?? "")

  const groups = useMemo(() => {
    const map = new Map<string, PosModifier[]>()
    for (const m of modifiers) map.set(m.group_name, [...(map.get(m.group_name) ?? []), m])
    return [...map.entries()]
  }, [modifiers])
  const options = modifiers.filter((m) => picked[m.group_name] === m.id)
  const unit = basePrice + options.reduce((s, m) => s + m.price_delta, 0)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {groups.map(([group, items]) => (
            <fieldset key={group} className="space-y-2">
              <legend className="text-sm font-semibold text-foreground">{group}</legend>
              <div className="flex flex-wrap gap-2">
                {items.map((m) => {
                  const on = picked[group] === m.id
                  return (
                    <button
                      key={m.id} type="button" aria-pressed={on}
                      onClick={() => setPicked((p) => ({ ...p, [group]: on ? null : m.id }))}
                      className={cn(
                        "min-h-11 rounded-lg border px-3 text-sm font-medium",
                        on ? "border-primary/30 bg-primary/10 text-[var(--color-app-primary-ink)]" : "bg-background text-foreground hover:bg-muted",
                      )}
                    >
                      {m.name}{m.price_delta !== 0 && ` (${m.price_delta > 0 ? "+" : ""}${vnd(m.price_delta)})`}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="pos-item-note">Ghi chú món</Label>
            <Input id="pos-item-note" value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} placeholder="Ít ngọt, mang đá riêng…" className="h-11" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Số lượng</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" className="size-11" aria-label="Giảm" onClick={() => setQty((q) => Math.max(1, q - 1))}><Minus /></Button>
              <span className="w-10 text-center text-lg font-bold tabular-nums" aria-live="polite">{qty}</span>
              <Button type="button" variant="outline" className="size-11" aria-label="Tăng" onClick={() => setQty((q) => Math.min(MAX_LINE_QTY, q + 1))}><Plus /></Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>Huỷ</Button>
          <Button type="button" className="min-h-11" onClick={() => onConfirm({ options, quantity: qty, note })}>
            Thêm · {vnd(unit * qty)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
