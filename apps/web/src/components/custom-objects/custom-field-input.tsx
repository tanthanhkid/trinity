"use client"

import { Input } from "@/components/ui/input"
import { CurrencyInput } from "@/components/ui/currency-input"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { isoToVnLocal, vnLocalToIso } from "@/lib/custom-objects/datetime"
import { CHOICE_COLOR_CLASS, resolveChoiceColor } from "@/lib/custom-objects/field-meta"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomRelationLabel } from "@/types/custom-objects"
import { RelationCombobox } from "./relation-combobox"
import { LinkInput } from "@/components/refs/link-input"
import { MentionEditor } from "@/components/refs/mention-editor"

const NONE = "__none__"

export interface CustomFieldInputProps {
  field: CustomFieldDef
  value: unknown
  onChange: (next: unknown) => void
  invalid?: boolean
  /** Nhãn liên kết đã biết (bản ghi đang sửa). */
  labels?: CustomRelationLabel | CustomRelationLabel[]
}

/**
 * Ô nhập cho 1 trường tuỳ biến theo kiểu. Giá trị "rỗng" luôn là `undefined` (caller đổi thành `null` khi cần xoá).
 * Ngày: `VnDateInput` (ISO). Tiền: `CurrencyInput` (ô trống = undefined, không ép 0). Select: Base-UI.
 * Công thức không nhập được — chỉ hiển thị ở nơi gọi.
 */
export function CustomFieldInput({ field, value, onChange, invalid, labels }: CustomFieldInputProps) {
  const id = `cf-${field.key}`
  const labelList = labels === undefined ? [] : Array.isArray(labels) ? labels : [labels]
  switch (field.type) {
    case "text": case "email":
      return <Input id={id} type="text" inputMode={field.type === "email" ? "email" : undefined} autoComplete="off" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} aria-invalid={invalid} maxLength={500} />
    case "phone":
      return <Input id={id} type="tel" inputMode="tel" autoComplete="off" placeholder="0912345678" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} aria-invalid={invalid} />
    case "url":
      return <Input id={id} type="url" inputMode="url" autoComplete="off" placeholder="https://" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} aria-invalid={invalid} />
    case "long_text":
      return <MentionEditor id={id} rows={4} value={typeof value === "string" ? value : undefined} onChange={(v) => onChange(v)} invalid={invalid} maxLength={10000} placeholder="Gõ @ để gắn thẻ bản ghi khác (vd @SP001)" />
    case "number": case "percent":
      return (
        <div className="relative">
          <Input id={id} type="number" step="any" inputMode="decimal" value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} aria-invalid={invalid} className={field.type === "percent" ? "pr-9" : undefined} />
          {field.type === "percent" && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">%</span>}
        </div>
      )
    case "currency":
      return <CurrencyInput id={id} value={typeof value === "number" ? String(Math.trunc(value)) : ""} onValueChange={(d) => onChange(d === "" ? undefined : Number(d))} aria-invalid={invalid} placeholder="0" />
    case "date":
      return <VnDateInput id={id} value={typeof value === "string" ? value : ""} onChange={(v) => onChange(v || undefined)} />
    case "datetime":
      return <VnDateTimeInput id={id} value={isoToVnLocal(value)} onChange={(v) => onChange(vnLocalToIso(v))} />
    case "boolean":
      return <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} aria-label={field.label} />
    case "select": {
      const choices = field.options.choices ?? []
      return (
        <Select value={typeof value === "string" ? value : NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
          <SelectTrigger id={id} aria-invalid={invalid}>
            <SelectValue>
              {(v) => {
                const c = choices.find((o) => o.value === v)
                return c ? c.label : <span className="text-muted-foreground">Chọn…</span>
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}><span className="text-muted-foreground">— Không chọn —</span></SelectItem>
            {choices.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )
    }
    case "multi_select": {
      const on = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
          {(field.options.choices ?? []).map((c) => {
            const active = on.includes(c.value)
            return (
              <Button key={c.value} type="button" size="sm" variant={active ? "soft" : "outline"} aria-pressed={active}
                className={cn(active && CHOICE_COLOR_CLASS[resolveChoiceColor(field.options.choices, c.value)])}
                onClick={() => { const next = active ? on.filter((x) => x !== c.value) : [...on, c.value]; onChange(next.length ? next : undefined) }}>
                {c.label}
              </Button>
            )
          })}
        </div>
      )
    }
    case "relation": {
      const kind = field.options.target === "contact" ? "__contacts" : field.options.target_key
      if (!kind) return <p className="text-sm text-muted-foreground">Bạn không có quyền xem tính năng được liên kết.</p>
      return <RelationCombobox id={id} kind={kind} multiple={field.options.multiple} value={value as number | number[] | undefined} onChange={onChange} initialLabels={labelList} invalid={invalid} />
    }
    case "user":
      return <RelationCombobox id={id} kind="__users" value={value as number | undefined} onChange={onChange} initialLabels={labelList} invalid={invalid} placeholder="Chọn nhân viên…" />
    case "link":
      return <LinkInput id={id} value={Array.isArray(value) ? (value as string[]) : undefined} onChange={onChange} labels={labelList} invalid={invalid} />
    case "formula":
      return <p className="text-sm text-muted-foreground">Tự tính khi lưu — không nhập tay.</p>
  }
}
