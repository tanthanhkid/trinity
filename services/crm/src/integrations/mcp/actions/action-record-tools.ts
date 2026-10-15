import { BadRequestException, NotFoundException } from '@nestjs/common';
import { assertInScope, maskPhone, type AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject, type ObjectDef } from '../../../custom-objects/custom-object-access';
import type { FieldDef, RecordData } from '../../../custom-objects/field-types';
import { titleOf } from '../../../custom-objects/record-events';
import type { ValidatedRecord } from '../../../custom-objects/record-validator.service';
import { optInt, type Z } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef, type DetailLine } from './action-types';
import { cleanText, line, lines, renamed, shown } from './action-helpers';
import { executeCoreCreate, executeCoreUpdate, prepareCoreCreate, prepareCoreUpdate } from './action-core-records';
import { isCoreKey, requirePerm } from '../tools/core-records';
import { idFromCode } from '../tools/code-tools';
import { RefResolver } from './ref-resolver';

const MAX_VALUES_KEYS = 60;
const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
const ID = (z: Z) => z.number().int().min(1).max(2_147_483_647);

const objectArg = (z: Z) => z.string().min(1).max(48).describe('Khoá bảng (lấy từ describe_schema, vd "don_hang") / Table key from describe_schema');
const ownerArg = (z: Z) => z.number().int().min(1).max(2_147_483_647).optional().describe('(Bảng tuỳ biến) giao cho nhân viên này phụ trách — id người dùng trong phạm vi của bạn (từ list_crm_options); bỏ trống = chính bạn / Owner user id');
const valuesArg = (z: Z) => z.record(z.string(), z.unknown()).describe('{khoá_trường: giá trị} theo describe_schema: select = value của lựa chọn, multi_select = mảng value, relation = id (số) / MÃ ("SP001") / khoá nghiệp vụ {"ma_kh":"C001"} (hoặc mảng), user = id, link = mảng MÃ ["SP001","KH002"], long_text gắn thẻ bằng @MÃ, date = YYYY-MM-DD, boolean = true/false. Trường công thức không nhập được / Field values keyed by field key');

/** Liên kết theo mã / khoá nghiệp vụ → id (cùng cơ chế với import_records). */
async function resolveLinks(deps: ActionDeps, user: AuthUser, def: ObjectDef, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resolver = new RefResolver(deps, user);
  await resolver.prime(def, [values]);
  const r = resolver.resolveRow(def, values);
  if (r.error) throw new ActionUserError(`Liên kết không hợp lệ — ${r.error}`);
  return r.row;
}

/** Lấy khoá bảng + values từ tham số AI; values phải là object thường, không chứa NUL, không quá nhiều khoá. */
function parseArgs(args: Record<string, unknown>): { key: string; values: Record<string, unknown>; owner?: number } {
  const key = cleanText(args.object, 48);
  if (!KEY_RE.test(key)) throw new ActionUserError('object phải là khoá bảng (a-z, 0-9, _) — hãy gọi describe_schema để lấy đúng khoá.');
  const v = args.values;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ActionUserError('values phải là object {khoá_trường: giá trị}.');
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > MAX_VALUES_KEYS) throw new ActionUserError(`values cần 1-${MAX_VALUES_KEYS} trường.`);
  if (JSON.stringify(v).includes('\\u0000')) throw new ActionUserError('values chứa ký tự không hợp lệ.');
  return { key, values: v as Record<string, unknown>, owner: optInt(args.owner_id) };
}

/** Bảng AI nhắm tới: ngoài tầm nhìn/không tồn tại ⇒ cùng một thông báo (không lộ bảng bị ẩn). */
async function loadDef(deps: ActionDeps, user: AuthUser, key: string): Promise<ObjectDef> {
  try {
    return await loadVisibleObject(deps.prisma, user, key);
  } catch (e) {
    if (e instanceof NotFoundException) throw new ActionUserError(`Không có bảng “${key}” (hoặc bạn không được thấy). Hãy gọi describe_schema để lấy danh sách bảng.`);
    throw e;
  }
}

/** Lỗi validator (400 kèm `errors` theo trường) → thông báo AI đọc được để sửa lại. */
export async function validateOrExplain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof BadRequestException)) throw e;
    const r = e.getResponse() as { message?: string; errors?: Record<string, string> };
    const detail = r.errors ? Object.entries(r.errors).map(([k, m]) => `${k.slice(0, 40)}: ${m}`).join('; ') : (r.message ?? e.message);
    throw new ActionUserError(`Dữ liệu không hợp lệ — ${detail}`.slice(0, 1500));
  }
}

