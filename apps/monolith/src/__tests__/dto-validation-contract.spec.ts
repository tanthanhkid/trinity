/**
 * Hợp đồng kiểm dữ liệu vào cho bản Rust (K15, docs/rust/PLAN.md 1.2, 6.1).
 *
 * Sinh ba tệp trong `server/contracts/dto/` từ chính metadata của class-validator/class-transformer và ValidationPipe
 * thật của Nest (cùng cấu hình `ServiceAwareValidationPipe`):
 * - `schema.json`: luật kiểm, @Type, @Transform, giá trị mặc định của các DTO mẫu và mọi DTO có @Transform;
 * - `validation.golden.json`: kết quả (body đã chuyển hoặc mảng câu lỗi 400) của bộ payload thử trên 20 DTO mẫu;
 * - `transform.golden.json`: kết quả từng @Transform trên bộ giá trị thử; `parse-int.golden.json`: ParseIntPipe.
 * Bản Rust (`trinity-http::validate`) đọc các tệp này và phải ra đúng kết quả.
 * Sinh lại: `UPDATE_GOLDEN=1 pnpm --filter @trinity/monolith exec jest src/__tests__/dto-validation-contract`.
 */
import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
import { BadRequestException, ParseIntPipe, ValidationPipe } from '@nestjs/common'
import { getMetadataStorage } from 'class-validator'
import { plainToInstance } from 'class-transformer'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage')

import * as createContact from '../../../../services/crm/src/contacts/dto/create-contact.dto'
import * as updateContact from '../../../../services/crm/src/contacts/dto/update-contact.dto'
import * as queryContact from '../../../../services/crm/src/contacts/dto/query-contact.dto'
import * as createProduct from '../../../../services/commerce/src/products/dto/create-product.dto'
import * as listProducts from '../../../../services/commerce/src/products/dto/list-products-query.dto'
import * as order from '../../../../services/commerce/src/pos/dto/order.dto'
import * as shiftCatalog from '../../../../services/commerce/src/pos/dto/shift-catalog.dto'
import * as createCard from '../../../../services/crm/src/kanban/cards/dto/create-card.dto'
import * as queryCards from '../../../../services/crm/src/kanban/cards/dto/query-cards.dto'
import * as createDeal from '../../../../services/crm/src/deals/dto/create-deal.dto'
import * as queryDeal from '../../../../services/crm/src/deals/dto/query-deal.dto'
import * as webhookEndpoint from '../../../../services/crm/src/integrations/webhooks/dto/webhook-endpoint.dto'
import * as queryDeliveries from '../../../../services/crm/src/integrations/webhooks/dto/query-deliveries.dto'
import * as queryAuditLogs from '../../../../services/crm/src/integrations/dto/query-audit-logs.dto'
import * as inboundPayload from '../../../../services/crm/src/integrations/webhooks/inbound/inbound-payload'
import * as inboundSource from '../../../../services/crm/src/integrations/webhooks/inbound/dto-inbound-source'
import * as attendanceStats from '../../../../services/crm/src/attendance/dto/query-attendance-stats.dto'
import * as createJobTitle from '../../../../services/crm/src/job-titles/dto/create-job-title.dto'
import * as queryJobTitles from '../../../../services/crm/src/job-titles/dto/query-job-titles.dto'
import * as createCandidate from '../../../../services/crm/src/recruitment/dto/create-candidate.dto'
import * as createRule from '../../../../services/payroll/src/salary-rules/dto/create-rule.dto'
import * as updateUser from '../../../../services/auth/src/users/dto/update-user.dto'
import * as customObject from '../../../../services/crm/src/custom-objects/dto/custom-object.dto'
import * as customField from '../../../../services/crm/src/custom-objects/dto/custom-field.dto'
import * as customRecord from '../../../../services/crm/src/custom-objects/dto/custom-record.dto'
import * as sendNotification from '../../../../services/notification/src/notifications/dto/send-notification.dto'
import * as createEmployee from '../../../../services/crm/src/employees/dto/create-employee.dto'
import * as updateEmployee from '../../../../services/crm/src/employees/dto/update-employee.dto'
import * as queryEmployees from '../../../../services/crm/src/employees/dto/query-employees.dto'
import * as createContract from '../../../../services/crm/src/contracts/dto/create-contract.dto'
import * as updateContract from '../../../../services/crm/src/contracts/dto/update-contract.dto'
import * as queryContracts from '../../../../services/crm/src/contracts/dto/query-contracts.dto'
import * as queryContractStats from '../../../../services/crm/src/contracts/dto/query-contract-stats.dto'
import * as office from '../../../../services/crm/src/attendance/dto/office.dto'
import * as attSettings from '../../../../services/crm/src/attendance/dto/update-attendance-settings.dto'
import * as attRequestConfig from '../../../../services/crm/src/attendance/dto/update-request-config.dto'
import * as attSaturdays from '../../../../services/crm/src/attendance/dto/update-working-saturdays.dto'
import * as employeesStats from '../../../../services/crm/src/employees/dto/employees-stats.dto'
import * as queryNotification from '../../../../services/notification/src/notifications/dto/query-notification.dto'
import * as publicCreateContact from '../../../../services/crm/src/public-api/dto/public-create-contact.dto'
import * as updateCandidate from '../../../../services/crm/src/recruitment/dto/update-candidate.dto'
import * as createPosition from '../../../../services/crm/src/recruitment/dto/create-position.dto'
import * as updatePosition from '../../../../services/crm/src/recruitment/dto/update-position.dto'
import * as queryCandidates from '../../../../services/crm/src/recruitment/dto/query-candidates.dto'
import * as queryPositions from '../../../../services/crm/src/recruitment/dto/query-positions.dto'
import * as publicWork from '../../../../services/crm/src/public-api/dto/public-work.dto'
import * as createOption from '../../../../services/crm/src/settings-options/dto/create-option.dto'
import * as queryOptions from '../../../../services/crm/src/settings-options/dto/query-options.dto'
import * as dashboardFilter from '../../../../services/crm/src/reports/dashboard-overview.filter'
import * as reportRange from '../../../../services/crm/src/reports/dto/query-report-range.dto'
import * as buildSystem from '../../../../services/crm/src/setup/setup-build.dto'
import * as wizardDto from '../../../../services/crm/src/onboarding/onboarding-wizard.dto'

