import { NotFoundException } from '@nestjs/common';
import { UpdateCustomObjectDto } from '../../../custom-objects/dto/custom-object.dto';
import { loadVisibleObject } from '../../../custom-objects/custom-object-access';
import { CUSTOM_ICONS } from '../../../custom-objects/field-types';
import type { Z } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef, type PreparedAction } from './action-types';
import { cleanText, compact, line, lines, renamed, shown, validateDto } from './action-helpers';
import { applyObjects, checkObjects, fieldShape, parseObject, type ObjectSpec } from './structure-spec';
import { countRecords, makeImpact } from './impact';
import { readPrefix } from './prefix-plan';
import { prefixTaken } from '../../../custom-objects/record-codes';
import { assertConfirmed, confirmationParam, CONSENT_NOTE } from './user-confirmation';

const MAX_OBJECTS_PER_DRAFT = 8;

const objectShape = (z: Z) => ({
  key: z.string().min(1).max(48).optional().describe('Khoá bảng (a-z, 0-9, _), bỏ trống = tự sinh từ tên; không đổi được sau khi tạo / Table key'),
  label: z.string().min(1).max(100).describe('Tên bảng (số ít), vd "Bệnh nhân" / Singular name'),
  label_plural: z.string().min(1).max(100).optional().describe('Tên số nhiều (mặc định = label) / Plural name'),
  icon: z.string().max(48).optional().describe(`Biểu tượng, một trong: ${CUSTOM_ICONS.join(', ')} / Icon`),
  description: z.string().max(500).optional().describe('Mô tả ngắn / Description'),
    code_prefix: z.string().min(2).max(4).optional().describe('Tiền tố mã bản ghi 2–4 chữ in hoa (vd SP → SP001); bỏ trống = tự sinh từ tên / Record code prefix'),
  fields: z.array(z.object(fieldShape(z))).max(60).optional().describe('Các trường của bảng, theo thứ tự hiển thị / Fields'),
});

function summarize(specs: ObjectSpec[]): PreparedAction {
  const names = specs.map((s) => `“${s.label}” (${s.fields.length} trường)`).join(', ');
  return {
    params: { objects: specs },
    summary: shown(`Dựng ${specs.length} bảng mới: ${names}`),
    details: lines(...specs.map((s) => line(`Bảng ${s.label} [${s.key}]`, s.fields.map((f) => `${f.label} (${f.type}${f.required ? ', bắt buộc' : ''}${f.target_object ? ` → ${f.target_object}` : ''})`).join('; ') || '(chưa có trường)', 900))),
  };
}

async function prepareCreate(raw: unknown[], deps: ActionDeps, confirmation: unknown): Promise<PreparedAction> {
  if (raw.length === 0) throw new ActionUserError('Cần ít nhất một bảng.');
  if (raw.length > MAX_OBJECTS_PER_DRAFT) throw new ActionUserError(`Mỗi lần tạo tối đa ${MAX_OBJECTS_PER_DRAFT} bảng.`);
  const specs = raw.map(parseObject);
  await checkObjects(deps, specs);
  const prepared = summarize(specs);
  assertConfirmed(confirmation, prepared.details ?? []);
  return prepared;
}

const CONFIRM_NOTE =
  'Cấu trúc bảng mới do người dùng duyệt trước khi tạo: confirmed_by_user là ' + CONSENT_NOTE + '; thiếu lời đồng ý thì máy chủ không tạo gì và trả danh sách cột dự kiến để người dùng xem. Bảng mới chưa có màn; loại màn (list/kanban/calendar/table, create_view) là lựa chọn riêng của người dùng, không nằm trong lời đồng ý cấu trúc. ';

async function executeCreate(params: Record<string, unknown>, { deps, user }: { deps: ActionDeps; user: import('@trinity/rbac-nest').AuthUser }): Promise<Record<string, unknown>> {
  const created = await applyObjects(deps, user, params.objects as ObjectSpec[]);
  return { created_objects: created, open_at: created.map((k) => `/x/${k}`) };
}

export const createObjectsAction: ActionToolDef = {
  name: 'create_objects',
  label: 'Dựng nhiều bảng tuỳ biến',
  title: 'Dựng bảng + trường cho một ngành / Build tables with fields',
  description:
    'Dựng MỘT HOẶC NHIỀU BẢNG TUỲ BIẾN MỚI cùng toàn bộ trường của chúng trong MỘT lần (tối đa 8 bảng) — cách nhanh nhất để dựng CRM theo ngành (vd bán hàng: Sản phẩm + Đơn hàng). ' +
    'Trường liên kết (type=relation) trỏ tới bảng khác bằng target_object = khoá bảng đó (có thể là bảng khác trong cùng lần tạo) hoặc "contacts" (khách hàng). ' +
    CONFIRM_NOTE + 'Dành cho quản trị viên (quyền sửa cấu trúc). describe_schema cho biết khoá đã dùng và kiểu trường hợp lệ. Sai cấu hình báo lỗi và không dựng gì. / ' +
    'Builds new custom tables with all their fields in one run (max 8) once the user has confirmed the planned columns (confirmed_by_user). Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: false,
  idempotent: false,
  input: (z) => ({ objects: z.array(z.object(objectShape(z))).min(1).max(MAX_OBJECTS_PER_DRAFT).describe('Danh sách bảng cần dựng / Tables to build'), confirmed_by_user: confirmationParam(z) }),
  prepare: (args, { deps }) => prepareCreate(Array.isArray(args.objects) ? args.objects : [], deps, args.confirmed_by_user),
  execute: (params, ctx) => executeCreate(params, ctx),
};

