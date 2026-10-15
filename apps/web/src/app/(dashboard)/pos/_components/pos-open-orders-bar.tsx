"use client"

import { cn } from "@/lib/utils"
import { usePosOrders } from "@/hooks/pos/use-pos"
import { vnd } from "@/lib/pos-format"
import type { PosOrder, PosTable } from "@/types/pos"

/** Dải đơn đang mở (làm mới 15s): chạm để mở lại đơn của bàn/khách đó. */
export function PosOpenOrdersBar({ currentId, tables, onPick }: { currentId: number | null; tables: PosTable[]; onPick: (o: PosOrder) => void }) {
  const { data: orders = [] } = usePosOrders("open", 15_000)
  if (orders.length === 0) return null
  return (
    <nav aria-label="Đơn đang mở" className="flex gap-2 overflow-x-auto pb-1">
      {orders.map((o) => {
        const t = tables.find((x) => x.id === o.table_id)
        return (
          <button
            key={o.id} type="button" aria-current={currentId === o.id} onClick={() => onPick(o)}
            className={cn(
              "flex min-h-11 shrink-0 flex-col items-start rounded-lg border px-3 py-1 text-left text-xs",
              currentId === o.id ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary" : "bg-card text-foreground hover:bg-muted",
            )}
          >
            <span className="font-semibold">{o.order_type === "takeaway" ? "Mang đi" : t ? `Bàn ${t.name}` : "Tại quán"} · {o.code.slice(-4)}</span>
            <span className="tabular-nums">{vnd(o.total)}</span>
          </button>
        )
      })}
    </nav>
  )
}
