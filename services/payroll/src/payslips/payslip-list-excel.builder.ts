import * as ExcelJS from 'exceljs'
import type { PayslipExcelData } from './payslip-excel.builder'

// 1 dòng = 1 nhân viên trong file "danh sách lương" (1 sheet, nhóm Phòng ban/Team).
export interface PayslipListRow {
  employee_code: string // Mã NV nhập tay, fallback NV<id>
  department: string // Phòng ban (employees.department), '' nếu chưa phân
  data: PayslipExcelData // tái dùng toàn bộ field tiền của mẫu phiếu lương
}

const FONT = { name: 'Times New Roman', size: 11 }
const NUM_FMT = '#,##0'
const GROUP_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F3E0' } }
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
const TOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
}

// Nhóm cột (hàng tiêu đề trên cùng — gộp ô theo nhóm liền kề).
const G_EMP = 'THÔNG TIN NHÂN VIÊN'
const G_LCB = 'LƯƠNG CƠ BẢN'
const G_DS = 'DOANH SỐ/THƯỞNG'
const G_GT = 'CÁC KHOẢN GIẢM TRỪ'
const G_TT = 'THÔNG TIN THANH TOÁN'

// 'index' STT · 'text' chuỗi · 'money' số tiền (cộng tổng) · 'pct' hệ số % · 'days' ngày công.
type Kind = 'index' | 'text' | 'money' | 'pct' | 'days'

interface ListColumn {
  group: string
  header: string
  kind: Kind
  width: number
  value?: (r: PayslipListRow) => string | number | bigint | null
}

// Thứ tự + tên cột của file Excel danh sách lương (33 cột, 5 nhóm). Đồng bộ với bảng FE.
const COLUMNS: ListColumn[] = [
  { group: G_EMP, header: 'STT', kind: 'index', width: 5 },
  { group: G_EMP, header: 'Mã nhân viên', kind: 'text', width: 13, value: (r) => r.employee_code },
  { group: G_EMP, header: 'Họ tên', kind: 'text', width: 22, value: (r) => r.data.full_name },
  { group: G_EMP, header: 'Vị trí', kind: 'text', width: 13, value: (r) => r.data.position },
  { group: G_EMP, header: 'Team Lead', kind: 'text', width: 18, value: (r) => r.data.team_name },
  { group: G_EMP, header: 'Phòng ban', kind: 'text', width: 11, value: (r) => r.department },

  { group: G_LCB, header: 'Lương cơ bản', kind: 'money', width: 14, value: (r) => r.data.base_salary },
  // mức lương đóng BHXH (cố định theo chức vụ, KHÁC lương cơ bản từng người).
  { group: G_LCB, header: 'Lương đóng BHXH', kind: 'money', width: 14, value: (r) => r.data.insurance_base },
  { group: G_LCB, header: 'Ngày công', kind: 'days', width: 9, value: (r) => r.data.working_days },
  { group: G_LCB, header: 'Số tiền ngày công', kind: 'money', width: 14, value: (r) => r.data.don_gia_ngay_cong },
  { group: G_LCB, header: 'Thực lĩnh LCB', kind: 'money', width: 14, value: (r) => r.data.base_salary_actual },
  { group: G_LCB, header: 'Ngày học việc', kind: 'days', width: 10, value: (r) => r.data.training_days },
  { group: G_LCB, header: 'Lương học việc', kind: 'money', width: 14, value: (r) => r.data.training_salary },
  { group: G_LCB, header: 'Phụ cấp học việc', kind: 'money', width: 14, value: (r) => r.data.probation_allowance },
  { group: G_LCB, header: 'Cộng lương cơ bản', kind: 'money', width: 15, value: (r) => r.data.cong_lcb },

  { group: G_DS, header: 'Doanh số', kind: 'money', width: 15, value: (r) => r.data.sales_personal },
  { group: G_DS, header: '% KPI', kind: 'pct', width: 9, value: (r) => r.data.kpi_percent },
  { group: G_DS, header: 'Hệ số (%)', kind: 'pct', width: 9, value: (r) => r.data.bonus_rate },
  { group: G_DS, header: 'Bonus', kind: 'money', width: 14, value: (r) => r.data.bonus_sales_personal },
  { group: G_DS, header: 'Vượt mốc cá nhân', kind: 'money', width: 14, value: (r) => r.data.bonus_milestone },
  { group: G_DS, header: 'Contest Team', kind: 'money', width: 14, value: (r) => r.data.bonus_cskh_team },
  { group: G_DS, header: 'Giới thiệu ứng viên', kind: 'money', width: 14, value: (r) => r.data.bonus_referral },
  { group: G_DS, header: 'Thưởng lễ', kind: 'money', width: 13, value: (r) => r.data.holiday_bonus },
  { group: G_DS, header: 'Cộng doanh số/Thưởng', kind: 'money', width: 15, value: (r) => r.data.cong_thuong },

  { group: G_GT, header: 'Đã ứng', kind: 'money', width: 13, value: (r) => r.data.advances },
  { group: G_GT, header: 'BHXH', kind: 'money', width: 13, value: (r) => r.data.insurance_total },
  { group: G_GT, header: 'Thuế TNCN', kind: 'money', width: 13, value: (r) => r.data.tax_total },
  { group: G_GT, header: 'Tổng giảm trừ', kind: 'money', width: 14, value: (r) => r.data.tong_giam_tru },

  { group: G_TT, header: 'Thực nhận', kind: 'money', width: 15, value: (r) => r.data.total },
  { group: G_TT, header: 'Số tài khoản', kind: 'text', width: 18, value: (r) => r.data.bank_account_number ?? '' },
  { group: G_TT, header: 'Ngân hàng', kind: 'text', width: 16, value: (r) => r.data.bank_name ?? '' },
]

