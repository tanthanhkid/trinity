import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { makePhoneMasker, scopeWhere, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { isObjectVisible, loadObjectAccess, type ObjectAccess, type ObjectDef } from './custom-object-access';
import { formulaInput } from './field-values';
import type { FieldDef, RecordData } from './field-types';
import { evaluateFormula, parseFormula } from './formula/formula-parser';
import { RecordRefsService } from './refs/record-refs.service';
import { parseRef, type Ref, type RefView } from './refs/ref-types';

/** Hàng thô từ DB (đã lọc phạm vi). */
export interface RecordRow {
  id: number;
  data: unknown;
  title: string | null;
  /** Mã chung (HS001) — null chỉ khi DB chưa chạy migration mã. */
  code?: string | null;
  owner_id: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface RelationLabel {
  id: number;
  /** `null` = đã xoá hoặc ngoài phạm vi của bạn (KHÔNG lộ tiêu đề). */
  title: string | null;
  accessible: boolean;
  /** Chỉ trường "Liên kết": loại + mã + bảng + đường mở (đích người xem không thấy ⇒ chỉ còn `type`, `id`). */
  type?: Ref['type'];
  code?: string | null;
  table?: string;
  href?: string | null;
}

export interface RecordView {
  id: number;
  code: string | null;
  title: string;
  owner_id: number | null;
  owner_name: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  data: RecordData;
  relations: Record<string, RelationLabel | RelationLabel[]>;
}

const asData = (v: unknown): RecordData => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordData) : {});

export function idsOf(v: unknown): number[] {
  if (typeof v === 'number') return [v];
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

function linkLabels(v: unknown, links: Map<string, RefView>): RelationLabel[] {
  return (Array.isArray(v) ? v : []).map(parseRef).filter((r): r is Ref => !!r).map((r) => {
    const x = links.get(`${r.type}:${r.id}`);
    return x ? { id: r.id, type: r.type, title: x.title, accessible: true, code: x.code, table: x.table, href: x.href } : { id: r.id, type: r.type, title: null, accessible: false };
  });
}

/** Tính các trường công thức từ dữ liệu thô. Lỗi/thiếu dữ liệu → null (không ném). */
export function computeFormulas(fields: FieldDef[], data: RecordData): Record<string, number | null> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: Record<string, number | null> = {};
  for (const f of fields) {
    if (f.type !== 'formula' || !f.options.expression) continue;
    try {
      const ast = parseFormula(f.options.expression);
      out[f.key] = evaluateFormula(ast, (k) => {
        const ref = byKey.get(k);
        return ref ? formulaInput(ref.type, data[k]) : null;
      });
    } catch {
      out[f.key] = null;
    }
  }
  return out;
}

/**
 * Dựng bản ghi để TRẢ RA API: chỉ trường còn sống, che SĐT theo `custom_records.phone_full` (1 lần `ownerIds`),
 * tính công thức, và giải nhãn liên kết theo LÔ (1 truy vấn / đích) chỉ với bản ghi người xem được (không rò tiêu đề).
 */
