import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '@trinity/rbac-nest';
import { assertFlagsAllowed, buildOptions } from '../../../custom-objects/field-definition';
import { CUSTOM_ICONS, FIELD_TYPES, KEY_REGEX, LIMITS, RESERVED_OBJECT_KEYS, TITLE_TYPES, isFieldType, type FieldDef, type FieldType } from '../../../custom-objects/field-types';
import { slugifyKey } from '../../../custom-objects/field-values';
import type { CreateCustomFieldDto } from '../../../custom-objects/dto/custom-field.dto';
import { cleanText } from './action-helpers';
import { ActionUserError, type ActionDeps } from './action-types';
import { assignPrefixes, readPrefix } from './prefix-plan';

/** Một trường theo cách AI mô tả (phẳng, dễ điền) — được đổi thành `CreateCustomFieldDto` của service tuỳ biến sẵn có. */
export interface FieldSpec {
  label: string; type: FieldType; key: string; required?: boolean; is_unique?: boolean; is_title?: boolean; show_in_list?: boolean; help_text?: string;
  choices?: (string | { label: string; value?: string; color?: string })[]; target_object?: string; multiple?: boolean;
  expression?: string; format?: string; decimals?: number;
}
export interface ObjectSpec { key: string; label: string; label_plural: string; icon?: string; description?: string; code_prefix?: string; fields: FieldSpec[] }

/** Phần zod dùng chung cho mọi tool dựng trường (khớp FieldSpec). */
export const fieldShape = (z: import('../tools/tool-types').Z) => ({
  label: z.string().min(1).max(100).describe('Tên hiển thị của trường, vd "Ngày sinh" / Field label'),
  type: z.enum(FIELD_TYPES).describe('Kiểu: text, long_text, number, currency, percent, date, datetime, boolean, select, multi_select, email, phone, url, relation, user, formula'),
  key: z.string().min(1).max(48).optional().describe('Khoá (a-z, 0-9, _); bỏ trống = tự sinh từ tên. Không đổi được sau khi tạo / Key'),
  required: z.boolean().optional().describe('Bắt buộc nhập / Required'),
  is_unique: z.boolean().optional().describe('Không cho trùng (chỉ text/số/tiền/email/url/ngày) / Unique'),
  is_title: z.boolean().optional().describe('Làm tiêu đề bản ghi; trường text/số/email/ngày đầu tiên tự là tiêu đề / Record title'),
  show_in_list: z.boolean().optional().describe('Hiện ở danh sách / Show in list'),
  help_text: z.string().max(300).optional().describe('Ghi chú dưới ô nhập / Help text'),
  choices: z.array(z.union([z.string().min(1).max(100), z.object({ label: z.string().min(1).max(100), value: z.string().max(64).optional(), color: z.string().max(12).optional() })])).max(LIMITS.maxChoices).optional()
    .describe('Chỉ select/multi_select: danh sách lựa chọn (chuỗi, hoặc {label,value?,color?}) / Choices'),
  target_object: z.string().min(1).max(48).optional().describe('Chỉ relation: khoá bảng được liên kết tới — bảng tuỳ biến (kể cả bảng khác trong cùng lần tạo) hoặc "contacts" (khách hàng) / Relation target table key'),
  multiple: z.boolean().optional().describe('relation: cho chọn nhiều / Allow multiple'),
  expression: z.string().max(300).optional().describe('Chỉ formula: biểu thức, vd {gia}*{so_luong} / Formula expression'),
  format: z.enum(['number', 'currency', 'percent']).optional().describe('formula: cách hiển thị / Result format'),
  decimals: z.number().int().min(0).max(6).optional().describe('formula: số chữ số thập phân / Decimals'),
});

const own = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function assertKey(key: string, what: string, reserved = false): string {
  if (!KEY_REGEX.test(key)) throw new ActionUserError(`Khoá ${what} “${key.slice(0, 50)}” không hợp lệ: chỉ a-z, 0-9, _ ; bắt đầu bằng chữ; tối đa 48 ký tự.`);
  if (reserved && RESERVED_OBJECT_KEYS.includes(key)) throw new ActionUserError(`Khoá bảng “${key}” là từ khoá hệ thống, hãy chọn khoá khác.`);
  if (!reserved && key in Object.prototype) throw new ActionUserError(`Khoá trường “${key}” là từ khoá hệ thống, hãy chọn khoá khác.`);
  return key;
}

