"use client"

/**
 * Select chung dạng "dropdown inline" — cùng giao diện với
 * `KanbanUserPicker` (bo góc, shadow, highlight option) nhưng generic cho mọi
 * danh sách `{value, label}`.
 *
 * Vì sao KHÔNG dùng Base-UI `<Select>` (`components/ui/select.tsx`): component
 * này được dùng BÊN TRONG `<Dialog>` — Select portal ra `document.body` làm
 * "outside press" đóng cả Dialog, và `<SelectValue>` phải tự map label. Ở đây dropdown render INLINE (`absolute` trong container
 * `relative`, không portal) và label luôn lấy trực tiếp từ `options`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"
import { DS_V2_ENABLED } from "@/lib/design-system-flags"
import { cn } from "@/lib/utils"

export interface InlineSelectOption<T extends string | number> {
  value: T
  label: string
  /** Dòng phụ nhỏ dưới label (vd email). */
  description?: string
  disabled?: boolean
}

interface InlineSelectProps<T extends string | number> {
  options: InlineSelectOption<T>[]
  value: T | null | undefined
  onChange: (value: T | null) => void
  placeholder?: string
  /** Hiện ô tìm kiếm trong dropdown (mặc định tự bật khi > 8 option). */
  searchable?: boolean
  /** Có label này → thêm option đầu danh sách để bỏ chọn (value = null). */
  clearLabel?: string
  disabled?: boolean
  loading?: boolean
  emptyText?: string
  id?: string
  ariaLabel?: string
  className?: string
  /** `sm` = h-9 cho thanh lọc/toolbar gọn; mặc định `md` = h-11 khớp `<Input>`. */
  size?: "sm" | "md"
}

const AUTO_SEARCH_THRESHOLD = 8

export function InlineSelect<T extends string | number>({
  options,
  value,
  onChange,
  placeholder = "Chọn…",
  searchable,
  clearLabel,
  disabled = false,
  loading = false,
  emptyText = "Không có lựa chọn",
  id,
  ariaLabel,
  className,
  size = "md",
}: InlineSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const showSearch = searchable ?? options.length > AUTO_SEARCH_THRESHOLD

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.description ?? "").toLowerCase().includes(q),
    )
  }, [options, search])

  const selected = value == null ? undefined : options.find((o) => o.value === value)
  const close = () => {
    setOpen(false)
    setSearch("")
  }
  const pick = (v: T | null) => {
    onChange(v)
    close()
  }
  const isDisabled = disabled || loading

  return (
    <div
      ref={rootRef}
      className={cn("relative w-full", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation()
          close()
        }
      }}
    >
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={isDisabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-2 border border-input bg-card px-2.5 text-left text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
          size === "sm" ? "h-9" : "h-11",
          DS_V2_ENABLED ? "rounded-sm" : "rounded-lg",
        )}
      >
        <span className={cn("truncate", selected ? "" : "text-muted-foreground")}>
          {loading ? "Đang tải…" : (selected?.label ?? placeholder)}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && !isDisabled && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-input bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10">
          {showSearch && (
            <div className="relative border-b border-input p-1.5">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm…"
                className="h-8 w-full rounded-md bg-transparent pr-2 pl-7 text-base outline-none placeholder:text-muted-foreground md:text-sm"
              />
            </div>
          )}
          <div id={listId} role="listbox" className="max-h-60 overflow-y-auto py-1">
            {clearLabel && (
              <OptionRow selected={value == null} onPick={() => pick(null)} muted label={clearLabel} />
            )}
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {search.trim() ? "Không tìm thấy" : emptyText}
              </div>
            ) : (
              filtered.map((o) => (
                <OptionRow
                  key={String(o.value)}
                  selected={o.value === value}
                  onPick={() => pick(o.value)}
                  label={o.label}
                  description={o.description}
                  disabled={o.disabled}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function OptionRow({
  selected,
  onPick,
  label,
  description,
  muted = false,
  disabled = false,
}: {
  disabled?: boolean
  selected: boolean
  onPick: () => void
  label: string
  description?: string
  muted?: boolean
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
        selected && "bg-accent/50",
        muted && "text-muted-foreground",
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
      </span>
      {selected && <CheckIcon className="size-4 shrink-0" />}
    </button>
  )
}
