"use client"

import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { formatDateTimeVn } from "@/lib/format"
import { MODE_LABEL, OUTCOME_LABEL } from "@/lib/extensions"
import { useExtensionLogs } from "@/hooks/extensions/use-extensions"

/** Nhật ký các lần chạy. Nội dung log do mã của AI in ra (BE đã che SĐT) ⇒ hiển thị dạng text. */
export function ExtensionLogs({ id }: { id: number }) {
  const q = useExtensionLogs(id, true)
  if (q.isLoading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Đang tải...</p>
  if (q.isError) return <p className="text-sm text-red-600" role="alert">Không tải được nhật ký chạy.</p>
  const runs = q.data?.runs ?? []
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">Chưa có lần chạy nào.</p>
  return (
    <ul className="space-y-2" data-testid="extension-runs">
      {runs.map((r) => (
        <li key={r.id} className="rounded-lg border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={r.outcome === "ok" ? "success" : "destructive"}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</Badge>
            <span>{MODE_LABEL[r.mode] ?? r.mode}</span>
            <span className="text-muted-foreground">{formatDateTimeVn(r.started_at)} · {r.duration_ms} ms</span>
          </div>
          {r.log && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">{r.log}</pre>}
        </li>
      ))}
    </ul>
  )
}
