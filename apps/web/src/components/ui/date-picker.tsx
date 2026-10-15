"use client"

/**
 * Chọn MỘT ngày bằng lịch. Giá trị vào/ra là ISO `YYYY-MM-DD`
 * (giữ contract cũ của native `<input type="date">`), hiển thị `dd/mm/yyyy`.
 *
 * - `DatePickerPopover`: lớp lịch dùng lại (VnDateInput gắn vào nút lịch của nó).
 * - `DatePicker`: nút bấm hiện ngày + lịch, dùng khi không cần gõ tay.
 *
 * Popup tự gắn vào Dialog/Sheet chứa nó (xem `usePopoverContainer`).
 */
import { useRef, useState, type ReactElement, type RefObject } from "react"
import { CalendarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { dateToIso, isoToDate, todayVnDate } from "@/lib/date-iso"
import { isoToVnDate } from "@/lib/format"
import { usePopoverContainer } from "@/lib/use-popover-container"

export const MIN_YEAR_START = new Date(1900, 0, 1)
export const MAX_YEAR_END = new Date(2100, 11, 31)

interface PopoverProps {
  value?: string | null
  onChange: (iso: string) => void
  min?: string
  max?: string
  /** Phần tử để căn popup (mặc định: nút kích hoạt). */
  anchorRef?: RefObject<HTMLElement | null>
  /** Nút kích hoạt (render vào PopoverTrigger). */
  trigger: ReactElement
  disabled?: boolean
  allowClear?: boolean
  align?: "start" | "center" | "end"
}

/** Ngày hôm nay (VN) có nằm trong [min, max] không. */
function todayInRange(min?: string, max?: string): boolean {
  const t = dateToIso(todayVnDate())
  return !(min && t < min) && !(max && t > max)
}

export function DatePickerPopover({
  value, onChange, min, max, anchorRef, trigger, disabled, allowClear = true, align = "end",
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLElement | null>(null)
  const { container, resolve } = usePopoverContainer(anchorRef ?? hostRef)
  const selected = isoToDate(value)
  const minDate = isoToDate(min)
  const maxDate = isoToDate(max)
  const pick = (iso: string) => {
    onChange(iso)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) resolve()
        setOpen(next)
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={trigger}
        ref={(el: HTMLElement | null) => { hostRef.current = el }}
      />
      <PopoverContent
        align={align}
        container={container}
        anchor={anchorRef}
        className="w-auto gap-1 p-2"
      >
        <Calendar
          mode="single"
          required
          selected={selected}
          onSelect={(d) => pick(dateToIso(d))}
          defaultMonth={selected ?? maxDate ?? todayVnDate()}
          captionLayout="dropdown"
          startMonth={minDate ?? MIN_YEAR_START}
          endMonth={maxDate ?? MAX_YEAR_END}
          disabled={[...(minDate ? [{ before: minDate }] : []), ...(maxDate ? [{ after: maxDate }] : [])]}
        />
        <div className="flex items-center justify-between border-t border-border/60 pt-1.5">
          {allowClear ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => pick("")}>Xoá</Button>
          ) : <span />}
          <Button
            type="button" variant="ghost" size="sm" className="text-primary"
            disabled={!todayInRange(min, max)}
            onClick={() => pick(dateToIso(todayVnDate()))}
          >
            Hôm nay
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface DatePickerProps extends Omit<PopoverProps, "trigger" | "anchorRef"> {
  id?: string
  placeholder?: string
  ariaLabel?: string
  className?: string
}

export function DatePicker({
  value, id, placeholder = "dd/mm/yyyy", ariaLabel, className, ...rest
}: DatePickerProps) {
  const text = isoToVnDate(value)
  return (
    <DatePickerPopover
      {...rest}
      value={value}
      trigger={
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={ariaLabel}
          className={cn("h-9 w-full justify-start gap-2 font-normal", !text && "text-muted-foreground", className)}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          {text || placeholder}
        </Button>
      }
    />
  )
}
