import { Prisma } from '@prisma/client';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject, type ObjectDef } from '../../../custom-objects/custom-object-access';
import type { FieldDef } from '../../../custom-objects/field-types';
import { parseCode } from '../../../custom-objects/record-codes';
import { scopeSql } from '../../../custom-objects/record-query';
import type { RefView } from '../../../custom-objects/refs/ref-types';
import { ActionUserError, type ActionDeps } from './action-types';

/**
 * Ghép LIÊN KẾT khi AI ghi dữ liệu (import_records, create_record, update_record): giá trị của trường relation / link có thể là
 *  - id số (như cũ) · mã chung `"HS001"` · khoá nghiệp vụ `{"ma_kh": "C001"}` (relation: tìm trong bảng đích theo trường ma_kh;
 *    link: thêm `"object": "khach_hang"`). Tìm theo phạm vi XEM của người ghi; trùng hai bản ghi ⇒ lỗi (không đoán).
 *  - Khoá nghiệp vụ chưa có trong DB nhưng có trong BẢNG ĐI TRƯỚC của cùng lượt import ⇒ để lại chỗ trống `{"$key": …}`,
 *    ghép lúc duyệt (sau khi bảng trước đã ghi) — khỏi phải duyệt lô cha rồi mới gửi lô con.
 */
export interface KeyRef { object: string; field: string; value: string }
export type Pending = Map<string, Map<string, Set<string>>>;
const KEY_TYPES = ['text', 'number', 'email', 'url', 'date'];
const norm = (v: unknown): string => String(v).trim().toLowerCase();

export function isPlaceholder(v: unknown): v is { $key: KeyRef } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && '$key' in (v as object);
}

/** Bảng ghi lại các giá trị của bảng đi trước (để bảng sau tham chiếu theo khoá nghiệp vụ). */
export function remember(pending: Pending, objectKey: string, rows: Record<string, unknown>[]): void {
  const byField = pending.get(objectKey) ?? new Map<string, Set<string>>();
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'string' || typeof v === 'number') (byField.get(k) ?? byField.set(k, new Set()).get(k))?.add(norm(v));
  pending.set(objectKey, byField);
}

export class RefResolver {
  private codes = new Map<string, RefView>();
  private keys = new Map<string, number[]>();
  private defs = new Map<string, ObjectDef | null>();
  private targets = new Map<number, string>();

  constructor(private readonly deps: ActionDeps, private readonly user: AuthUser) {}

  /** Tra trước (theo lô) mọi mã + khoá nghiệp vụ xuất hiện trong `rows`. */
  async prime(def: ObjectDef, rows: Record<string, unknown>[]): Promise<void> {
    const ids = refFields(def).map((f) => f.options.target_object_id).filter((x): x is number => typeof x === 'number');
    if (ids.length) (await this.deps.prisma.customObject.findMany({ where: { id: { in: ids } }, select: { id: true, key: true } })).forEach((o) => this.targets.set(o.id, o.key));
    const codes = new Set<string>();
    const keys: KeyRef[] = [];
    for (const f of refFields(def)) {
      for (const r of rows) {
        for (const item of asList(r[f.key])) {
          if (typeof item === 'string' && parseCode(item.replace(/^@/, ''))) codes.add(parseCode(item.replace(/^@/, ''))?.code as string);
          const k = isPlaceholder(item) ? item.$key : this.keyOf(def, f, item);
          if (k) keys.push(k);
        }
      }
    }
    if (codes.size) this.codes = await this.deps.refs.resolveCodes(this.user, [...codes]);
    await this.lookupKeys(keys);
  }

  /** Đổi giá trị liên kết của một dòng; trả `deferred` = trường còn chỗ trống chờ bảng trước, `error` = không ghép được. */
  resolveRow(def: ObjectDef, row: Record<string, unknown>, pending?: Pending): { row: Record<string, unknown>; deferred: string[]; error?: string } {
    const out = { ...row };
    const deferred: string[] = [];
    for (const f of refFields(def)) {
      if (row[f.key] === undefined || row[f.key] === null) continue;
      const items: unknown[] = [];
      for (const item of asList(row[f.key])) {
        const r = this.resolveItem(def, f, item, pending);
        if ('error' in r) return { row, deferred, error: `${f.key}: ${r.error}` };
        if ('placeholder' in r) deferred.push(f.key);
        items.push('placeholder' in r ? r.placeholder : r.value);
      }
      out[f.key] = Array.isArray(row[f.key]) || (f.type === 'relation' && f.options.multiple) || f.type === 'link' ? items : items[0];
    }
    return { row: out, deferred: [...new Set(deferred)] };
  }

