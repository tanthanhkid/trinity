import * as ExcelJS from 'exceljs'
import type { UpdatePayslipDto } from './dto/update-payslip.dto'

// Ánh xạ tiêu đề cột Excel → tên field UpdatePayslipDto. Tên cột ĐỒNG BỘ với file
// Excel xuất ra (khớp header ở payslip-list-excel.builder.ts + bảng FE).
// Comment bên phải CHỈ để ghi chú lịch sử tên cột cũ (KHÔNG phải alias thật) — file Excel
// dùng tên cột CŨ sẽ KHÔNG được `HEADER_TO_FIELD` nhận dạng (header không khớp key → bị bỏ
// qua khi build fieldByCol), PHẢI export lại theo Template mới để import hoạt động.
export const HEADER_TO_FIELD: Record<string, keyof UpdatePayslipDto> = {
  'Ngày công': 'working_days', // cũ: "Ngày công thực tế"
  'Ngày công chuẩn': 'standard_working_days',
  'Lương cơ bản': 'base_salary',
  'Ngày học việc': 'training_days',
  'Lương học việc': 'training_salary',
  'Phụ cấp học việc': 'probation_allowance',
  'Doanh số': 'sales_personal', // cũ: "Doanh số cá nhân"
  'Hệ số (%)': 'bonus_rate', // cũ: "Hệ số %"
  '% KPI': 'kpi_percent',
  'Bonus': 'bonus_sales_personal', // cũ: "Bonus DS cá nhân"
  'Doanh số Team': 'sales_team',
  'Contest Team': 'bonus_cskh_team', // cũ: "Thưởng CSKH Team"
  'Vượt mốc cá nhân': 'bonus_milestone',
  'Giới thiệu ứng viên': 'bonus_referral', // cũ: "Thưởng giới thiệu"
  'Thưởng lễ': 'holiday_bonus', // cũ: "Thưởng Lễ"
  'Đã ứng': 'advances', // cũ: "Các khoản lĩnh trước"
  'Thuế TNCN': 'personal_income_tax',
  'Ghi chú': 'notes',
}

// float: số thực (ngày công, ngày học việc, hệ số %)
const FLOAT_FIELDS = new Set<string>(['working_days', 'training_days', 'bonus_rate', 'kpi_percent'])
// int: số nguyên (ngày công chuẩn)
const INT_FIELDS = new Set<string>(['standard_working_days'])
// string: văn bản (ghi chú)
const STRING_FIELDS = new Set<string>(['notes'])
// còn lại = money: số nguyên VNĐ dưới dạng chuỗi

// Biên trên cho field float — PHẢI khớp @Max(...) của UpdatePayslipDto để import KHÔNG
// bypass validate của luồng sửa tay. kpi_percent khớp @db.Decimal(5,2)
// (schema.prisma model Payslip) — tối đa 999.99, vượt là numeric-overflow Prisma giữa
// transaction. bonus_rate cột là @db.Decimal(7,4) (chịu tới 999.9999) nhưng nghiệp vụ +
// DTO giới hạn 0-100(%) — dùng 100 vừa đúng nghiệp vụ vừa an toàn dưới ngưỡng overflow.
/** Trần cho cột tiền (VNĐ, bigint): 15 chữ số — dư xa mọi mức lương thực, và an toàn tuyệt đối với Number/BigInt. */
const MONEY_MAX = 999_999_999_999_999

const FLOAT_FIELD_MAX: Record<string, number> = {
  working_days: 31,
  training_days: 31,
  bonus_rate: 100,
  kpi_percent: 999.99,
}

// Ném khi giá trị 1 field trong 1 dòng Excel vượt biên cho phép — bắt SỚM tại lúc parse
// thay vì để Prisma ném lỗi numeric-overflow giữa transaction. Được
// `parseImportFile` bắt riêng cho từng field, gom vào `ImportRow.fieldErrors` — KHÔNG
// làm sập cả file import, chỉ dòng chứa field lỗi bị skip (giữ nguyên ngữ nghĩa cũ:
// "skip 1 dòng vẫn tiếp tục các dòng khác").
export class PayslipFieldValidationError extends Error {}

export interface ImportRow {
  employee_code: string
  employee_name: string | null
  fields: Partial<UpdatePayslipDto>
  fieldErrors?: string[]
}

// Dữ liệu nhân viên cho template (giá trị hiện tại từ serializePayslip)
export interface TemplateEmployee {
  employee_code: string
  full_name: string
  current?: Record<string, string | number | null | undefined>
}

// --- Cell parsing helpers ---

