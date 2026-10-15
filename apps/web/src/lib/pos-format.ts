import { formatCurrency } from "@/lib/format"
import { getApiErrorMessage } from "@/lib/api-client"

/** "35.000đ" — VND không có phần lẻ (POS lưu số nguyên). */
export const vnd = (n: number | null | undefined): string => `${formatCurrency(n)}đ`

/** Thông điệp lỗi API tiếng Việt; NestJS validation trả `message` là MẢNG → nối lại. */
export function posErrorMessage(err: unknown, fallback = "Có lỗi xảy ra, thử lại"): string {
  const m = getApiErrorMessage(err, fallback) as unknown
  return Array.isArray(m) ? m.join("; ") : typeof m === "string" ? m : fallback
}

/** Chuỗi người dùng gõ ("1.250.000", "50k"?) → số nguyên ≥ 0; rỗng → null. Bỏ mọi ký tự không phải chữ số. */
export function parseMoney(raw: string): number | null {
  const digits = raw.replace(/\D/g, "")
  if (!digits) return null
  const n = Number(digits)
  return Number.isSafeInteger(n) ? n : null
}
