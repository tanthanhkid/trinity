import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validYmd } from './field-values';
import type { ObjectDef } from './custom-object-access';
import { FILTERABLE_TYPES, LIMITS, SORTABLE_TYPES, type FieldDef } from './field-types';

/**
 * Dựng điều kiện SQL (tham số hoá) cho danh sách bản ghi tuỳ biến. 🔴 KHÔNG nội suy chuỗi người dùng vào SQL:
 * khoá trường luôn đi qua tham số (`data -> $n`) SAU khi đã đối chiếu với trường THẬT của thực thể; hướng sắp xếp
 * và kiểu ép (`numeric`…) là hằng của mình.
 */

export type SortKind = 'id' | 'ts' | 'text' | 'num';
export interface SortSpec { kind: SortKind; expr: Prisma.Sql }
export interface Cursor { v: string | null; id: number }

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function scopeSql(owners: number[] | 'all'): Prisma.Sql {
  if (owners === 'all') return Prisma.sql`TRUE`;
  return Prisma.sql`(owner_id = ANY(${owners}::int[]) OR created_by = ANY(${owners}::int[]))`;
}

export function buildSort(def: ObjectDef, sort: string | undefined): SortSpec {
  if (!sort || sort === 'id') return { kind: 'id', expr: Prisma.sql`id` };
  if (sort === 'updated_at') return { kind: 'ts', expr: Prisma.sql`updated_at` };
  if (sort === 'title') return { kind: 'text', expr: Prisma.sql`title` };
  if (!sort.startsWith('field:')) throw new BadRequestException('Cách sắp xếp không hợp lệ');
  const f = def.fields.find((x) => x.key === sort.slice(6));
  if (!f || !SORTABLE_TYPES.includes(f.type)) throw new BadRequestException('Không sắp xếp được theo trường này');
  if (f.type === 'number' || f.type === 'currency' || f.type === 'percent') return { kind: 'num', expr: Prisma.sql`((data ->> ${f.key})::numeric)` };
  return { kind: 'text', expr: Prisma.sql`(data ->> ${f.key})` };
}

const castOf = (k: SortKind): Prisma.Sql => (k === 'num' ? Prisma.sql`numeric` : k === 'ts' ? Prisma.sql`timestamptz` : Prisma.sql`text`);

export function orderSql(spec: SortSpec, dir: 'asc' | 'desc'): Prisma.Sql {
  const d = dir === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  if (spec.kind === 'id') return Prisma.sql`ORDER BY id ${d}`;
  return Prisma.sql`ORDER BY (${spec.expr} IS NULL), ${spec.expr} ${d}, id ${d}`;
}

const NUM_RE = /^-?\d+(\.\d+)?$/;

