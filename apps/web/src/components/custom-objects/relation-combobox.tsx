"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Loader2, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useCustomLookup } from "@/hooks/custom-objects/use-custom-objects"
import { cn } from "@/lib/utils"
import type { CustomRelationLabel } from "@/types/custom-objects"

/**
 * Ô chọn bản ghi liên kết / người dùng / khách hàng. Danh sách thả nằm INLINE trong cây DOM (không portal —
 * portal ra body làm "outside press" đóng cả Dialog). BE chỉ trả `{id, title}` của bản ghi TRONG PHẠM VI người xem.
 * `kind`: khoá thực thể đích | "__users" | "__contacts".
 */
export interface RelationComboboxProps {
  kind: string
  value: number | number[] | undefined
  multiple?: boolean
  onChange: (next: number | number[] | undefined) => void
  /** Nhãn đã biết (từ bản ghi đang sửa) để hiện tên trước khi mở danh sách. */
  initialLabels?: CustomRelationLabel[]
  /** Với kind "__users": lấy người trong phạm vi quyền sửa (chọn người phụ trách) hay xem. */
  forPerm?: "view" | "manage"
  placeholder?: string
  id?: string
  disabled?: boolean
  invalid?: boolean
}

export function RelationCombobox({ kind, value, multiple, onChange, initialLabels = [], forPerm, placeholder = "Chọn…", id, disabled, invalid }: RelationComboboxProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [up, setUp] = useState(false) // thiếu chỗ phía dưới → mở lên trên (không bị đáy màn / thanh Lưu che)
  const [term, setTerm] = useState("") // q đã debounce → khoá truy vấn (không mỗi phím một request)
  const timer = useRef<number | null>(null)
  const [known, setKnown] = useState<Record<number, string>>(() =>
    Object.fromEntries(initialLabels.filter((l) => l.title !== null).map((l) => [l.id, l.title as string])),
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const lookup = useCustomLookup(kind, term.trim(), open, forPerm)
  const selected = Array.isArray(value) ? value : value === undefined ? [] : [value]

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])

  function onQuery(next: string) {
    setQ(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setTerm(next), 250)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  function toggle(item: { id: number; title: string }) {
    setKnown((k) => ({ ...k, [item.id]: item.title }))
    if (!multiple) {
      onChange(selected[0] === item.id ? undefined : item.id)
      setOpen(false)
      return
    }
    const next = selected.includes(item.id) ? selected.filter((x) => x !== item.id) : [...selected, item.id]
    onChange(next.length ? next : undefined)
  }

  const label = (idv: number) => known[idv] ?? `#${idv}`

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        onClick={() => {
          const r = rootRef.current?.getBoundingClientRect()
          if (r) setUp(window.innerHeight - r.bottom < 340 && r.top > window.innerHeight - r.bottom)
          setOpen((o) => !o)
        }}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-2.5 py-1.5 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          invalid && "border-destructive",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {selected.length === 0 && <span className="text-muted-foreground">{placeholder}</span>}
          {selected.map((s) => (
            <span key={s} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
              <span className="truncate">{label(s)}</span>
              {multiple && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Bỏ ${label(s)}`}
                  className="relative inline-flex rounded after:absolute after:-inset-3 after:content-['']"
                  onClick={(e) => { e.stopPropagation(); onChange(selected.filter((x) => x !== s).length ? selected.filter((x) => x !== s) : undefined) }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange(selected.filter((x) => x !== s).length ? selected.filter((x) => x !== s) : undefined) } }}
                >
                  <X className="size-3" />
                </span>
              )}
            </span>
          ))}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className={cn("absolute z-50 w-full rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg", up ? "bottom-full mb-1" : "mt-1")}>
          <Input autoFocus value={q} onChange={(e) => onQuery(e.target.value)} placeholder="Gõ để tìm…" aria-label="Tìm" className="mb-2" />
          <ul role="listbox" className="max-h-56 overflow-y-auto">
            {lookup.isLoading && <li className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tìm…</li>}
            {!lookup.isLoading && (lookup.data ?? []).length === 0 && (
              <li className="px-2 py-2 text-sm text-muted-foreground">{kind === "__contacts" && term.trim().length < 2 ? "Gõ ít nhất 2 ký tự để tìm khách" : "Không có kết quả trong phạm vi của bạn"}</li>
            )}
            {(lookup.data ?? []).map((it) => {
              const on = selected.includes(it.id)
              return (
                <li key={it.id} role="option" aria-selected={on}>
                  <button type="button" onClick={() => toggle(it)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                    <Check className={cn("size-4 shrink-0", on ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{it.title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