type Cls = new () => object
type Mode = 'strict' | 'lenient'

const OUT = path.resolve(__dirname, '../../../../server/contracts/dto')

/** DTO mẫu và chế độ của route dùng nó (lenient: auth, payroll, notification — xem service-aware-validation.pipe.ts). */
const SAMPLES: Array<[Cls, Mode]> = [
  [createContact.CreateContactDto, 'strict'],
  [updateContact.UpdateContactDto, 'strict'],
  [queryContact.QueryContactDto, 'strict'],
  [createProduct.CreateProductDto, 'strict'],
  [order.CreateOrderDto, 'strict'],
  [shiftCatalog.UpdateSettingsDto, 'strict'],
  [createCard.CreateKanbanCardDto, 'strict'],
  [queryCards.QueryKanbanCardsDto, 'strict'],
  [createDeal.CreateDealDto, 'strict'],
  [queryDeal.QueryDealDto, 'strict'],
  [webhookEndpoint.CreateWebhookEndpointDto, 'strict'],
  [queryDeliveries.QueryWebhookDeliveriesDto, 'strict'],
  [attendanceStats.QueryAttendanceStatsDto, 'strict'],
  [createJobTitle.CreateJobTitleDto, 'strict'],
  [createCandidate.CreateCandidateDto, 'strict'],
  [createRule.CreateSalaryRuleDto, 'lenient'],
  [updateUser.UpdateUserDto, 'lenient'],
  [sendNotification.SendNotificationDto, 'lenient'],
  [publicCreateContact.PublicCreateContactDto, 'strict'],
  [publicWork.PublicCreateDealDto, 'strict'],
  [publicWork.PublicCreateTaskDto, 'strict'],
  [createOption.CreateOptionDto, 'strict'],
  [customObject.CreateCustomObjectDto, 'strict'],
  [customObject.UpdateCustomObjectDto, 'strict'],
  [customField.CreateCustomFieldDto, 'strict'],
  [customField.UpdateCustomFieldDto, 'strict'],
  [customField.ReorderCustomFieldsDto, 'strict'],
  [customField.FormulaPreviewDto, 'strict'],
  [customRecord.LookupQueryDto, 'strict'],
  // M12 (tuyển dụng)
  [updateCandidate.UpdateCandidateDto, 'strict'],
  [createPosition.CreatePositionDto, 'strict'],
  [updatePosition.UpdatePositionDto, 'strict'],
  [queryCandidates.QueryCandidatesDto, 'strict'],
  [queryCandidates.QueryRecruitmentStatsDto, 'strict'],
  [queryPositions.QueryPositionsDto, 'strict'],
  [createEmployee.CreateEmployeeDto, 'strict'],
  [updateEmployee.UpdateEmployeeDto, 'strict'],
  [queryEmployees.QueryEmployeesDto, 'strict'],
  [employeesStats.HrStatsQueryDto, 'strict'],
  [employeesStats.BirthdayListQueryDto, 'strict'],
  [office.CreateOfficeDto, 'strict'],
  [office.UpdateOfficeDto, 'strict'],
  [attSettings.UpdateAttendanceSettingsDto, 'strict'],
  [attRequestConfig.UpdateRequestConfigDto, 'strict'],
  [attSaturdays.UpdateWorkingSaturdaysDto, 'strict'],
  [createContract.CreateContractDto, 'strict'],
  [updateContract.UpdateContractDto, 'strict'],
  [queryContracts.QueryContractsDto, 'strict'],
  [queryContractStats.QueryContractStatsDto, 'strict'],
  [dashboardFilter.DashboardFilterQuery, 'strict'],
  [reportRange.QueryReportRangeDto, 'strict'],
  [customObject.ApplyTemplateDto, 'strict'],
  [buildSystem.BuildSystemDto, 'strict'],
  [wizardDto.WizardStepDto, 'strict'],
  [wizardDto.WizardConfigDto, 'strict'],
]

