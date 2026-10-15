import { BadRequestException, NotFoundException } from '@nestjs/common';
import { loadVisibleObject, type ObjectDef } from '../../../custom-objects/custom-object-access';
import { assertFlagsAllowed, buildOptions, formulasReferencing } from '../../../custom-objects/field-definition';
import type { AuthUser } from '@trinity/rbac-nest';
import { ActionUserError, type ActionDeps, type ActionToolDef } from './action-types';
import { cleanText, compact, line, lines, renamed, shown } from './action-helpers';
import { checkFields, fieldShape, parseField, targetId, toFieldDto } from './structure-spec';
import { countWithValue, fieldImpact, makeImpact } from './impact';

const objectArg = (z: import('../tools/tool-types').Z) => z.string().min(1).max(48).describe('Khoá bảng tuỳ biến (từ describe_schema) / Table key');

async function loadDef(deps: ActionDeps, user: AuthUser, key: string): Promise<ObjectDef> {
  return loadVisibleObject(deps.prisma, user, key).catch((e: unknown) => {
    if (e instanceof NotFoundException) throw new ActionUserError(`Không có bảng “${key}”. Hãy gọi describe_schema để xem danh sách bảng.`);
    throw e;
  });
}

const targets = async (deps: ActionDeps): Promise<Set<string>> => new Set((await deps.prisma.customObject.findMany({ where: { deleted_at: null }, select: { key: true }, take: 100 })).map((o) => o.key));

export const addFieldAction: ActionToolDef = {
  name: 'add_field',
  label: 'Thêm trường',
  title: 'Thêm trường vào bảng tuỳ biến / Add a field',
  description:
    'Thêm MỘT trường vào bảng tuỳ biến đã có (mọi kiểu: text, long_text, number, currency, percent, date, datetime, boolean, select, multi_select, email, phone, url, relation, user, formula). ' +
    'select/multi_select cần choices; relation cần target_object (khoá bảng hoặc "contacts"); formula cần expression. Bảng LÕI (khách hàng, deal, việc) không thêm trường cấu trúc được — muốn dữ liệu riêng hãy tạo bảng tuỳ biến liên kết tới khách hàng. ' +
    'CHỈ quản trị viên; chạy ngay. / Adds one field to a custom table immediately. Admins only; core tables are not supported.',
  permissions: ['custom_objects.manage'],
  destructive: false,
  idempotent: false,
  input: (z) => ({ object: objectArg(z), ...fieldShape(z) }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const def = await loadDef(deps, user, key);
    const { object: _o, ...raw } = args;
    const f = parseField(raw);
    checkFields([f], def.fields, await targets(deps));
    return {
      params: { object: key, field: f },
      summary: shown(`Thêm trường “${f.label}” (${f.type}) vào bảng “${def.obj.label}”`),
      details: lines(line('Bảng', `${def.obj.label} [${key}]`), line('Trường', `${f.label} [${f.key}]`), line('Kiểu', f.type), line('Bắt buộc', f.required ? 'Có' : 'Không'), line('Lựa chọn', f.choices?.map((c) => (typeof c === 'string' ? c : c.label)).join(', ')), line('Liên kết tới', f.target_object), line('Công thức', f.expression)),
    };
  },
  async execute(params, { deps, user }) {
    const f = params.field as Parameters<typeof toFieldDto>[0];
    const created = await deps.fields.create(String(params.object), toFieldDto(f, await targetId(deps, f)), user);
    return { object: params.object, field: created.key };
  },
};

