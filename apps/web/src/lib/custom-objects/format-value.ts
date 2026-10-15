import { formatCurrency, formatDateTimeVn, isoToVnDate } from "@/lib/format"
import type { CustomFieldDef } from "@/types/custom-objects"

/** Số kiểu VN, tối đa `maxFraction` chữ số thập phân (không thêm số 0 thừa). */
export function formatNumberVn(n: number, maxFraction = 6): string {
  return n.toLocaleString("vi-VN", { maximumFractionDigits: maxFraction })
}

/**
 * Giá trị scalar → chuỗi hiển thị (null/undefined → "—" TRƯỚC khi format: không nuốt null thành "0").
 * Không xử lý select/relation (cần nhãn) — `CustomFieldValue` lo.
 */
export function formatScalar(field: CustomFieldDef, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—"
  switch (field.type) {
    case "currency": return typeof v === "number" ? `${formatCurrency(v)} ₫` : "—"
    case "percent": return typeof v === "number" ? `${formatNumberVn(v)}%` : "—"
    case "number": return typeof v === "number" ? formatNumberVn(v) : "—"
    case "date": return isoToVnDate(String(v)) || "—"
    case "datetime": return formatDateTimeVn(String(v))
    case "boolean": return v === true ? "Có" : "Không"
    case "formula": return formatFormula(field, v)
    default: return String(v)
  }
}

function formatFormula(field: CustomFieldDef, v: unknown): string {
  if (typeof v !== "number") return "—"
  const d = field.options.decimals
  const fmt = field.options.format ?? "number"
  const n = formatNumberVn(v, d ?? (fmt === "currency" ? 0 : 2))
  return fmt === "currency" ? `${n} ₫` : fmt === "percent" ? `${n}%` : n
}