const EMP_COL_COUNT = COLUMNS.filter((c) => c.group === G_EMP).length // 6 → gộp ô nhãn "TỔNG CỘNG"
const TITLE_ROW = 1
const GROUP_ROW = 2
const HEAD_ROW = 3
const DATA_START = 4

function writeDataCell(cell: ExcelJS.Cell, col: ListColumn, row: PayslipListRow, idx: number): void {
  cell.font = FONT
  cell.border = THIN
  switch (col.kind) {
    case 'index':
      cell.value = idx + 1
      cell.alignment = { horizontal: 'center' }
      break
    case 'money':
      cell.value = Number(col.value!(row) as bigint)
      cell.numFmt = NUM_FMT
      cell.alignment = { horizontal: 'right' }
      break
    case 'days': {
      const v = col.value!(row) as number | null
      cell.value = v === null ? '—' : v
      cell.alignment = { horizontal: 'right' }
      break
    }
    case 'pct': {
      const v = col.value!(row) as number | null
      cell.value = v === null ? '—' : `${v}%`
      cell.alignment = { horizontal: 'right' }
      break
    }
    default: // text
      cell.value = (col.value!(row) as string) || ''
      cell.alignment = { vertical: 'middle', wrapText: true }
  }
}

/**
 * Dựng workbook "Danh sách lương" — 1 sheet, mỗi NV 1 dòng, đã sắp xếp theo
 * Phòng ban → Team Lead → Họ tên (gọi từ service). Có 2 hàng tiêu đề (nhóm + cột),
 * AutoFilter ở hàng cột, và 1 dòng TỔNG CỘNG ở cuối (cộng các cột tiền).
 */
export async function buildPayslipsListWorkbook(rows: PayslipListRow[], month: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Trinity CRM'
  const ws = wb.addWorksheet('DANH SÁCH LƯƠNG')
  const nCols = COLUMNS.length
  COLUMNS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width
  })

  // Hàng 1: tiêu đề tổng.
  ws.mergeCells(TITLE_ROW, 1, TITLE_ROW, nCols)
  const [year, mm] = month.split('-')
  const titleCell = ws.getCell(TITLE_ROW, 1)
  titleCell.value = `DANH SÁCH LƯƠNG THÁNG ${mm}/${year}`
  titleCell.font = { ...FONT, bold: true, size: 14 }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(TITLE_ROW).height = 24

  // Hàng 2: tiêu đề nhóm (gộp ô theo nhóm liền kề).
  let c = 1
  while (c <= nCols) {
    const group = COLUMNS[c - 1].group
    let end = c
    while (end < nCols && COLUMNS[end].group === group) end++
    ws.mergeCells(GROUP_ROW, c, GROUP_ROW, end)
    const gc = ws.getCell(GROUP_ROW, c)
    gc.value = group
    gc.font = { ...FONT, bold: true }
    gc.alignment = { horizontal: 'center', vertical: 'middle' }
    gc.fill = GROUP_FILL
    gc.border = THIN
    c = end + 1
  }

  // Hàng 3: tiêu đề cột.
  COLUMNS.forEach((col, i) => {
    const hc = ws.getCell(HEAD_ROW, i + 1)
    hc.value = col.header
    hc.font = { ...FONT, bold: true }
    hc.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    hc.fill = HEADER_FILL
    hc.border = THIN
  })
  ws.getRow(HEAD_ROW).height = 30

  // Dữ liệu.
  rows.forEach((row, idx) => {
    const r = DATA_START + idx
    COLUMNS.forEach((col, i) => writeDataCell(ws.getCell(r, i + 1), col, row, idx))
  })

  // Dòng TỔNG CỘNG (cộng cột tiền). Đặt DƯỚI vùng AutoFilter để không bị ẩn khi lọc.
  const totalRow = DATA_START + rows.length
  ws.mergeCells(totalRow, 1, totalRow, EMP_COL_COUNT)
  const lblCell = ws.getCell(totalRow, 1)
  lblCell.value = 'TỔNG CỘNG'
  lblCell.font = { ...FONT, bold: true }
  lblCell.alignment = { horizontal: 'center', vertical: 'middle' }
  lblCell.fill = TOTAL_FILL
  lblCell.border = THIN
  COLUMNS.forEach((col, i) => {
    if (i < EMP_COL_COUNT) return
    const cell = ws.getCell(totalRow, i + 1)
    cell.fill = TOTAL_FILL
    cell.border = THIN
    cell.font = { ...FONT, bold: true }
    if (col.kind === 'money') {
      const sum = rows.reduce((acc, row) => acc + (col.value!(row) as bigint), BigInt(0))
      cell.value = Number(sum)
      cell.numFmt = NUM_FMT
      cell.alignment = { horizontal: 'right' }
    }
  })

  // AutoFilter từ hàng tiêu đề cột tới hàng dữ liệu cuối (không gồm dòng tổng).
  if (rows.length > 0) {
    ws.autoFilter = {
      from: { row: HEAD_ROW, column: 1 },
      to: { row: DATA_START + rows.length - 1, column: nCols },
    }
  }
  // Cố định 3 hàng tiêu đề + 6 cột thông tin NV khi cuộn.
  ws.views = [{ state: 'frozen', xSplit: EMP_COL_COUNT, ySplit: HEAD_ROW }]

  const buffer = await wb.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
