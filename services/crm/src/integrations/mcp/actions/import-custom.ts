import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject, type ObjectDef } from '../../../custom-objects/custom-object-access';
import type { RecordData } from '../../../custom-objects/field-types';
import { titleOf } from '../../../custom-objects/record-events';
import { ActionUserError, type ActionDeps } from './action-types';
import { viValidation } from './action-helpers';
import { isPlaceholder, RefResolver, type Pending } from './ref-resolver';

const LOCK_NS = 7373;
/** Dòng lỗi báo cho AI: `row` = số thứ tự dòng (1-based) trong lô AI gửi lên. */
export interface RowError { row: number; reason: string; object?: string }
/** `rowNumbers[i]` = số dòng gốc (1-based) của `valid[i]` — để lỗi lúc ghi vẫn trỏ đúng dòng AI gửi. */
export interface Checked { valid: RecordData[]; errors: RowError[]; rowNumbers: number[] }

/** Trần số dòng lỗi trả về chi tiết (tổng số luôn có trong `error_total`). */
export const MAX_REPORTED_ERRORS = 50;

/** Gói lỗi cho kết quả: tối đa MAX_REPORTED_ERRORS dòng (theo thứ tự dòng) + tổng số. */
export function reportErrors(errors: RowError[]): { errors: RowError[]; error_total: number } {
  const sorted = [...errors].sort((a, b) => a.row - b.row);
  return { errors: sorted.slice(0, MAX_REPORTED_ERRORS), error_total: errors.length };
}

/** Câu ngắn nêu vài dòng lỗi đầu, vd "dòng 3: Trường không tồn tại: foo; dòng 7: …". */
export function errorPreview(errors: RowError[], n = 3): string {
  return [...errors].sort((a, b) => a.row - b.row).slice(0, n)
    .map((e) => `${e.object ? `${e.object} ` : ''}dòng ${e.row}: ${e.reason.length > 80 ? `${e.reason.slice(0, 80)}…` : e.reason}`).join('; ');
}

export const errText = (e: unknown): string => {
  if (e instanceof BadRequestException) {
    const r = e.getResponse() as { message?: string | string[]; errors?: Record<string, string> };
    if (r.errors) return Object.entries(r.errors).map(([k, m]) => `${k.slice(0, 40)}: ${m}`).join('; ');
    // Thông điệp class-validator (ValidationPipe trả mảng, validateDto đã dịch sẵn) — dịch phần còn tiếng Anh.
    return Array.isArray(r.message) ? r.message.map(viValidation).join('; ') : viValidation(r.message ?? e.message);
  }
  if (e instanceof ActionUserError) return e.message;
  throw e;
};

/** Định nghĩa dùng để kiểm dòng khi vài trường liên kết còn chờ bảng trước: trường đó tạm không bắt buộc. */
const relaxed = (def: ObjectDef, keys: string[]): ObjectDef => (keys.length ? { ...def, fields: def.fields.map((f) => (keys.includes(f.key) ? { ...f, required: false } : f)) } : def);

/**
 * Kiểm từng dòng bằng ĐÚNG validator của form web + trùng "duy nhất" (trong lô và với dữ liệu đã có). Liên kết theo mã / khoá
 * nghiệp vụ được ghép trước (RefResolver); trường còn chờ bảng đi trước giữ chỗ trống `{"$key": …}` để ghép lúc duyệt.
 */
export async function checkCustom(deps: ActionDeps, user: AuthUser, def: ObjectDef, rows: Record<string, unknown>[], pending?: Pending): Promise<Checked> {
  const valid: RecordData[] = [];
  const errors: RowError[] = [];
  const rowNumbers: number[] = [];
  const uniq = def.fields.filter((f) => f.is_unique);
  const seen = new Map<string, Set<string>>(uniq.map((f) => [f.key, new Set<string>()]));
  const resolver = new RefResolver(deps, user);
  await resolver.prime(def, rows);
  for (const [i, raw] of rows.entries()) {
    try {
      const r = resolver.resolveRow(def, raw, pending);
      if (r.error) throw new ActionUserError(r.error);
      const held = Object.fromEntries(r.deferred.map((k) => [k, r.row[k]]));
      const input = Object.fromEntries(Object.entries(r.row).filter(([k]) => !r.deferred.includes(k)));
      const v = await deps.validator.validate(relaxed(def, r.deferred), user, input, null);
      for (const f of uniq) {
        const val = v.data[f.key];
        if (val === undefined || val === null) continue;
        const norm = String(val).toLowerCase();
        if (seen.get(f.key)?.has(norm)) throw new ActionUserError(`“${f.label}” trùng với dòng khác trong lô`);
        seen.get(f.key)?.add(norm);
      }
      await deps.validator.assertUnique(deps.prisma, def, v.data, Object.keys(v.data), null);
      valid.push({ ...v.data, ...held });
      rowNumbers.push(i + 1);
    } catch (e) {
      errors.push({ row: i + 1, reason: errText(e) });
    }
  }
  return { valid, errors, rowNumbers };
}

