"use client"

import { useState } from "react"
import { ChevronDown, Loader2, MoreHorizontal, Play, Trash2, Upload } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { formatDateTimeVn } from "@/lib/format"
import { DIRECTION_LABELS, RUN_STATUS_LABELS, SCHEDULE_OPTIONS, summarizeStats, type GoogleSync } from "./google-sheets-types"
import { useSyncRuns } from "./use-google-sheets"

export interface SyncCardActions {
  onToggle: (s: GoogleSync, active: boolean) => void
  onRun: (s: GoogleSync, backfill?: boolean) => void
  onDelete: (s: GoogleSync) => void
}

/** 1 cấu hình đồng bộ = 1 thẻ: trạng thái lần chạy gần nhất + lịch sử (mở rộng) — không hiện dữ liệu dòng. */
export function GoogleSyncCard({ s, actions, running, canWrite }: { s: GoogleSync; actions: SyncCardActions; running: boolean; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const runs = useSyncRuns(s.id, open)
  const schedule = SCHEDULE_OPTIONS.find((o) => o.value === String(s.schedule_minutes ?? ""))?.label ?? `Mỗi ${s.schedule_minutes} phút`
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <Badge variant="outline">{DIRECTION_LABELS[s.direction]}</Badge>
              {!s.is_active && <Badge variant="outline">Đang tắt</Badge>}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              Tab “{s.sheet_title}” · {schedule}
              {s.last_run_at ? ` · chạy lần cuối ${formatDateTimeVn(s.last_run_at)} (${s.last_status ? RUN_STATUS_LABELS[s.last_status] : "—"})` : " · chưa chạy"}
            </p>
            {s.last_error && <p className="text-xs text-red-600">{s.last_error}</p>}
          </div>
          {canWrite && (
            <div className="flex items-center gap-2">
              <Switch checked={s.is_active} onCheckedChange={(v) => actions.onToggle(s, v)} aria-label={`Bật/tắt ${s.name}`} />
              <Button size="sm" variant="outline" disabled={running} onClick={() => actions.onRun(s)} className="max-sm:h-11">
                {running ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Play className="mr-1 size-4" />}Chạy ngay
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label="Thêm thao tác" className="max-sm:size-11" />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {s.direction === "export" && <DropdownMenuItem onClick={() => actions.onRun(s, true)}><Upload className="mr-2 size-4" />Đẩy cả dữ liệu hiện có</DropdownMenuItem>}
                  <DropdownMenuItem className="text-red-600" onClick={() => actions.onDelete(s)}><Trash2 className="mr-2 size-4" />Xoá cấu hình</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1 text-xs text-muted-foreground max-sm:min-h-11">
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />Lịch sử chạy
        </button>
        {open && (
          <ul className="space-y-1 text-xs">
            {runs.isLoading && <li className="text-muted-foreground">Đang tải…</li>}
            {runs.isError && <li className="text-red-600">Không tải được lịch sử.</li>}
            {runs.data?.length === 0 && <li className="text-muted-foreground">Chưa có lần chạy nào.</li>}
            {runs.data?.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{formatDateTimeVn(r.started_at)}</span>
                <span>{RUN_STATUS_LABELS[r.status]}</span>
                <span className="text-muted-foreground">{r.error ?? summarizeStats(r.stats, s.direction)}</span>
                {r.stats.error_samples?.[0] && <span className="text-red-600">{r.stats.error_samples[0]}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
