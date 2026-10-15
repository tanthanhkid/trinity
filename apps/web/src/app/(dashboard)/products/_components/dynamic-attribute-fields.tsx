"use client"

/**
 * Render TRƯỜNG ĐỘNG theo `ProductAttributeDef[]` của danh mục đã chọn — form tạo/sửa sản phẩm dùng bộ
 * field do danh mục tự khai báo (`type` quyết định control nào render).
 *
 * State giá trị `attributes` giữ RIÊNG (ngoài `react-hook-form`, xem
 * `product-form-dialog.tsx`) vì path động `attributes.<key tuỳ danh mục>`
 * không khớp kiểu tĩnh của `ProductForm` — validate THẬT SỰ nằm ở BE
 * (`validateProductAttributes`), component này chỉ chặn "thiếu field bắt
 * buộc" trước khi submit (`findMissingRequiredAttributes`).
 */
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { CurrencyInput } from "@/components/ui/currency-input"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { ProductAttributeDef } from "@/types/product-category"

export type AttributeValues = Record<string, unknown>

/** Trả về danh sách KEY các field bắt buộc còn thiếu — rỗng = hợp lệ để submit. */
export function findMissingRequiredAttributes(
  defs: ProductAttributeDef[],
  values: AttributeValues,
): string[] {
  const missing: string[] = []
  for (const def of defs) {
    if (!def.is_required) continue
    const v = values[def.key]
    const isEmpty =
      v === undefined ||
      v === null ||
      v === "" ||
      (Array.isArray(v) && v.length === 0)
    if (isEmpty) missing.push(def.key)
  }
  return missing
}

/** Giá trị thuộc tính tiền (number | string | rỗng) → chuỗi chữ số cho `CurrencyInput`. */
export function attributeCurrencyToDigits(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.round(Math.abs(value)))
  if (typeof value === "string") return value.replace(/\D/g, "")
  return ""
}

interface FieldProps {
  def: ProductAttributeDef
  value: unknown
  onChange: (value: unknown) => void
  hasError: boolean
}

export function DynamicAttributeFields({
  defs,
  values,
  onChange,
  invalidKeys,
}: {
  defs: ProductAttributeDef[]
  values: AttributeValues
  onChange: (key: string, value: unknown) => void
  /** Tập `def.key` đang thiếu bắt buộc — set trực tiếp từ output của `findMissingRequiredAttributes` (KHÔNG qua `label`), xem `product-form-dialog.tsx`. */
  invalidKeys: Set<string>
}) {
  if (defs.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-xl border p-3">
      <p className="text-xs font-semibold text-muted-foreground">Thuộc tính theo danh mục</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {defs.map((def) => (
          <div
            key={def.id}
            className={cn(
              def.type === "textarea" || def.type === "multiselect" ? "sm:col-span-2" : undefined,
              "space-y-1.5",
            )}
          >
            <Label htmlFor={`attr-${def.key}`}>
              {def.label}
              {def.is_required ? " *" : ""}
            </Label>
            <AttributeField
              def={def}
              value={values[def.key]}
              onChange={(v) => onChange(def.key, v)}
              hasError={invalidKeys.has(def.key)}
            />
            <p className="min-h-4 text-xs leading-4 text-destructive">
              {invalidKeys.has(def.key) ? `${def.label} là bắt buộc` : ""}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function AttributeField({ def, value, onChange, hasError }: FieldProps) {
  const inputId = `attr-${def.key}`
  switch (def.type) {
    case "textarea":
      return (
        <Textarea
          id={inputId}
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={hasError}
        />
      )
    case "currency":
      // tiền VNĐ hiện dấu chấm hàng nghìn khi gõ; giá trị GỬI BE
      // vẫn là số (ô trống = undefined, KHÔNG ép 0).
      return (
        <CurrencyInput
          id={inputId}
          value={attributeCurrencyToDigits(value)}
          onValueChange={(digits) => onChange(digits === "" ? undefined : Number(digits))}
          aria-invalid={hasError}
        />
      )
    case "number":
      return (
        <Input
          id={inputId}
          type="number"
          value={typeof value === "number" || typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          aria-invalid={hasError}
        />
      )
    case "percent":
      return (
        <Input
          id={inputId}
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={typeof value === "number" || typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          aria-invalid={hasError}
        />
      )
    case "date":
      // native <input type="date"> render theo locale trình duyệt/OS,
      // KHÔNG theo `lang` trang (mm/dd/yyyy trên máy locale en-US dù toàn app
      // tiếng Việt). Dùng `VnDateInput` (LUÔN dd/mm/yyyy, contract ISO
      // YYYY-MM-DD không đổi) — mirror convention toàn repo.
      return (
        <VnDateInput
          id={inputId}
          value={typeof value === "string" ? value : ""}
          onChange={(next) => onChange(next === "" ? undefined : next)}
        />
      )
    case "boolean":
      return (
        <div className="flex h-9 items-center max-sm:min-h-11">
          <Checkbox
            checked={value === true}
            onCheckedChange={(c) => onChange(c)}
          />
        </div>
      )
    case "select":
      return <SelectAttributeField def={def} value={value} onChange={onChange} />
    case "multiselect":
      return <MultiselectAttributeField def={def} value={value} onChange={onChange} />
    case "text":
    default:
      return (
        <Input
          id={inputId}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          aria-invalid={hasError}
        />
      )
  }
}

const NONE_SENTINEL = "__none__"

function SelectAttributeField({
  def,
  value,
  onChange,
}: {
  def: ProductAttributeDef
  value: unknown
  onChange: (value: unknown) => void
}) {
  const options = def.options ?? []
  const current = typeof value === "string" && value !== "" ? value : NONE_SENTINEL
  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(v === NONE_SENTINEL ? undefined : v)}
      items={[
        { value: NONE_SENTINEL, label: "— Chưa chọn —" },
        ...options.map((o) => ({ value: o.value, label: o.label })),
      ]}
    >
      <SelectTrigger>
        {/* children là hàm, TỰ trả nhãn kể cả khi chưa chọn gì. */}
        <SelectValue placeholder="Chọn...">
          {(v) => {
            if (!v || v === NONE_SENTINEL) {
              return <span className="text-muted-foreground">— Chưa chọn —</span>
            }
            return options.find((o) => o.value === v)?.label ?? v
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_SENTINEL}>— Chưa chọn —</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MultiselectAttributeField({
  def,
  value,
  onChange,
}: {
  def: ProductAttributeDef
  value: unknown
  onChange: (value: unknown) => void
}) {
  const options = def.options ?? []
  const selected = Array.isArray(value) ? (value as string[]) : []
  function toggle(optionValue: string) {
    const next = selected.includes(optionValue)
      ? selected.filter((v) => v !== optionValue)
      : [...selected, optionValue]
    onChange(next)
  }
  return (
    <div className="flex flex-wrap gap-2 rounded-md border p-2">
      {options.length === 0 && (
        <span className="text-xs text-muted-foreground">Danh mục chưa cấu hình lựa chọn</span>
      )}
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 text-sm font-normal max-sm:min-h-11">
          <Checkbox checked={selected.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  )
}