/** Mọi tệp có @Transform (đếm bằng grep trong services/): mỗi class trong đó vào schema và golden @Transform. */
const TRANSFORM_MODULES: Array<Record<string, unknown>> = [
  listProducts, shiftCatalog, order, queryNotification, attendanceStats, updateContact, createContact,
  publicCreateContact, publicWork, queryOptions, queryDeal, queryJobTitles, queryAuditLogs, webhookEndpoint, queryDeliveries,
  inboundPayload, inboundSource, queryCards, queryEmployees, employeesStats,
]

// ---------------------------------------------------------------------------------------------------------------
// Mã hoá giá trị JS (undefined, NaN, ±Infinity, RegExp, hàm) sang JSON.

function enc(v: unknown): unknown {
  if (v === undefined) return { $undefined: true }
  if (typeof v === 'number' && !Number.isFinite(v)) return { $number: String(v) }
  if (v instanceof RegExp) return { $regex: v.source, flags: v.flags }
  if (typeof v === 'function') return { $fn: String(v) }
  if (v instanceof Date) return { $date: v.toISOString() }
  if (Array.isArray(v)) return v.map(enc)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) o[k] = enc((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

// ---------------------------------------------------------------------------------------------------------------
// Schema

const transformTargets = (): Map<Function, Map<string, unknown[]>> => defaultMetadataStorage._transformMetadatas

function ancestors(cls: Function): Function[] {
  const out: Function[] = []
  let c = Object.getPrototypeOf(cls)
  while (c && c !== Function.prototype) {
    out.push(c)
    c = Object.getPrototypeOf(c)
  }
  return out
}

function transformProps(cls: Function): string[] {
  const props: string[] = []
  for (const t of [...ancestors(cls).reverse(), cls]) {
    for (const p of transformTargets().get(t)?.keys() ?? []) if (!props.includes(p)) props.push(p)
  }
  return props
}

function dumpClass(cls: Cls, out: Record<string, unknown>): string {
  const name = cls.name
  if (out[name]) return name
  out[name] = {} // chặn đệ quy
  const storage = getMetadataStorage()
  const metas = storage.getTargetValidationMetadatas(cls, '', true, false)
  const grouped: string[] = []
  const fields: Record<string, { rules: unknown[]; transforms?: unknown[]; type?: unknown }> = {}
  const field = (p: string) => (fields[p] ??= { rules: [] })
  for (const m of metas) {
    if (!grouped.includes(m.propertyName)) grouped.push(m.propertyName)
    const constraintName =
      m.type === 'customValidation' ? storage.getTargetValidatorConstraints(m.constraintCls)[0]?.name : undefined
    field(m.propertyName).rules.push({
      type: m.type,
      name: constraintName ?? m.name ?? null,
      constraints: enc(m.constraints ?? []),
      message: m.message === undefined ? null : enc(m.message),
      each: !!m.each,
    })
  }
  const extra = new Set<string>([...transformProps(cls)])
  for (const p of grouped) extra.add(p)
  for (const p of extra) {
    const tm = defaultMetadataStorage.findTransformMetadatas(cls, p, 0 /* PLAIN_TO_CLASS */) as Array<{ transformFn: Function; options: unknown }>
    if (tm.length) field(p).transforms = tm.map((t) => ({ fn: String(t.transformFn), options: enc(t.options ?? {}) }))
    const type = defaultMetadataStorage.findTypeMetadata(cls, p) as { typeFunction: () => Function } | undefined
    if (type) {
      const t = type.typeFunction() as Cls
      const builtin = [Number, String, Boolean, Object, Date, Array].find((b) => b === (t as unknown))
      field(p).type = builtin ? builtin.name : { dto: dumpClass(t, out) }
    }
  }
  const inst = new cls() as Record<string, unknown>
  const defaults: Record<string, unknown> = {}
  for (const k of Object.keys(inst)) if (inst[k] !== undefined) defaults[k] = enc(inst[k])
  out[name] = { declared: Object.keys(inst), validated: grouped, fields, defaults }
  return name
}

function isClass(v: unknown): v is Cls {
  return typeof v === 'function' && /^class\s/.test(Function.prototype.toString.call(v))
}

// ---------------------------------------------------------------------------------------------------------------
// Golden

/** Bộ giá trị thử đặt vào MỌI trường của DTO (cùng lúc), cộng `{}` và trường lạ. */
const FIELD_PROBES: Array<[string, unknown]> = [
  ['null', null],
  ['empty', ''],
  ['spaces', '  x  '],
  ['float', 12.5],
  ['negative', -1],
  ['zero', 0],
  ['true', true],
  ['mixed_array', ['a', 1]],
  ['object', { a: 1 }],
  ['long', 'x'.repeat(300)],
  ['iso_date', '2026-11-26T10:00:00Z'],
  ['digits', '123'],
  ['email', 'a@example.com'],
  ['objects_array', [{}, { __la__: 1 }]],
]

/** Payload viết tay: ca hợp lệ (body sau khi chuyển), lỗi lồng, câu tiếng Việt. */
const EXTRA_CASES: Array<[Cls, Mode, string, unknown]> = [
  [createEmployee.CreateEmployeeDto, 'strict', 'valid', { email: 'nv@example.vn', full_name: 'Nguyễn Văn A', phone: '+84901234567', team_id: '3', insurance_salary: '5000000', gender: 'M', birth_date: '1990-05-17', joined_at: '2026-01-02' }],
  [createEmployee.CreateEmployeeDto, 'strict', 'sai_tieng_viet', { email: 'khong-email', full_name: 'A', password: '123', phone: '0123', status: 'nghi', gender: 'X', avatar_url: 5 }],
  [createEmployee.CreateEmployeeDto, 'strict', 'rong_birth_date', { email: 'nv@example.vn', full_name: 'Trần B', birth_date: '', id_card_issued_date: null }],
  [updateEmployee.UpdateEmployeeDto, 'strict', 'null_het', { manager_id: null, insurance_salary: null, birth_date: null, avatar_url: null, department: null, full_name: null, status: null }],
  [updateEmployee.UpdateEmployeeDto, 'strict', 'valid', { full_name: ' Lê C ', manager_id: '4', status: 'resigned', birth_date: '', id_card_number: '0123456789' }],
  [queryEmployees.QueryEmployeesDto, 'strict', 'valid', { page: '2', page_size: '50', search: 'minh', employment_state: 'active', sort_by: 'joined_at', sort_dir: 'desc', team: 'none' }],
  [queryEmployees.QueryEmployeesDto, 'strict', 'sai', { page: '0', page_size: '101', employment_state: 'x', sort_by: 'email', sort_dir: 'up' }],
  [employeesStats.BirthdayListQueryDto, 'strict', 'thang_sai', { month: '13', office_id: 'a' }],
  [office.CreateOfficeDto, 'strict', 'valid', { name: 'VP Hà Nội', description: 'Trụ sở', ips: ['203.0.113.1'], is_active: true, is_demo: false }],
  [office.CreateOfficeDto, 'strict', 'sai', { name: '', ips: [], is_active: 'x', is_demo: null, description: 5 }],
  [office.CreateOfficeDto, 'strict', 'ips_khong_phai_chuoi', { name: 'A', ips: [1, 2] }],
  [office.UpdateOfficeDto, 'strict', 'valid', { description: null, ips: ['1.2.3.4'], is_active: false }],
  [office.UpdateOfficeDto, 'strict', 'null_het', { name: null, ips: null, is_active: null, is_demo: null }],
  [attSettings.UpdateAttendanceSettingsDto, 'strict', 'valid', { work_start: '08:00', work_end: '17:00', late_after: '08:10', lunch_start: '12:00', lunch_end: '13:30', review_max_hours: '1', half_day_min_hours: 4.5, full_day_min_hours: 8 }],
  [attSettings.UpdateAttendanceSettingsDto, 'strict', 'sai', { work_start: '8:00', work_end: '24:00', late_after: 5, review_max_hours: -1, half_day_min_hours: 25, full_day_min_hours: 'x' }],
  [attRequestConfig.UpdateRequestConfigDto, 'strict', 'valid', { default_check_in: '08:00', default_check_out: '17:30', monthly_forgot_limit: '2', monthly_late_early_limit: 0 }],
  [attRequestConfig.UpdateRequestConfigDto, 'strict', 'sai', { default_check_in: '8h', default_check_out: null, monthly_forgot_limit: -1, monthly_late_early_limit: 1.5 }],
  [attSaturdays.UpdateWorkingSaturdaysDto, 'strict', 'valid', { dates: ['2026-06-06', '2026-06-20'] }],
  [attSaturdays.UpdateWorkingSaturdaysDto, 'strict', 'sai', { dates: ['06/06/2026', 5, '2026-06-6'] }],
  [attSaturdays.UpdateWorkingSaturdaysDto, 'strict', 'khong_phai_mang', { dates: '2026-06-06' }],
  [createContract.CreateContractDto, 'strict', 'valid', { employee_id: 12, contract_type: 'hdld_2', signed_date: '2026-01-01', end_date: '2028-01-01', notes: 'ghi chú', is_terminated: false }],
  [createContract.CreateContractDto, 'strict', 'sai', { employee_id: 0, contract_type: 'khac', signed_date: 'hôm qua', end_date: 5, notes: 7, is_terminated: 'x' }],
  [createContract.CreateContractDto, 'strict', 'end_null', { employee_id: 1, signed_date: '2026-01-01', end_date: null, file_url: null, notes: null }],
  [updateContract.UpdateContractDto, 'strict', 'valid', { contract_type: 'hdld_vo_thoi_han', signed_date: '2026-02-02', end_date: null, is_terminated: true }],
  [updateContract.UpdateContractDto, 'strict', 'null_het', { contract_type: null, signed_date: null, is_terminated: null, notes: null }],
  [queryContracts.QueryContractsDto, 'strict', 'valid', { page: '2', page_size: '50', search: 'an', status: 'expiring', contract_type: 'hdld_1', employment_status: 'working', team: '3', sort_by: 'end_date', sort_dir: 'desc' }],
  [queryContracts.QueryContractsDto, 'strict', 'sai', { page: '0', page_size: '201', status: 'x', contract_type: 'y', employment_status: 'z', sort_by: 'email', sort_dir: 'up' }],
  [queryContractStats.QueryContractStatsDto, 'strict', 'valid', { date_from: '2026-01-01', date_to: '2026-12-31', department: 'KD', team: '3', employment_status: 'resigned' }],
  [queryContractStats.QueryContractStatsDto, 'strict', 'sai', { date_from: 'x', employment_status: 'nghi' }],
  [createDeal.CreateDealDto, 'strict', 'valid', { title: ' Hợp đồng A ', assigned_to: 3, value: 1500000, status: 'open' }],
  [createDeal.CreateDealDto, 'strict', 'status_sai', { title: 'A', assigned_to: 3, status: 'pending' }],
  [queryContact.QueryContactDto, 'strict', 'valid_query', { page: '2', limit: '50', search: 'An', sort_order: 'desc', created_from: '2026-01-01' }],
  [queryContact.QueryContactDto, 'strict', 'query_so_sai', { page: '0', limit: '500', team_id: 'abc', stage_id: '1.5' }],
  [order.CreateOrderDto, 'strict', 'valid', { items: [{ product_id: 1, quantity: 2, modifier_ids: [3, 4], note: ' ít đá ' }], order_type: 'takeaway' }],
  [order.CreateOrderDto, 'strict', 'item_loi', { items: [{ product_id: 0, quantity: 1000, modifier_ids: [0, 'x'], extra: 1 }, 5, null], discount_type: 'percent' }],
  [order.CreateOrderDto, 'strict', 'items_rong', { items: [] }],
  [order.CreateOrderDto, 'strict', 'items_khong_phai_mang', { items: { product_id: 1, quantity: 1 } }],
  [createRule.CreateSalaryRuleDto, 'lenient', 'valid_strip', { position: 'sale', name: 'Lương sale', details: [{ component: 'base', amount: '8000000', la: 1 }], la: 2 }],
  [createRule.CreateSalaryRuleDto, 'strict', 'detail_la', { position: 'sale', name: 'X', details: [{ component: 'bonus', amount: '8.000.000', la: 1 }] }],
  [updateUser.UpdateUserDto, 'lenient', 'valid', { full_name: 'Nguyễn Văn A', phone: '+84901234567', status: 'locked', role: 'admin' }],
  [updateUser.UpdateUserDto, 'lenient', 'phone_sai', { phone: '0123', email: 'không-phải-email' }],
  [createContact.CreateContactDto, 'strict', 'valid', { phone: '0901234567', full_name: '  Trần Thị B ', source_id: '2', email: 'b@example.vn', gender: 'nu', birthday: '1990-05-01' }],
  [createContact.CreateContactDto, 'strict', 'sai_tieng_viet', { phone: '12345', full_name: '', source_id: 'x', gender: 'khac', deal_assigned_to: '-1' }],
  [attendanceStats.QueryAttendanceStatsDto, 'strict', 'csv', { department: ' A , ,B', team_id: '1,x, 2', office_id: ['3', '4'], date_from: '2026-11-01' }],
  [webhookEndpoint.CreateWebhookEndpointDto, 'strict', 'url', { url: 'ftp://example.com/hook', events: ['contact.created', 'không-có'] }],
  [webhookEndpoint.CreateWebhookEndpointDto, 'strict', 'url_ok', { url: 'https://hooks.example.com/in?x=1', events: ['contact.created'] }],
  [sendNotification.SendNotificationDto, 'lenient', 'enum', { channel: 'sms', user_ids: [1, 1] }],
  [customObject.CreateCustomObjectDto, 'strict', 'valid', { key: 'khach_hang', label: ' Khách ', label_plural: 'Khách', icon: 'users', show_in_nav: true, nav_order: 3, visible_role_ids: [1, 2], code_prefix: 'kh' }],
  [customObject.CreateCustomObjectDto, 'strict', 'sai', { key: 'Khach', label: '', label_plural: 5, show_in_nav: 'x', nav_order: -1, visible_role_ids: [0, 'a'], code_prefix: 'k', la: 1 }],
  [customObject.UpdateCustomObjectDto, 'strict', 'valid', { label: 'Mới', is_active: false, icon: null, description: null }],
  [customObject.UpdateCustomObjectDto, 'strict', 'sai', { label: null, nav_order: 1.5, visible_role_ids: 'x', key: 'khong-sua-duoc' }],
  [customField.CreateCustomFieldDto, 'strict', 'valid', { label: 'Giá', type: 'currency', required: true, options: { decimals: 0 }, help_text: 'VND' }],
  [customField.CreateCustomFieldDto, 'strict', 'sai', { key: 'A b', label: '', type: 'khac', required: 'x', options: [], help_text: 5 }],
  [customField.UpdateCustomFieldDto, 'strict', 'valid', { label: 'Tên', type: 'text', is_title: true, options: {}, help_text: null }],
  [customField.UpdateCustomFieldDto, 'strict', 'sai', { label: null, type: 'x', options: 'o', key: 'khong' }],
  [customField.ReorderCustomFieldsDto, 'strict', 'valid', { keys: ['a', 'b'] }],
  [customField.ReorderCustomFieldsDto, 'strict', 'sai', { keys: [] }],
  [customField.ReorderCustomFieldsDto, 'strict', 'sai_kieu', { keys: [1, 'a'] }],
  [customField.FormulaPreviewDto, 'strict', 'valid', { object_key: 'don_hang', expression: '{gia}*2', sample: { gia: 5 }, editing_key: 'tong' }],
  [customField.FormulaPreviewDto, 'strict', 'sai', { object_key: 'Don Hang', expression: 5, sample: 'x', editing_key: 1 }],
  [customRecord.LookupQueryDto, 'strict', 'valid_query', { q: 'an', limit: '20', for: 'manage' }],
  [customRecord.LookupQueryDto, 'strict', 'query_sai', { q: 'a\u0000', limit: '500', for: 'all', x: '1' }],
  [dashboardFilter.DashboardFilterQuery, 'strict', 'valid_query', { dept_head_id: '3', team_lead_id: '4', user_id: '5' }],
  [dashboardFilter.DashboardFilterQuery, 'strict', 'query_sai', { dept_head_id: '0', team_lead_id: 'abc', user_id: '1.5', x: '1' }],
  [reportRange.QueryReportRangeDto, 'strict', 'valid_query', { date_from: '2026-09-01', date_to: '2026-09-26' }],
  [reportRange.QueryReportRangeDto, 'strict', 'query_sai', { date_from: '01/09/2026', date_to: '' }],
  [reportRange.QueryReportRangeDto, 'strict', 'thieu', {}],
  [customObject.ApplyTemplateDto, 'strict', 'valid', { with_sample_data: true }],
  [customObject.ApplyTemplateDto, 'strict', 'sai', { with_sample_data: 'yes', x: 1 }],
  [buildSystem.BuildSystemDto, 'strict', 'valid', { industry: 'clinic', features: ['inbox', 'pos'] }],
  [buildSystem.BuildSystemDto, 'strict', 'sai', { industry: 'khac', features: ['a', 1, null] }],
  [buildSystem.BuildSystemDto, 'strict', 'features_qua_nhieu', { industry: 'other', features: Array.from({ length: 40 }, (_, i) => `f${i}`) }],
  [buildSystem.BuildSystemDto, 'strict', 'thieu', {}],
  [wizardDto.WizardStepDto, 'strict', 'valid', { step: 'modules' }],
  [wizardDto.WizardStepDto, 'strict', 'sai', { step: 'khac' }],
  [wizardDto.WizardConfigDto, 'strict', 'valid', { enabled: false, skippable: ['data', 'post'], exempt_before: '2026-11-01T00:00:00Z' }],
  [wizardDto.WizardConfigDto, 'strict', 'null_exempt', { exempt_before: null }],
  [wizardDto.WizardConfigDto, 'strict', 'sai', { enabled: 'x', skippable: ['a', 1], exempt_before: 'hôm qua', y: 1 }],
  // Body là mảng JSON: Nest kiểm mảng như một đối tượng của DTO (khoá là chỉ số)
  [createContact.CreateContactDto, 'strict', 'array_body', [{ phone: '0901234567', full_name: 'A' }]],
  [createContact.CreateContactDto, 'strict', 'array_body_empty', []],
  [createContact.CreateContactDto, 'lenient', 'array_body', [{ phone: '0901234567', full_name: 'A' }, 5]],
  [sendNotification.SendNotificationDto, 'lenient', 'array_body', [{ channel: 'sms' }]],
  [sendNotification.SendNotificationDto, 'strict', 'array_body', [1, 2]],
]

function fieldNames(schema: Record<string, any>, name: string): string[] {
  return schema[name].validated as string[]
}

async function runPipe(cls: Cls, mode: Mode, payload: unknown): Promise<unknown> {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: mode === 'strict', transform: true })
  try {
    const out = await pipe.transform(JSON.parse(JSON.stringify(payload)), { type: 'body', metatype: cls, data: '' })
    return { ok: JSON.parse(JSON.stringify(out)) }
  } catch (e) {
    if (!(e instanceof BadRequestException)) throw e
    return { status: 400, message: (e.getResponse() as { message: unknown }).message }
  }
}

