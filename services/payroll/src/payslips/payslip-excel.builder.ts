import * as ExcelJS from 'exceljs'
import { resolvePayrollCompanyName } from './payslip-company'

// Dữ liệu 1 phiếu lương để xuất Excel theo mẫu kế toán.
export interface PayslipExcelData {
  month: string // YYYY-MM
  full_name: string
  position: string
  team_name: string
  base_salary: bigint
  working_days: number | null
  don_gia_ngay_cong: bigint // Số tiền ngày công = lương cơ bản / ngày công chuẩn
  base_salary_actual: bigint
  training_days: number | null // Ngày học việc
  training_salary: bigint // Lương học việc
  probation_allowance: bigint
  cong_lcb: bigint
  sales_personal: bigint
  bonus_rate: number | null // Hệ số %
  kpi_percent: number | null // Tỷ lệ KPI đạt được %
  bonus_sales_personal: bigint
  sales_team: bigint
  bonus_cskh_team: bigint
  bonus_milestone: bigint
  bonus_referral: bigint
  holiday_bonus: bigint // Thưởng Lễ (5) — cộng vào cong_thuong
  cong_thuong: bigint
  tong_luong: bigint
  advances: bigint
  insurance_base: bigint // Lương đóng BHXH (mức cố định theo chức vụ)
  phu_cap_xang_xe: bigint // Phụ cấp xăng xe/ăn ca = base − insurance_base
  insurance_total: bigint
  tax_total: bigint
  tong_giam_tru: bigint
  total: bigint
  bank_account_number: string | null // STK
  bank_name: string | null // Ngân hàng
  notes: string | null
}

const FONT = { name: 'Times New Roman', size: 11 }
const SECTION_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE7F3E0' },
}
const NUM_FMT = '#,##0'

export const NOTE_TEXT =
  'Lưu ý:\n' +
  '- Nếu có thắc mắc về ngày công liên hệ Phòng HR, còn về lương thì liên hệ Phòng Kế Toán.\n' +
  '- "Các khoản đã chi lĩnh trước": số tiền Công ty đã chuyển khoản hoặc Anh/Chị đã tạm ứng trước đó.\n' +
  '- "TỔNG THỰC NHẬN": số tiền còn lại kế toán chuyển khoản để tất toán kỳ lương, chậm nhất ngày 05 hàng tháng.'

/**
 * Ghi nội dung 1 phiếu lương vào worksheet đã tạo (bố cục mẫu I/II/III/IV + lưu ý).
 * Cột B = nhãn, cột C = giá trị (số có định dạng nghìn).
 * MỌI helper + `r` (row counter) khai báo LOCAL trong hàm → reset độc lập mỗi sheet
 * (bắt buộc cho xuất hàng loạt nhiều sheet — KHÔNG share state giữa các phiếu).
 */
