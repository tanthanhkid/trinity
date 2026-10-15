"use client"

import { useState } from "react"
import { AlertTriangle, Loader2, ScrollText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { todayVn } from "@/lib/format"
import { IntegrationAuditRows } from "./integration-audit-rows"
import { OptionSelect } from "./option-select"
import { useIntegrationAuditLogs, type AuditFilters } from "./use-integrations"
import {
  CHANNEL_LABELS,
  STATUS_LABELS,
  type IntegrationAuditStatus,
  type IntegrationChannel,
} from "./integrations-meta"

const ALL = "all"
const CHANNEL_OPTIONS = [{ value: ALL, label: "Tất cả kênh" }, ...(Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label })))]
const STATUS_OPTIONS = [{ value: ALL, label: "Mọi kết quả" }, ...(Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })))]

/** Cài đặt > Kết nối & AI > Nhật ký tích hợp — dữ liệu từ `GET /integrations/audit-logs` (quyền `integrations.ai_admin`). */
export function IntegrationAuditLogs({ enabled }: { enabled: boolean }) {
  const [channel, setChannel] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  const filters: AuditFilters = {
    channel: channel === ALL ? undefined : (channel as IntegrationChannel),
    status: status === ALL ? undefined : (status as IntegrationAuditStatus),
    from: from || undefined,
    to: to || undefined,
  }
  const q = useIntegrationAuditLogs(filters, enabled)
  const rows = q.data?.pages.flatMap((p) => p.data) ?? []
  const activeCount = [channel !== ALL, status !== ALL, from, to].filter(Boolean).length

  function reset() {
    setChannel(ALL)
    setStatus(ALL)
    setFrom("")
    setTo("")
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <MobileFilterSheet activeCount={activeCount} onReset={reset}>
          <OptionSelect label="Kênh" value={channel} options={CHANNEL_OPTIONS} onChange={setChannel} />
          <OptionSelect label="Kết quả" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Từ ngày
            <VnDateInput value={from} max={to || todayVn()} ariaLabel="Từ ngày" onChange={setFrom} className="sm:w-40" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Đến ngày
            <VnDateInput value={to} min={from || undefined} max={todayVn()} ariaLabel="Đến ngày" onChange={setTo} className="sm:w-40" />
          </label>
        </MobileFilterSheet>
      </div>

      <p className="text-xs text-muted-foreground">
        Mới nhất ở trên. Nhật ký không lưu SĐT đầy đủ hay khoá bí mật — dữ liệu nhạy cảm đã được lọc khi ghi.
      </p>

      {q.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-600">
            <AlertTriangle className="size-4" /> Không tải được nhật ký. Vui lòng thử lại.
          </CardContent>
        </Card>
      )}

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Đang tải nhật ký...
        </div>
      )}

      {!q.isLoading && !q.isError && rows.length === 0 && (
        <EmptyState icon={ScrollText} message="Chưa có dòng nhật ký nào khớp bộ lọc." />
      )}

      {rows.length > 0 && <IntegrationAuditRows rows={rows} />}

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} className="gap-2">
            {q.isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
            Tải thêm
          </Button>
        </div>
      )}
    </div>
  )
}
