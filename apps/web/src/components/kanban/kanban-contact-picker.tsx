"use client"

/**
 * Picker "Khách hàng" cho card Kanban — tìm kiếm khách hàng mà
 * NGƯỜI DÙNG HIỆN TẠI xem được, qua `GET /contacts?search=` (RBAC-scoped —
 * KHÔNG dùng `/contacts/search` bypass-RBAC, tránh biến picker thành oracle
 * dò tên/SĐT khách ngoài phạm vi). BE vẫn là gate thật khi gắn
 * (`assertCanAccessContactOrNotFound`, 404 nếu chọn nhầm) — đây chỉ là UX.
 *
 * Cùng khuôn (inline dropdown, không portal) — dùng trong Dialog chi tiết card.
 */
import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { Input } from "@/components/ui/input"

interface ContactSearchResult {
  id: string | number
  full_name: string
  phone: string
}

interface ContactsSearchResponse {
  data?: ContactSearchResult[]
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

interface KanbanContactPickerProps {
  value: number | null
  valueLabel?: string | null
  onChange: (contactId: number | null, label: string | null) => void
  disabled?: boolean
}

export function KanbanContactPicker({
  value,
  valueLabel,
  onChange,
  disabled = false,
}: KanbanContactPickerProps) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const debouncedSearch = useDebouncedValue(search, 300)

  const { data: results = [], isFetching } = useQuery<ContactSearchResult[]>({
    queryKey: ["kanban-contact-picker-search", debouncedSearch],
    queryFn: async () => {
      const res = await apiClient.get<ContactsSearchResponse | ContactSearchResult[]>(
        "/contacts",
        { params: { search: debouncedSearch, limit: 10, page: 1 } },
      )
      const payload = res.data
      if (Array.isArray(payload)) return payload
      return payload.data ?? []
    },
    enabled: open && debouncedSearch.trim().length >= 2,
    staleTime: 15_000,
  })

  const displayValue = open ? search : value != null ? (valueLabel ?? `#${value}`) : ""

  return (
    <div className="relative w-full">
      <Input
        placeholder="Tìm khách hàng theo tên/SĐT…"
        value={displayValue}
        disabled={disabled}
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
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(null, null)
              setSearch("")
              setOpen(false)
            }}
            className="flex w-full items-center px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            — Gỡ liên kết khách hàng —
          </button>
          {debouncedSearch.trim().length < 2 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Gõ ít nhất 2 ký tự</div>
          ) : isFetching ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Đang tìm…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Không tìm thấy khách hàng phù hợp</div>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(Number(c.id), c.full_name)
                  setSearch("")
                  setOpen(false)
                }}
                className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="truncate font-medium">{c.full_name}</span>
                <span className="text-xs text-muted-foreground">{c.phone}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