export const updateFieldAction: ActionToolDef = {
  name: 'update_field',
  label: 'Sửa trường',
  title: 'Sửa trường / Edit a field',
  description:
    'Sửa một trường của bảng tuỳ biến: nhãn, bắt buộc, duy nhất, tiêu đề, hiện ở danh sách, ghi chú, và với select/multi_select là danh sách lựa chọn (gửi ĐỦ danh sách mới; không bỏ được lựa chọn đang có bản ghi dùng). ' +
    'Không đổi được khoá và kiểu. CHỈ quản trị viên; chạy ngay. / Edits a field (label, required, choices…) immediately. Cannot change key or type. Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: true,
  idempotent: true,
  input: (z) => {
    const s = fieldShape(z);
    return {
      object: objectArg(z), field: z.string().min(1).max(48).describe('Khoá trường cần sửa / Field key'),
      label: s.label.optional(), required: s.required, is_unique: s.is_unique, is_title: s.is_title, show_in_list: s.show_in_list, help_text: s.help_text,
      choices: s.choices, expression: s.expression, format: s.format, decimals: s.decimals,
    };
  },
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const fkey = cleanText(args.field, 48);
    const def = await loadDef(deps, user, key);
    const cur = def.fields.find((x) => x.key === fkey);
    if (!cur) throw new ActionUserError(`Bảng “${key}” không có trường “${fkey}”. Gọi describe_schema để xem.`);
    const patch = compact({ label: args.label && cleanText(args.label, 100), required: args.required, is_unique: args.is_unique, is_title: args.is_title, show_in_list: args.show_in_list, help_text: args.help_text && cleanText(args.help_text, 300), expression: args.expression, format: args.format, decimals: args.decimals });
    const options = optionsPatch(args, cur.type);
    if (options) Object.assign(patch, { options });
    if (Object.keys(patch).length === 0) throw new ActionUserError('Không có gì để sửa.');
    try {
      if (options) buildOptions(cur.type, options, def.fields, fkey);
      assertFlagsAllowed(cur.type, { required: (patch.required as boolean | undefined) ?? cur.required, is_unique: (patch.is_unique as boolean | undefined) ?? cur.is_unique, is_title: (patch.is_title as boolean | undefined) ?? cur.is_title });
    } catch (e) {
      if (e instanceof BadRequestException) throw new ActionUserError(e.message);
      throw e;
    }
    return {
      params: { object: key, field: fkey, patch },
      impact: await fieldImpact(deps, def, fkey, patch),
      summary: shown(`Sửa trường “${renamed(cur.label, patch.label)}” của bảng “${def.obj.label}”: ${Object.keys(patch).join(', ')}`),
      details: lines(line('Bảng', `${def.obj.label} [${key}]`), line('Trường', `${cur.label} [${fkey}]`), ...Object.entries(patch).map(([k, v]) => line(k, typeof v === 'object' ? JSON.stringify(v) : String(v)))),
    };
  },
  async execute(params, { deps, user }) {
    await deps.fields.update(String(params.object), String(params.field), params.patch as never, user);
    return { object: params.object, field: params.field };
  },
};

function optionsPatch(args: Record<string, unknown>, type: string): Record<string, unknown> | undefined {
  if (Array.isArray(args.choices)) {
    if (type !== 'select' && type !== 'multi_select') throw new ActionUserError('choices chỉ dùng cho trường select / multi_select.');
    return { choices: args.choices.map((c) => (typeof c === 'string' ? { label: c } : c)) };
  }
  if (type === 'formula' && (args.expression || args.format || args.decimals !== undefined)) return compact({ expression: args.expression, format: args.format, decimals: args.decimals });
  return undefined;
}

export const archiveFieldAction: ActionToolDef = {
  name: 'archive_field',
  label: 'Ẩn trường',
  title: 'Ẩn trường / Hide a field',
  description:
    'ẨN (lưu trữ) một trường của bảng tuỳ biến: trường biến khỏi form và danh sách nhưng DỮ LIỆU ĐÃ NHẬP VẪN CÒN trong bản ghi. Không ẩn được trường tiêu đề hoặc trường đang được công thức dùng. ' +
    'CHỈ quản trị viên; chạy ngay. / Hides a field immediately (data is kept). Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: true,
  idempotent: true,
  input: (z) => ({ object: objectArg(z), field: z.string().min(1).max(48).describe('Khoá trường cần ẩn / Field key') }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const fkey = cleanText(args.field, 48);
    const def = await loadDef(deps, user, key);
    const cur = def.fields.find((x) => x.key === fkey);
    if (!cur) throw new ActionUserError(`Bảng “${key}” không có trường “${fkey}”.`);
    if (cur.is_title) throw new ActionUserError('Đây là trường tiêu đề — hãy chọn trường khác làm tiêu đề (update_field is_title) trước.');
    const used = formulasReferencing(def.fields, fkey);
    if (used.length > 0) throw new ActionUserError(`Không ẩn được: trường công thức “${used.map((f) => f.label).join('”, “')}” đang dùng trường này.`);
    const withValue = await countWithValue(deps, def.obj.id, fkey);
    const impact = makeImpact([{ key, label: def.obj.label, records: withValue }], [`${withValue} bản ghi của “${def.obj.label}” đang có dữ liệu ở trường “${cur.label}” — sẽ KHÔNG còn thấy trên form/danh sách (dữ liệu vẫn giữ, quay lui được).`]);
    return { params: { object: key, field: fkey }, impact, summary: shown(`Ẩn trường “${cur.label}” của bảng “${def.obj.label}” (dữ liệu giữ nguyên)`), details: lines(line('Bảng', `${def.obj.label} [${key}]`), line('Trường', `${cur.label} [${fkey}]`), line('Hậu quả', 'Trường biến khỏi form/danh sách; dữ liệu cũ vẫn nằm trong bản ghi')) };
  },
  async execute(params, { deps, user }) {
    await deps.fields.remove(String(params.object), String(params.field), user);
    return { object: params.object, field: params.field, archived: true };
  },
};
