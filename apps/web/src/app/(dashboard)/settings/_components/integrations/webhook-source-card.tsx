"use client"

import { MoreHorizontal, Pencil, RefreshCw, Terminal, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { formatDateTimeVn } from "@/lib/format"
import type { InboundSource } from "./webhook-types"

export interface SourceActions {
  onToggle: (s: InboundSource, active: boolean) => void
  onEdit: (s: InboundSource) => void
  onRotate: (s: InboundSource) => void
  onDelete: (s: InboundSource) => void
  onGuide: (s: InboundSource) => void
}

/** 1 nguồn webhook vào = 1 thẻ. Token KHÔNG còn xem lại được (chỉ hiện lúc tạo / tạo lại) — chỉ hiện tiền tố. */
export function WebhookSourceCard({
  s,
  assigneeName,
  sourceLabel,
  actions,
  busy,
  canWrite,
}: {
  s: InboundSource
  assigneeName: string
  sourceLabel: string
  actions: SourceActions
  busy: boolean
  /** Có `contacts.create` (cần để sửa/tạo lại token) — BE vẫn là cổng thật. */
  canWrite: boolean
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              <span className="break-words">{s.name}</span>
              <Badge variant={s.is_active ? "success" : "secondary"}>{s.is_active ? "Đang bật" : "Đã tắt"}</Badge>
              {s.signed && <Badge variant="soft">Có chữ ký</Badge>}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{s.token_prefix}•••••••••</p>
          </div>
          <Switch checked={s.is_active} disabled={busy} onCheckedChange={(c) => actions.onToggle(s, c)} id={`src-active-${s.id}`} aria-label={`Bật/tắt nguồn ${s.name}`} />
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Sale nhận khách</dt><dd className="text-right text-foreground">{assigneeName}</dd>
          <dt>Nguồn khách</dt><dd className="text-right text-foreground">{sourceLabel}</dd>
          <dt>Nhận lần gần nhất</dt><dd className="text-right">{s.last_received_at ? formatDateTimeVn(s.last_received_at) : "Chưa nhận"}</dd>
        </dl>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => actions.onGuide(s)}>
            <Terminal className="mr-1 size-4" /> Cách gọi (curl)
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Thao tác khác cho ${s.name}`} className="max-sm:size-11" />}>
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem className="gap-2" disabled={!canWrite} onClick={() => actions.onEdit(s)}><Pencil className="size-4" /> Sửa</DropdownMenuItem>
              <DropdownMenuItem className="gap-2" disabled={!canWrite} onClick={() => actions.onRotate(s)}><RefreshCw className="size-4" /> Tạo lại token</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" className="gap-2" onClick={() => actions.onDelete(s)}><Trash2 className="size-4" /> Xoá</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  )
}