function showValue(f: FieldDef, v: unknown): string {
  if (v === undefined || v === null) return '(trống)';
  if (f.type === 'phone') return maskPhone(String(v)) ?? '***';
  const label = (x: unknown): string => f.options.choices?.find((c) => c.value === x)?.label ?? String(x);
  if (f.type === 'select') return label(v);
  if (Array.isArray(v)) return v.map((x) => (f.type === 'multi_select' ? label(x) : `#${String(x)}`)).join(', ');
  if (f.type === 'relation' || f.type === 'user') return `#${String(v)}`;
  if (typeof v === 'boolean') return v ? 'Có' : 'Không';
  return String(v);
}

function fieldLines(def: ObjectDef, data: RecordData, only: string[], before?: RecordData): DetailLine[] {
  return lines(...only.map((k) => {
    const f = def.fields.find((x) => x.key === k);
    if (!f) return null;
    const now = showValue(f, data[k]);
    return line(f.label, before ? `${showValue(f, before[k])} → ${now}` : now, 600);
  }));
}

/** Giao cho người khác: phải nằm trong phạm vi SỬA của người dùng (báo lỗi sớm; service kiểm lại lúc ghi). */
async function assertOwnerOk(deps: ActionDeps, user: AuthUser, owner?: number): Promise<void> {
  if (!owner || owner === user.userId) return;
  const o = await deps.scope.ownerIds(user, 'custom_records.manage');
  if (o === null || (o !== 'all' && !o.includes(owner))) throw new ActionUserError('Không giao được cho người này (ngoài phạm vi của bạn). Xem list_crm_options.');
}

const asData = (v: unknown): RecordData => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordData) : {});

export const createRecordAction: ActionToolDef = {
  name: 'create_record',
  label: 'Tạo bản ghi',
  title: 'Tạo bản ghi / Create a record',
  description:
    'Tạo một bản ghi mới trong MỘT BẢNG: bảng tuỳ biến, hoặc bảng lõi contacts (khách hàng) | deals (thương vụ) | tasks (việc). HÃY GỌI describe_schema TRƯỚC để biết khoá bảng, khoá trường, kiểu, trường bắt buộc và giá trị hợp lệ của select. ' +
    'Chạy ngay, kiểm dữ liệu trước khi ghi (sai kiểu/thiếu trường bắt buộc sẽ báo lỗi). Mặc định người phụ trách là chính người dùng (bảng tuỳ biến có thể truyền owner_id cho cấp dưới). / ' +
    'Creates a record in a table (custom or core: contacts, deals, tasks) immediately; call describe_schema first. Validated before writing.',
  permissions: [],
  destructive: false,
  idempotent: false,
  input: (z) => ({ object: objectArg(z), values: valuesArg(z), owner_id: ownerArg(z) }),
  async prepare(args, ctx) {
    const { deps, user } = ctx;
    const { key, values, owner } = parseArgs(args);
    if (isCoreKey(key)) return prepareCoreCreate(key, values, ctx);
    requirePerm(user, 'custom_records.view');
    requirePerm(user, 'custom_records.manage');
    await assertOwnerOk(deps, user, owner);
    const def = await loadDef(deps, user, key);
    const resolved = await resolveLinks(deps, user, def, values);
    const v: ValidatedRecord = await validateOrExplain(async () => {
      const r = await deps.validator.validate(def, user, resolved, null);
      await deps.validator.assertUnique(deps.prisma, def, r.data, r.changed, null);
      return r;
    });
    const title = titleOf(def, v.data);
    return {
      params: { object: key, values: resolved, ...(owner ? { owner_id: owner } : {}) },
      summary: shown(`Tạo ${def.obj.label}${title ? ` "${title}"` : ''} (bảng ${def.obj.label_plural})`),
      details: lines(line('Bảng', def.obj.label_plural), line('Người phụ trách', owner ? `#${owner}` : 'Bạn'), ...fieldLines(def, v.data, Object.keys(v.data))),
    };
  },
  async execute(params, ctx, draftId) {
    const { deps, user } = ctx;
    const key = String(params.object);
    if (isCoreKey(key)) return executeCoreCreate(key, params, ctx, draftId);
    requirePerm(user, 'custom_records.manage');
    const res = await deps.records.create(user, key, { data: asData(params.values), owner_id: optInt(params.owner_id) });
    return { record_id: res.id, object: key };
  },
};

