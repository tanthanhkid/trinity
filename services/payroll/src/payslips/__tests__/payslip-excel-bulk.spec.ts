import * as ExcelJS from 'exceljs'
import {
  buildPayslipsWorkbook,
  sanitizeSheetName,
  PayslipExcelData,
} from '../payslip-excel.builder'

function fakeData(over: Partial<PayslipExcelData> = {}): PayslipExcelData {
  return {
    month: '2026-03',
    full_name: 'Nguyễn Văn A',
    position: 'Sale (NV)',
    team_name: 'Team A',
    base_salary: BigInt(6_000_000),
    working_days: 26,
    don_gia_ngay_cong: BigInt(230_769),
    base_salary_actual: BigInt(6_000_000),
    training_days: null,
    training_salary: BigInt(0),
    probation_allowance: BigInt(0),
    cong_lcb: BigInt(6_000_000),
    sales_personal: BigInt(0),
    bonus_rate: null,
    kpi_percent: null,
    bonus_sales_personal: BigInt(0),
    sales_team: BigInt(0),
    bonus_cskh_team: BigInt(0),
    bonus_milestone: BigInt(0),
    bonus_referral: BigInt(0),
    holiday_bonus: BigInt(0),
    cong_thuong: BigInt(0),
    tong_luong: BigInt(6_000_000),
    advances: BigInt(0),
    insurance_base: BigInt(0),
    phu_cap_xang_xe: BigInt(0),
    insurance_total: BigInt(0),
    tax_total: BigInt(0),
    tong_giam_tru: BigInt(0),
    total: BigInt(6_000_000),
    bank_account_number: null,
    bank_name: null,
    notes: null,
    ...over,
  }
}

describe('sanitizeSheetName', () => {
  it('bỏ ký tự cấm Excel [ ] : * ? / \\', () => {
    expect(sanitizeSheetName('A/B:C*D?[E]', 'NV1')).toBe('ABCDE')
  })
  it('cắt còn ≤ 31 ký tự', () => {
    const long = 'X'.repeat(50)
    expect(sanitizeSheetName(long, 'NV1')).toHaveLength(31)
  })
  it('rỗng/toàn ký tự cấm → fallback', () => {
    expect(sanitizeSheetName('   ', 'NV9')).toBe('NV9')
    expect(sanitizeSheetName('[]:*?/\\', 'NV9')).toBe('NV9')
  })
  it('giữ tên tiếng Việt có dấu', () => {
    expect(sanitizeSheetName('Nguyễn Văn A', 'NV1')).toBe('Nguyễn Văn A')
  })
  it('null/undefined → fallback (không crash)', () => {
    expect(sanitizeSheetName(null, 'NV5')).toBe('NV5')
    expect(sanitizeSheetName(undefined, 'NV5')).toBe('NV5')
  })
  it('bỏ dấu nháy đơn đầu/cuối (Excel cấm)', () => {
    expect(sanitizeSheetName("'An'", 'NV1')).toBe('An')
  })
})

