import { BadRequestException } from '@nestjs/common';
import {
  KANBAN_FIELD_TYPES,
  KANBAN_MONEY_CEILING,
  KANBAN_NUMBER_CEILING,
  KANBAN_TEXT_MAX_LENGTH,
  KanbanFieldType,
} from './kanban.constants';

/**
 * Validate + chuẩn hoá `KanbanCard.attributes` theo `KanbanFieldDef[]` của
 * board — mirror `validateProductAttributes` (`product-attributes.validator.ts`).
 * Hàm TS THUẦN, whitelist theo `key`/`type` đã khai báo, KHÔNG nội suy tên cột
 * hay raw SQL.
 *
 * Quy tắc:
 *  - `defs` rỗng → `raw` PHẢI là object rỗng, không thì 400.
 *  - Key trong `raw` KHÔNG khớp def nào → 400 (giữ whitelist chặt).
 *  - `required=true` mà thiếu/rỗng → 400. Checkbox `false` KHÔNG coi là rỗng.
 *  - Sai kiểu → 400 nêu rõ field + lý do.
 *  - Giá trị hợp lệ được CHUẨN HOÁ trước khi trả — object trả về CHỈ chứa
 *    đúng các key thuộc `defs` hiện tại; caller PHẢI tự merge với giá trị cũ
 *    để giữ nguyên field ĐÃ XOÁ khỏi cấu hình ("Giá trị của field
 *    đã xoá thì giữ, không crash khi render") — xem `mergeKanbanAttributes`.
 */
export interface KanbanFieldOption {
  value: string;
  label: string;
}

export interface KanbanFieldDefLike {
  key: string;
  label: string;
  type: string;
  options: unknown;
  required: boolean;
}

export function validateKanbanAttributes(
  defs: KanbanFieldDefLike[],
  raw: unknown,
  /** `partial` (PATCH): chỉ kiểm các key CÓ gửi lên; key vắng mặt không bị ghi đè về null và không bị bắt "bắt buộc". */
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  const input = normalizeInput(raw);
  if (defs.length === 0) {
    if (Object.keys(input).length > 0) {
      throw new BadRequestException(
        'Board chưa có trường tuỳ biến nào — không thể nhập attributes',
      );
    }
    return {};
  }

  const defByKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(input)) {
    if (!defByKey.has(key)) {
      throw new BadRequestException(`Trường "${key}" không thuộc board này`);
    }
  }

  const result: Record<string, unknown> = {};
  for (const def of defs) {
    if (options.partial && !Object.prototype.hasOwnProperty.call(input, def.key)) continue;
    result[def.key] = validateOneField(def, input[def.key]);
  }
  return result;
}

/**
 * Merge giá trị vừa validate (chỉ chứa key thuộc `defs` HIỆN TẠI) với giá trị
 * ĐÃ LƯU — giữ nguyên key của field đã bị xoá khỏi cấu hình board, KHÔNG rơi
 * mất khi card được sửa field khác.
 */
export function mergeKanbanAttributes(
  existing: unknown,
  validatedNew: Record<string, unknown>,
): Record<string, unknown> {
  const base = normalizeInput(existing);
  return { ...base, ...validatedNew };
}

function normalizeInput(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('attributes phải là object');
  }
  return raw as Record<string, unknown>;
}

function validateOneField(def: KanbanFieldDefLike, value: unknown): unknown {
  const isEmpty = value === undefined || value === null || value === '';
  if (isEmpty) {
    if (def.required) {
      throw new BadRequestException(`Trường "${def.label}" là bắt buộc`);
    }
    return null;
  }
  const type = def.type as KanbanFieldType;
  if (!(KANBAN_FIELD_TYPES as readonly string[]).includes(type)) {
    throw new BadRequestException(`Board cấu hình sai kiểu cho trường "${def.label}"`);
  }
  return VALIDATORS[type](def, value);
}