export const updateRecordAction: ActionToolDef = {
  name: 'update_record',
  label: 'Sửa bản ghi',
  title: 'Sửa bản ghi / Update a record',
  description:
    'Sửa một bản ghi (id số, hoặc code = mã chung như SP001) của một bảng (tuỳ biến, hoặc lõi contacts | deals | tasks): chỉ gửi những trường cần đổi trong values (giá trị null = xoá giá trị trường). HÃY GỌI describe_schema TRƯỚC, và get_record để biết giá trị hiện tại. ' +
    'Sửa ngay (kiểm dữ liệu + quyền trước khi ghi); hỏi người dùng trước khi sửa hàng loạt. Không đổi được cấu trúc bảng (dùng các tool cấu trúc, chỉ admin); xoá bản ghi tuỳ biến dùng archive_record. / ' +
    'Updates one record of a table (custom or core) immediately; send only the fields to change.',
  permissions: [],
  destructive: true,
  idempotent: true,
  input: (z) => ({
    object: objectArg(z), id: ID(z).optional().describe('ID bản ghi / Record id'), code: z.string().min(2).max(20).optional().describe('HOẶC mã chung, vd SP001 / Record code'),
    values: valuesArg(z), owner_id: ownerArg(z),
  }),
  async prepare(args, ctx) {
    const { deps, user } = ctx;
    const { key, values: raw, owner } = parseArgs(args);
    const byCode = args.code ? await idFromCode(deps, user, args.code, key) : null;
    const rawId = optInt(args.id);
    if (byCode && rawId && rawId !== byCode.id) throw new ActionUserError(`id ${rawId} và code ${String(args.code).trim().toUpperCase()} (bản ghi #${byCode.id}) không cùng một bản ghi — chỉ gửi một trong hai.`);
    const id = byCode?.id ?? rawId;
    if (!id) throw new ActionUserError('Cần id (số nguyên dương) hoặc code (mã bản ghi, vd SP001).');
    const values = isCoreKey(key) ? raw : await resolveLinks(deps, user, await loadDef(deps, user, key), raw);
    if (isCoreKey(key)) return prepareCoreUpdate(key, id, values, ctx);
    requirePerm(user, 'custom_records.view');
    requirePerm(user, 'custom_records.manage');
    await assertOwnerOk(deps, user, owner);
    const def = await loadDef(deps, user, key);
    const gone = new ActionUserError('Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn.');
    const row = await deps.prisma.customRecord.findFirst({ where: { id, object_id: def.obj.id, deleted_at: null } });
    if (!row) throw gone;
    // Phạm vi SỬA + phạm vi XEM (tiêu đề/giá trị cũ đi vào bản nháp trả cho AI — AI không được biết hơn tool đọc cho phép).
    try {
      await assertInScope(deps.scope, user, 'custom_records.manage', [row.owner_id, row.created_by]);
      await assertInScope(deps.scope, user, 'custom_records.view', [row.owner_id, row.created_by]);
    } catch {
      throw gone;
    }
    const before = asData(row.data);
    const v = await validateOrExplain(async () => {
      const r = await deps.validator.validate(def, user, values, before);
      await deps.validator.assertUnique(deps.prisma, def, r.data, r.changed, id);
      return r;
    });
    if (v.changed.length === 0 && !(owner && owner !== row.owner_id)) throw new ActionUserError('Không có thay đổi nào so với bản ghi hiện tại.');
    const labels = v.changed.map((k) => def.fields.find((f) => f.key === k)?.label ?? k).join(', ');
    const title = renamed(row.title, titleOf(def, v.data));
    return {
      params: { object: key, id, values, ...(owner ? { owner_id: owner } : {}) },
      summary: shown(`Sửa ${def.obj.label} #${id}${title ? ` "${title}"` : ''}: ${labels}`),
      details: lines(line('Bảng', def.obj.label_plural), line('Bản ghi', `#${id}${row.title ? ` ${row.title}` : ''}`), ...fieldLines(def, v.data, v.changed, before)),
    };
  },
  async execute(params, ctx) {
    const { deps, user } = ctx;
    const key = String(params.object);
    if (isCoreKey(key)) return executeCoreUpdate(key, params, ctx);
    requirePerm(user, 'custom_records.manage');
    const res = await deps.records.update(user, key, Number(params.id), { data: asData(params.values), owner_id: optInt(params.owner_id) });
    return { record_id: res.id, object: key };
  },
};
