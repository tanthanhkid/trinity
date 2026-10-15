import { Prisma } from '@prisma/client';
import type { ObjectDef } from '../../../custom-objects/custom-object-access';
import type { ActionDeps } from './action-types';

/**
 * Ảnh hưởng của một đề xuất đổi cấu trúc — hiện ở hộp đỏ màn duyệt. Có bản ghi bị ảnh hưởng ⇒ `confirm_label` = tên bảng,
 * người duyệt phải GÕ ĐÚNG mới duyệt được (BE kiểm, không chỉ FE).
 */
export interface Impact {
  affected_records: number;
  confirm_label: string | null;
  lines: string[];
  tables: { key: string; label: string; records: number }[];
}

export function makeImpact(tables: Impact['tables'], lines: string[], confirmLabel?: string): Impact {
  const affected = tables.reduce((s, t) => s + t.records, 0);
  return { affected_records: affected, confirm_label: affected > 0 ? (confirmLabel ?? tables.find((t) => t.records > 0)?.label ?? null) : null, lines: lines.slice(0, 12), tables: tables.slice(0, 20) };
}

export async function countRecords(deps: ActionDeps, objectId: number): Promise<number> {
  return deps.prisma.customRecord.count({ where: { object_id: objectId, deleted_at: null } });
}

/** Số bản ghi ĐANG CÓ giá trị ở trường `key`. */
export async function countWithValue(deps: ActionDeps, objectId: number, key: string): Promise<number> {
  const r = await deps.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM custom_records WHERE object_id = ${objectId} AND deleted_at IS NULL AND data ? ${key} AND data -> ${key} <> 'null'::jsonb`);
  return r[0]?.n ?? 0;
}

/** Số bản ghi ĐANG DÙNG một trong các lựa chọn `values` của trường select / multi_select. */
export async function countUsingChoices(deps: ActionDeps, objectId: number, key: string, multi: boolean, values: string[]): Promise<number> {
  if (values.length === 0) return 0;
  const cond = multi
    ? Prisma.sql`jsonb_typeof(data -> ${key}) = 'array' AND (data -> ${key}) ?| ${values}::text[]`
    : Prisma.sql`(data ->> ${key}) = ANY(${values}::text[])`;
  const r = await deps.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM custom_records WHERE object_id = ${objectId} AND deleted_at IS NULL AND ${cond}`);
  return r[0]?.n ?? 0;
}

const DISPLAY_KEYS = ['label', 'help_text', 'show_in_list'];

/**
 * Ảnh hưởng của sửa trường: đổi nhãn/ghi chú/hiện cột = 0 bản ghi. Sửa LỰA CHỌN = số bản ghi DÙNG lựa chọn bị bỏ (vd bỏ
 * 1 lựa chọn báo số bản ghi thật sự dùng nó, không phải cả bảng); đổi tên/màu/thứ tự lựa chọn = 0. Cờ khác (bắt buộc, duy nhất, tiêu đề, công thức) = số bản
 * ghi có dữ liệu ở trường (bắt buộc: + số bản ghi đang trống).
 */
export async function fieldImpact(deps: ActionDeps, def: ObjectDef, fieldKey: string, patch: Record<string, unknown>): Promise<Impact> {
  const f = def.fields.find((x) => x.key === fieldKey);
  const keys = Object.keys(patch);
  if (!f || keys.every((k) => DISPLAY_KEYS.includes(k))) return makeImpact([], [`Chỉ đổi cách hiển thị trường “${f?.label ?? fieldKey}”, dữ liệu không đổi.`]);
  const lines: string[] = [];
  let affected = 0;
  if (patch.options && f.options.choices) {
    const next = ((patch.options as { choices?: ({ label: string; value?: string } | string)[] }).choices ?? []).map((c) => (typeof c === 'string' ? c : (c.value ?? c.label)));
    const gone = f.options.choices.filter((c) => !next.includes(c.value) && !next.includes(c.label));
    if (gone.length) {
      affected = await countUsingChoices(deps, def.obj.id, f.key, f.type === 'multi_select', gone.map((c) => c.value));
      lines.push(`${affected} bản ghi của “${def.obj.label}” đang dùng lựa chọn bị bỏ: ${gone.map((c) => c.label).join(', ')} (lựa chọn còn bản ghi dùng sẽ bị chặn lúc duyệt).`);
    } else lines.push(`Chỉ đổi tên/màu/thứ tự lựa chọn của “${f.label}”; dữ liệu không đổi.`);
  }
  if (keys.some((k) => !DISPLAY_KEYS.includes(k) && k !== 'options')) {
    const withValue = await countWithValue(deps, def.obj.id, fieldKey);
    affected = Math.max(affected, withValue);
    lines.unshift(`${withValue} bản ghi của “${def.obj.label}” đang có dữ liệu ở trường “${f.label}”.`);
    if (patch.required === true && !f.required) {
      const total = await countRecords(deps, def.obj.id);
      lines.push(`${Math.max(total - withValue, 0)} bản ghi đang TRỐNG trường này sẽ bị báo lỗi bắt buộc khi sửa lần sau.`);
    }
    if (patch.is_title === true) lines.push('Đổi trường tiêu đề: tiêu đề của MỌI bản ghi được tính lại.');
  }
  return makeImpact([{ key: def.obj.key, label: def.obj.label, records: affected }], lines);
}
