import * as ExcelJS from 'exceljs'
import { HEADER_TO_FIELD, parseImportFile, buildImportTemplate, parseDecimal } from '../payslip-import.helper'

// Import Excel PHẢI đọc đúng tên cột theo Template Excel công ty
// (đồng bộ với payslip-list-excel.builder.ts + bảng FE 5 nhóm cột).
const TEMPLATE_HEADERS_SUBSET = [
  'Ngày công',
  'Ngày học việc',
  'Lương học việc',
  'Phụ cấp học việc',
  'Doanh số',
  'Hệ số (%)',
  '% KPI',
  'Bonus',
  'Contest Team',
  'Vượt mốc cá nhân',
  'Giới thiệu ứng viên',
  'Thưởng lễ',
  'Đã ứng',
  'Thuế TNCN',
]

describe('payslip-import.helper — HEADER_TO_FIELD đồng bộ Template', () => {
  it('mọi header trong TEMPLATE_HEADERS_SUBSET có mặt trong HEADER_TO_FIELD', () => {
    for (const h of TEMPLATE_HEADERS_SUBSET) {
      expect(HEADER_TO_FIELD[h]).toBeDefined()
    }
  })

  it('KHÔNG còn header cũ trước (đã đổi tên đồng bộ Template)', () => {
    const staleHeaders = [
      'Ngày công thực tế',
      'Doanh số cá nhân',
      'Hệ số %',
      'Bonus DS cá nhân',
      'Thưởng CSKH Team',
      'Thưởng giới thiệu',
      'Thưởng Lễ',
      'Các khoản lĩnh trước',
    ]
    for (const h of staleHeaders) {
      expect(HEADER_TO_FIELD[h]).toBeUndefined()
    }
  })
})

async function buildParseableBuffer(row: Record<string, string | number>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet')
  const headers = ['Mã NV', 'Họ tên', ...Object.keys(row)]
  ws.addRow(headers)
  ws.addRow(['NV0001', 'Nguyễn Văn A', ...Object.values(row)])
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

describe('parseImportFile — đọc đúng field theo header Template mới', () => {
  it('đọc "Doanh số", "Hệ số (%)", "Bonus" → field sales_personal/bonus_rate/bonus_sales_personal', async () => {
    const buf = await buildParseableBuffer({
      'Doanh số': 20_000_000,
      'Hệ số (%)': 0.5,
      Bonus: 100_000,
    })
    const rows = await parseImportFile(buf)
    expect(rows).toHaveLength(1)
    expect(rows[0].employee_code).toBe('NV0001')
    expect(rows[0].fields.sales_personal).toBe('20000000')
    expect(rows[0].fields.bonus_rate).toBe(0.5)
    expect(rows[0].fields.bonus_sales_personal).toBe('100000')
  })

  it('ô tiền khổng lồ (≥1e21) vào fieldErrors của dòng đó thay vì thành "1e+21" làm BigInt() ném lỗi', async () => {
    const buf = await buildParseableBuffer({ 'Doanh số': 1e21, Bonus: 100_000 })
    const rows = await parseImportFile(buf)
    expect(rows[0].fields.sales_personal).toBeUndefined()
    expect(rows[0].fieldErrors?.[0]).toContain('vượt giới hạn')
    expect(rows[0].fields.bonus_sales_personal).toBe('100000')
  })

  it('ô số không parse được / âm vào fieldErrors (không im lặng); dấu "-" coi như trống', async () => {
    const buf = await buildParseableBuffer({ 'Doanh số': '12abc', Bonus: -5, 'Thưởng lễ': '-', 'Đã ứng': 100_000 })
    const rows = await parseImportFile(buf)
    expect(rows[0].fields.sales_personal).toBeUndefined()
    expect(rows[0].fieldErrors).toHaveLength(2)
    expect(rows[0].fieldErrors?.[0]).toContain('không phải số hợp lệ')
    expect(rows[0].fields.holiday_bonus).toBeUndefined()
  })

  it('đọc "Ngày học việc" + "Contest Team" + "Thưởng lễ"', async () => {
    const buf = await buildParseableBuffer({
      'Ngày học việc': 10,
      'Contest Team': 500_000,
      'Thưởng lễ': 200_000,
    })
    const rows = await parseImportFile(buf)
    expect(rows[0].fields.training_days).toBe(10)
    expect(rows[0].fields.bonus_cskh_team).toBe('500000')
    expect(rows[0].fields.holiday_bonus).toBe('200000')
  })
})

describe('buildImportTemplate — header sinh ra khớp HEADER_TO_FIELD', () => {
  it('dòng header có "Mã NV", "Họ tên" + toàn bộ field header hiện tại', async () => {
    const buf = await buildImportTemplate(
      [{ employee_code: 'NV0001', full_name: 'Nguyễn Văn A', current: {} }],
      '2026-07',
    )
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as never)
    const ws = wb.worksheets[0]
    const headers: string[] = []
    ws.getRow(2).eachCell((c) => headers.push(String(c.value)))
    expect(headers[0]).toBe('Mã NV')
    expect(headers[1]).toBe('Họ tên')
    for (const h of Object.keys(HEADER_TO_FIELD)) {
      expect(headers).toContain(h)
    }
  })
})

describe('parseDecimal', () => {
  it('dấu phẩy thập phân kiểu Việt', () => {
    expect(parseDecimal('85,5')).toBe(85.5)
    expect(parseDecimal('0,4')).toBe(0.4)
    expect(parseDecimal('1.234,5')).toBe(1234.5)
  })
  it('dấu chấm thập phân và rác', () => {
    expect(parseDecimal('1.5')).toBe(1.5)
    expect(parseDecimal('12abc')).toBeNaN()
    expect(parseDecimal('  ')).toBeNaN()
  })
})