function parseCellRaw(cell: ExcelJS.Cell): string | number | null {
  const v = cell.value
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'object') {
    // formula result
    if ('result' in v) {
      const r = (v as ExcelJS.CellFormulaValue).result
      if (typeof r === 'number') return r
      if (typeof r === 'string') return r.trim() || null
    }
    // rich text
    if ('richText' in v) {
      const parts = (v as ExcelJS.CellRichTextValue).richText
      return parts?.map((p) => p.text).join('').trim() || null
    }
  }
  return null
}

/** Số thập phân kiểu Việt: "85,5" → 85.5; "1.234,5" → 1234.5; "1.5" → 1.5. Rác ("12abc") → NaN. */
export function parseDecimal(raw: string): number {
  let s = raw.trim().replace(/\s/g, '')
  if (s === '') return NaN
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  return Number(s)
}

const EMPTY_PLACEHOLDERS = new Set(['-', '–', '—', 'n/a', 'na'])

/** Ô số không parse được / âm: bỏ qua nếu chỉ là dấu gạch "không có", còn lại báo lỗi để preview không im lặng. */
function invalidNumber(fieldName: string, raw: string | number): undefined {
  const text = String(raw).trim()
  if (text === '' || EMPTY_PLACEHOLDERS.has(text.toLowerCase())) return undefined
  throw new PayslipFieldValidationError(`${fieldName}: giá trị "${text.slice(0, 40)}" không phải số hợp lệ (không âm)`)
}

function parseField(
  fieldName: string,
  raw: string | number | null,
): UpdatePayslipDto[keyof UpdatePayslipDto] | undefined {
  if (raw === null) return undefined

  if (FLOAT_FIELDS.has(fieldName)) {
    const n = typeof raw === 'number' ? raw : parseDecimal(raw)
    if (!Number.isFinite(n) || n < 0) return invalidNumber(fieldName, raw)
    const max = FLOAT_FIELD_MAX[fieldName]
    if (max !== undefined && n > max) {
      throw new PayslipFieldValidationError(
        `${fieldName} vượt giới hạn cho phép (tối đa ${max})`,
      )
    }
    return n
  }

  if (INT_FIELDS.has(fieldName)) {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    if (!Number.isFinite(n) || n < 1 || n > 31) return undefined
    return Math.round(n)
  }

  if (STRING_FIELDS.has(fieldName)) {
    const s = typeof raw === 'string' ? raw : String(raw)
    return s || undefined
  }

  // money: số nguyên không âm dưới dạng chuỗi
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''))
  if (!Number.isFinite(n) || n < 0) return invalidNumber(fieldName, raw)
  // Số ≥1e21 bị String() in thành "1e+21" → BigInt() ném SyntaxError ngoài transaction (500 cả lần áp dụng).
  // Chặn SỚM như các field float: dòng này vào fieldErrors, các dòng khác vẫn chạy.
  if (n > MONEY_MAX) {
    throw new PayslipFieldValidationError(`${fieldName} vượt giới hạn cho phép (tối đa ${MONEY_MAX.toLocaleString('en-US')})`)
  }
  return String(Math.round(n))
}

// --- Parse uploaded file ---

export async function parseImportFile(buffer: Buffer): Promise<ImportRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const ws = wb.worksheets[0]
  if (!ws) return []

  // Dòng 1 = tiêu đề, dòng 2 = header (nếu có title row); thử cả 2 cách
  const headerRowIdx = detectHeaderRow(ws)
  if (headerRowIdx === -1) return []

  const headerRow = ws.getRow(headerRowIdx)
  const fieldByCol: Map<number, string> = new Map()
  let codeColIdx = -1
  let nameColIdx = -1

  headerRow.eachCell({ includeEmpty: false }, (cell, colNum) => {
    const header = typeof cell.value === 'string' ? cell.value.trim() : ''
    if (header === 'Mã NV' || header === 'Mã nhân viên') codeColIdx = colNum
    else if (header === 'Họ tên') nameColIdx = colNum
    else {
      const fieldName = HEADER_TO_FIELD[header]
      if (fieldName) fieldByCol.set(colNum, fieldName as string)
    }
  })

  if (codeColIdx === -1) return []

  const rows: ImportRow[] = []

  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const codeRaw = parseCellRaw(row.getCell(codeColIdx))
    if (!codeRaw) continue
    const employee_code = String(codeRaw).trim()
    if (!employee_code) continue

    const nameRaw = nameColIdx !== -1 ? parseCellRaw(row.getCell(nameColIdx)) : null
    const employee_name = nameRaw ? String(nameRaw).trim() : null

    const fields: Partial<UpdatePayslipDto> = {}
    const fieldErrors: string[] = []
    for (const [colNum, fieldName] of fieldByCol) {
      const raw = parseCellRaw(row.getCell(colNum))
      try {
        const parsed = parseField(fieldName, raw)
        if (parsed !== undefined) {
          ;(fields as Record<string, unknown>)[fieldName] = parsed
        }
      } catch (err) {
        if (err instanceof PayslipFieldValidationError) {
          fieldErrors.push(err.message)
        } else {
          throw err
        }
      }
    }

    rows.push({
      employee_code,
      employee_name,
      fields,
      fieldErrors: fieldErrors.length > 0 ? fieldErrors : undefined,
    })
  }

  return rows
}