const hasPlaceholder = (d: RecordData): boolean => Object.values(d).some((v) => isPlaceholder(v) || (Array.isArray(v) && v.some(isPlaceholder)));

/**
 * Ghi các dòng của MỘT bảng tuỳ biến trong một giao dịch (lỗi ⇒ không ghi dòng nào). Kiểm lại theo định nghĩa HIỆN TẠI; chỗ trống
 * `{"$key"}` được ghép lúc này (bảng đi trước đã ghi xong). Trả id mới để bù trừ nếu bảng sau lỗi.
 */
export async function writeCustom(deps: ActionDeps, user: AuthUser, key: string, rows: RecordData[]): Promise<{ result: Record<string, unknown>; ids: number[] }> {
  const def = await loadVisibleObject(deps.prisma, user, key);
  const checked = await checkCustom(deps, user, def, rows);
  if (checked.errors.length || checked.valid.some(hasPlaceholder)) {
    const e = checked.errors[0];
    throw new BadRequestException(`Bảng “${def.obj.label_plural}”: ${checked.errors.length || 1} dòng không còn hợp lệ${e ? ` (vd dòng ${e.row}: ${e.reason})` : ''}. Hãy nhờ AI đề xuất lại.`);
  }
  const targets = await Promise.all(checked.valid.map((d) => deps.links.targetsFor(def, user, d)));
  const saved = await deps.prisma.$transaction(async (tx) => {
    if (def.fields.some((f) => f.is_unique)) await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${def.obj.id}::int)`);
    for (const d of checked.valid) await deps.validator.assertUnique(tx, def, d, Object.keys(d), null);
    // createManyAndReturn giữ đúng thứ tự dòng ⇒ ghép được cạnh liên kết (thẻ @ / trường Liên kết) cho từng bản ghi mới.
    const made = await tx.customRecord.createManyAndReturn({ data: checked.valid.map((d) => ({ object_id: def.obj.id, data: d as Prisma.InputJsonValue, title: titleOf(def, d), owner_id: user.userId, created_by: user.userId })), select: { id: true, code: true } });
    for (const [i, r] of made.entries()) await deps.links.sync(tx, { type: 'record', id: r.id }, targets[i], user.userId);
    return made;
  }, { timeout: 60_000 });
  const codes = saved.map((r) => r.code).filter((c): c is string => !!c);
  return {
    result: { object: key, created: saved.length, codes: codes.length > 6 ? `${codes[0]} … ${codes[codes.length - 1]}` : codes.join(', '), open_at: `/x/${key}` },
    ids: saved.map((r) => r.id),
  };
}

/** Nhiều bảng trong MỘT lần duyệt, đúng thứ tự (bảng cha trước). Bảng sau lỗi ⇒ xoá hẳn bản ghi vừa tạo của bảng trước (không nửa vời). */
export async function writeTables(deps: ActionDeps, user: AuthUser, tables: { object: string; rows: RecordData[] }[]): Promise<Record<string, unknown>> {
  const done: Record<string, unknown>[] = [];
  const made: number[] = [];
  try {
    for (const t of tables) {
      const r = await writeCustom(deps, user, t.object, t.rows);
      done.push(r.result);
      made.push(...r.ids);
    }
  } catch (e) {
    if (made.length) {
      await deps.prisma.recordLink.deleteMany({ where: { source_type: 'record', source_id: { in: made } } }).catch(() => undefined);
      await deps.prisma.customRecord.deleteMany({ where: { id: { in: made }, created_by: user.userId } }).catch(() => undefined);
    }
    throw e;
  }
  return tables.length === 1 ? done[0] : { tables: done, created: done.reduce((s, d) => s + Number(d.created ?? 0), 0) };
}