const VALIDATORS: Record<KanbanFieldType, (def: KanbanFieldDefLike, value: unknown) => unknown> = {
  text: (def, value) => validateString(def, value),
  url: (def, value) => validateUrl(def, value),
  number: (def, value) => validateNumber(def, value, KANBAN_NUMBER_CEILING),
  money: (def, value) => validateMoney(def, value),
  date: (def, value) => validateDate(def, value),
  checkbox: (def, value) => validateBoolean(def, value),
  select: (def, value) => validateSelect(def, value),
  multi_select: (def, value) => validateMultiSelect(def, value),
  user: (def, value) => validateUserId(def, value),
};

function validateString(def: KanbanFieldDefLike, value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`Trường "${def.label}" phải là chuỗi`);
  }
  if (value.length > KANBAN_TEXT_MAX_LENGTH) {
    throw new BadRequestException(`Trường "${def.label}" tối đa ${KANBAN_TEXT_MAX_LENGTH} ký tự`);
  }
  return value;
}

function validateUrl(def: KanbanFieldDefLike, value: unknown): string {
  const str = validateString(def, value);
  if (!/^https?:\/\/\S+$/i.test(str)) {
    throw new BadRequestException(`Trường "${def.label}" phải là URL hợp lệ (http/https)`);
  }
  return str;
}

function validateNumber(def: KanbanFieldDefLike, value: unknown, ceiling: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(n)) {
    throw new BadRequestException(`Trường "${def.label}" phải là số`);
  }
  if (Math.abs(n) > ceiling) {
    throw new BadRequestException(`Trường "${def.label}" vượt trần cho phép`);
  }
  return n;
}

/** Money = số nguyên VND, KHÔNG âm ("money as integer VND"). null vs 0
 * là 2 nghĩa KHÁC NHAU (chưa nhập vs nhập 0đ) — phân biệt ở `isEmpty`, KHÔNG ở đây. */
function validateMoney(def: KanbanFieldDefLike, value: unknown): number {
  const n = validateNumber(def, value, KANBAN_MONEY_CEILING);
  if (!Number.isInteger(n)) {
    throw new BadRequestException(`Trường "${def.label}" phải là số nguyên (VNĐ, không thập phân)`);
  }
  if (n < 0) {
    throw new BadRequestException(`Trường "${def.label}" không được âm`);
  }
  return n;
}

function validateDate(def: KanbanFieldDefLike, value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`Trường "${def.label}" phải là ngày hợp lệ (ISO 8601)`);
  }
  return value;
}

function validateBoolean(def: KanbanFieldDefLike, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`Trường "${def.label}" phải là boolean`);
  }
  return value;
}

/** `user` = id nhân viên (số nguyên dương) — KHÔNG verify tồn tại trong DB ở
 * tầng validator thuần này (FE picker đã giới hạn danh sách hợp lệ). */
function validateUserId(def: KanbanFieldDefLike, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(n) || n <= 0) {
    throw new BadRequestException(`Trường "${def.label}" phải là ID người dùng hợp lệ`);
  }
  return n;
}

function resolveOptionValues(def: KanbanFieldDefLike): Set<string> {
  if (!Array.isArray(def.options)) {
    throw new BadRequestException(`Board thiếu cấu hình lựa chọn (options) cho trường "${def.label}"`);
  }
  const values = def.options
    .map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === 'string');
  return new Set(values);
}

function validateSelect(def: KanbanFieldDefLike, value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`Trường "${def.label}" phải là 1 lựa chọn (chuỗi)`);
  }
  const allowed = resolveOptionValues(def);
  if (!allowed.has(value)) {
    throw new BadRequestException(`Trường "${def.label}" có giá trị không hợp lệ`);
  }
  return value;
}

function validateMultiSelect(def: KanbanFieldDefLike, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestException(`Trường "${def.label}" phải là mảng chuỗi`);
  }
  const allowed = resolveOptionValues(def);
  for (const v of value) {
    if (!allowed.has(v)) {
      throw new BadRequestException(`Trường "${def.label}" có giá trị "${v}" không hợp lệ`);
    }
  }
  return value;
}
