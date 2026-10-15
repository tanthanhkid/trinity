import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import { normalizeOptions, ValueError } from './field-values';
import {
  COMPATIBLE_TYPE_GROUPS, DATE_TYPES, NUMERIC_TYPES, TITLE_TYPES, type FieldDef, type FieldOptions, type FieldType,
} from './field-types';
import { FormulaError, checkFormula, collectRefs, parseFormula, type RefKind } from './formula/formula-parser';

/**
 * Kiểu cho phép bật "duy nhất". 🔴 KHÔNG có `phone`: kiểm trùng chạy trên MỌI bản ghi (kể cả ngoài phạm vi) và báo
 * "đã tồn tại" nên là oracle dò SĐT người khác, vòng qua quyền `custom_records.phone_full`.
 * Text/email/số vẫn lộ "mã này đã có" — vốn là bản chất của ràng buộc duy nhất; thông báo không nêu bản ghi nào.
 */
export const UNIQUE_TYPES: readonly FieldType[] = ['text', 'number', 'currency', 'email', 'url', 'date', 'datetime'];

export function refKindOf(type: FieldType): RefKind | undefined {
  if (NUMERIC_TYPES.includes(type)) return 'num';
  if (DATE_TYPES.includes(type)) return 'date';
  return undefined;
}

/** Chuẩn hoá `options` + kiểm công thức tham chiếu đúng trường. Lỗi → 400 tiếng Việt. */
export function buildOptions(type: FieldType, raw: unknown, siblings: FieldDef[], editingKey?: string): FieldOptions {
  let options: FieldOptions;
  try {
    options = normalizeOptions(type, raw);
  } catch (e) {
    if (e instanceof ValueError) throw new BadRequestException(e.message);
    throw e;
  }
  if (type === 'formula') validateFormula(options.expression ?? '', siblings, editingKey);
  return options;
}

export function validateFormula(expression: string, fields: FieldDef[], editingKey?: string): void {
  try {
    const ast = parseFormula(expression);
    checkFormula(ast, (key) => {
      if (key === editingKey) return undefined;
      const f = fields.find((x) => x.key === key);
      return f ? refKindOf(f.type) : undefined;
    });
  } catch (e) {
    if (e instanceof FormulaError) throw new BadRequestException(`Công thức: ${e.message}`);
    throw e;
  }
}

/** Các trường công thức (khác `exceptKey`) đang tham chiếu `key`. */
export function formulasReferencing(fields: FieldDef[], key: string): FieldDef[] {
  return fields.filter((f) => {
    if (f.type !== 'formula' || !f.options.expression) return false;
    try {
      return collectRefs(parseFormula(f.options.expression)).has(key);
    } catch {
      return false;
    }
  });
}

export function assertFlagsAllowed(type: FieldType, flags: { required: boolean; is_unique: boolean; is_title: boolean }): void {
  if (type === 'formula' && (flags.required || flags.is_unique)) {
    throw new BadRequestException('Trường công thức tự tính nên không đặt được “bắt buộc” hay “duy nhất”');
  }
  if (flags.is_unique && !UNIQUE_TYPES.includes(type)) {
    throw new BadRequestException('Kiểu trường này không đặt được “duy nhất” (chỉ văn bản ngắn, số, tiền, email, đường dẫn, ngày; SĐT không đặt duy nhất được để tránh dò số)');
  }
  if (flags.is_title && !TITLE_TYPES.includes(type)) {
    throw new BadRequestException('Trường tiêu đề phải là văn bản ngắn, số, email hoặc ngày');
  }
}

export function typesCompatible(a: FieldType, b: FieldType): boolean {
  return a === b || COMPATIBLE_TYPE_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

/** Có bản ghi CÒN SỐNG nào đang giữ giá trị ở khoá này không. */
export async function fieldHasData(prisma: PrismaService, objectId: number, key: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ x: number }[]>(
    Prisma.sql`SELECT 1 AS x FROM custom_records WHERE object_id = ${objectId} AND deleted_at IS NULL AND (data -> ${key}) IS NOT NULL LIMIT 1`,
  );
  return rows.length > 0;
}

/** Giá trị select đang được dùng bởi bản ghi còn sống (để chặn xoá lựa chọn đang dùng). */
export async function usedChoiceValues(
  prisma: PrismaService, objectId: number, key: string, type: FieldType, candidates: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const rows = type === 'multi_select'
    ? await prisma.$queryRaw<{ v: string }[]>(Prisma.sql`SELECT DISTINCT e AS v FROM custom_records r, jsonb_array_elements_text(r.data -> ${key}) e WHERE r.object_id = ${objectId} AND r.deleted_at IS NULL AND jsonb_typeof(r.data -> ${key}) = 'array' AND e = ANY(${candidates}::text[])`)
    : await prisma.$queryRaw<{ v: string }[]>(Prisma.sql`SELECT DISTINCT data ->> ${key} AS v FROM custom_records WHERE object_id = ${objectId} AND deleted_at IS NULL AND data ->> ${key} = ANY(${candidates}::text[])`);
  return rows.map((r) => r.v);
}

/** Có 2 bản ghi sống trùng giá trị ở khoá này không (trước khi bật “duy nhất”). */
export async function hasDuplicates(prisma: PrismaService, objectId: number, key: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>(
    Prisma.sql`SELECT count(*) AS n FROM custom_records WHERE object_id = ${objectId} AND deleted_at IS NULL AND (data -> ${key}) IS NOT NULL GROUP BY lower(data ->> ${key}) HAVING count(*) > 1 LIMIT 1`,
  );
  return rows.length > 0;
}
