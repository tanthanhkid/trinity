"use client"

import { ShoppingBag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { vnd } from "@/lib/pos-format"
import type { PosArea, PosTable } from "@/types/pos"

interface Props {
  areas: PosArea[]
  tables: PosTable[]
  currentTableId: number | null
  onPickTable: (t: PosTable) => void
  onTakeaway: () => void
  onClose: () => void
}

/** Chọn bàn theo khu vực (bàn có khách tô màu + hiện số tiền) hoặc "Mang đi". Chọn bàn đang có đơn → mở lại đơn đó. */
export function PosTableDialog({ areas, tables, currentTableId, onPickTable, onTakeaway, onClose }: Props) {
  const activeAreas = areas.filter((a) => a.is_active)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Chọn bàn</DialogTitle></DialogHeader>
        <Button type="button" variant="outline" className="min-h-11 w-full justify-start gap-2" onClick={onTakeaway}>
          <ShoppingBag aria-hidden /> Mang đi (không gán bàn)
        </Button>
        {activeAreas.length === 0 && <p className="text-sm text-muted-foreground">Chưa có khu vực/bàn. Quản lý thêm ở tab Cài đặt.</p>}
        {activeAreas.map((a) => (
          <div key={a.id} className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{a.name}</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {tables.filter((t) => t.area_id === a.id && t.is_active).map((t) => (
                <button
                  key={t.id} type="button" onClick={() => onPickTable(t)}
                  aria-pressed={currentTableId === t.id}
                  className={cn(
                    "flex min-h-16 flex-col items-center justify-center rounded-xl border p-2 text-sm font-semibold",
                    t.open_order ? "border-amber-600 bg-amber-50 text-amber-950" : "bg-card text-foreground hover:border-primary",
                    currentTableId === t.id && "ring-2 ring-primary",
                  )}
                >
                  <span>{t.name}</span>
                  <span className="text-xs font-medium">{t.open_order ? vnd(t.open_order.total) : "Trống"}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </DialogContent>
    </Dialog>
  )
}
