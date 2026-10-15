"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface SelectOption {
  value: string
  label: string
}

/**
 * Select có nhãn (dùng chung bộ lọc nhật ký + form webhook). `SelectValue` có children là hàm thì
 * placeholder bị bỏ qua ⇒ tự trả nhãn cho cả nhánh chưa chọn (`placeholder`) và nhánh giá trị trỏ mục đã mất.
 */
export function OptionSelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  className,
  disabled,
}: {
  label: string
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Select value={value} onValueChange={(v) => onChange(typeof v === "string" ? v : "")} disabled={disabled}>
        <SelectTrigger className={className ?? "h-8 w-[170px] text-sm max-sm:h-11 max-sm:w-full"} aria-label={label}>
          <SelectValue>
            {(v) => {
              const o = options.find((x) => x.value === v)
              if (o) return o.label
              return placeholder ? <span className="text-muted-foreground">{placeholder}</span> : (options[0]?.label ?? null)
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}
