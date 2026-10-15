"use client"

/**
 * Ô chọn ngày giờ thay `<input type="datetime-local">` native:
 * luôn hiển thị `dd/mm/yyyy HH:mm` bất kể locale trình duyệt, có lịch
 * popup bo góc + chọn giờ/phút. Giá trị vào/ra là chuỗi `YYYY-MM-DDTHH:mm`
 * (cùng định dạng datetime-local) nên thay thế trực tiếp ở mọi form.
 *
 * Lịch dùng `Calendar` chung (react-day-picker) trong Popover Base-UI; popup
 * tự gắn vào Dialog/Sheet chứa nó nên không dính "outside press".
 */
import { useRef, useState } from "react"
import { CalendarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { InlineSelect } from "@/components/ui/inline-select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MAX_YEAR_END, MIN_YEAR_START } from "@/components/ui/date-picker"
import { cn } from "@/lib/utils"
import { isoToDate, todayVnDate } from "@/lib/date-iso"
import { usePopoverContainer } from "@/lib/use-popover-container"
import {
  autoMaskVnDateTime,
  joinLocalDateTime,
  localToVnDateTime,
  nowLocalParts,
  parseVnDateTime,
  splitLocalDateTime,
  type LocalDateTimeParts,
} from "@/lib/vn-datetime"

interface VnDateTimeInputProps {
  value?: string | null
  onChange: (next: string) => void
  id?: string
  ariaLabel?: string
  placeholder?: string
  className?: string
  disabled?: boolean
}

const HOURS = Array.from({ length: 24 }, (_, i) => ({ value: i, label: String(i).padStart(2, "0") }))
const MINUTES = Array.from({ length: 60 }, (_, i) => ({ value: i, label: String(i).padStart(2, "0") }))

export function VnDateTimeInput({
  value, onChange, id, ariaLabel, placeholder = "dd/mm/yyyy HH:mm", className, disabled = false,
}: VnDateTimeInputProps) {
  const [text, setText] = useState("")
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { container, resolve } = usePopoverContainer(rootRef)
  const parts = splitLocalDateTime(value)
  const invalid = text.length === 16 && parseVnDateTime(text) === undefined
  const emit = (p: LocalDateTimeParts) => onChange(joinLocalDateTime(p))
  const current = parts ?? nowLocalParts()
  const selected = parts ? isoToDate(joinLocalDateTime(parts)) : undefined

  return (
    <div ref={rootRef} className={cn("relative w-full", className)}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        maxLength={16}
        disabled={disabled}
        value={editing ? text : localToVnDateTime(value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onFocus={() => { setEditing(true); setText(localToVnDateTime(value)) }}
        onBlur={() => { setEditing(false); setText(localToVnDateTime(value)) }}
        onChange={(e) => {
          const masked = autoMaskVnDateTime(e.target.value)
          setText(masked)
          const parsed = parseVnDateTime(masked)
          if (parsed === "") {
            if (value) onChange("")
          } else if (parsed !== undefined && parsed !== (value ?? "")) {
            onChange(parsed)
          }
        }}
        className="pr-9"
      />
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => {
          if (next) resolve()
          setOpen(next)
        }}
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            <button
              type="button"
              aria-label="Mở lịch"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50 max-sm:after:absolute max-sm:after:top-1/2 max-sm:after:left-1/2 max-sm:after:size-11 max-sm:after:-translate-x-1/2 max-sm:after:-translate-y-1/2 max-sm:after:content-['']"
            >
              <CalendarIcon className="size-4" />
            </button>
          }
        />
        <PopoverContent
          align="end"
          container={container}
          anchor={rootRef}
          className="w-auto gap-2 p-2"
        >
          <Calendar
            mode="single"
            required
            selected={selected}
            onSelect={(d) =>
              emit({ ...current, year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() })
            }
            defaultMonth={selected ?? todayVnDate()}
            captionLayout="dropdown"
            startMonth={MIN_YEAR_START}
            endMonth={MAX_YEAR_END}
          />
          <div className="flex items-center gap-2 border-t border-border/60 px-1 pt-2">
            <span className="text-xs text-muted-foreground">Giờ</span>
            <InlineSelect<number> className="w-20" options={HOURS} searchable={false}
              value={current.hour} onChange={(h) => emit({ ...current, hour: h ?? 0 })} ariaLabel="Giờ" />
            <span>:</span>
            <InlineSelect<number> className="w-20" options={MINUTES} searchable={false}
              value={current.minute} onChange={(m) => emit({ ...current, minute: m ?? 0 })} ariaLabel="Phút" />
          </div>
          <div className="flex items-center justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={() => { onChange(""); setOpen(false) }}>Xoá</Button>
            <div className="flex gap-1">
              <Button type="button" variant="outline" size="sm" onClick={() => emit(nowLocalParts())}>Bây giờ</Button>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>Xong</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