/** Giá trị trong con trỏ do client gửi lại → PHẢI đúng kiểu ép (`::numeric`/`::timestamptz`), nếu không Postgres ném 22P02 (→ 500). */
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** Dạng + ngày THẬT (V8 chấp nhận "2026-02-30" nhưng Postgres ném 22008). */
function validTimestamp(v: string): boolean {
  const m = TS_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const timeOk = Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60;
  return timeOk && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function assertCursorValue(spec: SortSpec, v: string): void {
  const ok = spec.kind === 'num' ? NUM_RE.test(v) : spec.kind === 'ts' ? validTimestamp(v) : v.length <= 1000 && !v.includes('\u0000');
  if (!ok) throw new BadRequestException('Con trỏ phân trang không hợp lệ');
}

/** Bản ghi đứng SAU con trỏ theo đúng thứ tự trên (NULL xếp cuối cả hai chiều). */
export function cursorSql(spec: SortSpec, dir: 'asc' | 'desc', c: Cursor): Prisma.Sql {
  const cmp = dir === 'desc' ? Prisma.sql`<` : Prisma.sql`>`;
  if (spec.kind === 'id') return Prisma.sql`id ${cmp} ${c.id}`;
  if (c.v === null) return Prisma.sql`(${spec.expr} IS NULL AND id ${cmp} ${c.id})`;
  assertCursorValue(spec, c.v);
  const cast = castOf(spec.kind);
  return Prisma.sql`(${spec.expr} IS NULL OR ${spec.expr} ${cmp} ${c.v}::${cast} OR (${spec.expr} = ${c.v}::${cast} AND id ${cmp} ${c.id}))`;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (!Number.isSafeInteger(o.id) || (o.v !== null && typeof o.v !== 'string')) throw new Error('shape');
    return { v: o.v as string | null, id: o.id as number };
  } catch {
    throw new BadRequestException('Con trỏ phân trang không hợp lệ');
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

function numRange(f: FieldDef, v: unknown): Prisma.Sql[] {
  const o = (v && typeof v === 'object' ? v : {}) as { min?: unknown; max?: unknown };
  const out: Prisma.Sql[] = [];
  for (const [k, op] of [['min', Prisma.sql`>=`], ['max', Prisma.sql`<=`]] as const) {
    const x = o[k];
    if (x === undefined || x === null || x === '') continue;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new BadRequestException(`Bộ lọc “${f.label}” cần số hợp lệ`);
    out.push(Prisma.sql`(data ->> ${f.key})::numeric ${op} ${x}`);
  }
  return out;
}

const DAY_MS = 86_400_000;

function dateRange(f: FieldDef, v: unknown): Prisma.Sql[] {
  const o = (v && typeof v === 'object' ? v : {}) as { from?: unknown; to?: unknown };
  const out: Prisma.Sql[] = [];
  for (const [k, op] of [['from', Prisma.sql`>=`], ['to', Prisma.sql`<=`]] as const) {
    const x = o[k];
    if (x === undefined || x === null || x === '') continue;
    const ok = typeof x === 'string' && (f.type === 'date' ? YMD.test(x) : !Number.isNaN(Date.parse(x)));
    if (!ok) throw new BadRequestException(`Bộ lọc “${f.label}” cần ngày hợp lệ`);
    if (f.type === 'date') {
      out.push(Prisma.sql`(data ->> ${f.key}) ${op} ${x as string}`);
      continue;
    }
    // datetime lưu ISO UTC. Ngày thuần YYYY-MM-DD hiểu theo NGÀY VN (+07:00), không phải 00:00 UTC:
    // `from` = 00:00 VN của ngày đó; `to` = hết ngày đó (trước 00:00 VN của ngày kế tiếp).
    const s = x as string;
    if (YMD.test(s)) {
      const start = Date.parse(`${s}T00:00:00+07:00`);
      if (!validYmd(s) || Number.isNaN(start)) throw new BadRequestException(`Bộ lọc “${f.label}” cần ngày hợp lệ`);
      out.push(k === 'from'
        ? Prisma.sql`(data ->> ${f.key}) >= ${new Date(start).toISOString()}`
        : Prisma.sql`(data ->> ${f.key}) < ${new Date(start + DAY_MS).toISOString()}`);
      continue;
    }
    out.push(Prisma.sql`(data ->> ${f.key}) ${op} ${new Date(Date.parse(s)).toISOString()}`);
  }
  return out;
}

/**
 * Giá trị lọc select/multi_select: dữ liệu lưu `value` của lựa chọn, nhưng AI/người dùng hay gửi NHÃN ("Đã đăng ký").
 * Trùng value ⇒ giữ; trùng nhãn (không phân biệt hoa thường) ⇒ đổi sang value; không khớp lựa chọn nào ⇒ báo lỗi liệt kê value hợp lệ
 * (thay vì trả 0 dòng im lặng). Trường chưa khai lựa chọn ⇒ giữ nguyên.
 */
export function choiceValues(f: FieldDef, v: unknown): string[] {
  const vals = asArray(v).filter((x): x is string => typeof x === 'string').slice(0, LIMITS.maxFilterValues);
  const raw = (f.options as { choices?: unknown } | null)?.choices;
  const choices = Array.isArray(raw) ? (raw as { value?: unknown; label?: unknown }[]).filter((c) => typeof c?.value === 'string') : [];
  if (choices.length === 0) return vals;
  const norm = (x: unknown): string => String(x ?? '').normalize('NFC').trim().toLowerCase();
  const bad: string[] = [];
  const out = vals.map((x) => {
    const byValue = choices.find((c) => c.value === x);
    if (byValue) return x;
    const byLabel = choices.find((c) => norm(c.label) === norm(x)) ?? choices.find((c) => norm(c.value) === norm(x));
    if (byLabel) return byLabel.value as string;
    bad.push(x);
    return x;
  });
  if (bad.length) {
    const list = choices.slice(0, 30).map((c) => (c.label && c.label !== c.value ? `${String(c.value)} (${String(c.label)})` : String(c.value))).join(', ');
    throw new BadRequestException(`Bộ lọc “${f.label}”: không có lựa chọn ${bad.slice(0, 5).map((b) => `“${b.slice(0, 40)}”`).join(', ')}. Value hợp lệ: ${list}`);
  }
  return out;
}

function oneFilter(f: FieldDef, v: unknown): Prisma.Sql[] {
  switch (f.type) {
    case 'select': {
      const vals = choiceValues(f, v);
      return [Prisma.sql`(data ->> ${f.key}) = ANY(${vals}::text[])`];
    }
    case 'multi_select': {
      const vals = choiceValues(f, v);
      return [Prisma.sql`(data -> ${f.key}) ?| ${vals}::text[]`];
    }
    case 'relation': case 'user': {
      const ids = asArray(v).filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x)).slice(0, LIMITS.maxFilterValues);
      if (ids.length === 0) throw new BadRequestException(`Bộ lọc “${f.label}” cần mã hợp lệ`);
      return [Prisma.sql`(${Prisma.join(ids.map((i) => Prisma.sql`(data -> ${f.key}) @> ${JSON.stringify(i)}::jsonb`), ' OR ')})`];
    }
    case 'boolean':
      if (typeof v !== 'boolean') throw new BadRequestException(`Bộ lọc “${f.label}” cần đúng/sai`);
      return [Prisma.sql`(data -> ${f.key}) = ${JSON.stringify(v)}::jsonb`];
    case 'number': case 'currency': case 'percent': return numRange(f, v);
    default: return dateRange(f, v);
  }
}

