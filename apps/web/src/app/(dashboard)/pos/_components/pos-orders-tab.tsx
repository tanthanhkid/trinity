"use client"

import { useState } from "react"
import { MoreHorizontal, Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { usePosOrders, usePosTables } from "@/hooks/pos/use-pos"
import { formatDateTimeVn } from "@/lib/format"
import { vnd } from "@/lib/pos-format"
import { receiptFromOrder } from "@/lib/pos-receipt"
import type { PosOrder, PosOrderStatus } from "@/types/pos"
import { usePosPrint } from "./pos-receipt"
import { PosVoidDialog } from "./pos-void-dialog"

const TABS: Array<{ v: PosOrderStatus; label: string }> = [
  { v: "open", label: "Đang mở" }, { v: "paid", label: "Đã thanh toán" }, { v: "void", label: "Đã huỷ" },
]

/** Danh sách đơn theo trạng thái; in lại hoá đơn, huỷ đơn (đơn đã thu chỉ quản lý — BE kiểm, FE ẩn nút cho người không có quyền). */
export function PosOrdersTab({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<PosOrderStatus>("open")
  const [voiding, setVoiding] = useState<PosOrder | null>(null)
  const orders = usePosOrders(status, 15_000)
  const tables = usePosTables().data ?? []
  const print = usePosPrint()
  const tableName = (o: PosOrder) => tables.find((t) => t.id === o.table_id)?.name ?? null

  return (
    <div className="space-y-3">
      <div className="flex gap-2 max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Trạng thái đơn">
        {TABS.map((t) => (
          <button key={t.v} type="button" role="tab" aria-selected={status === t.v} onClick={() => setStatus(t.v)}
            className={cn("min-h-11 rounded-full border px-4 text-sm font-semibold max-sm:shrink-0 max-sm:whitespace-nowrap", status === t.v ? "border-primary/30 bg-primary/10 text-[var(--color-app-primary-ink)]" : "bg-background text-foreground hover:bg-muted")}>
            {t.label}
          </button>
        ))}
      </div>
      {orders.isLoading && <LoadingBlock variant="cards" count={3} label="Đang tải đơn…" />}
      {/* Lỗi tải ≠ không có đơn. */}
      {orders.isError && !orders.data && <ErrorState title="Không tải được danh sách đơn" error={orders.error} onRetry={() => void orders.refetch()} retrying={orders.isFetching} />}
      {orders.data?.length === 0 && <EmptyState title="Không có đơn nào ở mục này" message="Đơn bán ở tab Bán hàng sẽ hiện ở đây; đổi trạng thái phía trên để xem đơn khác." />}
      <ul className="space-y-2">
        {(orders.data ?? []).map((o) => (
          <li key={o.id} className="rounded-[var(--radius)] border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-semibold text-foreground">{o.code}</span>
                <span className="ml-2 text-sm text-muted-foreground">{o.order_type === "takeaway" ? "Mang đi" : tableName(o) ? `Bàn ${tableName(o)}` : "Tại quán"} · {formatDateTimeVn(o.paid_at ?? o.created_at)}</span>
              </div>
              <span className="text-lg font-bold tabular-nums text-foreground">{vnd(o.total)}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{o.items.map((i) => `${i.quantity} ${i.product_name}`).join(", ")}</p>
            {o.void_reason && <p className="mt-1 text-sm text-destructive">Lý do huỷ: {o.void_reason}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {o.status !== "void" && (
                <Button type="button" variant="outline" className="min-h-11 gap-1.5" onClick={() => print(receiptFromOrder(o, tableName(o)))}><Printer aria-hidden />{o.status === "paid" ? "In hoá đơn" : "In tạm tính"}</Button>
              )}
              {(o.status === "open" || (o.status === "paid" && canManage)) && (
                <>
                  <Button type="button" variant="destructive" className="min-h-11 max-sm:hidden" onClick={() => setVoiding(o)}>Huỷ đơn</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="Thao tác khác" className="sm:hidden" />}>
                      <MoreHorizontal aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" className="min-h-11" onClick={() => setVoiding(o)}>Huỷ đơn</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {voiding && <PosVoidDialog orderId={voiding.id} code={voiding.code} onClose={() => setVoiding(null)} onVoided={() => setVoiding(null)} />}
    </div>
  )
}