export const createObjectAction: ActionToolDef = {
  name: 'create_object',
  label: 'Tạo bảng tuỳ biến',
  title: 'Tạo một bảng tuỳ biến / Create a custom table',
  description:
    'Tạo MỘT bảng tuỳ biến mới (khoá, tên, biểu tượng, mô tả) và tuỳ chọn kèm luôn các trường. Muốn dựng nhiều bảng liên quan nhau (vd Bệnh nhân + Lịch hẹn) hãy dùng create_objects để dựng trong một lần. ' +
    CONFIRM_NOTE + 'Dành cho quản trị viên. / Creates one new custom table (optionally with fields) once the user has confirmed the planned columns (confirmed_by_user). Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: false,
  idempotent: false,
  input: (z) => ({ ...objectShape(z), confirmed_by_user: confirmationParam(z) }),
  prepare: (args, { deps }) => {
    const { confirmed_by_user: confirmation, ...obj } = args;
    return prepareCreate([obj], deps, confirmation);
  },
  execute: (params, ctx) => executeCreate(params, ctx),
};

export const updateObjectAction: ActionToolDef = {
  name: 'update_object',
  label: 'Sửa bảng tuỳ biến',
  title: 'Sửa/ẩn bảng tuỳ biến / Edit or hide a custom table',
  description:
    'Đổi tên, mô tả, biểu tượng, hiện/ẩn menu hoặc BẬT/TẮT (is_active=false = ẩn bảng với người không phải quản trị) của một bảng tuỳ biến. KHÔNG xoá được bảng và không động tới dữ liệu. ' +
    'CHỈ quản trị viên; chạy ngay. / Renames or hides a custom table immediately; cannot delete a table. Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: true,
  idempotent: true,
  input: (z) => ({
    object: z.string().min(1).max(48).describe('Khoá bảng (từ describe_schema) / Table key'),
    label: z.string().min(1).max(100).optional(), label_plural: z.string().min(1).max(100).optional(),
    icon: z.string().max(48).optional().describe(`Một trong: ${CUSTOM_ICONS.join(', ')}`), description: z.string().max(500).optional(),
    show_in_nav: z.boolean().optional().describe('Hiện ở menu / Show in menu'), is_active: z.boolean().optional().describe('false = ẩn bảng / Hide table'),
    code_prefix: z.string().min(2).max(4).optional().describe('Đổi tiền tố mã (vd HS → HV): mã mọi bản ghi đổi theo, mã cũ vẫn tra được / New code prefix'),
  }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const def = await loadVisibleObject(deps.prisma, user, key).catch((e: unknown) => {
      if (e instanceof NotFoundException) throw new ActionUserError(`Không có bảng “${key}”. Hãy gọi describe_schema.`);
      throw e;
    });
    const patch = compact({ label: args.label, label_plural: args.label_plural, icon: args.icon, description: args.description, show_in_nav: args.show_in_nav, is_active: args.is_active, code_prefix: readPrefix(args.code_prefix, def.obj.label) });
    if (typeof patch.code_prefix === 'string' && patch.code_prefix !== def.obj.code_prefix && (await prefixTaken(deps.prisma, patch.code_prefix, def.obj.id))) throw new ActionUserError(`Tiền tố “${patch.code_prefix}” đã được bảng khác dùng (hoặc từng dùng).`);
    if (Object.keys(patch).length === 0) throw new ActionUserError('Không có gì để sửa.');
    if (typeof patch.icon === 'string' && !(CUSTOM_ICONS as readonly string[]).includes(patch.icon)) throw new ActionUserError(`Biểu tượng không hợp lệ. Dùng một trong: ${CUSTOM_ICONS.join(', ')}.`);
    await validateDto(UpdateCustomObjectDto, patch);
    const hides = patch.is_active === false || patch.show_in_nav === false;
    const records = hides ? await countRecords(deps, def.obj.id) : 0;
    return {
      params: { object: key, patch },
      impact: makeImpact([{ key, label: def.obj.label, records }], [hides ? `${records} bản ghi của “${def.obj.label}” sẽ ${patch.is_active === false ? 'bị ẨN với mọi người trừ quản trị viên' : 'không còn mục menu (vẫn mở được qua đường dẫn)'}.` : 'Chỉ đổi tên/mô tả/biểu tượng, dữ liệu không đổi.']),
      summary: shown(`Sửa bảng “${renamed(def.obj.label, patch.label)}”: ${Object.keys(patch).join(', ')}${patch.is_active === false ? ' (ẨN bảng)' : ''}`),
      details: lines(line('Bảng', `${def.obj.label} [${key}]`), ...Object.entries(patch).map(([k, v]) => line(k, String(v)))),
    };
  },
  async execute(params, { deps, user }) {
    const key = String(params.object);
    await deps.objects.update(key, await validateDto(UpdateCustomObjectDto, params.patch as Record<string, unknown>), user);
    return { object: key, updated: Object.keys(params.patch as Record<string, unknown>) };
  },
};
