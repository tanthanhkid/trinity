import { BadRequestException } from '@nestjs/common';

/**
 * Whitelist các kiểu thuộc tính động — KHỚP `ProductAttributeDef.type`
 * (`@db.VarChar(32)`, không phải Prisma enum để danh mục tự thêm kiểu mới không
 * cần migration — nhưng service CHỈ chấp nhận đúng 9 giá trị này).
 */
export const PRODUCT_ATTRIBUTE_TYPES = [
  'text',
  'number',
  'currency',
  'percent',
  'date',
  'select',
  'multiselect',
  'textarea',
  'boolean',
] as const;

export type ProductAttributeType = (typeof PRODUCT_ATTRIBUTE_TYPES)[number];

/** Trần độ dài cho type=text/textarea — chặn payload phình vô hạn (mirror `PRODUCT_LIST_ITEM_MAX_LENGTH`). */
export const ATTRIBUTE_TEXT_MAX_LENGTH = 500;
export const ATTRIBUTE_TEXTAREA_MAX_LENGTH = 10_000;
/** Trần số — đủ rộng cho VND lẫn số lượng, dưới `Number.MAX_SAFE_INTEGER`. */
export const ATTRIBUTE_NUMBER_CEILING = 1_000_000_000_000;

export interface AttributeOption {
  value: string;
  label: string;
}

/** Shape tối thiểu cần để validate — KHÔNG import `Prisma.ProductAttributeDef` để hàm giữ THUẦN, dễ unit-test. */
export interface AttributeDefLike {
  key: string;
  label: string;
  type: string;
  options: unknown;
  is_required: boolean;
}

/**
 * Validate + chuẩn hoá `Product.attributes` theo `ProductAttributeDef[]` của
 * danh mục đang gán — hàm TS THUẦN (whitelist theo `key`/`type` đã khai báo),
 * TUYỆT ĐỐI KHÔNG nội suy tên cột hay raw SQL. Ném `BadRequestException` với
 * message tiếng Việt nêu rõ field sai — KHÔNG âm thầm bỏ qua field lỗi.
 *
 * Quy tắc:
 *  - `defs` rỗng (category_id=null hoặc danh mục chưa có def nào) → `raw` PHẢI
 *    là object rỗng, không thì 400 ngay (không có def nào để gán giá trị).
 *  - Key trong `raw` KHÔNG khớp bất kỳ def nào → 400 ("thuộc tính không xác định")
 *    giữ whitelist chặt, không lặng lẽ bỏ qua field lạ.
 *  - `is_required=true` mà thiếu/rỗng → 400.
 *  - Sai kiểu (text không phải string, number không phải số hữu hạn, select
 *    không thuộc `options`...) → 400 nêu rõ field + lý do.
 *  - Giá trị hợp lệ được CHUẨN HOÁ (number ép `Number`, boolean ép `Boolean`)
 *    trước khi trả về — object trả về là thứ DUY NHẤT được ghi vào cột `attributes`.
 */
export function validateProductAttributes(
  defs: AttributeDefLike[],
  raw: unknown,
): Record<string, unknown> {
  const input = normalizeInput(raw);
  if (defs.length === 0) {
    if (Object.keys(input).length > 0) {
      throw new BadRequestException(
        'Sản phẩm chưa gán danh mục (hoặc danh mục chưa có thuộc tính nào) — không thể nhập attributes',
      );
    }
    return {};
  }

  const defByKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(input)) {
    if (!defByKey.has(key)) {
      throw new BadRequestException(`Thuộc tính "${key}" không thuộc danh mục đã chọn`);
    }
  }

  const result: Record<string, unknown> = {};
  for (const def of defs) {
    const value = input[def.key];
    result[def.key] = validateOneAttribute(def, value);
  }
  return result;
}

function normalizeInput(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('attributes phải là object');
  }
  return raw as Record<string, unknown>;
}

/** Tách khỏi `validateProductAttributes` để giữ mỗi hàm <30 dòng (coding-standards). */
function validateOneAttribute(def: AttributeDefLike, value: unknown): unknown {
  const isEmpty = value === undefined || value === null || value === '';
  if (isEmpty) {
    if (def.is_required) {
      throw new BadRequestException(`Thuộc tính "${def.label}" là bắt buộc`);
    }
    return null;
  }
  const type = def.type as ProductAttributeType;
  if (!PRODUCT_ATTRIBUTE_TYPES.includes(type)) {
    // Định nghĩa hỏng (dữ liệu cấu hình sai) — LOUD, không âm thầm bỏ qua.
    throw new BadRequestException(`Danh mục cấu hình sai kiểu cho thuộc tính "${def.label}"`);
  }
  return VALIDATORS[type](def, value);
}

const VALIDATORS: Record<ProductAttributeType, (def: AttributeDefLike, value: unknown) => unknown> = {
  text: (def, value) => validateString(def, value, ATTRIBUTE_TEXT_MAX_LENGTH),
  textarea: (def, value) => validateString(def, value, ATTRIBUTE_TEXTAREA_MAX_LENGTH),
  number: (def, value) => validateNumber(def, value),
  currency: (def, value) => validateNumber(def, value),
  percent: (def, value) => validatePercent(def, value),
  date: (def, value) => validateDate(def, value),
  boolean: (def, value) => validateBoolean(def, value),
  select: (def, value) => validateSelect(def, value),
  multiselect: (def, value) => validateMultiselect(def, value),
};

function validateString(def: AttributeDefLike, value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải là chuỗi`);
  }
  if (value.length > maxLength) {
    throw new BadRequestException(`Thuộc tính "${def.label}" tối đa ${maxLength} ký tự`);
  }
  return value;
}

function validateNumber(def: AttributeDefLike, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(n)) {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải là số`);
  }
  if (Math.abs(n) > ATTRIBUTE_NUMBER_CEILING) {
    throw new BadRequestException(`Thuộc tính "${def.label}" vượt trần cho phép`);
  }
  return n;
}

function validatePercent(def: AttributeDefLike, value: unknown): number {
  const n = validateNumber(def, value);
  if (n < 0 || n > 100) {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải trong khoảng 0-100`);
  }
  return n;
}

function validateDate(def: AttributeDefLike, value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải là ngày hợp lệ (ISO 8601)`);
  }
  return value;
}

function validateBoolean(def: AttributeDefLike, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải là boolean`);
  }
  return value;
}

/** `options` của def PHẢI là `AttributeOption[]` hợp lệ — cấu hình hỏng thì LOUD, không đoán mò. */
function resolveOptionValues(def: AttributeDefLike): Set<string> {
  if (!Array.isArray(def.options)) {
    throw new BadRequestException(
      `Danh mục thiếu cấu hình lựa chọn (options) cho thuộc tính "${def.label}"`,
    );
  }
  const values = def.options
    .map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === 'string');
  return new Set(values);
}

function validateSelect(def: AttributeDefLike, value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải là 1 lựa chọn (chuỗi)`);
  }
  const allowed = resolveOptionValues(def);
  if (!allowed.has(value)) {
    throw new BadRequestException(`Thuộc tính "${def.label}" có giá trị không hợp lệ`);
  }
  return value;
}

function validateMultiselect(def: AttributeDefLike, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestException(`Thuộc tính "${def.label}" phải là mảng chuỗi`);
  }
  const allowed = resolveOptionValues(def);
  for (const v of value) {
    if (!allowed.has(v)) {
      throw new BadRequestException(`Thuộc tính "${def.label}" có giá trị "${v}" không hợp lệ`);
    }
  }
  return value;
}
