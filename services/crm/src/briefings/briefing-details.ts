import type { PrismaService } from '@trinity/prisma';
import type { Prisma } from '@trinity/prisma';
import { scopeWhere } from '@trinity/rbac-nest';
import { buildContactScope } from '../reports/dashboard-overview.scope';
import { slotWindows } from './briefing-time';
import type { BriefingSlot } from './briefing.types';

type Owner = number[] | 'all';

/** Số dòng tối đa mỗi danh sách — đủ để agent viết bản tin, không phình kết quả MCP. */
export const DETAIL_LIMIT = 15;

/**
 * Danh sách chi tiết đi kèm số liệu bản tin (khách mới, việc quá hạn, lịch hẹn nhắc, lead nóng) — THEO PHẠM VI QUYỀN `owner`
 * (cùng phạm vi với số liệu). Không có AI: agent của khách (ChatGPT/Claude… qua MCP) đọc dữ liệu này rồi tự viết bản tin.
 * Không trả SĐT; lớp `wrapData` của MCP che thêm số trong văn bản tự do.
 */
export interface BriefingDetails {
  new_contacts: { id: number; name: string | null; source: string | null; owner: string | null; created_at: Date }[];
  overdue_tasks: { id: number; title: string; due_at: Date | null; owner: string | null }[];
  callbacks: { id: number; name: string | null; reminder_at: Date | null; note: string | null; owner: string | null }[];
  hot_leads: { id: number; name: string | null; score: number | null; label: string | null; owner: string | null }[];
}

const EMPTY: BriefingDetails = { new_contacts: [], overdue_tasks: [], callbacks: [], hot_leads: [] };
const OWNER = { assigned_user: { select: { full_name: true } } } as const;

export async function collectBriefingDetails(prisma: PrismaService, owner: Owner, slot: BriefingSlot, now: Date): Promise<BriefingDetails> {
  if (owner !== 'all' && owner.length === 0) return { ...EMPTY };
  const w = slotWindows(slot, now);
  const scope = buildContactScope(owner);
  const [created, tasks, cbs, hot] = await Promise.all([
    prisma.contact.findMany({
      where: { AND: [scope, { created_at: { gte: w.cur.start, lt: w.cur.end } }] },
      orderBy: { created_at: 'desc' },
      take: DETAIL_LIMIT,
      select: { id: true, full_name: true, created_at: true, source: { select: { label: true } }, ...OWNER },
    }),
    prisma.kanbanCard.findMany({
      where: {
        AND: [
          scopeWhere(owner, ['assignee_id']) as Prisma.KanbanCardWhereInput,
          { deleted_at: null, completed_at: null, due_completed_at: null, due_at: { lt: now } },
        ],
      },
      orderBy: { due_at: 'asc' },
      take: DETAIL_LIMIT,
      select: { id: true, title: true, due_at: true, assignee_id: true },
    }),
    prisma.contact.findMany({
      where: { AND: [scope, { reminder_at: { gte: w.callbacks.start, lt: w.callbacks.end } }] },
      orderBy: { reminder_at: 'asc' },
      take: DETAIL_LIMIT,
      select: { id: true, full_name: true, reminder_at: true, reminder_notes: true, ...OWNER },
    }),
    prisma.contact.findMany({
      where: { AND: [scope, { lead_label: { in: ['hot', 'warm'] } }] },
      orderBy: [{ lead_score: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: DETAIL_LIMIT,
      select: { id: true, full_name: true, lead_score: true, lead_label: true, ...OWNER },
    }),
  ]);
  const ids = [...new Set(tasks.map((t) => t.assignee_id).filter((x): x is number => x != null))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, full_name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.full_name]));
  return {
    new_contacts: created.map((c) => ({ id: c.id, name: c.full_name, source: c.source?.label ?? null, owner: c.assigned_user?.full_name ?? null, created_at: c.created_at })),
    overdue_tasks: tasks.map((t) => ({ id: t.id, title: t.title, due_at: t.due_at, owner: t.assignee_id != null ? names.get(t.assignee_id) ?? null : null })),
    callbacks: cbs.map((c) => ({ id: c.id, name: c.full_name, reminder_at: c.reminder_at, note: c.reminder_notes, owner: c.assigned_user?.full_name ?? null })),
    hot_leads: hot.map((c) => ({ id: c.id, name: c.full_name, score: c.lead_score, label: c.lead_label, owner: c.assigned_user?.full_name ?? null })),
  };
}