describe('buildPayslipsWorkbook', () => {
  async function readSheetNames(buf: Buffer): Promise<string[]> {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as never)
    return wb.worksheets.map((w) => w.name)
  }

  it('tạo đúng 1 sheet / phiếu lương', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'An', data: fakeData() },
      { sheetName: 'Bình', data: fakeData() },
      { sheetName: 'Cường', data: fakeData() },
    ])
    const names = await readSheetNames(buf)
    expect(names).toEqual(['An', 'Bình', 'Cường'])
  })

  it('trùng tên → append (2), (3) để unique', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'An', data: fakeData() },
      { sheetName: 'An', data: fakeData() },
      { sheetName: 'An', data: fakeData() },
    ])
    const names = await readSheetNames(buf)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe('An')
    expect(names[1]).toBe('An (2)')
    expect(names[2]).toBe('An (3)')
  })

  it('trùng tên KHÁC hoa/thường → vẫn dedup (Excel case-insensitive)', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'An', data: fakeData() },
      { sheetName: 'AN', data: fakeData() },
    ])
    const names = await readSheetNames(buf)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(2)
  })

  it('tên có ký tự cấm + rỗng → sanitize + fallback NV<idx>', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'A/B', data: fakeData() },
      { sheetName: '   ', data: fakeData() },
    ])
    const names = await readSheetNames(buf)
    expect(names[0]).toBe('AB')
    expect(names[1]).toBe('NV2')
  })

  it('ghi dòng "Thưởng Lễ (5)" + nhãn tổng "Cộng doanh số & thưởng (1+2+3+4+5)"', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'An', data: fakeData({ holiday_bonus: BigInt(800_000), cong_thuong: BigInt(800_000) }) },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as never)
    const ws = wb.worksheets[0]
    let holidayValue: number | null = null
    let sumValue: number | null = null
    ws.eachRow((row) => {
      const label = String(row.getCell(2).value)
      if (label === 'Thưởng Lễ (5)') holidayValue = Number(row.getCell(3).value)
      if (label === 'Cộng doanh số & thưởng (1+2+3+4+5)') sumValue = Number(row.getCell(3).value)
    })
    expect(holidayValue).toBe(800_000)
    expect(sumValue).toBe(800_000) // cong_thuong gồm Thưởng Lễ
  })

  it('KHÔNG ghi dòng "Doanh số Team" trong Excel (đã bỏ khỏi mẫu)', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'An', data: fakeData({ sales_team: BigInt(5_000_000) }) },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as never)
    const ws = wb.worksheets[0]
    let hasTeamRow = false
    ws.eachRow((row) => {
      if (String(row.getCell(2).value).startsWith('Doanh số Team')) hasTeamRow = true
    })
    expect(hasTeamRow).toBe(false)
  })

  it('ghi đúng giá trị "Tổng thực nhận" ngay trên dòng tiêu đề mục IV', async () => {
    const buf = await buildPayslipsWorkbook([
      { sheetName: 'An', data: fakeData({ total: BigInt(7_500_000) }) },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as never)
    const ws = wb.worksheets[0]
    // Giá trị tổng thực nhận nằm NGAY trên dòng tiêu đề mục "IV/ TỔNG THỰC NHẬN"
    // (đã bỏ dòng nhãn "TỔNG THỰC NHẬN" trùng lặp).
    let found = false
    ws.eachRow((row) => {
      if (String(row.getCell(2).value) === 'IV/ TỔNG THỰC NHẬN') {
        expect(Number(row.getCell(3).value)).toBe(7_500_000)
        found = true
      }
    })
    expect(found).toBe(true)
  })

  it('đã gỡ nhãn thừa: "Rank lương", "TỔNG LƯƠNG (Chưa trừ BHXH)", dòng "TỔNG THỰC NHẬN" trùng', async () => {
    const buf = await buildPayslipsWorkbook([{ sheetName: 'An', data: fakeData() }])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as never)
    const ws = wb.worksheets[0]
    const labels: string[] = []
    ws.eachRow((row) => labels.push(String(row.getCell(2).value)))
    // Mục I: chỉ còn "Vị trí" (đã bỏ "/ Rank lương")
    expect(labels).toContain('Vị trí')
    expect(labels.some((l) => l.includes('Rank lương'))).toBe(false)
    // Mục III: đã bỏ dòng "TỔNG LƯƠNG (Chưa trừ BHXH)"
    expect(labels).not.toContain('TỔNG LƯƠNG (Chưa trừ BHXH)')
    // Mục IV: chỉ còn tiêu đề "IV/ TỔNG THỰC NHẬN", KHÔNG còn dòng nhãn trùng "TỔNG THỰC NHẬN"
    expect(labels).toContain('IV/ TỔNG THỰC NHẬN')
    expect(labels).not.toContain('TỔNG THỰC NHẬN')
  })
})
