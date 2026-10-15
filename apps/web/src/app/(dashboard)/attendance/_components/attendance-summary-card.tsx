"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { todayVn, isoToVnDate, parseVnDate, autoMaskVnDate } from "@/lib/format"
import {
  useTodaySummary,
  type TodaySummaryAdmin,
  type TodaySummarySelf,
} from "@/hooks/use-attendance"

function timeVn(iso: string | null): string {
  if (!iso) return "--:--"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

function SummaryBox({
  label,
  value,
  tone = "neutral",
}: {
  label: string
  value: string
  tone?: "neutral" | "green" | "amber" | "red"
}) {
  const toneCls: Record<string, string> = {
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    red: "border-rose-200 bg-rose-50 text-rose-700",
  }
  return (
    <div className={`rounded-lg border p-3 text-center ${toneCls[tone]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium">{label}</div>
    </div>
  )
}

function TodayAdminStrip({
  data,
  loading,
}: {
  data?: TodaySummaryAdmin
  loading: boolean
}) {
  if (loading)
    return (
      <p className="text-sm text-muted-foreground">Đang tải tóm tắt...</p>
    )
  if (!data) return null
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <SummaryBox
        label="Đã chấm công"
        value={`${data.checked_in}/${data.total}`}
        tone="neutral"
      />
      <SummaryBox label="Có mặt" value={String(data.present)} tone="green" />
      <SummaryBox
        label="Chưa đủ vào/ra"
        value={String(data.incomplete)}
        tone="amber"
      />
      <SummaryBox label="Vắng" value={String(data.absent)} tone="red" />
    </div>
  )
}

function TodaySelfStrip({
  data,
  loading,
}: {
  data?: TodaySummarySelf
  loading: boolean
}) {
  if (loading)
    return <p className="text-sm text-muted-foreground">Đang tải...</p>
  const rec = data?.record
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      {rec ? (
        <span>
          Vào <b>{timeVn(rec.check_in_at)}</b> · Ra{" "}
          <b>{timeVn(rec.check_out_at)}</b> ·{" "}
          {rec.total_hours != null ? `${rec.total_hours}h` : "chưa đủ"}
        </span>
      ) : (
        <span className="text-muted-foreground">
          Chưa có dữ liệu chấm công cho ngày đã chọn.
        </span>
      )}
    </div>
  )
}

export function AttendanceSummaryCard({ isAdmin }: { isAdmin: boolean }) {
  const [date, setDate] = useState<string>(todayVn())
  const [dateText, setDateText] = useState<string>(isoToVnDate(todayVn()))
  const todaySummary = useTodaySummary(date)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sổ chấm công</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Ngày</label>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="DD/MM/YYYY"
            value={dateText}
            onChange={(e) => {
              const masked = autoMaskVnDate(e.target.value)
              setDateText(masked)
              const iso = parseVnDate(masked)
              if (iso) {
                setDate(iso)
              }
            }}
            className="h-8 w-[160px] text-sm"
          />
        </div>

        {isAdmin ? (
          <TodayAdminStrip
            data={todaySummary.data as TodaySummaryAdmin | undefined}
            loading={todaySummary.isLoading}
          />
        ) : (
          <TodaySelfStrip
            data={todaySummary.data as TodaySummarySelf | undefined}
            loading={todaySummary.isLoading}
          />
        )}
      </CardContent>
    </Card>
  )
}