const TRANSFORM_PROBES: unknown[] = [
  undefined, null, '', '  a b  ', '5', ' 7 ', '-3', '3.7', '0x1A', 'abc', '1,2,x', ' 1 , 2 ', 'true', 'false',
  ['1', '2'], ['x', 3], 3, 3.7, 0, true, false, { a: 1 },
]

async function parseIntCase(v: string): Promise<unknown> {
  try {
    return { ok: await new ParseIntPipe().transform(v, { type: 'param', data: 'id' }) }
  } catch (e) {
    return { status: 400, message: (e as BadRequestException).message }
  }
}

function writeOrCompare(file: string, data: unknown) {
  const p = path.join(OUT, file)
  const text = JSON.stringify(data, null, 1) + '\n'
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(p, text)
  expect(JSON.parse(text)).toEqual(JSON.parse(fs.readFileSync(p, 'utf8')))
}

describe('hợp đồng kiểm dữ liệu vào cho bản Rust', () => {
  const schema: Record<string, any> = {}
  const transformClasses: Cls[] = []
  for (const [cls] of SAMPLES) dumpClass(cls, schema)
  for (const mod of TRANSFORM_MODULES) {
    for (const v of Object.values(mod)) {
      if (isClass(v) && transformProps(v).length) {
        transformClasses.push(v)
        dumpClass(v, schema)
      }
    }
  }

  it('schema.json khớp metadata', () => {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(schema).sort()) sorted[k] = schema[k]
    writeOrCompare('schema.json', sorted)
  })

  it('validation.golden.json khớp ValidationPipe', async () => {
    const cases: unknown[] = []
    for (const [cls, mode] of SAMPLES) {
      const names = fieldNames(schema, cls.name)
      const all = (v: unknown) => Object.fromEntries(names.map((n) => [n, v]))
      cases.push({ dto: cls.name, mode, probe: 'empty_object', input: {}, result: await runPipe(cls, mode, {}) })
      for (const [probe, v] of FIELD_PROBES) {
        const input = all(v)
        cases.push({ dto: cls.name, mode, probe, input, result: await runPipe(cls, mode, input) })
      }
      for (const m of ['strict', 'lenient'] as Mode[]) {
        const input = { __la__: 1, [names[0]]: 'x' }
        cases.push({ dto: cls.name, mode: m, probe: 'unknown_field', input, result: await runPipe(cls, m, input) })
      }
    }
    for (const [cls, mode, probe, input] of EXTRA_CASES) {
      cases.push({ dto: cls.name, mode, probe, input, result: await runPipe(cls, mode, input) })
    }
    writeOrCompare('validation.golden.json', cases)
  })

  it('transform.golden.json khớp từng @Transform', () => {
    const cases: unknown[] = []
    for (const cls of transformClasses) {
      for (const prop of transformProps(cls)) {
        for (const v of TRANSFORM_PROBES) {
          const inst = plainToInstance(cls, v === undefined ? {} : { [prop]: v }) as Record<string, unknown>
          cases.push({ dto: cls.name, prop, input: enc(v), output: enc(inst[prop]) })
        }
      }
    }
    writeOrCompare('transform.golden.json', cases)
  })

  it('parse-int.golden.json khớp ParseIntPipe', async () => {
    const cases: unknown[] = []
    for (const v of ['12', '-3', '0', '007', '1.5', 'abc', '', ' 1', '1 ', '1e3', '+5', '0x10', '9007199254740991']) {
      cases.push({ input: v, result: await parseIntCase(v) })
    }
    writeOrCompare('parse-int.golden.json', cases)
  })
})
