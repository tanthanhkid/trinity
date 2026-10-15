"use client"

/**
 * Searchable Select cho trường "Người phụ trách" tại form
 * Thêm/Sửa Team (Cài đặt > Team).
 *
 * Cùng pattern `bot-select-combobox.tsx`: KHÔNG dùng Base-UI `<Select>`
 * (FloatingFocusManager kéo focus khỏi Input → không gõ được) và KHÔNG
 * `createPortal(document.body)` — field này nằm TRONG Base-UI `<Dialog>`
 * (form Thêm/Sửa Team). Dialog dùng `useDismiss` capture-phase listener trên
 * `document` để tự đóng khi click "ngoài" Popup (kiểm tra DOM containment
 * thật, KHÔNG phải React tree) — 1 node portal ra `document.body` KHÔNG là
 * descendant của Dialog Popup nên bị tính là "outside press" → Dialog tự
 * đóng NGAY khi chọn 1 người trong dropdown, mất toàn bộ form đang nhập
 * (Tên Team, Phòng ban...). Dropdown ở đây render INLINE (absolute trong
 * cùng container `relative`, KHÔNG portal).
 */
import { useMemo, useState } from "react"
import { Input } from "@/components/ui/input"

export interface ManagerComboboxOption {
  id: number
  label: string
}

interface ManagerSelectComboboxProps {
  options: ManagerComboboxOption[]
  value: string | null
  onChange: (id: string | null) => void
  placeholder?: string
  disabled?: boolean
  unassignedLabel?: string
}

export function ManagerSelectCombobox({
  options,
  value,
  onChange,
  placeholder = "Chọn người phụ trách…",
  disabled = false,
  unassignedLabel = "— Chưa gán —",
}: ManagerSelectComboboxProps): React.ReactElement {
  const [search, setSearch] = useState("")
  const [comboOpen, setComboOpen] = useState(false)

  // Sort A-Z theo label — locale 'vi' để sắp đúng dấu tiếng Việt.
  const sortedOptions = useMemo(
    () => [...options].sort((a, b) => a.label.localeCompare(b.label, "vi")),
    [options],
  )

  // Filter case-insensitive, contains, theo tên (đủ tiếng Việt có dấu qua toLowerCase locale).
  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sortedOptions
    return sortedOptions.filter((o) => o.label.toLowerCase().includes(q))
  }, [sortedOptions, search])

  const selected = value ? options.find((o) => String(o.id) === value) : undefined
  const displayValue = comboOpen ? search : value ? (selected?.label ?? "") : ""

  return (
    <div className="relative w-full">
      <Input
        placeholder={placeholder}
        value={displayValue}
        disabled={disabled}
        onChange={(e) => {
          setSearch(e.target.value)
          setComboOpen(true)
        }}
        onFocus={() => {
          if (disabled) return
          setSearch("")
          setComboOpen(true)
        }}
        onBlur={() => setTimeout(() => setComboOpen(false), 200)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && comboOpen) {
            e.preventDefault()
            e.stopPropagation()
            setComboOpen(false)
          }
        }}
        className="pr-8"
        role="combobox"
        aria-expanded={comboOpen}
        autoComplete="off"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 5L7 9L11 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {comboOpen && !disabled && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-input bg-popover py-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(null)
              setSearch("")
              setComboOpen(false)
            }}
            className={`flex w-full items-center px-3 py-2 text-left text-sm max-sm:min-h-11 text-muted-foreground hover:bg-accent hover:text-accent-foreground ${!value ? "bg-accent/50" : ""}`}
          >
            {unassignedLabel}
          </button>
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {search.trim() ? "Không tìm thấy nhân viên phù hợp" : "Chưa có nhân viên nào"}
            </div>
          ) : (
            filteredOptions.map((o) => {
              const isSelected = String(o.id) === value
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(String(o.id))
                    setSearch("")
                    setComboOpen(false)
                  }}
                  className={`flex w-full items-center px-3 py-2 text-left text-sm max-sm:min-h-11 hover:bg-accent hover:text-accent-foreground ${isSelected ? "bg-accent/50" : ""}`}
                >
                  <span className="truncate">{o.label}</span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
