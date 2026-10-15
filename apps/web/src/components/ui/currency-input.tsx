"use client"

/**
 * Ô nhập số tiền VNĐ có dấu phân cách hàng nghìn kiểu VN ("1.500.000") ngay khi
 * gõ.
 *
 * Hợp đồng dữ liệu KHÔNG đổi: `value`/`onValueChange` làm việc với chuỗi CHỈ GỒM
 * CHỮ SỐ ("1500000"); chuỗi rỗng "" = CHƯA NHẬP (caller đổi thành `null`, KHÔNG
 * ép 0). Dấu chấm chỉ là phần HIỂN THỊ. Chỉ nhận số nguyên không âm (VND
 * không có phần thập phân; BE `price` là `@IsInt @Min(0)`).
 *
 * Giữ vị trí con trỏ: đếm số chữ số nằm trước con trỏ rồi đặt lại sau khi định
 * dạng — sửa giữa dãy số không bị nhảy con trỏ về cuối.
 */
import { useLayoutEffect, useRef, type ComponentProps } from "react"
import { Input } from "@/components/ui/input"

/** 15 chữ số < `Number.MAX_SAFE_INTEGER` (9,007e15) — `Number(raw)` không mất chính xác. */
export const CURRENCY_MAX_DIGITS = 15

/** Bỏ mọi ký tự không phải chữ số, bỏ số 0 đứng đầu thừa, cắt ở `CURRENCY_MAX_DIGITS`. */
export function toCurrencyDigits(text: string): string {
  const digits = text.replace(/\D/g, "").slice(0, CURRENCY_MAX_DIGITS)
  return digits.replace(/^0+(?=\d)/, "")
}

/** "1500000" → "1.500.000"; "" → "". Tự cài dấu chấm, KHÔNG phụ thuộc ICU của môi trường. */
export function formatCurrencyDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
}

/** Vị trí trong chuỗi ĐÃ định dạng ứng với `digitCount` chữ số đầu tiên. */
function caretForDigitCount(formatted: string, digitCount: number): number {
  if (digitCount <= 0) return 0
  let seen = 0
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) seen += 1
    if (seen === digitCount) return i + 1
  }
  return formatted.length
}

type CurrencyInputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "defaultValue"
> & {
  /** Chuỗi chữ số ("" = chưa nhập). */
  value: string
  onValueChange: (digits: string) => void
}

export function CurrencyInput({ value, onValueChange, ...rest }: CurrencyInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const display = formatCurrencyDigits(value)

  useLayoutEffect(() => {
    const el = ref.current
    if (el && pendingCaret.current != null && document.activeElement === el) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
    }
    pendingCaret.current = null
  })

  return (
    <Input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      value={display}
      onChange={(e) => {
        const raw = e.target.value
        const caret = e.target.selectionStart ?? raw.length
        const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, "").length
        const next = toCurrencyDigits(raw)
        pendingCaret.current = caretForDigitCount(
          formatCurrencyDigits(next),
          Math.min(digitsBeforeCaret, next.length),
        )
        onValueChange(next)
        // Giá trị không đổi (gõ chữ cái) ⇒ không render lại ⇒ dọn mốc con trỏ chờ.
        requestAnimationFrame(() => {
          pendingCaret.current = null
        })
      }}
    />
  )
}
