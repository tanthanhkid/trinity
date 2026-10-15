import { buildPayslipPdf } from '../payslip-pdf.builder'
import { PayslipExcelData } from '../payslip-excel.builder'

function fakeData(over: Partial<PayslipExcelData> = {}): PayslipExcelData {
  return {
    month: '2026-06',
    full_name: 'Nguyễn Văn Á',
    position: 'Giám đốc kinh doanh (GDK)',
    team_name: 'Team Hà Nội',
    base_salary: BigInt(12_000_000),
    working_days: 24,
    don_gia_ngay_cong: BigInt(500_000),
    base_salary_actual: BigInt(12_000_000),
    training_days: null,
    training_salary: BigInt(0),
    probation_allowance: BigInt(0),
    cong_lcb: BigInt(12_000_000),
    sales_personal: BigInt(20_800_000_000),
    bonus_rate: 0.4,
    kpi_percent: 95,
    bonus_sales_personal: BigInt(83_200_000),
    sales_team: BigInt(0),
    bonus_cskh_team: BigInt(1_000_000),
    bonus_milestone: BigInt(2_000_000),
    bonus_referral: BigInt(500_000),
    holiday_bonus: BigInt(1_500_000),
    cong_thuong: BigInt(88_200_000),
    tong_luong: BigInt(100_200_000),
    advances: BigInt(5_000_000),
    insurance_base: BigInt(0),
    phu_cap_xang_xe: BigInt(0),
    insurance_total: BigInt(1_260_000),
    tax_total: BigInt(3_000_000),
    tong_giam_tru: BigInt(9_260_000),
    total: BigInt(90_940_000),
    bank_account_number: '0123456789',
    bank_name: 'Bank Test',
    notes: 'Hoàn thành tốt chỉ tiêu tháng',
    ...over,
  }
}

describe('buildPayslipPdf', () => {
  it('xuất Buffer PDF hợp lệ', async () => {
    const buf = await buildPayslipPdf(fakeData())
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.toString('latin1', 0, 5)).toBe('%PDF-')
  })

  it('nhúng font Tinos (Unicode) để render tiếng Việt — KHÔNG dùng font built-in', async () => {
    const raw = (await buildPayslipPdf(fakeData())).toString('latin1')
    // CID TrueType embedded → có FontFile2 + tên Tinos trong font descriptor.
    expect(raw).toContain('Tinos')
    expect(raw).toContain('FontFile2')
    // KHÔNG được rơi về font WinAnsi built-in (Helvetica/Times) gây mojibake.
    expect(raw).not.toContain('/BaseFont /Helvetica')
  })

  it('không lỗi với field null (bonus_rate/kpi_percent/STK/ngân hàng/ghi chú null)', async () => {
    const buf = await buildPayslipPdf(
      fakeData({
        bonus_rate: null,
        kpi_percent: null,
        working_days: null,
        bank_account_number: null,
        bank_name: null,
        notes: null,
      }),
    )
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.toString('latin1', 0, 5)).toBe('%PDF-')
  })
})
