"use client"

import { MoreHorizontal, Pencil, RefreshCw, Send, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { formatDateTimeVn } from "@/lib/format"
import { DISABLED_REASON_LABELS, type WebhookEndpoint } from "./webhook-types"

export interface EndpointActions {
  onToggle: (ep: WebhookEndpoint, active: boolean) => void
  onTest: (ep: WebhookEndpoint) => void
  onEdit: (ep: WebhookEndpoint) => void
  onRotate: (ep: WebhookEndpoint) => void
  onDelete: (ep: WebhookEndpoint) => void
  onShowDeliveries: (ep: WebhookEndpoint) => void
}

/** 1 endpoint = 1 thẻ (dùng chung điện thoại + máy tính). Nút phụ `outline`, thao tác hiếm trong menu. */
export function WebhookEndpointCard({
  ep,
  actions,
  busy,
  keyReady,
}: {
  ep: WebhookEndpoint
  actions: EndpointActions
  busy: boolean
  /** false ⇒ máy chủ thiếu INTEGRATIONS_SECRET_KEY: gửi thử / tạo lại secret không dùng được. */
  keyReady: boolean
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              <span className="break-words">{ep.name}</span>
              <Badge variant={ep.is_active ? "success" : "secondary"}>{ep.is_active ? "Đang bật" : "Đã tắt"}</Badge>
            </p>
            <p className="mt-0.5 font-mono text-xs break-all text-muted-foreground">{ep.url}</p>
          </div>
          <Switch
            checked={ep.is_active}
            disabled={busy}
            onCheckedChange={(c) => actions.onToggle(ep, c)}
            id={`wh-active-${ep.id}`}
            aria-label={`Bật/tắt endpoint ${ep.name}`}
          />
        </div>

        {!ep.is_active && ep.disabled_reason && (
          <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">{DISABLED_REASON_LABELS[ep.disabled_reason] ?? ep.disabled_reason}</p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {ep.events.map((e) => (
            <Badge key={e} variant="outline" className="font-mono text-sm">{e}</Badge>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Lần thành công gần nhất</dt>
          <dd className="text-right">{ep.last_success_at ? formatDateTimeVn(ep.last_success_at) : "—"}</dd>
          <dt>Lần lỗi gần nhất</dt>
          <dd className="text-right">{ep.last_failure_at ? formatDateTimeVn(ep.last_failure_at) : "—"}</dd>
          <dt>Lỗi liên tiếp</dt>
          <dd className="text-right">{ep.consecutive_failures}</dd>
        </dl>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => actions.onShowDeliveries(ep)}>Nhật ký gửi</Button>
          <Button variant="outline" size="sm" className="max-sm:h-11" disabled={busy || !keyReady} onClick={() => actions.onTest(ep)}>
            <Send className="mr-1 size-4" /> Gửi thử
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Thao tác khác cho ${ep.name}`} className="max-sm:size-11" />}>
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem className="gap-2" onClick={() => actions.onEdit(ep)}><Pencil className="size-4" /> Sửa</DropdownMenuItem>
              <DropdownMenuItem className="gap-2" disabled={!keyReady} onClick={() => actions.onRotate(ep)}><RefreshCw className="size-4" /> Tạo lại secret</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" className="gap-2" onClick={() => actions.onDelete(ep)}><Trash2 className="size-4" /> Xoá</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  )
}
