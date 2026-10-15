"use client"

/**
 * Render 1 ô nhập cho trường tuỳ biến theo `KanbanFieldDef.type`.
 * Giá trị đi ra/vào giữ NGUYÊN kiểu JS thật (number/boolean/string/string[])
 * — validate/chuẩn hoá cuối cùng do BE làm (`kanban-field.validator.ts`).
 */
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { KanbanUserPicker } from "./kanban-user-picker"
import type { KanbanFieldDef } from "@/types/kanban"

interface KanbanAttributeFieldProps {
  def: KanbanFieldDef
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
}

export function KanbanAttributeField({ def, value, onChange, disabled }: KanbanAttributeFieldProps) {
  switch (def.type) {
    case "text":
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={def.label}
        />
      )
    case "url":
      return (
        <Input
          type="url"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="https://…"
        />
      )
    case "number":
      return (
        <Input
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          disabled={disabled}
        />
      )
    case "money":
      return (
        <div className="relative">
          <Input
            type="number"
            step={1}
            min={0}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            disabled={disabled}
            className="pr-10"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            đ
          </span>
        </div>
      )
    case "date":
      return (
        <VnDateInput
          value={typeof value === "string" ? value : ""}
          onChange={(next) => onChange(next || null)}
        />
      )
    case "checkbox":
      return (
        <Checkbox
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked === true)}
          disabled={disabled}
        />
      )
    case "select": {
      const options = Array.isArray(def.options) ? def.options : []
      return (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const isSelected = value === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                onClick={() => onChange(isSelected ? null : opt.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent"
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )
    }
    case "multi_select": {
      const options = Array.isArray(def.options) ? def.options : []
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const isSelected = selected.includes(opt.value)
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange(
                    isSelected
                      ? selected.filter((v) => v !== opt.value)
                      : [...selected, opt.value],
                  )
                }
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent"
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )
    }
    case "user":
      return (
        <KanbanUserPicker
          value={typeof value === "number" ? value : null}
          onChange={(userId) => onChange(userId)}
          disabled={disabled}
        />
      )
    default:
      return (
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )
  }
}