@Injectable()
export class RecordPresenter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    @Optional() private readonly refs?: RecordRefsService,
  ) {}

  async present(def: ObjectDef, user: AuthUser, rows: RecordRow[]): Promise<RecordView[]> {
    if (rows.length === 0) return [];
    const phoneOwners = (await this.scope.ownerIds(user, 'custom_records.phone_full')) ?? [];
    const mask = makePhoneMasker(phoneOwners);
    const [labels, owners, links] = await Promise.all([this.resolveLabels(def, user, rows), this.ownerNames(rows), this.resolveLinks(def, user, rows)]);
    return rows.map((r) => {
      const raw = asData(r.data);
      const data: RecordData = {};
      const relations: RecordView['relations'] = {};
      const formulas = computeFormulas(def.fields, raw);
      for (const f of def.fields) {
        if (f.type === 'formula') { data[f.key] = formulas[f.key] ?? null; continue; }
        const v = raw[f.key];
        if (v === undefined || v === null) continue;
        data[f.key] = f.type === 'phone' && typeof v === 'string' ? mask([r.owner_id, r.created_by], v) : v;
        if (f.type === 'relation' || f.type === 'user') relations[f.key] = this.labelsFor(f, v, labels);
        if (f.type === 'link') relations[f.key] = linkLabels(v, links);
      }
      return {
        id: r.id, code: r.code ?? null, title: r.title ?? `${def.obj.label} #${r.id}`, owner_id: r.owner_id,
        owner_name: r.owner_id ? owners.get(r.owner_id) ?? null : null,
        created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, data, relations,
      };
    });
  }

  /** Thẻ của trường "Liên kết" (theo LÔ, chỉ bản ghi người xem thấy được). */
  private async resolveLinks(def: ObjectDef, user: AuthUser, rows: RecordRow[]): Promise<Map<string, RefView>> {
    const keys = def.fields.filter((f) => f.type === 'link').map((f) => f.key);
    if (keys.length === 0 || !this.refs) return new Map();
    const refs = rows.flatMap((r) => keys.flatMap((k) => { const v = asData(r.data)[k]; return Array.isArray(v) ? v.map(parseRef).filter((x): x is Ref => !!x) : []; }));
    return refs.length ? this.refs.resolveRefs(user, refs) : new Map();
  }

  private labelsFor(f: FieldDef, v: unknown, labels: Map<string, RelationLabel>): RelationLabel | RelationLabel[] {
    const kind = f.type === 'user' ? 'user' : f.options.target === 'contact' ? 'contact' : `obj${f.options.target_object_id}`;
    const one = (id: number): RelationLabel => labels.get(`${kind}:${id}`) ?? { id, title: null, accessible: false };
    return f.type === 'relation' && f.options.multiple ? idsOf(v).map(one) : one(idsOf(v)[0] ?? 0);
  }

  private async ownerNames(rows: RecordRow[]): Promise<Map<number, string>> {
    const ids = [...new Set(rows.map((r) => r.owner_id).filter((x): x is number => x != null))];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, full_name: true } });
    return new Map(users.map((u) => [u.id, u.full_name || `Nhân viên #${u.id}`]));
  }

  /** Nhãn cho mọi tham chiếu trong `rows`, khoá `obj<id>:<recId>` | `contact:<id>` | `user:<id>`. */
  private async resolveLabels(def: ObjectDef, user: AuthUser, rows: RecordRow[]): Promise<Map<string, RelationLabel>> {
    const out = new Map<string, RelationLabel>();
    const need = { objs: new Map<number, Set<number>>(), contact: new Set<number>(), user: new Set<number>() };
    for (const f of def.fields) {
      if (f.type !== 'relation' && f.type !== 'user') continue;
      for (const r of rows) {
        const ids = idsOf(asData(r.data)[f.key]);
        if (f.type === 'user') ids.forEach((i) => need.user.add(i));
        else if (f.options.target === 'contact') ids.forEach((i) => need.contact.add(i));
        else if (f.options.target_object_id) {
          const s = need.objs.get(f.options.target_object_id) ?? new Set<number>();
          ids.forEach((i) => s.add(i));
          need.objs.set(f.options.target_object_id, s);
        }
      }
    }
    await Promise.all([this.labelObjects(user, need.objs, out), this.labelContacts(user, need.contact, out), this.labelUsers(need.user, out)]);
    return out;
  }

  private async labelObjects(user: AuthUser, objs: Map<number, Set<number>>, out: Map<string, RelationLabel>): Promise<void> {
    if (objs.size === 0) return;
    const [access, owners, targets] = await Promise.all([
      loadObjectAccess(this.prisma, user),
      this.scope.ownerIds(user, 'custom_records.view'),
      this.prisma.customObject.findMany({ where: { id: { in: [...objs.keys()] }, deleted_at: null } }),
    ]);
    const visible = new Map(targets.filter((t) => isObjectVisible(t, access as ObjectAccess)).map((t) => [t.id, t]));
    for (const [objId, idSet] of objs) {
      const target = visible.get(objId);
      if (!target || owners === null) continue;
      const recs = await this.prisma.customRecord.findMany({
        where: { AND: [{ object_id: objId, deleted_at: null, id: { in: [...idSet] } }, scopeWhere(owners, ['owner_id', 'created_by'])] },
        select: { id: true, title: true },
      });
      for (const r of recs) out.set(`obj${objId}:${r.id}`, { id: r.id, title: r.title ?? `${target.label} #${r.id}`, accessible: true });
    }
  }

  private async labelContacts(user: AuthUser, ids: Set<number>, out: Map<string, RelationLabel>): Promise<void> {
    if (ids.size === 0) return;
    const owners = await this.scope.ownerIds(user, 'contacts.view');
    if (owners === null) return;
    const rows = await this.prisma.contact.findMany({
      where: { AND: [{ id: { in: [...ids] }, deleted_at: null }, scopeWhere(owners, ['assigned_to', 'created_by_id'])] },
      select: { id: true, full_name: true },
    });
    for (const c of rows) out.set(`contact:${c.id}`, { id: c.id, title: c.full_name || `Khách #${c.id}`, accessible: true });
  }

  private async labelUsers(ids: Set<number>, out: Map<string, RelationLabel>): Promise<void> {
    if (ids.size === 0) return;
    const users = await this.prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, full_name: true } });
    // Chỉ tên hiển thị — KHÔNG lùi về email (không lộ định danh của người ngoài phạm vi).
    for (const u of users) out.set(`user:${u.id}`, { id: u.id, title: u.full_name || `Nhân viên #${u.id}`, accessible: true });
  }
}
