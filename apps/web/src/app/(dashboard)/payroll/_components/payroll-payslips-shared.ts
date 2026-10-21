// Kiểu + helper thuần dùng chung cho tab Phiếu lương .
export interface PayslipComponentLine {
  code: string
  name: string
  component_type: "allowance" | "bonus" | "deduction"
  calc_method?: string
  amount: number
}
export interface PayslipInsuranceLine {
  code: string
  name: string
  rate: number
  base: number
  amount: number
}
export interface PayslipTaxJson {
  taxable_income: number
  tax: number
  brackets: Array<{ rate: number; portion: number; tax: number }>
}

export const COMPONENT_TYPE_META: Record<PayslipComponentLine["component_type"], { label: string; cls: string }> = {
  allowance: { label: "Phụ cấp", cls: "bg-emerald-50 text-emerald-600" },
  bonus: { label: "Thưởng", cls: "bg-sky-50 text-sky-700" },
  deduction: { label: "Khấu trừ", cls: "bg-rose-50 text-rose-600" },
}

// BE serializePayslip — mọi tiền là CHUỖI BigInt; working_days là số (hoặc null);
// các trường dẫn xuất (cong_lcb...) read-only do BE tính.
export interface PayslipRow {
  id: number
  employee_id: number
  month: string
  base_salary: string
  deductions: string
  total: string
  components_json?: PayslipComponentLine[] | null
  insurance_json?: PayslipInsuranceLine[] | null
  tax_json?: PayslipTaxJson | null
  working_days: number | null
  standard_working_days: number
  base_salary_actual: string
  training_days: number | null // Ngày học việc (passthrough, cột "Ngày học việc" theo Template)
  training_salary: string
  probation_allowance: string
  sales_personal: string
  bonus_rate: number | null
  kpi_percent: number | null
  bonus_sales_personal: string
  sales_team: string
  bonus_cskh_team: string
  bonus_milestone: string
  bonus_referral: string
  holiday_bonus: string
  advances: string
  notes: string | null
  cong_lcb: string
  cong_thuong: string
  tong_luong: string
  insurance_total: string
  insurance_base: string // Lương đóng BHXH (mức cố định)
  phu_cap_xang_xe: string // Phụ cấp xăng xe/ăn ca = base − insurance_base
  tax_total: string
  tong_giam_tru: string
  don_gia_ngay_cong: string
  bonus_sales_personal_suggested: string
  status: string
  employee: {
    id: number
    user_id: number
    position: string
    team_id: number | null
    // Mã NV — luôn có giá trị từ BE (formatEmployeeCode fallback NV<id>); optional cho an toàn kiểu.
    employee_code?: string | null
    team_name?: string | null
    team_lead_id?: number | null
    user: { full_name: string; email: string }
    bank_account_number?: string | null
    bank_name?: string | null
    // Segment info (BE serializePayslip enrich)
    office_id?: number | null
    office_name?: string | null
    department?: string | null
    job_title_name?: string | null // Tên chức danh chính thức (cột "Vị trí")
    job_title_category?: string | null
    standard_target?: string | null // BigInt as string
  }
}

export const MONTHS_VI = ["Th1","Th2","Th3","Th4","Th5","Th6","Th7","Th8","Th9","Th10","Th11","Th12"]

export function getCurrentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}
export function formatMonth(ym: string) {
  const [y, m] = ym.split("-")
  return `${m}/${y}`
}
export function statusColor(s: string) {
  if (s === "paid") return "bg-green-50 text-green-700"
  if (s === "approved") return "bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]"
  // Chờ duyệt (mọi bước) = cùng màu hổ phách như mẫu chung `StatusTag kind="pending"`; nháp = xám.
  if (s === "pending_accountant" || s === "pending_tl") return "bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]"
  return "bg-[var(--color-app-tag-slate-bg)] text-[var(--color-app-tag-slate-ink)]"
}
export function statusLabel(s: string) {
  if (s === "paid") return "Đã trả lương"
  if (s === "approved") return "Đã duyệt"
  if (s === "pending_accountant") return "Chờ Kế toán duyệt"
  if (s === "pending_tl") return "Chờ Team Lead duyệt"
  return "Nháp"
}
export function fmt(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("vi-VN") + " đ"
}
// Số tiền KHÔNG kèm "đ" — dùng trong ô bảng dày (tiêu đề cột đã ngụ ý VNĐ) cho gọn mắt.
export function fmtNum(n: number | string | null | undefined) {
  return Number(n ?? 0).toLocaleString("vi-VN")
}
// Duyệt 2 bước: bước 1 (`draft`/`pending_tl`, mirror `PayslipsService` BE) =
// `payroll.approve_team`; bước 2 (`pending_accountant`) = `payroll.approve_final`.
// BE vẫn kiểm phạm vi từng phiếu.
export function canApproveNow(
  can: (p: "payroll.approve_team" | "payroll.approve_final") => boolean,
  status: string,
): boolean {
  if (status === "draft" || status === "pending_tl") return can("payroll.approve_team")
  if (status === "pending_accountant") return can("payroll.approve_final")
  return false
}
// Sửa phiếu = `payroll.manage`; KHÔNG sửa phiếu đã duyệt/đã trả.
export function canEditPayslip(canManage: boolean, status: string): boolean {
  return canManage && status !== "approved" && status !== "paid"
}
// Quản lý người trong kỳ (thêm/loại) = `payroll.manage`. Phiếu ĐÃ DUYỆT/ĐÃ TRẢ
// chỉ người có thêm `payroll.approve_final` được loại (BE kiểm lại).
export function canRemoveFromPeriod(canManage: boolean, canFinal: boolean, status: string): boolean {
  if (!canManage) return false
  if (status === "approved" || status === "paid") return canFinal
  return true
}

// Doanh số cá nhân — field ĐÃ LƯU trên phiếu lương (`sales_personal`), nhập tay qua
// dialog Sửa phiếu lương; cột này chỉ đọc giá trị đã lưu.
export function displayRevenue(p: PayslipRow): number {
  return Number(p.sales_personal ?? 0)
}

export type PayslipTotals = Record<
  | "base_salary" | "insurance_base" | "base_salary_actual" | "training_salary"
  | "probation_allowance" | "cong_lcb" | "sales_personal" | "bonus_sales_personal"
  | "bonus_milestone" | "bonus_cskh_team" | "bonus_referral" | "holiday_bonus"
  | "cong_thuong" | "advances" | "insurance_total" | "tax_total" | "tong_giam_tru"
  | "total",
  number
>
