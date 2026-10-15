"use client"

import { forwardRef } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { parseMoney } from "@/lib/pos-format"

interface MoneyInputProps {
  value: number | null
  onChange: (v: number | null) => void
  id?: string
  placeholder?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
}

/**
 * Ô nhập tiền VND: gõ chữ số, hiển thị có dấu chấm ngăn nghìn ("1.250.000"), bàn phím số trên tablet.
 * Giá trị là số nguyên (hoặc null khi rỗng) — không có phần lẻ, không float.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, className, ...rest }, ref,
) {
  return (
    <Input
      ref={ref}
      inputMode="numeric"
      autoComplete="off"
      className={cn("h-11 text-right text-base tabular-nums", className)}
      value={value == null ? "" : value.toLocaleString("vi-VN")}
      onChange={(e) => onChange(parseMoney(e.target.value))}
      {...rest}
    />
  )
})