export function parseField(raw: unknown): FieldSpec {
  const f = own(raw);
  const label = cleanText(f.label, 100);
  if (!label) throw new ActionUserError('Mỗi trường cần có tên (label).');
  if (typeof f.type !== 'string' || !isFieldType(f.type)) throw new ActionUserError(`Kiểu trường không hợp lệ. Dùng một trong: ${FIELD_TYPES.join(', ')}.`);
  const key = assertKey(f.key ? cleanText(f.key, 48) : slugifyKey(label), 'trường');
  const spec: FieldSpec = { label, type: f.type, key };
  for (const k of ['required', 'is_unique', 'is_title', 'show_in_list', 'multiple'] as const) if (typeof f[k] === 'boolean') spec[k] = f[k] as boolean;
  if (f.help_text) spec.help_text = cleanText(f.help_text, 300);
  if (Array.isArray(f.choices)) spec.choices = f.choices.slice(0, LIMITS.maxChoices) as FieldSpec['choices'];
  if (f.target_object) spec.target_object = assertKey(cleanText(f.target_object, 48), 'bảng liên kết', true);
  if (f.expression) spec.expression = cleanText(f.expression, 300);
  if (typeof f.format === 'string') spec.format = f.format;
  if (typeof f.decimals === 'number') spec.decimals = f.decimals;
  return spec;
}

export function parseObject(raw: unknown): ObjectSpec {
  const o = own(raw);
  const label = cleanText(o.label, 100);
  if (!label) throw new ActionUserError('Mỗi bảng cần có tên (label).');
  const key = assertKey(o.key ? cleanText(o.key, 48) : slugifyKey(label), 'bảng', true);
  const icon = o.icon ? cleanText(o.icon, 48) : undefined;
  if (icon && !(CUSTOM_ICONS as readonly string[]).includes(icon)) throw new ActionUserError(`Biểu tượng “${icon}” không hợp lệ. Dùng một trong: ${CUSTOM_ICONS.join(', ')}.`);
  const fields = Array.isArray(o.fields) ? o.fields.map(parseField) : [];
  const keys = fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new ActionUserError(`Bảng “${label}” có hai trường trùng khoá.`);
  if (fields.length > LIMITS.maxFieldsPerObject) throw new ActionUserError(`Mỗi bảng tối đa ${LIMITS.maxFieldsPerObject} trường.`);
  return { key, label, label_plural: cleanText(o.label_plural, 100) || label, icon, description: o.description ? cleanText(o.description, 500) : undefined, code_prefix: readPrefix(o.code_prefix, label), fields };
}

/** FieldSpec → DTO của CustomFieldsService.create. `targetId` = id bảng đích (relation tới bảng tuỳ biến). */
export function toFieldDto(f: FieldSpec, targetId?: number): CreateCustomFieldDto {
  const options: Record<string, unknown> = {};
  if (f.choices) options.choices = f.choices.map((c) => (typeof c === 'string' ? { label: c } : c));
  if (f.type === 'relation') Object.assign(options, f.target_object === 'contacts' ? { target: 'contact' } : { target_object_id: targetId }, { multiple: f.multiple === true });
  if (f.type === 'formula') Object.assign(options, { expression: f.expression, format: f.format, decimals: f.decimals });
  return { key: f.key, label: f.label, type: f.type, required: f.required, is_unique: f.is_unique, is_title: f.is_title, show_in_list: f.show_in_list, help_text: f.help_text, options } as CreateCustomFieldDto;
}

function asDef(f: FieldSpec, i: number, options: FieldDef['options']): FieldDef {
  return { id: i + 1, key: f.key, label: f.label, type: f.type, required: !!f.required, is_unique: !!f.is_unique, is_title: !!f.is_title, show_in_list: true, sort_order: i, options, help_text: null };
}

