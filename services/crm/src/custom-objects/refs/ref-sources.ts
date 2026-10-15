import { Prisma, type CustomObject } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { scopeWhere, type AuthUser, type ScopeService } from '@trinity/rbac-nest';
import { isObjectVisible, loadObjectAccess } from '../custom-object-access';
import { scopeSql, whereSql } from '../record-query';
import {
  buildKanbanBoardVisibilityWhere, buildKanbanCardScopeWhere, loadKanbanAccessContext, type KanbanAccessContext,
} from '../../kanban/common/kanban-rbac.helper';
import { CORE_TABLE_LABEL, type RefView } from './ref-types';

/**
 * Nguồn bản ghi cho gắn thẻ @ — MỌI truy vấn ở đây đã lọc theo quyền XEM của người dùng (bảng tuỳ biến: bảng được thấy +
 * phạm vi `custom_records.view`; khách: `contacts.view`; deal: `deals.view`; công việc: `kanban.view` + bảng kanban được thấy).
 * Không có quyền ⇒ nguồn đó trả rỗng (không lỗi, không lộ có/không).
 */
export interface RefAccess {
  user: AuthUser;
  objects: Map<number, CustomObject>;
  recordOwners: number[] | 'all' | null;
  contactOwners: number[] | 'all' | null;
  dealOwners: number[] | 'all' | null;
  kanban: KanbanAccessContext | null;
}

export async function loadRefAccess(prisma: PrismaService, scope: ScopeService, user: AuthUser): Promise<RefAccess> {
  const [access, objs, recordOwners, contactOwners, dealOwners, kanbanOwners] = await Promise.all([
    loadObjectAccess(prisma, user),
    prisma.customObject.findMany({ where: { deleted_at: null }, take: 200 }),
    scope.ownerIds(user, 'custom_records.view'),
    scope.ownerIds(user, 'contacts.view'),
    scope.ownerIds(user, 'deals.view'),
    scope.ownerIds(user, 'kanban.view'),
  ]);
  const kanban = kanbanOwners === null ? null : await loadKanbanAccessContext(prisma, scope, user);
  const objects = new Map(objs.filter((o) => isObjectVisible(o, access)).map((o) => [o.id, o]));
  return { user, objects, recordOwners, contactOwners, dealOwners, kanban };
}

interface RecordHit { id: number; code: string | null; title: string | null; object_id: number }

/** Bản ghi tuỳ biến khớp `cond` (SQL tham số hoá trên `custom_records`), chỉ bảng được thấy + trong phạm vi xem. */
export async function findRecords(prisma: PrismaService, acc: RefAccess, cond: Prisma.Sql, limit: number, order?: Prisma.Sql): Promise<RefView[]> {
  if (acc.recordOwners === null || acc.objects.size === 0 || limit <= 0) return [];
  const parts = [Prisma.sql`deleted_at IS NULL`, Prisma.sql`object_id = ANY(${[...acc.objects.keys()]}::int[])`, scopeSql(acc.recordOwners), cond];
  const rows = await prisma.$queryRaw<RecordHit[]>(Prisma.sql`
    SELECT id, code, title, object_id FROM custom_records WHERE ${whereSql(parts)} ORDER BY ${order ?? Prisma.sql`id DESC`} LIMIT ${limit}`);
  return rows.map((r) => {
    const o = acc.objects.get(r.object_id) as CustomObject;
    return { type: 'record', id: r.id, ref: `record:${r.id}`, code: r.code, title: r.title ?? `${o.label} #${r.id}`, table: o.label, table_key: o.key, href: `/x/${o.key}/${r.id}` };
  });
}

export async function findContacts(prisma: PrismaService, acc: RefAccess, where: Prisma.ContactWhereInput, limit: number): Promise<RefView[]> {
  if (acc.contactOwners === null || limit <= 0) return [];
  const rows = await prisma.contact.findMany({
    where: { AND: [{ deleted_at: null }, where, scopeWhere(acc.contactOwners, ['assigned_to', 'created_by_id'])] },
    orderBy: { id: 'desc' }, take: limit, select: { id: true, code: true, full_name: true },
  });
  return rows.map((c) => ({ type: 'contact', id: c.id, ref: `contact:${c.id}`, code: c.code, title: c.full_name || `Khách #${c.id}`, table: CORE_TABLE_LABEL.contact, href: `/contacts/${c.id}` }));
}

export async function findDeals(prisma: PrismaService, acc: RefAccess, where: Prisma.DealWhereInput, limit: number): Promise<RefView[]> {
  if (acc.dealOwners === null || limit <= 0) return [];
  const rows = await prisma.deal.findMany({
    where: { AND: [where, scopeWhere(acc.dealOwners, ['assigned_to', 'created_by'])] },
    orderBy: { id: 'desc' }, take: limit, select: { id: true, code: true, title: true, contact_id: true },
  });
  return rows.map((d) => ({ type: 'deal', id: d.id, ref: `deal:${d.id}`, code: d.code, title: d.title || `Deal #${d.id}`, table: CORE_TABLE_LABEL.deal, href: d.contact_id ? `/contacts/${d.contact_id}` : null }));
}

export async function findTasks(prisma: PrismaService, acc: RefAccess, where: Prisma.KanbanCardWhereInput, limit: number): Promise<RefView[]> {
  if (acc.kanban === null || limit <= 0) return [];
  const rows = await prisma.kanbanCard.findMany({
    where: { AND: [{ deleted_at: null }, where, buildKanbanCardScopeWhere(acc.kanban), { board: buildKanbanBoardVisibilityWhere(acc.user, acc.kanban) }] },
    orderBy: { id: 'desc' }, take: limit, select: { id: true, code: true, title: true },
  });
  return rows.map((t) => ({ type: 'task', id: t.id, ref: `task:${t.id}`, code: t.code, title: t.title || `Công việc #${t.id}`, table: CORE_TABLE_LABEL.task, href: `/kanban?card=${t.id}` }));
}
