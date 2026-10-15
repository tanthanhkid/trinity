"use client"

import { useRef, useState } from "react"
import { Calendar as CalendarIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { DatePickerPopover } from "@/components/ui/date-picker"
import { cn } from "@/lib/utils"
import { autoMaskVnDate, isoToVnDate, parseVnDate } from "@/lib/format"

interface VnDateInputProps {
  id?: string
  value?: string
  min?: string
  max?: string
  placeholder?: string
  className?: string
  inputClassName?: string
  ariaLabel?: string
  onChange: (next: string) => void
  onEnter?: () => void
}

/** Trả về display string từ ISO value. Tách ra ngoài component để ≤30 lines. */
function formatDisplay(value: string | undefined): string {
  return isoToVnDate(value)
}

/** Xử lý thay đổi text input thô: mask → parse → clamp → emit ISO. */
function handleEditChange(
  raw: string,
  value: string | undefined,
  min: string | undefined,
  max: string | undefined,
  setText: (s: string) => void,
  onChange: (iso: string) => void,
): void {
  const masked = autoMaskVnDate(raw)
  setText(masked)
  if (masked === "") {
    if (value) onChange("")
    return
  }
  const iso = parseVnDate(masked)
  if (iso === undefined) return
  const clamped = (min && iso < min) ? min : (max && iso > max) ? max : iso
  if (clamped !== (value ?? "")) onChange(clamped)
}

export function VnDateInput({
  id,
  value,
  min,
  max,
  placeholder = "DD/MM/YYYY",
  className,
  inputClassName,
  ariaLabel,
  onChange,
  onEnter,
}: VnDateInputProps) {
  const [text, setText] = useState<string>(() => formatDisplay(value))
  const [isEditing, setIsEditing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const invalid = text.length === 10 && parseVnDate(text) === undefined

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        maxLength={10}
        value={isEditing ? text : formatDisplay(value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onFocus={() => { setIsEditing(true); setText(formatDisplay(value)) }}
        onBlur={() => { setIsEditing(false); setText(formatDisplay(value)) }}
        onChange={(e) => handleEditChange(e.target.value, value, min, max, setText, onChange)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
        className={cn("pr-9", inputClassName)}
      />
      <DatePickerPopover
        value={value}
        min={min}
        max={max}
        anchorRef={rootRef}
        onChange={onChange}
        trigger={
          <button
            type="button"
            aria-label="Mở lịch"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted max-sm:after:absolute max-sm:after:top-1/2 max-sm:after:left-1/2 max-sm:after:size-11 max-sm:after:-translate-x-1/2 max-sm:after:-translate-y-1/2 max-sm:after:content-['']"
          >
            <CalendarIcon className="h-4 w-4" />
          </button>
        }
      />
    </div>
  )
}
