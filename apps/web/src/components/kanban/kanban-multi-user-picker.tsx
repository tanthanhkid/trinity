"use client"

/**
 * Picker "Người phụ trách" NHIỀU người — mirror
 * `kanban-user-picker.tsx` (dropdown INLINE, KHÔNG Base-UI Select/Popover
 * vì component luôn nằm trong `<Dialog>` chi tiết card).
 */
import { useMemo, useState } from "react"
import { X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"

interface KanbanMultiUserPickerProps {
  value: number[]
  onChange: (userIds: number[]) => void
  disabled?: boolean
  placeholder?: string
}

export function KanbanMultiUserPicker({
  value,
  onChange,
  disabled = false,
  placeholder = "Thêm người phụ trách…",
}: KanbanMultiUserPickerProps) {
  const { data: roster = [], isLoading } = useKanbanUserRoster()
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)

  const nameById = useMemo(() => new Map(roster.map((u) => [u.id, u.full_name])), [roster])
  const sorted = useMemo(
    () => [...roster].sort((a, b) => a.full_name.localeCompare(b.full_name, "vi")),
    [roster],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q ? sorted.filter((u) => u.full_name.toLowerCase().includes(q)) : sorted
    return base
  }, [sorted, search])

  const toggle = (userId: number) => {
    if (value.includes(userId)) onChange(value.filter((id) => id !== userId))
    else onChange([...value, userId])
  }

  return (
    <div className="relative w-full">
      {value.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground"
            >
              {nameById.get(id) ?? `#${id}`}
              {!disabled && (
                <button type="button" onClick={() => toggle(id)} aria-label="Gỡ người phụ trách">
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <Input
        placeholder={isLoading ? "Đang tải…" : placeholder}
        value={search}
        disabled={disabled || isLoading}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
        }}
        onFocus={() => !disabled && setOpen(true)}
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
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {search.trim() ? "Không tìm thấy" : "Không có ai"}
            </div>
          ) : (
            filtered.map((u) => {
              const isSelected = value.includes(u.id)
              return (
                <button
                  key={u.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    toggle(u.id)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${isSelected ? "bg-accent/50" : ""}`}
                >
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center rounded border ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                  >
                    {isSelected && "✓"}
                  </span>
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
