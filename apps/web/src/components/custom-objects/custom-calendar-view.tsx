"use client"

import { useState } from "react"
import Link from "next/link"
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { useCustomRecords } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  addDays, addMonths, dayOf, monthGrid, monthTitle, rangeFilter, timeOf, visibleRange, vnDay, weekDays, WEEKDAY_LABELS, type CalendarMode,
} from "@/lib/custom-objects/calendar"
import { todayVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomObjectDef, CustomRecord, CustomViewDef } from "@/types/custom-objects"
import { CustomFieldValue } from "./custom-field-value"
import { RecordCode } from "./record-code"
import { ViewTabs } from "./view-tabs"

const MAX_RECORDS = 100
const PER_DAY_MONTH = 3

function Entry({ def, r, field, cardFields }: { def: CustomObjectDef; r: CustomRecord; field: CustomFieldDef; cardFields: CustomFieldDef[] }) {
  const time = timeOf(r.data[field.key], field.type as "date" | "datetime")
  return (
    <Link href={`/x/${def.key}/${r.id}`} className="block rounded-md border bg-card px-1.5 py-1 text-xs hover:bg-muted" data-testid="calendar-entry">
      <span className="flex items-center gap-1">
        {time && <span className="font-mono text-muted-foreground">{time}</span>}
        <RecordCode code={r.code} className="px-1 py-0 text-sm" />
        <span className="truncate font-medium text-primary">{r.title}</span>
      </span>
      {cardFields.map((f) => <span key={f.key} className="block truncate text-muted-foreground"><CustomFieldValue field={f} record={r} /></span>)}
    </Link>
  )
}

/**
 * Lịch cho bảng tuỳ biến: bản ghi đặt theo `date_field` (ngày hoặc ngày giờ, giờ Việt Nam); xem tháng hoặc tuần, T2 đầu tuần.
 * Tải tối đa 100 bản ghi trong khoảng đang xem (lọc ở BE theo phạm vi của người xem), quá thì báo rõ.
 */
export function CustomCalendarView({ def, view }: { def: CustomObjectDef; view: CustomViewDef }) {
  const today = todayVn()
  const [mode, setMode] = useState<CalendarMode>(view.config.mode === "week" ? "week" : "month")
  const [anchor, setAnchor] = useState(today)
  const field = def.fields.find((f) => f.key === view.config.date_field && (f.type === "date" || f.type === "datetime"))
  const cardFields = (view.config.card_fields ?? []).map((k) => def.fields.find((f) => f.key === k)).filter((f): f is CustomFieldDef => !!f && !f.is_title)
  const range = visibleRange(mode, anchor)
  const filter = field ? JSON.stringify({ ...(view.config.filter ?? {}), [field.key]: rangeFilter(field.type as "date" | "datetime", range) }) : undefined
  const q = useCustomRecords(def.key, { filter, sort: field ? `field:${field.key}` : undefined, dir: "asc" }, 1, MAX_RECORDS, !!field)
  const byDay = new Map<string, CustomRecord[]>()
  for (const r of q.data?.items ?? []) {
    const d = field ? dayOf(r.data[field.key], field.type as "date" | "datetime") : null
    if (d) byDay.set(d, [...(byDay.get(d) ?? []), r])
  }
  const step = (n: number) => setAnchor((a) => (mode === "week" ? addDays(a, 7 * n) : addMonths(a, n)))
  const title = mode === "week" ? `Tuần ${vnDay(weekDays(anchor)[0])} – ${vnDay(weekDays(anchor)[6])}` : monthTitle(anchor)

  return (
    <div className="space-y-4">
      <ShellPageHeader icon={CalendarDays} title={view.label} description={`${def.label_plural}${field ? ` · theo ${field.label}` : ""}`} />
      <ViewTabs objectKey={def.key} active={view.key} />
      {!field ? (
        <Card className="rounded-2xl"><ShellEmptyState icon={CalendarDays} title="Lịch chưa dùng được" description="Trường ngày của lịch không còn (hoặc không còn là trường ngày/ngày giờ). Hãy nhờ AI sửa màn này." /></Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="icon" aria-label={mode === "week" ? "Tuần trước" : "Tháng trước"} onClick={() => step(-1)}><ChevronLeft className="size-4" /></Button>
            <Button variant="outline" onClick={() => setAnchor(today)}>Hôm nay</Button>
            <Button variant="outline" size="icon" aria-label={mode === "week" ? "Tuần sau" : "Tháng sau"} onClick={() => step(1)}><ChevronRight className="size-4" /></Button>
            <h2 className="text-lg font-semibold" data-testid="calendar-title">{title}</h2>
            {q.isFetching && <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />}
            <div className="ml-auto flex gap-1" role="group" aria-label="Kiểu xem lịch">
              {(["month", "week"] as const).map((m) => (
                <Button key={m} size="sm" variant={mode === m ? "soft" : "outline"} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "month" ? "Tháng" : "Tuần"}</Button>
              ))}
            </div>
          </div>
          {q.isError && <p className="text-sm text-red-700">{getApiErrorMessage(q.error, "Không tải được lịch")}</p>}
          {(q.data?.total ?? 0) > MAX_RECORDS && <p className="text-sm text-amber-700">Khoảng này có {q.data?.total} bản ghi — lịch chỉ hiện {MAX_RECORDS} bản ghi sớm nhất. Xem theo tuần hoặc mở Danh sách để xem hết.</p>}
          <div className="overflow-x-auto">
            <div className="grid min-w-[42rem] grid-cols-7 gap-px overflow-hidden rounded-2xl border bg-border" data-testid="calendar-grid">
              {WEEKDAY_LABELS.map((w) => <div key={w} className="bg-muted px-2 py-1 text-center text-xs font-semibold text-muted-foreground">{w}</div>)}
              {(mode === "week" ? [weekDays(anchor)] : monthGrid(anchor)).flat().map((d) => {
                const items = byDay.get(d) ?? []
                const shown = mode === "week" ? items : items.slice(0, PER_DAY_MONTH)
                const outside = mode === "month" && d.slice(0, 7) !== anchor.slice(0, 7)
                return (
                  <div key={d} className={cn("space-y-1 bg-background p-1.5", mode === "week" ? "min-h-64" : "min-h-28", outside && "bg-muted/40 text-muted-foreground")} data-testid="calendar-day" data-day={d}>
                    <div className={cn("text-xs font-semibold", d === today && "inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground")}>{Number(d.slice(8))}</div>
                    {shown.map((r) => <Entry key={r.id} def={def} r={r} field={field} cardFields={mode === "week" ? cardFields : []} />)}
                    {items.length > shown.length && <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setAnchor(d); setMode("week") }}>+{items.length - shown.length} nữa</button>}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
