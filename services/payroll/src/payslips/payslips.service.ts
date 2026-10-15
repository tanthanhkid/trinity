import {
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
  Optional,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import { ApprovePayslipDto, ApprovalAction } from './dto/approve-payslip.dto'
import { UpdatePayslipDto } from './dto/update-payslip.dto'
import { can } from '@trinity/rbac'
import { ScopeService, assertInScope, type AuthUser } from '@trinity/rbac-nest'
import { SalaryComponentsEngine } from '../salary-components/salary-components-engine.service'
import { InsuranceEngine } from '../insurance/insurance.engine'
import { TaxEngine } from '../tax/tax.engine'
import {
  buildPayslipExcel,
  buildPayslipsWorkbook,
  PayslipExcelData,
} from './payslip-excel.builder'
import { buildPayslipPdf } from './payslip-pdf.builder'
import {
  PAYROLL_PAYSLIP_NOTIFY_PORT,
  PayslipNotifyPort,
} from './payslip-notify.port'
import {
  buildPayslipsListWorkbook,
  PayslipListRow,
} from './payslip-list-excel.builder'
import {
  parseImportFile,
  buildImportTemplate,
  HEADER_TO_FIELD,
  type TemplateEmployee,
  type ImportRow,
} from './payslip-import.helper'

// --- Interfaces ---

type PayslipStatus = 'draft' | 'pending_tl' | 'pending_accountant' | 'approved'

interface PayslipRow {
  id: number
  employee_id: number
  month: string
  base_salary: bigint
  kpi_bonus: bigint
  deductions: bigint
  total: bigint
  components_json: Prisma.JsonValue
  insurance_json: Prisma.JsonValue
  insurance_base: bigint // mức đóng BHXH thực dùng (để tách phụ cấp xăng xe = base − insurance_base)
  tax_json: Prisma.JsonValue
  // --- Dữ liệu nhập tay ---
  working_days: Prisma.Decimal | null
  standard_working_days: number
  base_salary_actual: bigint
  training_days: Prisma.Decimal | null // Ngày học việc (passthrough)
  training_salary: bigint
  probation_allowance: bigint
  sales_personal: bigint
  bonus_rate: Prisma.Decimal | null
  kpi_percent: Prisma.Decimal | null
  bonus_sales_personal: bigint
  sales_team: bigint
  bonus_cskh_team: bigint
  bonus_milestone: bigint
  bonus_referral: bigint
  holiday_bonus: bigint
  advances: bigint
  personal_income_tax: bigint // Thuế TNCN nhập tay — kế toán nhập ghi đè hệ thống tự tính, TRỪ VÀO total
  notes: string | null
  status: string
  tl_approved_by: number | null
  tl_approved_at: Date | null
  approved_by: number | null
  approved_at: Date | null
  created_at: Date
  updated_at: Date
}

interface PayslipWithEmployee extends PayslipRow {
  employee: {
    id: number
    user_id: number
    position: string
    team_id: number | null
    // Mã NV nhập tay — chuẩn hoá qua formatEmployeeCode (fallback NV<id> zero-pad 4).
    // Optional: path approve() dùng select tối giản KHÔNG cần field này (data path FE đầy đủ).
    employee_code?: string | null
    user: { full_name: string; email: string; manager: { id: number; full_name: string } | null }
    bank_account_number: string | null
    bank_name: string | null
    // phân khúc (FE dialog dò segment + chỉ tiêu). office/jobTitle là relation
    // → KHÔNG spread thô (jobTitle.standard_target BigInt sẽ crash JSON); flatten ở serializePayslip.
    // Optional: luôn có khi serialize cho FE (employeeListSelect select đủ); path approve() dùng
    // select tối giản KHÔNG cần các field này nên để optional (data path FE vẫn đầy đủ).
    department?: string | null
    office_id?: number | null
    office?: { id: number; name: string } | null
    jobTitle?: { category: string; name: string | null; standard_target: bigint } | null
  }
}

// Dữ liệu nhân viên tối thiểu để tính phiếu lương (engine + autofill).
type EmpForCompute = {
  id: number
  user_id: number
  salary_rule_id: number | null
  position: string
  job_title_id: number | null
  insurance_salary: bigint | null
  dependents_count: number
  jobTitle: { base_salary: bigint; rank_code: string | null; default_insurance_salary: bigint | null } | null
}

// 12 trường template kế toán nhập tay / điền sẵn (đã resolve giá trị, KHÔNG còn undefined).
interface ManualPayslipFields {
  working_days: number | null
  standard_working_days: number
  base_salary: bigint
  training_days: number | null // Ngày học việc — nhập tay (passthrough)
  training_salary: bigint // Lương học việc — nhập tay (tách khỏi phụ cấp học việc)
  probation_allowance: bigint
  sales_personal: bigint
  bonus_rate: number | null // Hệ số % (passthrough)
  kpi_percent: number | null // Tỷ lệ KPI % (passthrough)
  bonus_sales_personal: bigint
  sales_team: bigint
  bonus_cskh_team: bigint
  bonus_milestone: bigint
  bonus_referral: bigint
  holiday_bonus: bigint // Thưởng Lễ (5) — nhập tay; cộng vào cong_thuong → total
  advances: bigint
  personal_income_tax: bigint // Thuế TNCN nhập tay — TRỪ VÀO total
  notes: string | null
}

export interface ImportPreviewRow {
  employee_code: string
  employee_name: string | null
  payslip_id: number | null
  payslip_status: string | null
  changes: Array<{ header: string; field: string; before: string | null; after: string }>
  skipped: boolean
  skip_reason?: string
}

// --- Helpers ---

// Tổng BHXH/BHYT/BHTN NLĐ đóng từ snapshot insurance_json ([{amount}]).
function sumInsurance(insuranceJson: Prisma.JsonValue): bigint {
  if (!Array.isArray(insuranceJson)) return BigInt(0)
  let total = BigInt(0)
  for (const item of insuranceJson) {
    if (item && typeof item === 'object' && 'amount' in item) {
      const amount = (item as { amount?: unknown }).amount
      if (typeof amount === 'number' || typeof amount === 'string') {
        try {
          total += BigInt(Math.round(Number(amount)))
        } catch {
          // bỏ qua entry lỗi
        }
      }
    }
  }
  return total
}

// Thuế TNCN từ snapshot tax_json ({tax}).
function readTax(taxJson: Prisma.JsonValue): bigint {
  if (taxJson && typeof taxJson === 'object' && !Array.isArray(taxJson) && 'tax' in taxJson) {
    const tax = (taxJson as { tax?: unknown }).tax
    if (typeof tax === 'number' || typeof tax === 'string') {
      try {
        return BigInt(Math.round(Number(tax)))
      } catch {
        return BigInt(0)
      }
    }
  }
  return BigInt(0)
}

// Gợi ý Bonus DS cá nhân doanh số × hệ số (%).
//   bonus_rate là PERCENT (0.4 = 0.4%) → chia 100. Null/0 → 0.
//   sales_personal ≤ vài trăm tỷ << Number.MAX_SAFE_INTEGER → an toàn (không mất chính xác).
//   Đây CHỈ là gợi ý read-only; KHÔNG tự ghi đè bonus_sales_personal (kế toán bấm "Áp dụng" trên FE).
export function computeBonusSuggestion(
  salesPersonal: bigint,
  bonusRate: number | null,
): bigint {
  if (bonusRate === null || bonusRate <= 0) return BigInt(0)
  return BigInt(Math.round((Number(salesPersonal) * bonusRate) / 100))
}

// Mã NV hiển thị: ưu tiên `employee_code` nhập tay (dữ liệu master nhân viên);
// khi chưa nhập → fallback `NV<id>` ZERO-PAD 4 chữ số. PHẢI khớp tuyệt đối với CRM
// `mapEmployee` (`NV${String(id).padStart(4,'0')}`) để cột "Mã NV" ở Phiếu lương + Excel
// hiển thị CÙNG mã với module "Quản lý nhân viên" (vd id=27 → "NV0027", KHÔNG cắt số 0).
export function formatEmployeeCode(
  employeeCode: string | null | undefined,
  id: number,
): string {
  return employeeCode ?? `NV${String(id).padStart(4, '0')}`
}

// Nhóm team theo quản lý trực tiếp (manager): người có manager xếp theo nhóm của manager,
// người không có manager xếp cuối.
function teamRank(leadId: number | null): number {
  return leadId == null ? 999 : 0
}
// Team-lead trực thuộc = quản lý trực tiếp (manager) của nhân viên, nếu có.
function deriveTeam(
  _userId: number,
  _ownName: string,
  manager: { id: number; full_name: string } | null,
): { team_lead_id: number | null; team_name: string | null } {
  if (manager) return { team_lead_id: manager.id, team_name: manager.full_name }
  return { team_lead_id: null, team_name: null }
}

function serializePayslip(p: PayslipWithEmployee) {
  // Số liệu dẫn xuất cho FE/Excel theo mẫu (tính từ field đã lưu — KHÔNG lưu thêm cột).
  const insuranceTotal = sumInsurance(p.insurance_json)
  // Thuế nhập tay (> 0) ghi đè thuế hệ thống (xem phần tính tổng ở calculate): hiển thị MỘT khoản thuế, không cộng dồn hai nguồn.
  const taxTotal = p.personal_income_tax > BigInt(0) ? p.personal_income_tax : readTax(p.tax_json)
  const congLcb = p.base_salary_actual + p.training_salary + p.probation_allowance
  const congThuong =
    p.bonus_sales_personal +
    p.bonus_cskh_team +
    p.bonus_milestone +
    p.bonus_referral +
    p.holiday_bonus
  const tongLuong = congLcb + congThuong
  // deductions đã = config.deductions + BHXH + thuế (giữ semantics cũ). Tổng giảm trừ + đã chi lĩnh.
  const tongGiamTru = p.deductions + p.advances + p.personal_income_tax // thuế TNCN nhập tay
  // chênh giữa lương cơ bản và mức đóng BHXH → hiển thị "Phụ cấp xăng xe/ăn ca".
  //   Chỉ tách khi có đóng BHXH (insurance_base > 0); miễn BHXH (thử việc, insurance_base = 0) → 0.
  const phuCapXangXe =
    p.insurance_base > BigInt(0) && p.base_salary > p.insurance_base
      ? p.base_salary - p.insurance_base
      : BigInt(0)
  // dẫn xuất read-only cho mẫu kế toán:
  const bonusRate = p.bonus_rate === null ? null : Number(p.bonus_rate)
  const kpiPercent = p.kpi_percent === null ? null : Number(p.kpi_percent) // passthrough
  // Đơn giá công/ngày = lương cơ bản / ngày công chuẩn (mẫu kế toán cột "Số tiền ngày công").
  // Dùng Math.round (khớp FE) — base ≤ ~45tr nên Number an toàn.
  const donGiaNgayCong =
    p.standard_working_days > 0
      ? BigInt(Math.round(Number(p.base_salary) / p.standard_working_days))
      : BigInt(0)
  // Bonus DS cá nhân gợi ý theo hệ số (FE hiển thị + nút "Áp dụng"; KHÔNG tự ghi đè).
  const bonusSuggested = computeBonusSuggestion(p.sales_personal, bonusRate)

  // employee enrich phân khúc. KHÔNG spread relation thô (jobTitle.standard_target
  // là BigInt → crash JSON). office_id/department là scalar nên ride trong empRest; team_lead_id/team_name
  // do deriveTeam bổ sung (spread cuối → KHÔNG mất field cũ).
  const { office: empOffice, jobTitle: empJobTitle, ...empRest } = p.employee
  const employeeOut = {
    ...empRest,
    // Mã NV nhất quán với "Quản lý nhân viên" — fallback NV<id> zero-pad 4 (KHÔNG cắt số 0).
    // Ghi đè employee_code thô từ `...empRest` để FE luôn nhận mã chuẩn từ dữ liệu master.
    employee_code: formatEmployeeCode(p.employee.employee_code, p.employee.id),
    // Team = quản lý trực tiếp (null nếu không có manager).
    // Trả cả team_name (hiển thị) + team_lead_id (FE tô màu, BE sort nhóm).
    ...deriveTeam(p.employee.user_id, p.employee.user.full_name, p.employee.user.manager),
    office_name: empOffice?.name ?? null,
    // Tên chức danh chính thức cho cột "Vị trí" trên bảng Phiếu lương.
    job_title_name: empJobTitle?.name ?? null,
    job_title_category: empJobTitle?.category ?? null,
    standard_target:
      empJobTitle?.standard_target != null ? empJobTitle.standard_target.toString() : null,
  }

  return {
    id: p.id,
    employee_id: p.employee_id,
    month: p.month,
    base_salary: p.base_salary.toString(),
    kpi_bonus: p.kpi_bonus.toString(),
    deductions: p.deductions.toString(),
    total: p.total.toString(),
    components_json: p.components_json, // breakdown phụ cấp/thưởng/khấu trừ cho FE
    insurance_json: p.insurance_json, // breakdown bảo hiểm BHXH/BHYT/BHTN
    tax_json: p.tax_json, // breakdown thuế TNCN
    // --- Dữ liệu nhập tay ---
    working_days: p.working_days === null ? null : Number(p.working_days),
    standard_working_days: p.standard_working_days,
    base_salary_actual: p.base_salary_actual.toString(),
    training_days: p.training_days === null ? null : Number(p.training_days), // passthrough
    training_salary: p.training_salary.toString(),
    probation_allowance: p.probation_allowance.toString(),
    sales_personal: p.sales_personal.toString(),
    bonus_rate: bonusRate,
    kpi_percent: kpiPercent,
    bonus_sales_personal: p.bonus_sales_personal.toString(),
    sales_team: p.sales_team.toString(),
    bonus_cskh_team: p.bonus_cskh_team.toString(),
    bonus_milestone: p.bonus_milestone.toString(),
    bonus_referral: p.bonus_referral.toString(),
    holiday_bonus: p.holiday_bonus.toString(),
    advances: p.advances.toString(),
    personal_income_tax: p.personal_income_tax.toString(),
    notes: p.notes,
    // dẫn xuất (read-only) — FE hiển thị, KHÔNG gửi lên khi sửa
    cong_lcb: congLcb.toString(),
    cong_thuong: congThuong.toString(),
    tong_luong: tongLuong.toString(),
    insurance_total: insuranceTotal.toString(),
    insurance_base: p.insurance_base.toString(), // Lương đóng BHXH (mức cố định)
    phu_cap_xang_xe: phuCapXangXe.toString(), // Phụ cấp xăng xe/ăn ca = base − insurance_base
    tax_total: taxTotal.toString(),
    tong_giam_tru: tongGiamTru.toString(),
    don_gia_ngay_cong: donGiaNgayCong.toString(),
    bonus_sales_personal_suggested: bonusSuggested.toString(),
    status: p.status,
    tl_approved_by: p.tl_approved_by,
    tl_approved_at: p.tl_approved_at,
    approved_by: p.approved_by,
    approved_at: p.approved_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    employee: employeeOut,
  }
}

// --- Employee select shapes ---

const employeeListSelect = {
  id: true,
  user_id: true,
  position: true,
  employee_code: true,
  team_id: true,
  user: { select: { full_name: true, email: true, manager: { select: { id: true, full_name: true } } } },
  bank_account_number: true, // STK ngân hàng — hiển thị trên phiếu
  bank_name: true, // Tên ngân hàng — hiển thị trên phiếu
  // phân khúc + chỉ tiêu cho gợi ý (FE dialog). Đây là metadata tổ chức
  // không nhạy cảm (cùng cấp team_name/position đã trả), nằm trong scope RBAC payroll sẵn có.
  department: true,
  office_id: true,
  office: { select: { id: true, name: true } },
  jobTitle: { select: { category: true, name: true, standard_target: true } },
} as const

const payslipFieldsSelect = {
  id: true,
  employee_id: true,
  month: true,
  base_salary: true,
  kpi_bonus: true,
  deductions: true,
  total: true,
  components_json: true,
  insurance_json: true,
  insurance_base: true,
  tax_json: true,
  working_days: true,
  standard_working_days: true,
  base_salary_actual: true,
  training_days: true,
  training_salary: true,
  probation_allowance: true,
  sales_personal: true,
  bonus_rate: true,
  kpi_percent: true,
  bonus_sales_personal: true,
  sales_team: true,
  bonus_cskh_team: true,
  bonus_milestone: true,
  bonus_referral: true,
  holiday_bonus: true,
  advances: true,
  personal_income_tax: true,
  notes: true,
  status: true,
  tl_approved_by: true,
  tl_approved_at: true,
  approved_by: true,
  approved_at: true,
  created_at: true,
  updated_at: true,
} as const

// --- Service ---

@Injectable()
export class PayslipsService {
  private readonly logger = new Logger(PayslipsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly salaryComponentsEngine: SalaryComponentsEngine,
    private readonly insuranceEngine: InsuranceEngine,
    private readonly taxEngine: TaxEngine,
    private readonly scope: ScopeService,
    @Optional()
    @Inject(PAYROLL_PAYSLIP_NOTIFY_PORT)
    private readonly payslipNotifyPort?: PayslipNotifyPort,
  ) {}

  // =====================
  // List & Detail
  // =====================

  // Mẫu A — owner phiếu lương = employee.user_id.
  async findAll(
    month: string,
    user: AuthUser,
    teamId?: number,
    status?: string,
  ) {
    const owner = (await this.scope.ownerIds(user, 'payroll.view'))! // null không xảy ra: guard đã kiểm @Can
    const where: Prisma.PayslipWhereInput = { month, deleted_at: null }
    // owner sống trên quan hệ employee.user_id (không phải cột trực tiếp của
    // payslip) — ghép thủ công thay `scopeWhere` (hàm đó giả định field trên
    // chính bảng đang query).
    if (owner !== 'all') {
      where.employee = { user_id: owner.length === 0 ? -1 : { in: owner } }
    }

    if (status) {
      where.status = status
    }
    if (teamId && owner === 'all') {
      // Scope 'all' có thể filter thủ công theo team_id legacy.
      where.employee = { team_id: teamId }
    }

    const payslips = await this.prisma.payslip.findMany({
      where,
      select: {
        ...payslipFieldsSelect,
        employee: { select: employeeListSelect },
      },
      orderBy: { id: 'asc' },
    })

    const rows = payslips.map(serializePayslip)
    // Sắp xếp theo team (quản lý trực tiếp), người không có manager cuối; trong team: theo tên.
    rows.sort((a, b) => {
      const ra = teamRank(a.employee.team_lead_id)
      const rb = teamRank(b.employee.team_lead_id)
      if (ra !== rb) return ra - rb
      const la = a.employee.team_lead_id ?? 0
      const lb = b.employee.team_lead_id ?? 0
      if (la !== lb) return la - lb
      const sa = a.employee.user_id === a.employee.team_lead_id ? 0 : 1
      const sb = b.employee.user_id === b.employee.team_lead_id ? 0 : 1
      if (sa !== sb) return sa - sb
      return (a.employee.user.full_name ?? '').localeCompare(
        b.employee.user.full_name ?? '',
        'vi',
      )
    })
    return rows
  }

  // Mẫu B — chi tiết theo id, ngoài phạm vi → 404.
  async findById(id: number, user: AuthUser) {
    const payslip = await this.prisma.payslip.findUnique({
      // Phiếu đã loại khỏi kỳ (soft-delete) coi như không tồn tại — như list/update/approve.
      where: { id, deleted_at: null },
      select: {
        ...payslipFieldsSelect,
        employee: { select: employeeListSelect },
      },
    })

    if (!payslip) {
      throw new NotFoundException(`Phieu luong #${id} khong ton tai`)
    }
    await assertInScope(this.scope, user, 'payroll.view', [payslip.employee.user_id])

    return serializePayslip(payslip)
  }

  /** Phiếu lương của CHÍNH MÌNH — `@AuthOnly`, không cần `payroll.view`. */
  async findMine(userId: number, month?: string) {
    const where: Prisma.PayslipWhereInput = { deleted_at: null, employee: { user_id: userId } }
    if (month) where.month = month

    const payslips = await this.prisma.payslip.findMany({
      where,
      select: {
        ...payslipFieldsSelect,
        employee: { select: employeeListSelect },
      },
      orderBy: { month: 'desc' },
    })

    return payslips.map(serializePayslip)
  }

  // =====================
  // Generate
  // =====================

  async generate(
    month: string,
    employeeIds?: number[],
  ): Promise<{ generated: number; skipped: number }> {
    const employees = await this.fetchEmployees(employeeIds)

    let generated = 0
    let skipped = 0

    for (const emp of employees) {
      const result = await this.generateForEmployee(emp, month)
      if (result === 'generated') {
        generated++
      } else {
        skipped++
      }
    }

    return { generated, skipped }
  }

  // =====================
  // Approval
  // =====================

  async approve(
    id: number,
    dto: ApprovePayslipDto,
    user: AuthUser,
  ): Promise<{ id: number; status: string; message: string }> {
    const payslip = await this.prisma.payslip.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            user_id: true,
            position: true,
            team_id: true,
            user: { select: { full_name: true, email: true, manager: { select: { id: true, full_name: true } } } },
            bank_account_number: true,
            bank_name: true,
          },
        },
      },
    })

    // Phiếu đã loại khỏi kỳ lương (xoá mềm) coi như không tồn tại: không duyệt/từ chối, không báo cho nhân viên.
    if (!payslip || payslip.deleted_at != null) {
      throw new NotFoundException(`Phieu luong #${id} khong ton tai`)
    }

    const currentStatus = payslip.status as PayslipStatus

    if (dto.action === ApprovalAction.REJECT) {
      return this.handleReject(payslip, currentStatus, user)
    }

    return this.handleApprove(payslip, currentStatus, user)
  }

  // =====================
  // PDF Export
  // =====================

  async generatePdf(id: number, user: AuthUser): Promise<Buffer> {
    const payslip = await this.loadPayslipForExport(id)
    await assertInScope(this.scope, user, 'payroll.export', [payslip.employee.user_id])
    // PDF dùng CHUNG toExcelData với Excel → bố cục + dữ liệu đồng bộ mẫu.
    return buildPayslipPdf(this.toExcelData(payslip))
  }

  /**
   * Tải 1 phiếu lương kèm include cần cho `toExcelData` (employee + manager/team,
   * rank, STK/ngân hàng). Dùng CHUNG cho xuất Excel + PDF → 2 bên đồng bộ dữ liệu.
   */
  private async loadPayslipForExport(id: number) {
    const payslip = await this.prisma.payslip.findUnique({
      where: { id, deleted_at: null }, // phiếu đã loại khỏi kỳ không được xuất
      include: {
        employee: {
          select: {
            user_id: true,
            position: true,
            user: { select: { full_name: true, manager: { select: { id: true, full_name: true } } } },
            jobTitle: { select: { rank_code: true, name: true } },
            bank_account_number: true,
            bank_name: true,
          },
        },
      },
    })
    if (!payslip) {
      throw new NotFoundException(`Phieu luong #${id} khong ton tai`)
    }
    return payslip
  }

  // =====================
  // Xuất Excel theo mẫu kế toán
  // =====================

  async generateExcel(id: number, user: AuthUser): Promise<Buffer> {
    const payslip = await this.loadPayslipForExport(id)
    await assertInScope(this.scope, user, 'payroll.export', [payslip.employee.user_id])
    return buildPayslipExcel(this.toExcelData(payslip))
  }

  /**
   * Xuất Excel HÀNG LOẠT theo kỳ lương — 1 workbook, mỗi nhân viên 1 sheet.
   * Mẫu A trên `payroll.export` — scope đồng nhất `findAll` (own/team/subtree/all).
   */
  async generateBulkExcel(month: string, user: AuthUser): Promise<Buffer> {
    const owner = (await this.scope.ownerIds(user, 'payroll.export'))! // null không xảy ra: guard đã kiểm @Can
    const where: Prisma.PayslipWhereInput = { month, deleted_at: null }
    if (owner !== 'all') {
      where.employee = { user_id: owner.length === 0 ? -1 : { in: owner } }
    }

    const payslips = await this.prisma.payslip.findMany({
      where,
      include: {
        employee: {
          select: {
            user_id: true,
            position: true,
            user: { select: { full_name: true, manager: { select: { id: true, full_name: true } } } },
            jobTitle: { select: { rank_code: true, name: true } },
            bank_account_number: true,
            bank_name: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    })

    if (payslips.length === 0) {
      throw new NotFoundException(
        `Không có phiếu lương nào trong kỳ ${month}`,
      )
    }

    const items = payslips.map((p, idx) => ({
      // full_name có thể null (users.full_name String?) → fallback tránh crash sanitize.
      sheetName: p.employee.user.full_name ?? `NV${idx + 1}`,
      data: this.toExcelData(p),
    }))

    return buildPayslipsWorkbook(items)
  }

  /**
   * Xuất Excel DANH SÁCH NHÂN VIÊN theo kỳ — 1 file, 1 sheet duy nhất, mỗi NV 1 dòng.
   * Thứ tự dòng ĐỒNG NHẤT bảng "Phiếu lương" trên màn hình (findAll): sắp theo team
   * (theo quản lý trực tiếp rồi tên). Có dòng TỔNG CỘNG.
   * Mẫu A trên `payroll.export` — scope đồng nhất `generateBulkExcel`.
   */
  async generateEmployeeListExcel(
    month: string,
    user: AuthUser,
    orderedIds?: number[],
  ): Promise<Buffer> {
    const owner = (await this.scope.ownerIds(user, 'payroll.export'))! // null không xảy ra: guard đã kiểm @Can
    const where: Prisma.PayslipWhereInput = { month, deleted_at: null }
    if (owner !== 'all') {
      where.employee = { user_id: owner.length === 0 ? -1 : { in: owner } }
    }

    // Khi FE gửi danh sách ID theo ĐÚNG thứ tự đang hiển thị (đã lọc + sắp xếp client-side)
    // → CHỈ xuất các phiếu đó, theo đúng thứ tự đó → file Excel khớp 100% màn hình.
    // RBAC scope (where.employee) VẪN áp dụng làm chốt chặn: id ngoài quyền bị loại, không lộ
    // phiếu của người khác dù client cố tình gửi id lạ.
    const hasOrder = Array.isArray(orderedIds) && orderedIds.length > 0
    if (hasOrder) {
      where.id = { in: orderedIds as number[] }
    }

    const payslips = await this.prisma.payslip.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            employee_code: true, // Mã NV nhập tay — fallback NV<id> zero-pad 4
            department: true, // Phòng ban
            user_id: true,
            position: true,
            user: { select: { full_name: true, manager: { select: { id: true, full_name: true } } } },
            jobTitle: { select: { rank_code: true, name: true } },
            bank_account_number: true,
            bank_name: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    })

    if (payslips.length === 0) {
      throw new NotFoundException(`Không có phiếu lương nào trong kỳ ${month}`)
    }

    let ordered: typeof payslips
    if (hasOrder) {
      // Giữ NGUYÊN thứ tự nhân viên như trên màn hình (FE đã sắp xếp/lọc rồi gửi danh sách ID).
      const byId = new Map(payslips.map((p) => [p.id, p]))
      ordered = (orderedIds as number[])
        .map((id) => byId.get(id))
        .filter((p): p is (typeof payslips)[number] => p !== undefined)
    } else {
      // Mặc định (không nhận thứ tự FE — vd gọi GET cũ): sắp ĐỒNG NHẤT findAll (GET /payslips):
      // theo team (quản lý trực tiếp) rồi tên.
      const sortable = payslips.map((p) => ({
        p,
        teamLeadId: deriveTeam(
          p.employee.user_id,
          p.employee.user.full_name,
          p.employee.user.manager,
        ).team_lead_id,
      }))
      sortable.sort((a, b) => {
        const ra = teamRank(a.teamLeadId)
        const rb = teamRank(b.teamLeadId)
        if (ra !== rb) return ra - rb
        const la = a.teamLeadId ?? 0
        const lb = b.teamLeadId ?? 0
        if (la !== lb) return la - lb
        const sa = a.p.employee.user_id === a.teamLeadId ? 0 : 1
        const sb = b.p.employee.user_id === b.teamLeadId ? 0 : 1
        if (sa !== sb) return sa - sb
        return (a.p.employee.user.full_name ?? '').localeCompare(
          b.p.employee.user.full_name ?? '',
          'vi',
        )
      })
      ordered = sortable.map(({ p }) => p)
    }

    const rows: PayslipListRow[] = ordered.map((p) => ({
      employee_code: formatEmployeeCode(p.employee.employee_code, p.employee.id),
      department: p.employee.department ?? '',
      data: this.toExcelData(p),
    }))

    return buildPayslipsListWorkbook(rows, month)
  }

  private toExcelData(p: {
    month: string
    base_salary: bigint
    deductions: bigint
    total: bigint
    insurance_json: Prisma.JsonValue
    insurance_base: bigint
    tax_json: Prisma.JsonValue
    working_days: Prisma.Decimal | null
    standard_working_days: number
    base_salary_actual: bigint
    training_days: Prisma.Decimal | null
    training_salary: bigint
    probation_allowance: bigint
    sales_personal: bigint
    bonus_rate: Prisma.Decimal | null
    kpi_percent: Prisma.Decimal | null
    bonus_sales_personal: bigint
    sales_team: bigint
    bonus_cskh_team: bigint
    bonus_milestone: bigint
    bonus_referral: bigint
    holiday_bonus: bigint
    advances: bigint
    personal_income_tax: bigint
    notes: string | null
    employee: {
      user_id: number
      position: string
      user: { full_name: string; manager: { id: number; full_name: string } | null }
      jobTitle: { rank_code: string | null; name: string | null } | null
      bank_account_number: string | null
      bank_name: string | null
    }
  }): PayslipExcelData {
    const insuranceTotal = sumInsurance(p.insurance_json)
    const taxTotal = p.personal_income_tax > BigInt(0) ? p.personal_income_tax : readTax(p.tax_json)
    const congLcb = p.base_salary_actual + p.training_salary + p.probation_allowance
    const congThuong =
      p.bonus_sales_personal +
      p.bonus_cskh_team +
      p.bonus_milestone +
      p.bonus_referral +
      p.holiday_bonus
    const tongLuong = congLcb + congThuong
    // chênh lương cơ bản vs mức đóng BHXH → "Phụ cấp xăng xe/ăn ca".
    const phuCapXangXe =
      p.insurance_base > BigInt(0) && p.base_salary > p.insurance_base
        ? p.base_salary - p.insurance_base
        : BigInt(0)
    const donGiaNgayCong =
      p.standard_working_days > 0
        ? BigInt(Math.round(Number(p.base_salary) / p.standard_working_days))
        : BigInt(0)
    return {
      month: p.month,
      full_name: p.employee.user.full_name,
      // Hiển thị TÊN CHỨC DANH chính thức (job_titles.name) — KHÔNG còn position slug
      // (slug vai trò) + KHÔNG còn ký hiệu rank.
      // Chưa gán chức danh (job_title_id null) → "—" theo yêu cầu.
      position: p.employee.jobTitle?.name ?? '—',
      team_name: deriveTeam(p.employee.user_id, p.employee.user.full_name, p.employee.user.manager).team_name ?? '',
      base_salary: p.base_salary,
      working_days: p.working_days === null ? null : Number(p.working_days),
      don_gia_ngay_cong: donGiaNgayCong,
      base_salary_actual: p.base_salary_actual,
      training_days: p.training_days === null ? null : Number(p.training_days),
      training_salary: p.training_salary,
      probation_allowance: p.probation_allowance,
      cong_lcb: congLcb,
      sales_personal: p.sales_personal,
      bonus_rate: p.bonus_rate === null ? null : Number(p.bonus_rate),
      kpi_percent: p.kpi_percent === null ? null : Number(p.kpi_percent),
      bonus_sales_personal: p.bonus_sales_personal,
      sales_team: p.sales_team,
      bonus_cskh_team: p.bonus_cskh_team,
      bonus_milestone: p.bonus_milestone,
      bonus_referral: p.bonus_referral,
      holiday_bonus: p.holiday_bonus,
      cong_thuong: congThuong,
      tong_luong: tongLuong,
      advances: p.advances,
      insurance_base: p.insurance_base,
      phu_cap_xang_xe: phuCapXangXe,
      insurance_total: insuranceTotal,
      // Gộp thuế TNCN nhập tay vào dòng "Thuế TNCN" để bảng phiếu lương không có dòng thừa
      tax_total: taxTotal,
      tong_giam_tru: p.deductions + p.advances + p.personal_income_tax,
      total: p.total,
      bank_account_number: p.employee.bank_account_number,
      bank_name: p.employee.bank_name,
      notes: p.notes,
    }
  }

  // =====================
  // Private: Generate helpers
  // =====================

  private async fetchEmployees(employeeIds?: number[]) {
    const where: Prisma.EmployeeWhereInput = { status: 'active', deleted_at: null }
    if (employeeIds && employeeIds.length > 0) {
      where.id = { in: employeeIds }
    }

    return this.prisma.employee.findMany({
      where,
      select: {
        id: true,
        user_id: true,
        salary_rule_id: true,
        position: true,
        job_title_id: true,
        insurance_salary: true,
        dependents_count: true,
        jobTitle: {
          select: {
            base_salary: true,
            rank_code: true,
            default_insurance_salary: true, // mức đóng BHXH mặc định theo chức vụ
          },
        },
      },
    })
  }

  private async generateForEmployee(
    emp: EmpForCompute,
    month: string,
  ): Promise<'generated' | 'skipped'> {
    const existing = await this.prisma.payslip.findUnique({
      where: { employee_id_month: { employee_id: emp.id, month } },
    })

    // Đã bị loại khỏi kỳ (soft-delete) → KHÔNG tự tạo lại (xóa "dính"). Muốn có lại
    // dùng "Thêm người vào kỳ" (addToPeriod) — khôi phục có chủ đích.
    // Truthy-check: deleted_at là Date khi đã loại, null/undefined khi còn trong kỳ.
    if (existing && existing.deleted_at) {
      return 'skipped'
    }

    if (existing && existing.status !== 'draft') {
      return 'skipped'
    }

    const engine = await this.assembleEngine(emp, month)

    // Phiếu MỚI → điền sẵn từ engine (KHÔNG mất tiền): KPI → Thưởng mốc,
    //   phụ cấp config → Học việc, thưởng config → CSKH; ngày công tự lấy từ chấm công, kế toán sửa.
    // Phiếu draft ĐÃ CÓ → GIỮ nguyên các khoản kế toán đã nhập tay (chỉ làm mới engine + tính lại tổng).
    let manual: ManualPayslipFields
    if (existing) {
      manual = this.readManualFromPayslip(existing)
    } else {
      const workingDays = await this.getAttendanceWorkingDays(emp.user_id, month)
      manual = {
        working_days: workingDays,
        standard_working_days: 24,
        base_salary: engine.base_salary,
        training_days: null,
        training_salary: BigInt(0),
        probation_allowance: engine.config.allowances,
        sales_personal: BigInt(0),
        bonus_rate: null,
        kpi_percent: null,
        bonus_sales_personal: BigInt(0),
        sales_team: BigInt(0),
        bonus_cskh_team: engine.config.bonuses,
        bonus_milestone: engine.kpi_bonus,
        bonus_referral: BigInt(0),
        holiday_bonus: BigInt(0),
        advances: BigInt(0),
        personal_income_tax: BigInt(0),
        notes: null,
      }
    }

    const computed = await this.buildPayslipData(emp, month, engine, manual)

    if (existing) {
      await this.prisma.payslip.update({ where: { id: existing.id }, data: computed })
    } else {
      await this.prisma.payslip.create({
        data: { employee_id: emp.id, month, status: 'draft', ...computed },
      })
    }

    return 'generated'
  }

  // Ngày công thực tế từ chấm công: số ngày có check-in trong tháng (half_day = 0.5). null nếu không có
  // dữ liệu chấm công → thực lĩnh LCB = nguyên lương cơ bản (tránh tụt oan). Read-only, cùng DB.
  private async getAttendanceWorkingDays(
    userId: number,
    month: string,
  ): Promise<number | null> {
    const [yearStr, monthStr] = month.split('-')
    const year = parseInt(yearStr, 10)
    const monthNum = parseInt(monthStr, 10)
    if (!year || !monthNum) return null
    const from = new Date(Date.UTC(year, monthNum - 1, 1))
    const to = new Date(Date.UTC(year, monthNum, 1))
    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        user_id: userId,
        work_date: { gte: from, lt: to },
        check_in_at: { not: null },
      },
      select: { status: true },
    })
    if (records.length === 0) return null
    let days = 0
    for (const r of records) {
      days += r.status === 'half_day' ? 0.5 : 1
    }
    return days
  }

  // Thực lĩnh LCB (1) = lương cơ bản × ngày công / ngày chuẩn. base ≤ 45tr, days ≤ 31 → tích < 2^53 an toàn.
  private prorateBase(
    base: bigint,
    workingDays: number | null,
    standard: number,
  ): bigint {
    if (workingDays === null || standard <= 0) return base
    return BigInt(Math.round((Number(base) * workingDays) / standard))
  }

  // Engine lương cơ bản (rank/rule) + KPI + phụ cấp/thưởng/khấu trừ config.
  // KHÔNG tính BHXH/thuế ở đây (phụ thuộc thu nhập sau khi prorate + thưởng → tính ở buildPayslipData).
  private async assembleEngine(emp: EmpForCompute, month: string) {
    let baseSalary = BigInt(0)
    if (emp.job_title_id && emp.jobTitle && emp.jobTitle.base_salary > BigInt(0)) {
      baseSalary = emp.jobTitle.base_salary
    }
    if (emp.salary_rule_id) {
      const details = await this.loadSalaryRuleDetails(emp.salary_rule_id)
      for (const d of details) {
        if (d.component === 'base' && d.amount) {
          baseSalary = d.amount
        }
      }
    }

    let kpiBonus = BigInt(0)
    const kpiResults = await this.prisma.kpiResult.findMany({
      where: { employee_id: emp.id, month },
    })
    if (kpiResults.length > 0) {
      kpiBonus = this.calculateKpiBonus(kpiResults)
    }

    const rankCode = emp.jobTitle?.rank_code ?? null
    const config = await this.salaryComponentsEngine.computeForEmployee(
      baseSalary,
      month,
      rankCode,
    )

    return {
      base_salary: baseSalary,
      kpi_bonus: kpiBonus,
      config,
    }
  }

  // Đọc 12 trường nhập tay từ phiếu đã có (giữ nguyên khi tạo lại để không mất chỉnh sửa kế toán).
  private readManualFromPayslip(p: {
    working_days: Prisma.Decimal | null
    standard_working_days: number
    base_salary: bigint
    training_days: Prisma.Decimal | null
    training_salary: bigint
    probation_allowance: bigint
    sales_personal: bigint
    bonus_rate: Prisma.Decimal | null
    kpi_percent: Prisma.Decimal | null
    bonus_sales_personal: bigint
    sales_team: bigint
    bonus_cskh_team: bigint
    bonus_milestone: bigint
    bonus_referral: bigint
    holiday_bonus: bigint
    advances: bigint
    personal_income_tax: bigint
    notes: string | null
  }): ManualPayslipFields {
    return {
      working_days: p.working_days === null ? null : Number(p.working_days),
      standard_working_days: p.standard_working_days,
      base_salary: p.base_salary,
      training_days: p.training_days === null ? null : Number(p.training_days),
      training_salary: p.training_salary,
      probation_allowance: p.probation_allowance,
      sales_personal: p.sales_personal,
      bonus_rate: p.bonus_rate === null ? null : Number(p.bonus_rate),
      kpi_percent: p.kpi_percent === null ? null : Number(p.kpi_percent),
      bonus_sales_personal: p.bonus_sales_personal,
      sales_team: p.sales_team,
      bonus_cskh_team: p.bonus_cskh_team,
      bonus_milestone: p.bonus_milestone,
      bonus_referral: p.bonus_referral,
      holiday_bonus: p.holiday_bonus,
      advances: p.advances,
      personal_income_tax: p.personal_income_tax,
      notes: p.notes,
    }
  }

  // Tính phiếu theo mẫu kế toán từ giá trị nhập tay đã resolve:
  //   Thực lĩnh LCB = base × ngày công/chuẩn; CỘNG LCB = +học việc; Cộng Thưởng = Σ4 thưởng;
  //   BHXH (trên lương đóng BH) + Thuế TNCN (trên tổng lương kỳ) tự tính; Thực nhận = tổng lương − giảm trừ − đã chi lĩnh.
  private async buildPayslipData(
    emp: EmpForCompute,
    month: string,
    engine: Awaited<ReturnType<PayslipsService['assembleEngine']>>,
    manual: ManualPayslipFields,
  ) {
    const baseSalary = manual.base_salary
    const baseActual = this.prorateBase(
      baseSalary,
      manual.working_days,
      manual.standard_working_days,
    )
    const congLcb = baseActual + manual.training_salary + manual.probation_allowance
    const congThuong =
      manual.bonus_sales_personal +
      manual.bonus_cskh_team +
      manual.bonus_milestone +
      manual.bonus_referral +
      manual.holiday_bonus
    const tongLuong = congLcb + congThuong

    // BHXH: base = lương đóng BH (lương HĐ, KHÔNG prorate). thứ tự ưu tiên:
    //   override cá nhân (insurance_salary, 0n = miễn/thử việc) → mặc định theo chức vụ (>0) → lương cơ bản.
    const jtDefault = emp.jobTitle?.default_insurance_salary
    const insuranceBase =
      emp.insurance_salary ??
      (jtDefault != null && jtDefault > BigInt(0) ? jtDefault : baseSalary)
    const insurance = await this.insuranceEngine.compute(insuranceBase, month)

    // Thuế TNCN: thu nhập chịu thuế = tổng lương kỳ (thực lĩnh LCB + học việc + thưởng); engine tự
    // trừ BHXH + giảm trừ gia cảnh → lũy tiến TỪNG PHẦN. (Khoản thưởng nhập tay coi như chịu thuế.)
    const tax = await this.taxEngine.compute(
      tongLuong,
      insurance.total,
      emp.dependents_count,
      month,
    )

    // deductions = khấu trừ khác (config) + BHXH + thuế (giữ semantics cũ). "Đã chi lĩnh trước" tách riêng.
    // Thuế TNCN nhập tay (> 0) GHI ĐÈ thuế hệ thống tự tính: chỉ trừ MỘT lần (khoản nhập tay, ở rawTotal bên dưới).
    const systemTax = manual.personal_income_tax > BigInt(0) ? BigInt(0) : tax.tax
    const deductions = engine.config.deductions + insurance.total + systemTax
    const rawTotal = tongLuong - deductions - manual.advances - manual.personal_income_tax // thuế TNCN nhập tay
    if (rawTotal < BigInt(0)) {
      this.logger.warn(
        `[payslip] Tổng thực nhận âm (giảm trừ + đã chi lĩnh > tổng lương) — clamp về 0: ` +
          `employee=${emp.id} month=${month} raw=${rawTotal.toString()}`,
      )
    }
    const total = rawTotal < BigInt(0) ? BigInt(0) : rawTotal

    return {
      base_salary: baseSalary,
      kpi_bonus: engine.kpi_bonus,
      deductions,
      total,
      components_json: engine.config.snapshot as unknown as Prisma.InputJsonValue,
      insurance_json: insurance.snapshot as unknown as Prisma.InputJsonValue,
      insurance_base: insuranceBase, // lưu mức đóng BHXH thực dùng (authoritative)
      tax_json: tax.snapshot as unknown as Prisma.InputJsonValue,
      working_days: manual.working_days,
      standard_working_days: manual.standard_working_days,
      base_salary_actual: baseActual,
      training_days: manual.training_days, // passthrough — KHÔNG ảnh hưởng total
      training_salary: manual.training_salary,
      probation_allowance: manual.probation_allowance,
      sales_personal: manual.sales_personal,
      bonus_rate: manual.bonus_rate, // passthrough — KHÔNG ảnh hưởng total
      kpi_percent: manual.kpi_percent, // passthrough — KHÔNG ảnh hưởng total
      bonus_sales_personal: manual.bonus_sales_personal,
      sales_team: manual.sales_team,
      bonus_cskh_team: manual.bonus_cskh_team,
      bonus_milestone: manual.bonus_milestone,
      bonus_referral: manual.bonus_referral,
      holiday_bonus: manual.holiday_bonus, // Thưởng Lễ (5) — cộng vào cong_thuong → total
      advances: manual.advances,
      personal_income_tax: manual.personal_income_tax, // TRỪ VÀO total (non-passthrough)
      notes: manual.notes,
    }
  }

  // =====================
  // Edit phiếu lương (mẫu) — kế toán nhập tay/sửa, lưu DB
  // =====================

  async update(id: number, dto: UpdatePayslipDto, user: AuthUser) {
    const existing = await this.prisma.payslip.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            user_id: true,
            salary_rule_id: true,
            position: true,
            job_title_id: true,
            insurance_salary: true,
            dependents_count: true,
            jobTitle: { select: { base_salary: true, rank_code: true, default_insurance_salary: true } },
          },
        },
      },
    })

    if (!existing || existing.deleted_at != null) {
      throw new NotFoundException(`Phieu luong #${id} khong ton tai`)
    }

    // Chặn sửa phiếu đã DUYỆT / đã TRẢ (giữ audit). Muốn sửa → trả về nháp trước (reject).
    if (existing.status === 'approved' || existing.status === 'paid') {
      throw new BadRequestException(
        'Phiếu lương đã duyệt/đã trả không thể sửa. Vui lòng trả phiếu về nháp trước khi sửa.',
      )
    }

    const emp = existing.employee
    const engine = await this.assembleEngine(emp, existing.month)
    const manual = this.mergeManualFields(dto, existing)

    const computed = await this.buildPayslipData(emp, existing.month, engine, manual)
    await this.prisma.payslip.update({ where: { id }, data: computed })

    return this.findById(id, user)
  }

  // Merge PATCH (dto, có thể partial — dùng chung cho update() tay VÀ import Excel)
  // override lên giá trị đã lưu (existing); field không có trong dto giữ nguyên.
  // BẮT BUỘC dùng hàm này trước khi gọi buildPayslipData() — KHÔNG ghi thẳng field thô
  // (bỏ qua bước này sẽ làm total/base_salary_actual/deductions sai).
  private mergeManualFields(
    dto: Partial<UpdatePayslipDto>,
    existing: PayslipRow,
  ): ManualPayslipFields {
    return {
      working_days:
        dto.working_days !== undefined
          ? dto.working_days
          : existing.working_days === null
            ? null
            : Number(existing.working_days),
      standard_working_days: dto.standard_working_days ?? existing.standard_working_days,
      base_salary: this.pickBigint(dto.base_salary, existing.base_salary),
      training_days:
        dto.training_days !== undefined
          ? dto.training_days
          : existing.training_days === null
            ? null
            : Number(existing.training_days),
      training_salary: this.pickBigint(dto.training_salary, existing.training_salary),
      probation_allowance: this.pickBigint(
        dto.probation_allowance,
        existing.probation_allowance,
      ),
      sales_personal: this.pickBigint(dto.sales_personal, existing.sales_personal),
      bonus_rate:
        dto.bonus_rate !== undefined
          ? dto.bonus_rate
          : existing.bonus_rate === null
            ? null
            : Number(existing.bonus_rate),
      kpi_percent:
        dto.kpi_percent !== undefined
          ? dto.kpi_percent
          : existing.kpi_percent === null
            ? null
            : Number(existing.kpi_percent),
      bonus_sales_personal: this.pickBigint(
        dto.bonus_sales_personal,
        existing.bonus_sales_personal,
      ),
      sales_team: this.pickBigint(dto.sales_team, existing.sales_team),
      bonus_cskh_team: this.pickBigint(dto.bonus_cskh_team, existing.bonus_cskh_team),
      bonus_milestone: this.pickBigint(dto.bonus_milestone, existing.bonus_milestone),
      bonus_referral: this.pickBigint(dto.bonus_referral, existing.bonus_referral),
      holiday_bonus: this.pickBigint(dto.holiday_bonus, existing.holiday_bonus),
      advances: this.pickBigint(dto.advances, existing.advances),
      personal_income_tax: this.pickBigint(dto.personal_income_tax, existing.personal_income_tax),
      notes: dto.notes !== undefined ? dto.notes : existing.notes,
    }
  }

  // Chọn giá trị BigInt: ưu tiên DTO (string số), fallback giá trị cũ.
  private pickBigint(
    dtoValue: string | null | undefined,
    current: bigint,
  ): bigint {
    if (dtoValue === undefined || dtoValue === null) return current
    return BigInt(dtoValue)
  }

  // =====================
  // Quản lý người trong kỳ lương (soft-delete theo tháng) — loại / thêm lại
  // =====================

  /**
   * Loại 1 nhân viên khỏi kỳ lương (theo tháng) bằng soft-delete `deleted_at`.
   * Phiếu ẩn khỏi danh sách + "Tạo phiếu lương" bỏ qua (xóa "dính"); khôi phục qua addToPeriod.
   * Phiếu đã DUYỆT/đã TRẢ chỉ người có `payroll.approve_final` (đóng vai trò
   * "bước 2" của luồng duyệt lương) được loại.
   */
  async removeFromPeriod(id: number, user: AuthUser) {
    const payslip = await this.prisma.payslip.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        deleted_at: true,
        month: true,
        employee_id: true,
      },
    })

    if (!payslip || payslip.deleted_at != null) {
      throw new NotFoundException(`Phiếu lương #${id} không tồn tại`)
    }

    if (
      (payslip.status === 'approved' || payslip.status === 'paid') &&
      !can(user.grants, 'payroll.approve_final')
    ) {
      throw new ForbiddenException(
        'Phiếu lương đã duyệt — chỉ người có quyền duyệt bước 2 được loại khỏi kỳ',
      )
    }

    await this.prisma.payslip.update({
      where: { id },
      data: { deleted_at: new Date(), deleted_by: user.userId },
    })

    return {
      id,
      month: payslip.month,
      employee_id: payslip.employee_id,
      message: 'Đã loại nhân viên khỏi kỳ lương này',
    }
  }

  /**
   * Thêm 1 nhân viên vào kỳ lương: khôi phục phiếu đã loại HOẶC tạo phiếu mới (đúng logic
   * "Tạo phiếu lương" cho 1 người). NV phải `status='active'`.
   */
  async addToPeriod(month: string, employeeId: number, user: AuthUser) {
    const [emp] = await this.fetchEmployees([employeeId])
    if (!emp) {
      throw new BadRequestException(
        'Nhân viên không tồn tại hoặc không ở trạng thái đang làm việc',
      )
    }

    const existing = await this.prisma.payslip.findUnique({
      where: { employee_id_month: { employee_id: employeeId, month } },
      select: { id: true, deleted_at: true },
    })

    if (existing) {
      if (existing.deleted_at === null) {
        throw new BadRequestException('Nhân viên đã có trong kỳ lương này')
      }
      // Khôi phục phiếu đã loại — giữ nguyên giá trị đã tính trước đó.
      await this.prisma.payslip.update({
        where: { id: existing.id },
        data: { deleted_at: null, deleted_by: null },
      })
      return this.findById(existing.id, user)
    }

    // Chưa có phiếu trong kỳ → tạo mới.
    await this.generateForEmployee(emp, month)
    const created = await this.prisma.payslip.findUnique({
      where: { employee_id_month: { employee_id: employeeId, month } },
      select: { id: true },
    })
    if (!created) {
      throw new BadRequestException('Không thể tạo phiếu lương cho nhân viên này')
    }
    return this.findById(created.id, user)
  }

  /**
   * Danh sách nhân viên CÓ THỂ thêm vào kỳ: `status='active'` + chưa có phiếu (chưa loại)
   * trong tháng. Route chỉ mở cho `payroll.manage` (unscoped) — không thu hẹp theo subtree.
   */
  async listAddableEmployees(month: string, _user: AuthUser) {
    const empWhere: Prisma.EmployeeWhereInput = { status: 'active' }

    const employees = await this.prisma.employee.findMany({
      where: empWhere,
      select: {
        id: true,
        employee_code: true,
        user_id: true,
        position: true,
        user: {
          select: {
            full_name: true,
            email: true,
            manager: { select: { id: true, full_name: true } },
          },
        },
        jobTitle: { select: { name: true } },
      },
    })

    // Phiếu chưa-loại trong kỳ → đã có người này → loại khỏi danh sách "thêm được".
    const existing = await this.prisma.payslip.findMany({
      where: { month, deleted_at: null },
      select: { employee_id: true },
    })
    const taken = new Set(existing.map((p) => p.employee_id))

    return employees
      .filter((e) => !taken.has(e.id))
      .map((e) => {
        const team = deriveTeam(e.user_id, e.user.full_name, e.user.manager)
        return {
          employee_id: e.id,
          employee_code: formatEmployeeCode(e.employee_code, e.id),
          user_id: e.user_id,
          full_name: e.user.full_name,
          email: e.user.email,
          job_title_name: e.jobTitle?.name ?? null,
          team_name: team.team_name,
          team_lead_id: team.team_lead_id,
        }
      })
      .sort((a, b) =>
        (a.full_name ?? '').localeCompare(b.full_name ?? '', 'vi'),
      )
  }

  // ─── Import Excel phiếu lương ───────────────────────────────────────────

  // Route chỉ mở cho `payroll.manage` (unscoped) — không thu hẹp theo subtree.
  async generateImportTemplate(month: string, _user: AuthUser): Promise<Buffer> {
    const employees = await this.prisma.employee.findMany({
      where: { status: 'active', deleted_at: null },
      select: {
        id: true,
        employee_code: true,
        user: { select: { full_name: true } },
      },
      orderBy: { user: { full_name: 'asc' } },
    })

    // Lấy phiếu lương tháng hiện tại (nếu có) để prefill giá trị
    const payslips = await this.prisma.payslip.findMany({
      where: { month, deleted_at: null, employee_id: { in: employees.map((e) => e.id) } },
      select: { ...payslipFieldsSelect, employee_id: true },
    })
    const payslipByEmpId = new Map(payslips.map((p) => [p.employee_id, p]))

    const templateEmployees: TemplateEmployee[] = employees.map((emp) => {
      const p = payslipByEmpId.get(emp.id)
      const current: Record<string, string | number | null | undefined> = p
        ? this.getPayslipFieldValues(p as unknown as PayslipRow)
        : {}
      return {
        employee_code: formatEmployeeCode(emp.employee_code, emp.id),
        full_name: emp.user.full_name,
        current,
      }
    })

    return buildImportTemplate(templateEmployees, month)
  }

  async previewImport(buffer: Buffer, month: string, user: AuthUser): Promise<ImportPreviewRow[]> {
    const rows = await parseImportFile(buffer)
    return this.processImportRows(rows, month, user, false)
  }

  async applyImport(buffer: Buffer, month: string, user: AuthUser): Promise<ImportPreviewRow[]> {
    const rows = await parseImportFile(buffer)
    return this.processImportRows(rows, month, user, true)
  }

  // Route chỉ mở cho `payroll.manage` (unscoped) — không thu hẹp theo subtree.
  private async processImportRows(
    rows: ImportRow[],
    month: string,
    _user: AuthUser,
    apply: boolean,
  ): Promise<ImportPreviewRow[]> {
    if (!rows.length) return []

    // Lấy tất cả nhân viên active có employee_code khớp. Select đủ field EmpForCompute
    // để có thể gọi assembleEngine/buildPayslipData như update() thủ công.
    const codes = [...new Set(rows.map((r) => r.employee_code))]
    const employees = await this.prisma.employee.findMany({
      where: { status: 'active', deleted_at: null },
      select: {
        id: true,
        user_id: true,
        salary_rule_id: true,
        position: true,
        job_title_id: true,
        insurance_salary: true,
        dependents_count: true,
        employee_code: true,
        user: { select: { full_name: true } },
        jobTitle: { select: { base_salary: true, rank_code: true, default_insurance_salary: true } },
      },
    })
    const empByCode = new Map(
      employees
        // Mẫu import ghi mã dự phòng NV<id> cho người chưa có employee_code (formatEmployeeCode) → khoá theo CÙNG hàm đó để khớp ngược lại.
        .map((e) => [formatEmployeeCode(e.employee_code, e.id), e] as const)
        .filter(([code]) => codes.includes(code)),
    )

    // Lấy phiếu lương tháng
    const payslips = await this.prisma.payslip.findMany({
      where: { month, deleted_at: null, employee_id: { in: employees.map((e) => e.id) } },
      select: { ...payslipFieldsSelect, employee_id: true },
    })
    const payslipByEmpId = new Map(payslips.map((p) => [p.employee_id, p]))

    // Tiêu đề cột nghịch đảo (field → header để hiển thị)
    const fieldToHeader: Record<string, string> = {}
    for (const [h, f] of Object.entries(HEADER_TO_FIELD)) {
      fieldToHeader[f] = h
    }

    const results: ImportPreviewRow[] = []
    // Gom mọi update để ghi trong 1 transaction (KHÔNG ghi dở dang giữa chừng).
    const pendingUpdates: Array<{ id: number; data: Awaited<ReturnType<PayslipsService['buildPayslipData']>> }> = []

    for (const row of rows) {
      const emp = empByCode.get(row.employee_code)
      if (!emp) {
        results.push({
          employee_code: row.employee_code,
          employee_name: row.employee_name,
          payslip_id: null,
          payslip_status: null,
          changes: [],
          skipped: true,
          skip_reason: 'Không tìm thấy nhân viên với mã này',
        })
        continue
      }

      const payslip = payslipByEmpId.get(emp.id)
      if (!payslip) {
        results.push({
          employee_code: row.employee_code,
          employee_name: emp.user.full_name,
          payslip_id: null,
          payslip_status: null,
          changes: [],
          skipped: true,
          skip_reason: 'Chưa có phiếu lương tháng này',
        })
        continue
      }

      const status = payslip.status as string
      if (status === 'approved' || status === 'paid') {
        results.push({
          employee_code: row.employee_code,
          employee_name: emp.user.full_name,
          payslip_id: payslip.id,
          payslip_status: status,
          changes: [],
          skipped: true,
          skip_reason: `Phiếu đã được duyệt (${status}) — không thể chỉnh sửa`,
        })
        continue
      }

      // field vượt biên Decimal (kpi_percent/bonus_rate...) bị chặn ngay lúc
      // parse Excel (payslip-import.helper.ts) thay vì để Prisma ném lỗi giữa transaction.
      if (row.fieldErrors && row.fieldErrors.length > 0) {
        results.push({
          employee_code: row.employee_code,
          employee_name: emp.user.full_name,
          payslip_id: payslip.id,
          payslip_status: status,
          changes: [],
          skipped: true,
          skip_reason: row.fieldErrors.join('; '),
        })
        continue
      }

      const currentValues = this.getPayslipFieldValues(payslip as unknown as PayslipRow)
      const changes: ImportPreviewRow['changes'] = []

      for (const [fieldName, newVal] of Object.entries(row.fields) as [string, unknown][]) {
        const header = fieldToHeader[fieldName] ?? fieldName
        const before = currentValues[fieldName] !== undefined ? String(currentValues[fieldName] ?? '') : null
        const after = String(newVal ?? '')
        if (before !== after) {
          changes.push({ header, field: fieldName, before, after })
        }
      }

      if (apply && changes.length > 0) {
        // đi qua ĐÚNG con đường tính toán như update() thủ công
        // merge field import lên phiếu hiện có rồi buildPayslipData() tính lại total/
        // base_salary_actual/deductions. KHÔNG ghi thẳng row.fields (raw) vào DB nữa.
        const engine = await this.assembleEngine(emp, month)
        const manual = this.mergeManualFields(row.fields, payslip as unknown as PayslipRow)
        const computed = await this.buildPayslipData(emp, month, engine, manual)
        pendingUpdates.push({ id: payslip.id, data: computed })
      }

      results.push({
        employee_code: row.employee_code,
        employee_name: emp.user.full_name,
        payslip_id: payslip.id,
        payslip_status: status,
        changes,
        skipped: false,
      })
    }

    // ghi tất cả phiếu trong 1 transaction — lỗi giữa chừng (vd Decimal
    // overflow lọt qua validate) ROLLBACK toàn bộ batch thay vì ghi dở dang.
    if (apply && pendingUpdates.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const u of pendingUpdates) {
          await tx.payslip.update({ where: { id: u.id }, data: { ...u.data, updated_at: new Date() } })
        }
      })
    }

    return results
  }

  private getPayslipFieldValues(
    p: PayslipRow,
  ): Record<string, string | number | null | undefined> {
    return {
      working_days: p.working_days !== null ? Number(p.working_days) : null,
      standard_working_days: p.standard_working_days,
      base_salary: p.base_salary.toString(),
      training_days: p.training_days !== null ? Number(p.training_days) : null,
      training_salary: p.training_salary.toString(),
      probation_allowance: p.probation_allowance.toString(),
      sales_personal: p.sales_personal.toString(),
      bonus_rate: p.bonus_rate !== null ? Number(p.bonus_rate) : null,
      kpi_percent: p.kpi_percent !== null ? Number(p.kpi_percent) : null,
      bonus_sales_personal: p.bonus_sales_personal.toString(),
      sales_team: p.sales_team.toString(),
      bonus_cskh_team: p.bonus_cskh_team.toString(),
      bonus_milestone: p.bonus_milestone.toString(),
      bonus_referral: p.bonus_referral.toString(),
      holiday_bonus: p.holiday_bonus.toString(),
      advances: p.advances.toString(),
      personal_income_tax: p.personal_income_tax.toString(),
      notes: p.notes,
    }
  }

  // ────────────────────────────────────────────────────────────────────────

  private async loadSalaryRuleDetails(salaryRuleId: number) {
    return this.prisma.salaryRuleDetail.findMany({
      where: { salary_rule_id: salaryRuleId },
      select: { component: true, amount: true, formula: true },
      orderBy: { order: 'asc' },
    })
  }

  private calculateKpiBonus(
    kpiResults: Array<{
      achievement_rate: Prisma.Decimal | null
      achieved: boolean
    }>,
  ): bigint {
    const achievedCount = kpiResults.filter((k) => k.achieved).length
    return BigInt(achievedCount * 500_000)
  }

  // =====================
  // Private: Approval helpers
  // =====================

  private async handleReject(
    payslip: PayslipWithEmployee,
    currentStatus: PayslipStatus,
    user: AuthUser,
  ): Promise<{ id: number; status: string; message: string }> {
    // Reject chỉ hợp lệ TỪ 1 bước đang chờ (pending_tl/pending_accountant)
    // draft/approved không phải trạng thái "đang chờ duyệt" nên rớt xuống 409
    // ở assertApprovalPermission (allowDraft=false).
    await this.assertApprovalPermission(currentStatus, user, payslip, false)

    return this.updatePayslipStatus(payslip.id, 'draft', {
      tl_approved_by: null,
      tl_approved_at: null,
      approved_by: null,
      approved_at: null,
    })
  }

  private async handleApprove(
    payslip: PayslipWithEmployee,
    currentStatus: PayslipStatus,
    user: AuthUser,
  ): Promise<{ id: number; status: string; message: string }> {
    const step = await this.assertApprovalPermission(currentStatus, user, payslip, true)

    // Chống tự duyệt: `payroll.approve_team`/`payroll.approve_final` scope theo
    // cây manager_id LUÔN gồm chính actor (own/team/subtree đều chứa self
    // ScopeService.team()/subtree()), nên assertInScope KHÔNG tự chặn được ca
    // này. Ở CẢ 2 bước, nhân viên của phiếu === người duyệt → chặn tường minh.
    if (payslip.employee.user_id === user.userId) {
      throw new ForbiddenException('Không thể tự duyệt phiếu lương của mình')
    }

    if (step === 'team') {
      return this.updatePayslipStatus(payslip.id, 'pending_accountant', {
        tl_approved_by: user.userId,
        tl_approved_at: new Date(),
      })
    }

    const result = await this.updatePayslipStatus(payslip.id, 'approved', {
      approved_by: user.userId,
      approved_at: new Date(),
    })
    await this.publishApprovedEvent(payslip, user.userId)
    return result
  }

  /**
   * Duyệt lương 2 bước = quyền + trạng thái ( ghi chú), không phải
   * tầng quyền ẩn: `pending_accountant` cần `payroll.approve_final` (không
   * scope — bất kỳ ai giữ quyền này đều duyệt được bước 2 của MỌI nhân viên);
   * `draft`/`pending_tl` cần `payroll.approve_team` VÀ nhân viên của phiếu
   * phải nằm trong phạm vi scope đó (`assertInScope` — ngoài phạm vi → 404,
   *). Trạng thái khác (hoặc `draft` khi gọi từ reject, `allowDraft=false`)
   * → 409 "không ở bước chờ duyệt".
   */
  private async assertApprovalPermission(
    currentStatus: PayslipStatus,
    user: AuthUser,
    payslip: PayslipWithEmployee,
    allowDraft: boolean,
  ): Promise<'team' | 'final'> {
    if (currentStatus === 'pending_accountant') {
      if (!can(user.grants, 'payroll.approve_final')) {
        throw new ForbiddenException('Chỉ người có quyền duyệt bước 2 được thao tác')
      }
      return 'final'
    }

    if (currentStatus === 'pending_tl' || (allowDraft && currentStatus === 'draft')) {
      if (!can(user.grants, 'payroll.approve_team')) {
        throw new ForbiddenException('Chỉ người có quyền duyệt bước 1 được thao tác')
      }
      await assertInScope(this.scope, user, 'payroll.approve_team', [payslip.employee.user_id])
      return 'team'
    }

    throw new ConflictException('Phiếu lương không ở bước chờ duyệt')
  }

  private async updatePayslipStatus(
    id: number,
    status: string,
    data: Record<string, unknown>,
  ): Promise<{ id: number; status: string; message: string }> {
    await this.prisma.payslip.update({
      where: { id },
      data: { status, ...data },
    })

    const messages: Record<string, string> = {
      draft: 'Phiếu lương đã bị từ chối, chuyển về nháp',
      pending_tl: 'Phiếu lương chờ Team Lead duyệt',
      pending_accountant: 'Team Lead đã duyệt, chờ Kế toán duyệt',
      approved: 'Phiếu lương đã được duyệt',
    }

    return { id, status, message: messages[status] ?? status }
  }

  /**
   * Thông báo "phiếu lương đã duyệt" IN-PROCESS qua port.
   * KHÔNG làm hỏng mutation duyệt nếu thông báo lỗi (phiếu đã duyệt xong, đó là
   * source of truth) — nhưng lỗi LUÔN log ERROR kèm id phiếu, không nuốt âm thầm.
   */
  private async publishApprovedEvent(
    payslip: PayslipWithEmployee,
    approvedByUserId: number,
  ): Promise<void> {
    if (!this.payslipNotifyPort) {
      this.logger.error(
        `PAYROLL_PAYSLIP_NOTIFY_PORT chưa được nối — nhân viên KHÔNG nhận thông báo phiếu #${payslip.id} (chạy ngoài monolith?)`,
      )
      return
    }

    try {
      await this.payslipNotifyPort.onPayslipApproved({
        payslipId: payslip.id,
        employeeId: payslip.employee_id,
        userId: payslip.employee.user_id,
        month: payslip.month,
        baseSalary: Number(payslip.base_salary),
        kpiBonus: Number(payslip.kpi_bonus),
        totalAmount: Number(payslip.total),
        approvedBy: approvedByUserId,
        approvedAt: new Date().toISOString(),
      })
      this.logger.log(`payslip.approved published for #${payslip.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(
        `Failed to publish payslip.approved for payslip #${payslip.id}: ${msg}`,
      )
    }
  }
}
