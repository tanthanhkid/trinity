"use client"

/**
 * Chọn KHOẢNG ngày (Từ - Đến) bằng một lịch + khoảng nhanh.
 * Giá trị `{ date_from, date_to }` là ISO `YYYY-MM-DD` (rỗng = chưa chọn),
 * hiển thị `dd/mm/yyyy`. Bấm 2 ngày bất kỳ (thứ tự nào cũng được) để chốt
 * khoảng; bấm 1 ngày 2 lần = khoảng 1 ngày. Khoảng nhanh: Hôm nay, 7 ngày...
 * Mobile: 1 tháng + khoảng nhanh dạng chip; desktop: 2 tháng cạnh nhau.
 */
import { useRef, useState } from "react"
import { CalendarRangeIcon } from "lucide-react"
import type { DateRange as RdpRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MAX_YEAR_END, MIN_YEAR_START } from "@/components/ui/date-picker"
import { cn } from "@/lib/utils"
import { dateToIso, isoToDate, todayVnDate } from "@/lib/date-iso"
import {
  computeDateRangePreset,
  DATE_RANGE_PRESETS,
  matchDateRangePreset,
  type DateRange,
} from "@/lib/date-range-presets"
import { isoToVnDate } from "@/lib/format"
import { useMediaQuery, usePopoverContainer } from "@/lib/use-popover-container"

export type { DateRange }

interface Props {
  value: DateRange
  onChange: (range: DateRange) => void
  /** Ngày lớn nhất được chọn (ISO), vd hôm nay cho báo cáo. */
  max?: string
  min?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
  /** Ẩn cột khoảng nhanh. */
  hidePresets?: boolean
}

/** Trạng thái chọn dở: bấm ngày đầu → chờ ngày cuối. */
function nextDraft(draft: RdpRange | undefined, day: Date): { range: RdpRange; done: boolean } {
  if (!draft?.from || draft.to) return { range: { from: day, to: undefined }, done: false }
  const [from, to] = draft.from <= day ? [draft.from, day] : [day, draft.from]
  return { range: { from, to }, done: true }
}

function summary(value: DateRange): string {
  const f = isoToVnDate(value.date_from)
  const t = isoToVnDate(value.date_to)
  if (!f && !t) return "Chọn khoảng ngày"
  return `${f || "..."} – ${t || "..."}`
}

export function DateRangePicker({
  value, onChange, max, min, disabled, className, ariaLabel = "Chọn khoảng ngày", hidePresets,
}: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<RdpRange | undefined>()
  const hostRef = useRef<HTMLElement | null>(null)
  const { container, resolve } = usePopoverContainer(hostRef)
  const wide = useMediaQuery("(min-width: 640px)")
  const from = isoToDate(value.date_from)
  const to = isoToDate(value.date_to)
  const minDate = isoToDate(min)
  const maxDate = isoToDate(max)
  const shown: RdpRange | undefined = draft ?? (from ? { from, to } : undefined)
  const active = matchDateRangePreset(value)
  // Chưa có khoảng + 2 tháng: lùi 1 tháng để hôm nay nằm ở tháng bên phải.
  const base = from ?? todayVnDate()
  const initialMonth = wide && !from ? new Date(base.getFullYear(), base.getMonth() - 1, 1) : base

  const commit = (r: DateRange) => {
    onChange(r)
    setDraft(undefined)
    setOpen(false)
  }
  const clamp = (r: DateRange): DateRange => ({
    date_from: min && r.date_from < min ? min : r.date_from,
    date_to: max && r.date_to > max ? max : r.date_to,
  })
  const onDay = (day: Date) => {
    const { range, done } = nextDraft(draft, day)
    if (!done) return setDraft(range)
    commit({ date_from: dateToIso(range.from as Date), date_to: dateToIso(range.to as Date) })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) resolve()
        setDraft(undefined)
        setOpen(next)
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        ref={(el: HTMLElement | null) => { hostRef.current = el }}
        render={
          <Button
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            className={cn(
              "h-9 justify-start gap-2 rounded-xl font-normal",
              !value.date_from && !value.date_to && "text-muted-foreground",
              className,
            )}
          >
            <CalendarRangeIcon className="size-4 text-muted-foreground" />
            {summary(value)}
          </Button>
        }
      />
      <PopoverContent align="start" container={container} className="w-auto max-w-[calc(100vw-1rem)] gap-0 p-0">
        <div className="flex flex-col sm:flex-row">
          {!hidePresets && (
            <div className="flex flex-wrap gap-1.5 border-b border-border/60 p-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:gap-0.5 sm:border-r sm:border-b-0">
              {DATE_RANGE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => commit(clamp(computeDateRangePreset(p.id)))}
                  className={cn(
                    "rounded-md border border-border px-2.5 py-1 text-left text-xs transition-colors hover:bg-accent sm:border-transparent sm:py-1.5 sm:text-sm",
                    active === p.id && "border-primary/40 bg-primary/10 font-semibold text-primary",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <div className="p-2">
            <Calendar
              mode="range"
              selected={shown}
              onDayClick={onDay}
              numberOfMonths={wide ? 2 : 1}
              defaultMonth={initialMonth}
              startMonth={minDate ?? MIN_YEAR_START}
              endMonth={maxDate ?? MAX_YEAR_END}
              disabled={[...(minDate ? [{ before: minDate }] : []), ...(maxDate ? [{ after: maxDate }] : [])]}
            />
            <p className="px-1 pt-1 text-xs text-muted-foreground">
              {draft?.from && !draft.to ? "Bấm ngày kết thúc" : "Bấm ngày bắt đầu rồi ngày kết thúc"}
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
