import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import type { StaleWorkConfig } from './stale-work.config';

export interface OwnerStats {
  silent_contacts: number;
  silent_deals: number;
  overdue_tasks: number;
  missed_reminders: number;
}

export const emptyStats = (): OwnerStats => ({ silent_contacts: 0, silent_deals: 0, overdue_tasks: 0, missed_reminders: 0 });
export const totalOf = (s: OwnerStats): number => s.silent_contacts + s.silent_deals + s.overdue_tasks + s.missed_reminders;

export function addStats(a: OwnerStats, b: OwnerStats): OwnerStats {
  return {
    silent_contacts: a.silent_contacts + b.silent_contacts,
    silent_deals: a.silent_deals + b.silent_deals,
    overdue_tasks: a.overdue_tasks + b.overdue_tasks,
    missed_reminders: a.missed_reminders + b.missed_reminders,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Lịch hẹn nhắc lỡ quá 30 ngày coi là đã bỏ — không nhắc mãi. */
const REMINDER_LOOKBACK_DAYS = 30;
/** Hoạt động hệ thống không tính là "đã liên hệ lại". */
const SYSTEM_ACTIONS = ['contact_transfer', 'transfer', 'stage_change', 'search', 'auth', 'password_change'];

/**
 * Quét 4 loại việc treo, gộp theo NGƯỜI PHỤ TRÁCH. Mỗi loại 1 truy vấn gộp (groupBy/GROUP BY), không N+1.
 * Chỉ tính việc đã có người phụ trách (không ai nhận thì không có ai để nhắc).
 */
export async function scanStale(prisma: PrismaService, cfg: StaleWorkConfig, now: Date): Promise<Map<number, OwnerStats>> {
  const out = new Map<number, OwnerStats>();
  const bump = (owner: number | null, key: keyof OwnerStats, n: number): void => {
    if (owner === null || n <= 0) return;
    const cur = out.get(owner) ?? emptyStats();
    cur[key] += n;
    out.set(owner, cur);
  };
  const contactCut = new Date(now.getTime() - cfg.contact_days * DAY_MS);
  const dealCut = new Date(now.getTime() - cfg.deal_days * DAY_MS);
  const noRecent = (cut: Date): Prisma.ContactWhereInput => ({ activities: { none: { created_at: { gte: cut }, action: { notIn: SYSTEM_ACTIONS } } } });

  const [contacts, deals, tasks, callbacks] = await Promise.all([
    prisma.contact.groupBy({
      by: ['assigned_to'],
      where: { deleted_at: null, assigned_to: { not: null }, created_at: { lt: contactCut }, ...noRecent(contactCut) },
      _count: { _all: true },
    }),
    prisma.deal.groupBy({
      by: ['assigned_to'],
      where: { status: 'open', updated_at: { lt: dealCut }, OR: [{ contact_id: null }, { contact: noRecent(dealCut) }] },
      _count: { _all: true },
    }),
    prisma.kanbanCard.groupBy({
      by: ['assignee_id'],
      where: { deleted_at: null, completed_at: null, due_completed_at: null, due_at: { lt: now }, assignee_id: { not: null } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<{ owner: number; n: number }[]>(Prisma.sql`
      SELECT c.assigned_to AS owner, COUNT(*)::int AS n FROM contacts c
      WHERE c.deleted_at IS NULL AND c.assigned_to IS NOT NULL
        AND c.reminder_at < ${new Date(now.getTime() - cfg.reminder_grace_hours * HOUR_MS)}
        AND c.reminder_at > ${new Date(now.getTime() - REMINDER_LOOKBACK_DAYS * DAY_MS)}
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id AND a.created_at >= c.reminder_at
                        AND a.action NOT IN (${Prisma.join(SYSTEM_ACTIONS)}))
      GROUP BY c.assigned_to`),
  ]);
  for (const r of contacts) bump(r.assigned_to, 'silent_contacts', r._count._all);
  for (const r of deals) bump(r.assigned_to, 'silent_deals', r._count._all);
  for (const r of tasks) bump(r.assignee_id, 'overdue_tasks', r._count._all);
  for (const r of callbacks) bump(r.owner, 'missed_reminders', r.n);
  return out;
}

/** Câu mô tả cho thông báo: "5 khách im lặng quá 7 ngày, 2 việc quá hạn…". */
export function describeStats(s: OwnerStats, cfg: StaleWorkConfig): string {
  const parts: string[] = [];
  if (s.silent_contacts) parts.push(`${s.silent_contacts} khách im lặng quá ${cfg.contact_days} ngày`);
  if (s.silent_deals) parts.push(`${s.silent_deals} deal đứng yên quá ${cfg.deal_days} ngày`);
  if (s.overdue_tasks) parts.push(`${s.overdue_tasks} việc quá hạn`);
  if (s.missed_reminders) parts.push(`${s.missed_reminders} lịch hẹn nhắc bị lỡ`);
  return parts.join(', ');
}
