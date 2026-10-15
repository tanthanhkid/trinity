import * as ExcelJS from 'exceljs'
import { PayslipExcelData } from '../payslip-excel.builder'
import {
  buildPayslipsListWorkbook,
  PayslipListRow,
} from '../payslip-list-excel.builder'

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

function fakeRow(over: Partial<PayslipListRow> = {}): PayslipListRow {
  return {
    employee_code: 'NV001',
    department: 'KD',
    data: fakeData(),
    ...over,
  }
}

async function loadSheet(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as never)
  return wb.worksheets[0]
}

describe('buildPayslipsListWorkbook (danh sách lương 1 sheet)', () => {
  it('chỉ tạo 1 sheet "DANH SÁCH LƯƠNG"', async () => {
    const wb = new ExcelJS.Workbook()
    const buf = await buildPayslipsListWorkbook([fakeRow()], '2026-03')
    await wb.xlsx.load(buf as never)
    expect(wb.worksheets).toHaveLength(1)
    expect(wb.worksheets[0].name).toBe('DANH SÁCH LƯƠNG')
  })

  it('tiêu đề tổng = "DANH SÁCH LƯƠNG THÁNG MM/YYYY"', async () => {
    const ws = await loadSheet(await buildPayslipsListWorkbook([fakeRow()], '2026-03'))
    expect(String(ws.getCell(1, 1).value)).toBe('DANH SÁCH LƯƠNG THÁNG 03/2026')
  })

  it('hàng tiêu đề cột (hàng 3) đủ các cột theo yêu cầu nghiệp vụ', async () => {
    const ws = await loadSheet(await buildPayslipsListWorkbook([fakeRow()], '2026-03'))
    const headers: string[] = []
    ws.getRow(3).eachCell((c) => headers.push(String(c.value)))
    for (const h of [
      'STT', 'Mã nhân viên', 'Họ tên', 'Vị trí', 'Team Lead', 'Phòng ban',
      'Lương cơ bản', 'Lương đóng BHXH', 'Ngày công', 'Số tiền ngày công', 'Thực lĩnh LCB',
      'Ngày học việc', 'Lương học việc', 'Phụ cấp học việc', 'Cộng lương cơ bản',
      'Doanh số', '% KPI', 'Hệ số (%)', 'Bonus', 'Vượt mốc cá nhân', 'Contest Team',
      'Giới thiệu ứng viên', 'Thưởng lễ', 'Cộng doanh số/Thưởng',
      'Đã ứng', 'BHXH', 'Thuế TNCN', 'Tổng giảm trừ',
      'Thực nhận', 'Số tài khoản', 'Ngân hàng',
    ]) {
      expect(headers).toContain(h)
    }
  })

  it('hàng tiêu đề nhóm (hàng 2) gồm 5 nhóm', async () => {
    const ws = await loadSheet(await buildPayslipsListWorkbook([fakeRow()], '2026-03'))
    // Ô gộp (merge) — ExcelJS điền giá trị master vào mọi ô trong vùng khi load → dedup liền kề.
    const groups: string[] = []
    ws.getRow(2).eachCell((c) => {
      const v = c.value ? String(c.value) : ''
      if (v && groups[groups.length - 1] !== v) groups.push(v)
    })
    expect(groups).toEqual([
      'THÔNG TIN NHÂN VIÊN', 'LƯƠNG CƠ BẢN', 'DOANH SỐ/THƯỞNG',
      'CÁC KHOẢN GIẢM TRỪ', 'THÔNG TIN THANH TOÁN',
    ])
  })

  it('dữ liệu từ hàng 4: STT + mã NV + họ tên đúng thứ tự truyền vào', async () => {
    const ws = await loadSheet(
      await buildPayslipsListWorkbook(
        [
          fakeRow({ employee_code: 'NV001', data: fakeData({ full_name: 'An' }) }),
          fakeRow({ employee_code: 'NV002', data: fakeData({ full_name: 'Bình' }) }),
        ],
        '2026-03',
      ),
    )
    expect(ws.getCell(4, 1).value).toBe(1) // STT
    expect(ws.getCell(4, 2).value).toBe('NV001')
    expect(ws.getCell(4, 3).value).toBe('An')
    expect(ws.getCell(5, 1).value).toBe(2)
    expect(ws.getCell(5, 3).value).toBe('Bình')
  })

  it('dòng TỔNG CỘNG cộng đúng các cột tiền (Lương cơ bản + Thực nhận)', async () => {
    const ws = await loadSheet(
      await buildPayslipsListWorkbook(
        [
          fakeRow({ data: fakeData({ base_salary: BigInt(6_000_000), total: BigInt(7_000_000) }) }),
          fakeRow({ data: fakeData({ base_salary: BigInt(4_000_000), total: BigInt(5_000_000) }) }),
        ],
        '2026-03',
      ),
    )
    const totalRow = 4 + 2 // DATA_START(4) + 2 dòng
    // Map header → vị trí cột để khỏi hardcode index.
    const headerByCol = new Map<number, string>()
    ws.getRow(3).eachCell((c, col) => headerByCol.set(col, String(c.value)))
    const colOf = (h: string) =>
      [...headerByCol.entries()].find(([, v]) => v === h)?.[0] ?? -1
    expect(String(ws.getCell(totalRow, 1).value)).toBe('TỔNG CỘNG')
    expect(Number(ws.getCell(totalRow, colOf('Lương cơ bản')).value)).toBe(10_000_000)
    expect(Number(ws.getCell(totalRow, colOf('Thực nhận')).value)).toBe(12_000_000)
  })

  it('"Ngày học việc" hiển thị "—" khi null, số khi có giá trị', async () => {
    const ws = await loadSheet(
      await buildPayslipsListWorkbook(
        [
          fakeRow({ data: fakeData({ training_days: null }) }),
          fakeRow({ data: fakeData({ training_days: 10 }) }),
        ],
        '2026-03',
      ),
    )
    let col = -1
    ws.getRow(3).eachCell((c, i) => {
      if (String(c.value) === 'Ngày học việc') col = i
    })
    expect(ws.getCell(4, col).value).toBe('—')
    expect(ws.getCell(5, col).value).toBe(10)
  })

  it('"% KPI" hiển thị "—" khi null, "{n}%" khi có giá trị', async () => {
    const ws = await loadSheet(
      await buildPayslipsListWorkbook(
        [
          fakeRow({ data: fakeData({ kpi_percent: null }) }),
          fakeRow({ data: fakeData({ kpi_percent: 85.5 }) }),
        ],
        '2026-03',
      ),
    )
    let col = -1
    ws.getRow(3).eachCell((c, i) => {
      if (String(c.value) === '% KPI') col = i
    })
    expect(ws.getCell(4, col).value).toBe('—')
    expect(ws.getCell(5, col).value).toBe('85.5%')
  })

  it('"Hệ số (%)" hiển thị "—" khi null, "{n}%" khi có giá trị', async () => {
    const ws = await loadSheet(
      await buildPayslipsListWorkbook(
        [
          fakeRow({ data: fakeData({ bonus_rate: null }) }),
          fakeRow({ data: fakeData({ bonus_rate: 0.4 }) }),
        ],
        '2026-03',
      ),
    )
    let col = -1
    ws.getRow(3).eachCell((c, i) => {
      if (String(c.value) === 'Hệ số (%)') col = i
    })
    expect(ws.getCell(4, col).value).toBe('—')
    expect(ws.getCell(5, col).value).toBe('0.4%')
  })

  it('AutoFilter bao hàng tiêu đề cột → hàng dữ liệu cuối (KHÔNG gồm dòng tổng)', async () => {
    const ws = await loadSheet(
      await buildPayslipsListWorkbook([fakeRow(), fakeRow()], '2026-03'),
    )
    // 2 dòng dữ liệu → filter từ hàng 3 (tiêu đề cột) tới hàng 5 (data cuối). Dòng tổng = 6 (ngoài range).
    // ExcelJS sau khi load trả autoFilter dạng địa chỉ chuỗi "A3:AE5".
    expect(String(ws.autoFilter)).toMatch(/^[A-Z]+3:[A-Z]+5$/)
  })
})
