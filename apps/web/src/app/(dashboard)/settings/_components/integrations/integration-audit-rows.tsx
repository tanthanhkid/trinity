"use client"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { formatDateTimeVn } from "@/lib/format"
import {
  CHANNEL_LABELS,
  STATUS_LABELS,
  type IntegrationAuditRow,
  type IntegrationAuditStatus,
} from "./integrations-meta"

const STATUS_VARIANT: Record<IntegrationAuditStatus, "success" | "secondary" | "destructive"> = {
  ok: "success",
  denied: "secondary",
  error: "destructive",
}

function StatusBadge({ status }: { status: IntegrationAuditStatus }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "secondary"}>{STATUS_LABELS[status] ?? status}</Badge>
}

/** Người/ứng dụng thực hiện: user id + client (nếu có). Không có gì → "—". */
function actorText(r: IntegrationAuditRow): string {
  const parts: string[] = []
  if (r.user_id != null) parts.push(`User #${r.user_id}`)
  if (r.client_id) parts.push(r.client_id)
  return parts.length ? parts.join(" · ") : "—"
}

function targetText(r: IntegrationAuditRow): string {
  if (!r.resource) return "—"
  return r.resource_id ? `${r.resource} #${r.resource_id}` : r.resource
}

function detailsText(r: IntegrationAuditRow): string | null {
  const hasMeta = r.metadata && Object.keys(r.metadata).length > 0
  if (!r.error && !hasMeta) return null
  return JSON.stringify({ ...(r.error ? { error: r.error } : {}), ...(hasMeta ? { metadata: r.metadata } : {}) }, null, 2)
}

function Details({ r }: { r: IntegrationAuditRow }) {
  const text = detailsText(r)
  if (!text) return <span className="text-muted-foreground">—</span>
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[var(--color-app-primary-ink)]">Xem</summary>
      {/* Dữ liệu đã lọc ở BE (không SĐT đầy đủ/secret) — vẫn hiển thị dạng text thuần, không dangerouslySetInnerHTML. */}
      <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2">{text}</pre>
    </details>
  )
}

export function IntegrationAuditRows({ rows }: { rows: IntegrationAuditRow[] }) {
  return (
    <ShellResponsiveList
      table={
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Thời gian</TableHead>
                <TableHead>Kênh</TableHead>
                <TableHead>Hành động</TableHead>
                <TableHead>Người / ứng dụng</TableHead>
                <TableHead>Đối tượng</TableHead>
                <TableHead>Kết quả</TableHead>
                <TableHead className="text-right">HTTP</TableHead>
                <TableHead className="text-right">ms</TableHead>
                <TableHead>Chi tiết</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTimeVn(r.created_at)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{CHANNEL_LABELS[r.channel] ?? r.channel}</TableCell>
                  <TableCell className="text-xs font-medium">{r.action}</TableCell>
                  <TableCell className="text-xs">{actorText(r)}</TableCell>
                  <TableCell className="text-xs">{targetText(r)}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right text-xs">{r.http_status ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs">{r.duration_ms ?? "—"}</TableCell>
                  <TableCell><Details r={r} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      }
      cards={
        <div className="space-y-3">
          {rows.map((r) => (
            <ShellListCard key={r.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium break-words">{r.action}</span>
                <StatusBadge status={r.status} />
              </div>
              <ShellListCardRow label="Thời gian" value={formatDateTimeVn(r.created_at)} />
              <ShellListCardRow label="Kênh" value={CHANNEL_LABELS[r.channel] ?? r.channel} />
              <ShellListCardRow label="Người / ứng dụng" value={actorText(r)} />
              <ShellListCardRow label="Đối tượng" value={targetText(r)} />
              {r.http_status != null && <ShellListCardRow label="HTTP" value={r.http_status} />}
              {r.duration_ms != null && <ShellListCardRow label="Thời gian xử lý" value={`${r.duration_ms} ms`} />}
              <Details r={r} />
            </ShellListCard>
          ))}
        </div>
      }
    />
  )
}
