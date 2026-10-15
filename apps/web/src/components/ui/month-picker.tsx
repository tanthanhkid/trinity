"use client"

/**
 * Chọn THÁNG (thay `<input type="month">` native). Giá trị vào/ra
 * `YYYY-MM` (rỗng = chưa chọn), hiển thị `MM/YYYY`. Lưới 12 tháng + đổi năm;
 * tháng hiện tại theo giờ VN. Popup gắn vào Dialog/Sheet chứa nó.
 */
import { useRef, useState } from "react"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { todayVn } from "@/lib/format"
import { usePopoverContainer } from "@/lib/use-popover-container"

interface Props {
  value?: string | null
  onChange: (ym: string) => void
  id?: string
  ariaLabel?: string
  placeholder?: string
  className?: string
  disabled?: boolean
  allowClear?: boolean
}

const YM_RE = /^(\d{4})-(\d{2})$/

function parseYm(v?: string | null): { y: number; m: number } | null {
  const r = v ? YM_RE.exec(v) : null
  if (!r || Number(r[2]) < 1 || Number(r[2]) > 12) return null
  return { y: Number(r[1]), m: Number(r[2]) }
}

export function formatYm(ym?: string | null): string {
  const p = parseYm(ym)
  return p ? `${String(p.m).padStart(2, "0")}/${p.y}` : ""
}

export function MonthPicker({
  value, onChange, id, ariaLabel, placeholder = "mm/yyyy", className, disabled, allowClear = true,
}: Props) {
  const cur = parseYm(value)
  const now = parseYm(todayVn().slice(0, 7)) as { y: number; m: number }
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState((cur ?? now).y)
  const hostRef = useRef<HTMLElement | null>(null)
  const { container, resolve } = usePopoverContainer(hostRef)
  const text = formatYm(value)
  const pick = (ym: string) => {
    onChange(ym)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          resolve()
          setYear((cur ?? now).y)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        ref={(el: HTMLElement | null) => { hostRef.current = el }}
        render={
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
      <PopoverContent align="start" container={container} className="w-64 gap-2 p-2">
        <div className="flex items-center justify-between">
          <button type="button" aria-label="Năm trước" onClick={() => setYear((y) => y - 1)}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="text-sm font-semibold">{year}</span>
          <button type="button" aria-label="Năm sau" onClick={() => setYear((y) => y + 1)}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
            const selected = cur?.y === year && cur.m === m
            const isNow = now.y === year && now.m === m
            return (
              <button
                key={m}
                type="button"
                aria-label={`Tháng ${m} năm ${year}`}
                aria-pressed={selected}
                onClick={() => pick(`${year}-${String(m).padStart(2, "0")}`)}
                className={cn(
                  "h-9 rounded-md text-sm transition-colors hover:bg-accent",
                  isNow && !selected && "font-bold text-primary ring-1 ring-primary/40",
                  selected && "bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                Tháng {m}
              </button>
            )
          })}
        </div>
        {allowClear && (
          <div className="flex justify-start border-t border-border/60 pt-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => pick("")}>Xoá</Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