/**
 * Bộ lọc ĐÃ LƯU trong view có thể tham chiếu thứ về sau bị xoá (lựa chọn của select, hoặc cả trường). Khi mở view thì bỏ điều kiện
 * đã hỏng để view vẫn mở được (còn bộ lọc MỚI do người dùng/AI gửi vẫn đi qua `buildFilters` và báo lỗi rõ). select/multi_select: giữ
 * các giá trị còn tồn tại (đổi nhãn → value), hết giá trị nào thì bỏ cả điều kiện. Điều kiện khác giữ nguyên.
 */
export function pruneStaleFilter(def: ObjectDef, filter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(filter ?? {})) {
    const f = def.fields.find((x) => x.key === key);
    if (!f || !FILTERABLE_TYPES.includes(f.type)) continue;
    if (f.type === 'select' || f.type === 'multi_select') {
      const keep = asArray(v).filter((x): x is string => typeof x === 'string').flatMap((x) => {
        try { return choiceValues(f, x); } catch { return []; }
      });
      if (keep.length === 0) continue;
      out[key] = Array.isArray(v) ? keep : keep[0];
      continue;
    }
    out[key] = v;
  }
  return out;
}

/** `filter` = JSON `{khoá_trường: giá trị}`; chỉ trường SỐNG, kiểu cho phép lọc (không phone/text/url → chống dò). */
export function buildFilters(def: ObjectDef, raw: string | undefined): Prisma.Sql[] {
  if (!raw) return [];
  // Postgres không nhận NUL trong text (22021 → 500): chặn ngay cả dạng escape `\u0000` trong JSON.
  if (raw.includes('\u0000') || /\\u0000/i.test(raw)) throw new BadRequestException('Bộ lọc chứa ký tự không hợp lệ');
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { throw new BadRequestException('Bộ lọc không phải JSON hợp lệ'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new BadRequestException('Bộ lọc phải là object');
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length > LIMITS.maxFilterKeys) throw new BadRequestException(`Tối đa ${LIMITS.maxFilterKeys} bộ lọc`);
  const out: Prisma.Sql[] = [];
  for (const [key, v] of entries) {
    const f = def.fields.find((x) => x.key === key);
    if (!f || !FILTERABLE_TYPES.includes(f.type)) throw new BadRequestException(`Không lọc được theo trường “${key.slice(0, 30)}”`);
    out.push(...oneFilter(f, v));
  }
  return out;
}

export function whereSql(parts: Prisma.Sql[]): Prisma.Sql {
  return Prisma.join(parts.map((p) => Prisma.sql`(${p})`), ' AND ');
}