/** Chạy thử kiểm hợp lệ KHÔNG ghi gì: cùng các luật như service (kiểu, cờ, lựa chọn, công thức, đích liên kết) để báo lỗi sớm lúc tạo nháp. */
export function checkFields(fields: FieldSpec[], existing: FieldDef[], knownTargets: Set<string>): void {
  const sib: FieldDef[] = [...existing];
  if (sib.length + fields.length > LIMITS.maxFieldsPerObject) throw new ActionUserError(`Mỗi bảng tối đa ${LIMITS.maxFieldsPerObject} trường.`);
  let hasTitle = sib.some((x) => x.is_title);
  for (const f of fields) {
    if (sib.some((x) => x.key === f.key)) throw new ActionUserError(`Khoá trường “${f.key}” đã tồn tại.`);
    if (f.type === 'relation' && (!f.target_object || (f.target_object !== 'contacts' && !knownTargets.has(f.target_object)))) {
      throw new ActionUserError(`Trường liên kết “${f.label}” cần target_object là khoá một bảng có sẵn (${[...knownTargets].slice(0, 8).join(', ') || 'chưa có bảng nào'}) hoặc "contacts".`);
    }
    try {
      const dto = toFieldDto(f, 1);
      const options = buildOptions(f.type, dto.options, sib, f.key);
      const isTitle = f.is_title ?? (!hasTitle && TITLE_TYPES.includes(f.type));
      assertFlagsAllowed(f.type, { required: !!f.required, is_unique: !!f.is_unique, is_title: isTitle });
      hasTitle = hasTitle || isTitle;
      sib.push(asDef({ ...f, is_title: isTitle }, sib.length, options));
    } catch (e) {
      if (e instanceof BadRequestException) throw new ActionUserError(`Trường “${f.label}”: ${e.message}`);
      throw e;
    }
  }
}

/** Kiểm cả lô bảng mới (khoá chưa dùng, không vượt trần, liên kết tới bảng có sẵn hoặc cùng lô, mỗi bảng có trường làm tiêu đề). */
export async function checkObjects(deps: ActionDeps, specs: ObjectSpec[]): Promise<void> {
  const live = await deps.prisma.customObject.findMany({ where: { deleted_at: null }, select: { key: true }, take: LIMITS.maxObjects + 10 });
  if (live.length + specs.length > LIMITS.maxObjects) throw new ActionUserError(`Vượt giới hạn ${LIMITS.maxObjects} bảng tuỳ biến (đang có ${live.length}).`);
  const taken = new Set(live.map((o) => o.key));
  const batch = new Set(specs.map((s) => s.key));
  if (batch.size !== specs.length) throw new ActionUserError('Hai bảng trong cùng lần tạo bị trùng khoá.');
  for (const s of specs) if (taken.has(s.key)) throw new ActionUserError(`Khoá bảng “${s.key}” đã được dùng — hãy chọn khoá khác (hoặc describe_schema để xem bảng đã có).`);
  const targets = new Set([...taken, ...batch]);
  for (const s of specs) {
    checkFields(s.fields, [], targets);
    if (s.fields.length > 0 && !s.fields.some((f) => f.is_title ?? TITLE_TYPES.includes(f.type))) throw new ActionUserError(`Bảng “${s.label}” cần ít nhất một trường văn bản ngắn/số/email/ngày để làm tiêu đề.`);
  }
  await assignPrefixes(deps, specs);
}

/** Ghi thật (lúc duyệt). Lỗi giữa chừng ⇒ lưu trữ lại các bảng vừa tạo trong lượt này để không để lại cấu trúc dở dang. */
export async function applyObjects(deps: ActionDeps, user: AuthUser, specs: ObjectSpec[]): Promise<string[]> {
  const created: string[] = [];
  try {
    for (const s of specs) {
      await deps.objects.create({ key: s.key, label: s.label, label_plural: s.label_plural, icon: s.icon ?? null, description: s.description ?? null, show_in_nav: true, ...(s.code_prefix ? { code_prefix: s.code_prefix } : {}) }, user);
      created.push(s.key);
    }
    for (const s of specs) for (const f of s.fields) await deps.fields.create(s.key, toFieldDto(f, await targetId(deps, f)), user);
  } catch (e) {
    for (const key of [...created].reverse()) await deps.objects.remove(key, user).catch(() => undefined);
    throw e;
  }
  return created;
}

export async function targetId(deps: ActionDeps, f: FieldSpec): Promise<number | undefined> {
  if (f.type !== 'relation' || f.target_object === 'contacts' || !f.target_object) return undefined;
  const t = await deps.prisma.customObject.findFirst({ where: { key: f.target_object, deleted_at: null }, select: { id: true } });
  if (!t) throw new BadRequestException(`Không tìm thấy bảng “${f.target_object}” để liên kết`);
  return t.id;
}
