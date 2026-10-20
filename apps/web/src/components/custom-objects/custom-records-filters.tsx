"use client"

import { Plus, X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FILTERABLE_TYPES } from "@/lib/custom-objects/field-meta"
import { isoToVnDate } from "@/lib/format"
import { motionTokens } from "@/lib/motion-tokens"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomObjectDef } from "@/types/custom-objects"
import { RelationCombobox } from "./relation-combobox"

/** Giá trị bộ lọc theo khoá trường (dạng nội bộ FE, đổi sang JSON của BE ở `buildFilterParam`). */
export type FilterState = Record<string, unknown>

const ADD = "__add__"

export function filterableFields(def: CustomObjectDef): CustomFieldDef[] {
  return def.fields.filter((f) => FILTERABLE_TYPES.includes(f.type))
}

/** Bộ lọc FE → chuỗi JSON cho `?filter=` (bỏ ô rỗng). Ngày giờ theo giờ VN (UTC+7). */
export function buildFilterParam(def: CustomObjectDef, state: FilterState): string | undefined {
  const out: Record<string, unknown> = {}
  for (const f of filterableFields(def)) {
    const v = state[f.key]
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue
    if (f.type === "number" || f.type === "currency" || f.type === "percent") {
      const r = v as { min?: string; max?: string }
      const min = r.min ? Number(r.min) : undefined
      const max = r.max ? Number(r.max) : undefined
      if (min !== undefined || max !== undefined) out[f.key] = { ...(min !== undefined && { min }), ...(max !== undefined && { max }) }
    } else if (f.type === "date" || f.type === "datetime") {
      const r = v as { from?: string; to?: string }
      const conv = (d: string, end: boolean) => (f.type === "date" ? d : end ? `${d}T23:59:59.999+07:00` : `${d}T00:00:00+07:00`)
      if (r.from || r.to) out[f.key] = { ...(r.from && { from: conv(r.from, false) }), ...(r.to && { to: conv(r.to, true) }) }
    } else if (f.type === "boolean") {
      out[f.key] = v === "true"
    } else {
      out[f.key] = v
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}

export interface FilterChip {
  key: string
  label: string
  /** Giá trị đang lọc dạng chữ ngắn; relation/user chỉ có id nên ghi "đã chọn". */
  value: string
}

/** Bộ lọc ĐANG ÁP (bỏ ô rỗng, cùng điều kiện với `buildFilterParam`) dạng chữ để hiện chip. */
export function filterChips(def: CustomObjectDef, state: FilterState): FilterChip[] {
  const applied = buildFilterParam(def, state)
  if (!applied) return []
  const keys = Object.keys(JSON.parse(applied) as Record<string, unknown>)
  const range = (a?: string, b?: string) => (a && b ? `${a} – ${b}` : a ? `từ ${a}` : `đến ${b}`)
  const day = (d?: string) => (d ? isoToVnDate(d) : undefined)
  return filterableFields(def).filter((f) => keys.includes(f.key)).map((f) => {
    const v = state[f.key]
    let value: string
    switch (f.type) {
      case "select": case "multi_select": {
        const cur = Array.isArray(v) ? (v as string[])[0] : (v as string)
        value = f.options.choices?.find((c) => c.value === cur)?.label ?? cur
        break
      }
      case "boolean": value = v === "true" ? "Có" : "Không"; break
      case "number": case "currency": case "percent": {
        const r = v as { min?: string; max?: string }
        value = range(r.min || undefined, r.max || undefined)
        break
      }
      case "date": case "datetime": {
        const r = v as { from?: string; to?: string }
        value = range(day(r.from), day(r.to))
        break
      }
      case "relation": case "user": value = "đã chọn"; break
      default: value = String(v)
    }
    return { key: f.key, label: f.label, value }
  })
}

/**
 * Hàng chip "bộ lọc đang áp" — phỏng theo `filter-toolbar` của Arc Library (MIT, xem lib/motion-tokens.ts):
 * mỗi điều kiện một chip có nút bỏ, cuối hàng "Xoá lọc". Chip vào/ra và dồn chỗ bằng Motion.
 */
export function ActiveFilterChips({ chips, onRemove, onClear, className }: {
  chips: FilterChip[]
  onRemove: (key: string) => void
  onClear: () => void
  className?: string
}) {
  return (
    <AnimatePresence initial={false}>
      {chips.length > 0 && (
        <motion.div
          key="chips"
          className={cn("flex flex-wrap items-center gap-1.5", className)}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={motionTokens.spring.smooth}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {chips.map((c) => (
              <motion.span
                key={c.key}
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92, transition: { duration: motionTokens.duration.exit } }}
                transition={motionTokens.spring.snappy}
                className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/60 py-0.5 pr-0.5 pl-2.5 text-xs"
              >
                <span className="truncate"><span className="text-muted-foreground">{c.label}:</span> {c.value}</span>
                <button
                  type="button"
                  aria-label={`Bỏ bộ lọc ${c.label}`}
                  onClick={() => onRemove(c.key)}
                  className="relative grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground after:absolute after:-inset-2 after:content-['']"
                >
                  <X className="size-3" />
                </button>
              </motion.span>
            ))}
            <motion.button
              key="__clear"
              layout
              type="button"
              onClick={onClear}
              transition={motionTokens.spring.snappy}
              className="px-1.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Xoá lọc
            </motion.button>
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ChoiceFilter({ field, value, onChange }: { field: CustomFieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const cur = Array.isArray(value) ? (value as string[])[0] : (value as string | undefined)
  const choices = field.options.choices ?? []
  return (
    <Select value={cur ?? ""} onValueChange={(v) => onChange(v ? (field.type === "multi_select" ? [v] : v) : undefined)}>
      <SelectTrigger aria-label={field.label}>
        <SelectValue>{(v) => choices.find((c) => c.value === v)?.label ?? <span className="text-muted-foreground">Chọn…</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>{choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function Control({ field, value, onChange }: { field: CustomFieldDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.type) {
    case "select": case "multi_select":
      return <ChoiceFilter field={field} value={value} onChange={onChange} />
    case "boolean":
      return (
        <Select value={(value as string | undefined) ?? ""} onValueChange={(v) => onChange(v || undefined)}>
          <SelectTrigger aria-label={field.label}>
            <SelectValue>{(v) => (v === "true" ? "Có" : v === "false" ? "Không" : <span className="text-muted-foreground">Chọn…</span>)}</SelectValue>
          </SelectTrigger>
          <SelectContent><SelectItem value="true">Có</SelectItem><SelectItem value="false">Không</SelectItem></SelectContent>
        </Select>
      )
    case "number": case "currency": case "percent": {
      const r = (value as { min?: string; max?: string } | undefined) ?? {}
      return (
        <div className="flex items-center gap-2">
          <Input type="number" step="any" inputMode="decimal" placeholder="Từ" aria-label={`${field.label} từ`} value={r.min ?? ""} onChange={(e) => onChange({ ...r, min: e.target.value })} />
          <Input type="number" step="any" inputMode="decimal" placeholder="Đến" aria-label={`${field.label} đến`} value={r.max ?? ""} onChange={(e) => onChange({ ...r, max: e.target.value })} />
        </div>
      )
    }
    case "date": case "datetime": {
      const r = (value as { from?: string; to?: string } | undefined) ?? {}
      return (
        <div className="flex items-center gap-2">
          <VnDateInput ariaLabel={`${field.label} từ ngày`} value={r.from ?? ""} onChange={(v) => onChange({ ...r, from: v })} />
          <VnDateInput ariaLabel={`${field.label} đến ngày`} value={r.to ?? ""} onChange={(v) => onChange({ ...r, to: v })} />
        </div>
      )
    }
    case "relation": case "user": {
      const kind = field.type === "user" ? "__users" : field.options.target === "contact" ? "__contacts" : field.options.target_key
      if (!kind) return null
      return <RelationCombobox kind={kind} value={value as number | undefined} onChange={(v) => onChange(typeof v === "number" ? v : undefined)} />
    }
    default: return null
  }
}

/** Thanh bộ lọc theo trường: "Thêm bộ lọc" chọn trường rồi nhập điều kiện. BE lọc, FE chỉ dựng tham số. */
export function CustomRecordsFilters({ def, state, active, onActiveChange, onChange }: {
  def: CustomObjectDef
  state: FilterState
  active: string[]
  onActiveChange: (keys: string[]) => void
  onChange: (next: FilterState) => void
}) {
  const fields = filterableFields(def)
  const remaining = fields.filter((f) => !active.includes(f.key))
  if (fields.length === 0) return null

  function remove(key: string) {
    onActiveChange(active.filter((k) => k !== key))
    const next = { ...state }
    delete next[key]
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {active.map((key) => {
        const f = fields.find((x) => x.key === key)
        if (!f) return null
        return (
          <div key={key} className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto]">
            <span className="truncate text-sm font-medium">{f.label}</span>
            <Control field={f} value={state[key]} onChange={(v) => onChange({ ...state, [key]: v })} />
            <Button type="button" variant="ghost" size="icon" aria-label={`Bỏ bộ lọc ${f.label}`} onClick={() => remove(key)}>
              <X className="size-4" />
            </Button>
          </div>
        )
      })}
      {remaining.length > 0 && (
        <Select value={ADD} onValueChange={(v) => { if (v && v !== ADD) onActiveChange([...active, v]) }}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Thêm bộ lọc">
            <SelectValue>{() => <span className="flex items-center gap-1.5 text-muted-foreground"><Plus className="size-4" /> Thêm bộ lọc</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent>{remaining.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
        </Select>
      )}
    </div>
  )
}
