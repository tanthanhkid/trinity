// Mô hình form + phép tính tạm tính của màn chi tiết phiếu lương (thuần, không React) — tách khỏi UI để test.
import type { PayslipRow } from "./payroll-payslips-shared"

export interface PayslipForm {
  working_days: string
  standard_working_days: string
  base_salary: string
  training_days: string
  training_salary: string
  probation_allowance: string
  sales_personal: string
  bonus_rate: string
  kpi_percent: string
  bonus_sales_personal: string
  sales_team: string
  bonus_cskh_team: string
  bonus_milestone: string
  bonus_referral: string
  holiday_bonus: string
  advances: string
  notes: string
}
export type PayslipFormKey = keyof PayslipForm

export function digits(v: string): string {
  return v.replace(/\D/g, "")
}
export function n(v: string): number {
  return Number(v || 0)
}
/** Chuỗi rỗng hoặc không phải số hữu hạn (vd "." đơn lẻ) → null; không để NaN lọt vào JSON. */
export function numOrNull(raw: string): number | null {
  if (raw === "") return null
  const x = Number(raw)
  return Number.isFinite(x) ? x : null
}
/** Chỉ số + tối đa MỘT dấu chấm: '21.5.2' → NaN → JSON null (= "đủ công/không đặt") sẽ lưu sai im lặng. */
export function oneDecimalPoint(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "")
  const i = cleaned.indexOf(".")
  return i < 0 ? cleaned : cleaned.slice(0, i + 1) + cleaned.slice(i + 1).replace(/\./g, "")
}

export function formFromRow(row: PayslipRow): PayslipForm {
  return {
    working_days: row.working_days === null ? "" : String(row.working_days),
    standard_working_days: String(row.standard_working_days || 24),
    base_salary: digits(row.base_salary),
    training_days: row.training_days === null ? "" : String(row.training_days),
    training_salary: digits(row.training_salary),
    probation_allowance: digits(row.probation_allowance),
    sales_personal: digits(row.sales_personal),
    bonus_rate: row.bonus_rate === null ? "" : String(row.bonus_rate),
    kpi_percent: row.kpi_percent === null ? "" : String(row.kpi_percent),
    bonus_sales_personal: digits(row.bonus_sales_personal),
    sales_team: digits(row.sales_team),
    bonus_cskh_team: digits(row.bonus_cskh_team),
    bonus_milestone: digits(row.bonus_milestone),
    bonus_referral: digits(row.bonus_referral),
    holiday_bonus: digits(row.holiday_bonus),
    advances: digits(row.advances),
    notes: row.notes ?? "",
  }
}

/** Body `PATCH /payslips/:id` — đúng bộ trường của hộp thoại Sửa phiếu cũ. */
export function payloadFromForm(f: PayslipForm) {
  return {
    working_days: numOrNull(f.working_days),
    standard_working_days: Number(f.standard_working_days) || 24,
    base_salary: f.base_salary || "0",
    training_days: numOrNull(f.training_days),
    training_salary: f.training_salary || "0",
    probation_allowance: f.probation_allowance || "0",
    sales_personal: f.sales_personal || "0",
    bonus_rate: numOrNull(f.bonus_rate),
    kpi_percent: numOrNull(f.kpi_percent),
    bonus_sales_personal: f.bonus_sales_personal || "0",
    sales_team: f.sales_team || "0",
    bonus_cskh_team: f.bonus_cskh_team || "0",
    bonus_milestone: f.bonus_milestone || "0",
    bonus_referral: f.bonus_referral || "0",
    holiday_bonus: f.holiday_bonus || "0",
    advances: f.advances || "0",
    notes: f.notes,
  }
}

export interface FormTotals {
  donGiaNgayCong: number
  baseActual: number
  congLcb: number
  congThuong: number
  tongLuong: number
}

/** Các phần tính được ở FE (giống BE `buildPayslipData`); BHXH/thuế/thực nhận do máy chủ tính lại khi lưu. */
export function totalsFromForm(f: PayslipForm): FormTotals {
  const wd = numOrNull(f.working_days)
  const std = Number(f.standard_working_days) || 24
  const donGiaNgayCong = std > 0 ? Math.round(n(f.base_salary) / std) : 0
  const baseActual = wd === null ? n(f.base_salary) : Math.round((n(f.base_salary) * wd) / std)
  const congLcb = baseActual + n(f.training_salary) + n(f.probation_allowance)
  const congThuong =
    n(f.bonus_sales_personal) + n(f.bonus_cskh_team) + n(f.bonus_milestone) + n(f.bonus_referral) + n(f.holiday_bonus)
  return { donGiaNgayCong, baseActual, congLcb, congThuong, tongLuong: congLcb + congThuong }
}

export interface Projection {
  net: number
  gross: number
  ded: number
}

/**
 * Số tạm tính hiện ở khối nhấn: chưa sửa ⇒ đúng số đã lưu của máy chủ; đã sửa ⇒ số đã lưu cộng chênh lệch
 * (thu nhập theo công thức FE, khấu trừ theo «đã chi lĩnh trước»). Bảo hiểm/thuế giữ số đã lưu tới khi lưu.
 * Thực nhận không âm (BE chặn về 0).
 */
export function projectTotals(row: PayslipRow, form: PayslipForm, saved: PayslipForm): Projection {
  const gross0 = Number(row.tong_luong ?? 0)
  const ded0 = Number(row.tong_giam_tru ?? 0)
  const net0 = Number(row.total ?? 0)
  const dGross = totalsFromForm(form).tongLuong - totalsFromForm(saved).tongLuong
  const dAdv = n(form.advances) - n(saved.advances)
  if (dGross === 0 && dAdv === 0) return { net: net0, gross: gross0, ded: ded0 }
  return { net: Math.max(0, net0 + dGross - dAdv), gross: gross0 + dGross, ded: ded0 + dAdv }
}

export function changedKeys(form: PayslipForm, saved: PayslipForm): PayslipFormKey[] {
  return (Object.keys(form) as PayslipFormKey[]).filter((k) => form[k] !== saved[k])
}