// Tìm dòng header: dòng đầu tiên có cell "Mã NV" (hoặc "Mã nhân viên" theo Template công ty)
function detectHeaderRow(ws: ExcelJS.Worksheet): number {
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const row = ws.getRow(r)
    let found = false
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = typeof cell.value === 'string' ? cell.value.trim() : ''
      if (v === 'Mã NV' || v === 'Mã nhân viên') found = true
    })
    if (found) return r
  }
  return -1
}

// --- Build template ---

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF4472C4' }, // xanh dương đậm
}
const HEADER_FONT: Partial<ExcelJS.Font> = {
  name: 'Times New Roman',
  size: 11,
  bold: true,
  color: { argb: 'FFFFFFFF' },
}
const BODY_FONT: Partial<ExcelJS.Font> = { name: 'Times New Roman', size: 11 }
const NUM_FMT = '#,##0'

const FIELD_HEADERS = Object.keys(HEADER_TO_FIELD)
const ALL_HEADERS = ['Mã NV', 'Họ tên', ...FIELD_HEADERS]

function templateCellValue(
  fieldName: string,
  current: Record<string, string | number | null | undefined> | undefined,
): number | string | null {
  const v = current?.[fieldName]
  if (v === null || v === undefined) return null

  if (FLOAT_FIELDS.has(fieldName) || INT_FIELDS.has(fieldName)) {
    return typeof v === 'number' ? v : null
  }
  if (STRING_FIELDS.has(fieldName)) {
    return typeof v === 'string' ? v : null
  }
  // money: chuỗi "12345678" → số để Excel format được
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

export async function buildImportTemplate(
  employees: TemplateEmployee[],
  month: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Nhập phiếu lương')

  // Dòng 1: tiêu đề
  const [year, mon] = month.split('-')
  ws.mergeCells(1, 1, 1, ALL_HEADERS.length)
  const titleCell = ws.getCell(1, 1)
  titleCell.value = `MẪU NHẬP PHIẾU LƯƠNG — THÁNG ${mon}/${year}`
  titleCell.font = { name: 'Times New Roman', size: 13, bold: true }
  titleCell.alignment = { horizontal: 'center' }

  // Dòng 2: header
  const hRow = ws.getRow(2)
  hRow.height = 28
  ALL_HEADERS.forEach((h, i) => {
    const cell = hRow.getCell(i + 1)
    cell.value = h
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    }
  })

  // Dòng 3+: dữ liệu
  employees.forEach((emp, idx) => {
    const row = ws.getRow(3 + idx)
    const vals: (string | number | null)[] = [
      emp.employee_code,
      emp.full_name,
      ...FIELD_HEADERS.map((h) => {
        const fieldName = HEADER_TO_FIELD[h] as string
        return templateCellValue(fieldName, emp.current)
      }),
    ]

    vals.forEach((v, i) => {
      const cell = row.getCell(i + 1)
      cell.value = v as ExcelJS.CellValue
      cell.font = BODY_FONT
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      }

      // Format số cho money fields (index 2+ tương ứng FIELD_HEADERS)
      if (i >= 2) {
        const fieldName = HEADER_TO_FIELD[FIELD_HEADERS[i - 2]] as string
        if (!FLOAT_FIELDS.has(fieldName) && !INT_FIELDS.has(fieldName) && !STRING_FIELDS.has(fieldName)) {
          cell.numFmt = NUM_FMT
        }
      }
    })
  })

  // Column widths
  ws.getColumn(1).width = 14 // Mã NV
  ws.getColumn(2).width = 24 // Họ tên
  FIELD_HEADERS.forEach((h, i) => {
    ws.getColumn(3 + i).width = Math.max(14, h.length + 2)
  })

  // Freeze header rows
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 2 }]

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}
