"use client"

import { useState } from "react"
import { AlertTriangle, Loader2, RotateCcw, ScrollText } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { formatDateTimeVn } from "@/lib/format"
import { OptionSelect } from "./option-select"
import { useRetryDelivery, useWebhookDeliveries } from "./use-webhooks"
import {
  apiErrorMessage,
  DELIVERY_STATUS_LABELS,
  deliveryErrorText,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "./webhook-types"

const ALL = "all"
const STATUS_VARIANT: Record<DeliveryStatus, "success" | "secondary" | "destructive" | "soft"> = {
  success: "success",
  pending: "soft",
  failed: "secondary",
  dead: "destructive",
}
const STATUS_OPTIONS = [{ value: ALL, label: "Mọi trạng thái" }, ...Object.entries(DELIVERY_STATUS_LABELS).map(([value, label]) => ({ value, label }))]

/** Chỉ lượt lỗi/đã dừng mới gửi lại được (BE cũng kiểm: 409 với lượt khác). Định nghĩa NGOÀI component để không remount mỗi lần render. */
function RetryButton({ d, pending, onRetry }: { d: WebhookDelivery; pending: boolean; onRetry: (d: WebhookDelivery) => void }) {
  if (d.status !== "failed" && d.status !== "dead") return null
  return (
    <Button variant="outline" size="sm" className="max-sm:h-11" disabled={pending} onClick={() => onRetry(d)}>
      <RotateCcw className="mr-1 size-3.5" /> Gửi lại
    </Button>
  )
}

/** Nhật ký gửi webhook ra: lọc theo endpoint/trạng thái, "Tải thêm", gửi lại lượt lỗi/đã dừng. */
export function WebhookDeliveries({ endpoints, endpointId, onEndpointChange }: {
  endpoints: WebhookEndpoint[]
  endpointId: string
  onEndpointChange: (v: string) => void
}) {
  const [status, setStatus] = useState(ALL)
  const q = useWebhookDeliveries(
    { endpointId: endpointId === ALL ? undefined : Number(endpointId), status: status === ALL ? undefined : (status as DeliveryStatus) },
    true,
  )
  const retry = useRetryDelivery()
  const rows = q.data?.pages.flatMap((p) => p.data) ?? []
  const nameOf = (id: number) => endpoints.find((e) => e.id === id)?.name ?? `Endpoint #${id}`
  const endpointOptions = [{ value: ALL, label: "Mọi endpoint" }, ...endpoints.map((e) => ({ value: String(e.id), label: e.name }))]

  function doRetry(d: WebhookDelivery) {
    retry.mutate(d.id, {
      onSuccess: () => toast.success("Đã xếp lịch gửi lại"),
      onError: (e) => toast.error(apiErrorMessage(e, "Không gửi lại được")),
    })
  }
  const retryBtn = (d: WebhookDelivery) => <RetryButton d={d} pending={retry.isPending} onRetry={doRetry} />

  return (
    <section aria-label="Nhật ký gửi" className="space-y-3">
      <h3 className="text-sm font-semibold">Nhật ký gửi</h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <OptionSelect label="Endpoint" value={endpointId} options={endpointOptions} onChange={onEndpointChange} />
        <OptionSelect label="Trạng thái" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
      </div>
      <p className="text-xs text-muted-foreground">
        Bên nhận có thể nhận trùng một sự kiện (at-least-once) — dùng mã lượt gửi <code>X-Trinity-Delivery</code> để loại trùng. Nhật ký không lưu nội dung gửi đi.
      </p>

      {q.isError && (
        <Card><CardContent className="flex items-center gap-2 py-4 text-sm text-red-600"><AlertTriangle className="size-4" /> Không tải được nhật ký gửi.</CardContent></Card>
      )}
      {q.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
      {!q.isLoading && !q.isError && rows.length === 0 && <EmptyState icon={ScrollText} message="Chưa có lượt gửi nào khớp bộ lọc." />}

      {rows.length > 0 && (
        <ShellResponsiveList
          table={
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Thời gian</TableHead><TableHead>Endpoint</TableHead><TableHead>Sự kiện</TableHead><TableHead>Trạng thái</TableHead><TableHead>Lần gửi</TableHead><TableHead>Chi tiết</TableHead><TableHead /></TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTimeVn(d.created_at)}</TableCell>
                      <TableCell className="text-xs">{nameOf(d.endpoint_id)}</TableCell>
                      <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[d.status]}>{DELIVERY_STATUS_LABELS[d.status]}</Badge></TableCell>
                      <TableCell className="text-xs">{d.attempts}</TableCell>
                      <TableCell className="max-w-xs text-xs">{d.last_status_code ? `HTTP ${d.last_status_code}` : ""} {d.status === "success" ? "" : deliveryErrorText(d.last_error, d.last_status_code)}</TableCell>
                      <TableCell>{retryBtn(d)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          }
          cards={
            <div className="space-y-3">
              {rows.map((d) => (
                <ShellListCard key={d.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{d.event_type}</span>
                    <Badge variant={STATUS_VARIANT[d.status]}>{DELIVERY_STATUS_LABELS[d.status]}</Badge>
                  </div>
                  <ShellListCardRow label="Endpoint" value={nameOf(d.endpoint_id)} />
                  <ShellListCardRow label="Thời gian" value={formatDateTimeVn(d.created_at)} />
                  <ShellListCardRow label="Lần gửi" value={String(d.attempts)} />
                  {d.status !== "success" && <ShellListCardRow label="Chi tiết" value={deliveryErrorText(d.last_error, d.last_status_code)} />}
                  <div className="flex justify-end pt-1">{retryBtn(d)}</div>
                </ShellListCard>
              ))}
            </div>
          }
        />
      )}

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} className="gap-2 max-sm:h-11">
            {q.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />} Tải thêm
          </Button>
        </div>
      )}
    </section>
  )
}
