import { existsSync } from 'node:fs'
import { join } from 'node:path'
import PDFDocument from 'pdfkit'
import { PayslipExcelData } from './payslip-excel.builder'
import { NOTE_TEXT } from './payslip-excel.builder'
import { resolvePayrollCompanyName } from './payslip-company'

// PDF phiếu lương — ĐỒNG BỘ bố cục mẫu Excel (I/II/III/IV + Lưu ý).
// Dùng CHUNG `PayslipExcelData` (từ `toExcelData`) với Excel builder → 2 bên
// KHÔNG bao giờ lệch nhau. Font Tinos (serif metric-compatible Times, có tiếng
// Việt) nhúng để render đúng dấu — pdfkit built-in (Helvetica/Times) là WinAnsi,
// không có glyph tiếng Việt.

// --- Font (dual-path: dist/assets/fonts copy bởi nest-cli + fallback src) ---
const FONT_DIR_CANDIDATES = [
  join(__dirname, '..', 'assets', 'fonts'),
  join(__dirname, '..', '..', 'src', 'assets', 'fonts'),
]

function resolveFontPath(file: string): string {
  for (const dir of FONT_DIR_CANDIDATES) {
    const candidate = join(dir, file)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

// Định dạng tiền VNĐ dấu chấm nghìn (đồng nhất với formatVnd của service).
function formatVnd(value: bigint): string {
  const str = value.toString()
  const negative = str.startsWith('-')
  const abs = negative ? str.slice(1) : str
  const formatted = abs.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return negative ? `-${formatted}` : formatted
}

// --- Layout (A4 dọc 595×842pt, lề 40) ---
const MARGIN = 40
const CONTENT_W = 515 // 595 - 2*40 (làm tròn)
const X_LABEL = 46
const X_VALUE = 320
const W_LABEL = X_VALUE - X_LABEL - 6
const W_VALUE = MARGIN + CONTENT_W - X_VALUE // tới mép phải nội dung
const ROW_H = 16
const SEC_H = 19
const BODY_FS = 10.5
const PAGE_BOTTOM = 802 // 842 - 40
const SECTION_FILL = '#E7F3E0' // = ARGB FFE7F3E0 của Excel

const FONT_REGULAR = 'tinos'
const FONT_BOLD = 'tinos-bold'

interface PdfDoc {
  y: number
  fontSize(n: number): PdfDoc
  text(t: string, x?: number, y?: number, o?: Record<string, unknown>): PdfDoc
  registerFont(name: string, src: string): PdfDoc
  font(name: string): PdfDoc
  fillColor(c: string): PdfDoc
  rect(x: number, y: number, w: number, h: number): PdfDoc
  fill(c?: string): PdfDoc
  moveTo(x: number, y: number): PdfDoc
  lineTo(x: number, y: number): PdfDoc
  stroke(c?: string): PdfDoc
  addPage(o?: Record<string, unknown>): PdfDoc
  on(e: string, cb: (...a: unknown[]) => void): PdfDoc
  end(): void
}

// Bộ vẽ 1 phiếu — mọi state (y, helper) LOCAL theo từng lần dựng.
function writePayslip(doc: PdfDoc, d: PayslipExcelData): void {
  const regular = resolveFontPath('Tinos-Regular.ttf')
  if (!regular) {
    throw new Error(
      `Thiếu font Tinos-Regular.ttf cho PDF phiếu lương (đã kiểm tra: ${FONT_DIR_CANDIDATES.join(', ')})`,
    )
  }
  doc.registerFont(FONT_REGULAR, regular)
  doc.registerFont(FONT_BOLD, resolveFontPath('Tinos-Bold.ttf') || regular)

  let y = MARGIN

  const ensure = (h: number) => {
    if (y + h > PAGE_BOTTOM) {
      doc.addPage()
      y = MARGIN
    }
  }

  const centerTitle = (text: string, size: number) => {
    ensure(size + 8)
    doc.font(FONT_BOLD).fontSize(size).fillColor('#000000')
    doc.text(text, MARGIN, y, { width: CONTENT_W, align: 'center' })
    y += size + 8
  }

  const row = (
    label: string,
    value: string,
    opts: { bold?: boolean; align?: 'left' | 'right' } = {},
  ) => {
    ensure(ROW_H)
    doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fontSize(BODY_FS).fillColor('#000000')
    doc.text(label, X_LABEL, y, { width: W_LABEL, lineBreak: false })
    doc.text(value, X_VALUE, y, {
      width: W_VALUE,
      align: opts.align ?? 'right',
      lineBreak: false,
    })
    y += ROW_H
  }

  const moneyLine = (label: string, value: bigint, bold = false) =>
    row(label, formatVnd(value), { bold, align: 'right' })
  const numLine = (label: string, value: number | null) =>
    row(label, value === null ? '—' : String(value), { align: 'right' })
  const textLine = (label: string, value: string) =>
    row(label, value, { align: 'left' })

  const section = (text: string) => {
    ensure(SEC_H + 2)
    doc.fillColor(SECTION_FILL).rect(MARGIN, y, CONTENT_W, SEC_H).fill()
    doc.fillColor('#000000').font(FONT_BOLD).fontSize(BODY_FS)
    doc.text(text, X_LABEL, y + 5, { width: CONTENT_W - 12, lineBreak: false })
    y += SEC_H + 3
  }

  // Dòng tiêu đề mục KÈM giá trị (cột phải) — dùng cho mục IV để bỏ dòng nhãn trùng lặp.
  const sectionMoney = (text: string, value: bigint) => {
    ensure(SEC_H + 2)
    doc.fillColor(SECTION_FILL).rect(MARGIN, y, CONTENT_W, SEC_H).fill()
    doc.fillColor('#000000').font(FONT_BOLD).fontSize(BODY_FS)
    doc.text(text, X_LABEL, y + 5, { width: W_LABEL, lineBreak: false })
    doc.text(formatVnd(value), X_VALUE, y + 5, {
      width: W_VALUE,
      align: 'right',
      lineBreak: false,
    })
    y += SEC_H + 3
  }

  const [year, month] = d.month.split('-')

  // Header
  centerTitle(resolvePayrollCompanyName(), 13)
  textLine('Kính gửi: Quý Anh/Chị', d.full_name)
  centerTitle(`THÔNG TIN LƯƠNG THÁNG ${month}/${year}`, 12)
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke('#999999')
  y += 6

  // I/ THÔNG TIN CƠ BẢN
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

  // II/ DOANH SỐ/THƯỞNG
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

  // III/ TỔNG LƯƠNG & GIẢM TRỪ
  section('III/ TỔNG LƯƠNG & GIẢM TRỪ')
  moneyLine('Các khoản đã chi lĩnh trước', d.advances)
  moneyLine('Trích đóng BHXH', d.insurance_total)
  moneyLine('Thuế TNCN', d.tax_total)
  moneyLine('Tổng các khoản giảm trừ', d.tong_giam_tru, true)

  // IV/ TỔNG THỰC NHẬN
  sectionMoney('IV/ TỔNG THỰC NHẬN', d.total)
  textLine('Số tài khoản', d.bank_account_number ?? '')
  textLine('Ngân hàng', d.bank_name ?? '')

  textLine('Ghi chú', d.notes ?? '')

  // Khối "Lưu ý" — chung 1 hằng NOTE_TEXT với Excel.
  y += 6
  ensure(72)
  doc.font(FONT_REGULAR).fontSize(9).fillColor('#444444')
  doc.text(NOTE_TEXT, X_LABEL, y, { width: CONTENT_W - 12 })
}

/**
 * Dựng PDF 1 phiếu lương theo mẫu kế toán (đồng bộ Excel builder).
 */
export function buildPayslipPdf(d: PayslipExcelData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: `Phiếu lương - ${d.month}`, Author: resolvePayrollCompanyName() },
    }) as unknown as PdfDoc

    const chunks: Buffer[] = []
    doc.on('data', (c: unknown) => chunks.push(c as Buffer))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', (e: unknown) => reject(e as Error))

    try {
      writePayslip(doc, d)
    } catch (err) {
      reject(err as Error)
      return
    }
    doc.end()
  })
}