function writePayslipSheet(ws: ExcelJS.Worksheet, d: PayslipExcelData): void {
  ws.columns = [{ width: 3 }, { width: 40 }, { width: 22 }]

  const [year, month] = d.month.split('-')
  let r = 2

  const setLabel = (text: string, bold: boolean) => {
    const cell = ws.getCell(`B${r}`)
    cell.value = text
    cell.font = { ...FONT, bold }
  }

  const title = (text: string) => {
    setLabel(text, true)
    r++
  }

  const section = (text: string) => {
    setLabel(text, true)
    ws.getCell(`B${r}`).fill = SECTION_FILL
    ws.getCell(`C${r}`).fill = SECTION_FILL
    r++
  }

  // Dòng tiêu đề mục KÈM giá trị (cột C) — dùng cho mục IV để bỏ dòng nhãn trùng lặp.
  const sectionMoney = (text: string, value: bigint) => {
    setLabel(text, true)
    const c = ws.getCell(`C${r}`)
    c.value = Number(value)
    c.numFmt = NUM_FMT
    c.font = { ...FONT, bold: true }
    c.alignment = { horizontal: 'right' }
    ws.getCell(`B${r}`).fill = SECTION_FILL
    c.fill = SECTION_FILL
    r++
  }

  const moneyLine = (label: string, value: bigint, bold = false) => {
    setLabel(label, bold)
    const c = ws.getCell(`C${r}`)
    c.value = Number(value)
    c.numFmt = NUM_FMT
    c.font = { ...FONT, bold }
    c.alignment = { horizontal: 'right' }
    r++
  }

  const textLine = (label: string, value: string) => {
    setLabel(label, false)
    const c = ws.getCell(`C${r}`)
    c.value = value
    c.font = FONT
    r++
  }

  const numLine = (label: string, value: number | null) => {
    setLabel(label, false)
    const c = ws.getCell(`C${r}`)
    c.value = value === null ? '—' : value
    c.font = FONT
    c.alignment = { horizontal: 'right' }
    r++
  }

  title(resolvePayrollCompanyName())
  textLine('Kính gửi: Quý Anh/Chị', d.full_name)
  title(`THÔNG TIN LƯƠNG THÁNG ${month}/${year}`)

  section('I/ THÔNG TIN CƠ BẢN')
  textLine('Họ tên', d.full_name)
  textLine('Vị trí', d.position)
  textLine('Đơn vị/Team', d.team_name)
  moneyLine('Lương cơ bản', d.base_salary)
  // tách lương cơ bản thành mức đóng BHXH + phụ cấp (chỉ hiện khi có cấu hình BHXH cố định).
  if (d.insurance_base > BigInt(0)) {
    moneyLine('Lương đóng BHXH', d.insurance_base)
    moneyLine('Phụ cấp xăng xe/ăn ca', d.phu_cap_xang_xe)
  }
  numLine('Ngày công thực tế', d.working_days)
  moneyLine('Số tiền ngày công', d.don_gia_ngay_cong)
  moneyLine('Thực lĩnh lương căn bản (1)', d.base_salary_actual)
  numLine('Ngày học việc', d.training_days)
  moneyLine('Lương học việc', d.training_salary)
  moneyLine('Phụ cấp học việc (2)', d.probation_allowance)
  moneyLine('CỘNG LCB (1+2)', d.cong_lcb, true)

  section('II/ DOANH SỐ/THƯỞNG')
  moneyLine('Doanh số cá nhân', d.sales_personal)
  textLine('% KPI', d.kpi_percent === null ? '—' : `${d.kpi_percent}%`)
  textLine('Hệ số (%)', d.bonus_rate === null ? '—' : `${d.bonus_rate}%`)
  moneyLine('Bonus doanh số (1)', d.bonus_sales_personal)
  moneyLine('Vượt mốc cá nhân (2)', d.bonus_milestone)
  moneyLine('Contest toàn Team (3)', d.bonus_cskh_team)
  moneyLine('Giới thiệu ứng viên (4)', d.bonus_referral)
  moneyLine('Thưởng Lễ (5)', d.holiday_bonus)
  moneyLine('Cộng doanh số & thưởng (1+2+3+4+5)', d.cong_thuong, true)

  section('III/ TỔNG LƯƠNG & GIẢM TRỪ')
  moneyLine('Các khoản đã chi lĩnh trước', d.advances)
  moneyLine('Trích đóng BHXH', d.insurance_total)
  moneyLine('Thuế TNCN', d.tax_total)
  moneyLine('Tổng các khoản giảm trừ', d.tong_giam_tru, true)

  sectionMoney('IV/ TỔNG THỰC NHẬN', d.total)
  textLine('Số tài khoản', d.bank_account_number ?? '')
  textLine('Ngân hàng', d.bank_name ?? '')

  textLine('Ghi chú', d.notes ?? '')

  // Khối "Lưu ý" — gộp ô B:C, xuống dòng tự động.
  r++
  ws.mergeCells(`B${r}:C${r}`)
  const noteCell = ws.getCell(`B${r}`)
  noteCell.value = NOTE_TEXT
  noteCell.font = { ...FONT, italic: true, size: 10 }
  noteCell.alignment = { wrapText: true, vertical: 'top' }
  ws.getRow(r).height = 70
}

/**
 * Chuẩn hoá tên worksheet theo ràng buộc Excel: bỏ ký tự cấm `[ ] : * ? / \`,
 * bỏ dấu nháy đơn đầu/cuối (Excel cấm), cắt còn ≤ 31 ký tự, fallback khi rỗng.
 * Null-safe (full_name có thể null) — KHÔNG đảm bảo unique, dùng `uniqueSheetName`.
 */
export function sanitizeSheetName(
  name: string | null | undefined,
  fallback: string,
): string {
  const cleaned = (name ?? '')
    .replace(/[[\]:*?/\\]/g, '')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
  return cleaned.length > 0 ? cleaned : fallback.slice(0, 31)
}

/**
 * Đảm bảo tên sheet duy nhất trong workbook (Excel cấm trùng tên — KHÔNG phân biệt
 * hoa/thường). Dedup theo lowercase; trùng → append ` (2)`, ` (3)`... cắt lại ≤ 31.
 */
function uniqueSheetName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) {
    used.add(base.toLowerCase())
    return base
  }
  let i = 2
  for (;;) {
    const suffix = ` (${i})`
    const candidate = base.slice(0, 31 - suffix.length) + suffix
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase())
      return candidate
    }
    i++
  }
}

/**
 * Dựng workbook 1 phiếu lương theo bố cục mẫu (I/II/III/IV + lưu ý).
 */
export async function buildPayslipExcel(d: PayslipExcelData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Trinity CRM'
  const ws = wb.addWorksheet('PHIẾU LƯƠNG')
  writePayslipSheet(ws, d)
  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

/**
 * Dựng workbook xuất HÀNG LOẠT theo kỳ lương — mỗi nhân viên 1 sheet,
 * cùng bố cục I/II/III/IV. `sheetName` được sanitize + đảm bảo unique.
 */
export async function buildPayslipsWorkbook(
  items: Array<{ sheetName: string; data: PayslipExcelData }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Trinity CRM'
  const used = new Set<string>()
  items.forEach((item, idx) => {
    const base = sanitizeSheetName(item.sheetName, `NV${idx + 1}`)
    const name = uniqueSheetName(base, used)
    const ws = wb.addWorksheet(name)
    writePayslipSheet(ws, item.data)
  })
  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