  private resolveItem(def: ObjectDef, f: FieldDef, item: unknown, pending?: Pending): { value: unknown } | { placeholder: { $key: KeyRef } } | { error: string } {
    if (typeof item === 'number' || (typeof item === 'string' && /^(record|contact|deal|task):\d+$/.test(item))) return { value: item };
    if (typeof item === 'string') {
      const c = parseCode(item.replace(/^@/, ''));
      if (!c) return { error: `“${item.slice(0, 30)}” không phải id, mã (HS001) hay khoá nghiệp vụ {"trường": "giá trị"}` };
      if (f.type === 'link') return { value: c.code };
      const v = this.codes.get(c.code);
      const okTarget = v && (f.options.target === 'contact' ? v.type === 'contact' : v.type === 'record' && v.table_key === this.targetKey(f));
      return okTarget ? { value: v.id } : { error: `không tìm thấy ${c.code} trong bảng đích (hoặc bạn không có quyền xem)` };
    }
    const k = isPlaceholder(item) ? item.$key : this.keyOf(def, f, item);
    if (!k) return { error: 'giá trị liên kết phải là id, mã (HS001) hoặc {"trường_khoá": "giá trị"}' };
    const ids = this.keys.get(`${k.object}|${k.field}|${norm(k.value)}`) ?? [];
    if (ids.length > 1) return { error: `có ${ids.length} bản ghi ${k.object}.${k.field} = “${k.value}” — khoá không duy nhất, hãy dùng mã` };
    if (ids.length === 1) return { value: f.type === 'link' ? `record:${ids[0]}` : ids[0] };
    if (pending?.get(k.object)?.get(k.field)?.has(norm(k.value))) return { placeholder: { $key: k } };
    return { error: `không tìm thấy ${k.object}.${k.field} = “${k.value}” (chưa có, hoặc bảng đó chưa được nhập TRƯỚC trong cùng lượt)` };
  }

  private targetKey(f: FieldDef): string | undefined {
    return typeof f.options.target_object_id === 'number' ? this.targets.get(f.options.target_object_id) : undefined;
  }

  private keyOf(_def: ObjectDef, f: FieldDef, item: unknown): KeyRef | null {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    const entries = Object.entries(o).filter(([k]) => k !== 'object');
    if (entries.length !== 1 || (typeof entries[0][1] !== 'string' && typeof entries[0][1] !== 'number')) return null;
    // relation: bảng đích là bảng của trường (bỏ qua "object" AI ghi thừa); link: bắt buộc "object". Khách hàng không tra theo khoá (chỉ mã).
    const object = f.type === 'link' ? (typeof o.object === 'string' ? o.object : '') : (this.targetKey(f) ?? '');
    return object ? { object, field: entries[0][0], value: String(entries[0][1]) } : null;
  }

  private async lookupKeys(keys: KeyRef[]): Promise<void> {
    const groups = new Map<string, { object: string; field: string; values: Set<string> }>();
    for (const k of keys) {
      const g = groups.get(`${k.object}|${k.field}`) ?? { object: k.object, field: k.field, values: new Set<string>() };
      g.values.add(norm(k.value));
      groups.set(`${k.object}|${k.field}`, g);
    }
    if (groups.size === 0) return;
    const owners = await this.deps.scope.ownerIds(this.user, 'custom_records.view');
    for (const g of groups.values()) {
      const def = await this.def(g.object);
      const f = def?.fields.find((x) => x.key === g.field);
      if (!def) throw new ActionUserError(`Liên kết theo khoá: không có bảng “${g.object}” (hoặc bạn không được thấy).`);
      if (!f || !KEY_TYPES.includes(f.type)) throw new ActionUserError(`Liên kết theo khoá: bảng “${g.object}” không có trường “${g.field}” kiểu văn bản/số/email/ngày để tra.`);
      if (owners === null) continue;
      const rows = await this.deps.prisma.$queryRaw<{ id: number; v: string }[]>(Prisma.sql`
        SELECT id, lower(data ->> ${f.key}) AS v FROM custom_records
        WHERE object_id = ${def.obj.id} AND deleted_at IS NULL AND ${scopeSql(owners)} AND lower(data ->> ${f.key}) = ANY(${[...g.values]}::text[])`);
      for (const r of rows) {
        const key = `${g.object}|${g.field}|${r.v}`;
        this.keys.set(key, [...(this.keys.get(key) ?? []), r.id]);
      }
    }
  }

  private async def(key: string): Promise<ObjectDef | null> {
    if (!this.defs.has(key)) this.defs.set(key, await loadVisibleObject(this.deps.prisma, this.user, key).catch(() => null));
    return this.defs.get(key) ?? null;
  }
}

function refFields(def: ObjectDef): FieldDef[] {
  return def.fields.filter((f) => f.type === 'relation' || f.type === 'link');
}

function asList(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
