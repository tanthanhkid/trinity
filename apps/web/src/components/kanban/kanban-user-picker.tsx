"use client"

/**
 * Picker "Người phụ trách" cho card Kanban. Mirror
 * `manager-select-combobox.tsx`: KHÔNG Base-UI `<Select>`, KHÔNG portal
 * — dropdown render INLINE (absolute trong container `relative`) vì component
 * này luôn được dùng bên trong `<Dialog>` chi tiết card.
 */
import { useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"

interface KanbanUserPickerProps {
  value: number | null
  onChange: (userId: number | null) => void
  disabled?: boolean
  placeholder?: string
}

export function KanbanUserPicker({
  value,
  onChange,
  disabled = false,
  placeholder = "Chọn người phụ trách…",
}: KanbanUserPickerProps) {
  const { data: roster = [], isLoading } = useKanbanUserRoster()
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)

  const sorted = useMemo(
    () => [...roster].sort((a, b) => a.full_name.localeCompare(b.full_name, "vi")),
    [roster],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter((u) => u.full_name.toLowerCase().includes(q))
  }, [sorted, search])

  const selected = value != null ? roster.find((u) => u.id === value) : undefined
  const displayValue = open ? search : value != null ? (selected?.full_name ?? `#${value}`) : ""

  return (
    <div className="relative w-full">
      <Input
        placeholder={isLoading ? "Đang tải…" : placeholder}
        value={displayValue}
        disabled={disabled || isLoading}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (disabled) return
          setSearch("")
          setOpen(true)
        }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
      />
      {open && !disabled && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-input bg-popover py-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          <button
            type="button"
            role="option"
            aria-selected={value == null}
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(null)
              setSearch("")
              setOpen(false)
            }}
            className={`flex w-full items-center px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground ${value == null ? "bg-accent/50" : ""}`}
          >
            — Chưa gán —
          </button>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {search.trim() ? "Không tìm thấy" : "Không có ai"}
            </div>
          ) : (
            filtered.map((u) => {
              const isSelected = u.id === value
              return (
                <button
                  key={u.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(u.id)
                    setSearch("")
                    setOpen(false)
                  }}
                  className={`flex w-full items-center px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${isSelected ? "bg-accent/50" : ""}`}
                >
                  <span className="truncate">{u.full_name}</span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
