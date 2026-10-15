import { PrismaService } from '@trinity/prisma';
import type { LeadScoringRules, LeadSignals } from './lead-scoring.rules';

/** Hoạt động hệ thống/nội bộ — KHÔNG tính là "tương tác với khách". */
export const NON_INTERACTION_ACTIONS = [
  'contact_transfer', 'transfer', 'stage_change', 'search', 'auth', 'password_change',
];

export interface ContactSignalRow {
  signals: LeadSignals;
}

/** Gom chữ từ `details`/`metadata` JSON của activity (note/tin nhắn) — chỉ giá trị chuỗi ở các khoá quen thuộc. */
export function extractText(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const keys = ['content', 'note', 'notes', 'text', 'message', 'body', 'description'];
  const o = json as Record<string, unknown>;
  return keys.map((k) => o[k]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

const DAY_MS = 86_400_000;

/** Gom tín hiệu cho cả lô khách bằng 3 truy vấn gộp (không N+1). Khách đã xoá/không tồn tại bị bỏ. */
export async function loadSignals(
  prisma: PrismaService,
  ids: number[],
  rules: LeadScoringRules,
  now: Date,
): Promise<Map<number, ContactSignalRow>> {
  const out = new Map<number, ContactSignalRow>();
  if (ids.length === 0) return out;
  const since = new Date(now.getTime() - rules.interactions.window_days * DAY_MS);
  const contacts = await prisma.contact.findMany({
    where: { id: { in: ids }, deleted_at: null },
    select: {
      id: true, phone: true, product_id: true, created_at: true,
      source: { select: { value: true } },
      stage: { select: { value: true } },
    },
  });
  const human = { contact_id: { in: contacts.map((c) => c.id) }, action: { notIn: NON_INTERACTION_ACTIONS } };
  const [last, recent, resp, intents] = await Promise.all([
    prisma.activity.groupBy({ by: ['contact_id'], where: human, _max: { created_at: true } }),
    prisma.activity.groupBy({ by: ['contact_id'], where: { ...human, created_at: { gte: since } }, _count: { _all: true } }),
    prisma.activity.groupBy({
      by: ['contact_id'],
      where: { contact_id: human.contact_id, action: { in: rules.response.actions } },
      _max: { created_at: true },
    }),
    prisma.leadAiIntent.findMany({ where: { contact_id: human.contact_id }, select: { contact_id: true, intent: true } }),
  ]);
  const intentBy = new Map(intents.map((r) => [r.contact_id, r.intent]));
  const lastBy = new Map(last.map((r) => [r.contact_id, r._max.created_at]));
  const countBy = new Map(recent.map((r) => [r.contact_id, r._count._all]));
  const respBy = new Map(resp.map((r) => [r.contact_id, r._max.created_at]));
  for (const c of contacts) {
    out.set(c.id, {
      signals: {
        phone: c.phone,
        has_demand: c.product_id !== null,
        stage_value: c.stage?.value ?? null,
        source_value: c.source?.value ?? null,
        last_activity_at: lastBy.get(c.id) ?? null,
        last_response_at: respBy.get(c.id) ?? null,
        interactions_in_window: countBy.get(c.id) ?? 0,
        ai_intent: intentBy.get(c.id) ?? null,
        created_at: c.created_at,
      },
    });
  }
  return out;
}

/** Ghi chú gần nhất của 1 khách (đưa agent AI của khách đọc qua MCP để chấm ý định): `reminder_notes` + tối đa 5 note mới nhất. */
export async function loadNoteText(prisma: PrismaService, contactId: number, reminderNotes: string): Promise<string> {
  const rows = await prisma.activity.findMany({
    where: { contact_id: contactId, action: 'note' },
    orderBy: { created_at: 'desc' },
    take: 5,
    select: { details: true },
  });
  return [reminderNotes, ...rows.flatMap((r) => extractText(r.details))].filter(Boolean).join('\n');
}
