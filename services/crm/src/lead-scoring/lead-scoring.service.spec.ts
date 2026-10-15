import { LeadScoringService } from './lead-scoring.service';
import { LeadIntentService } from './lead-intent.service';
import { LeadScoringController } from './lead-scoring.controller';
import { NotFoundException } from '@nestjs/common';

const NOW = new Date('2026-10-07T03:00:00Z');
const ON = { isEnabled: jest.fn(async () => true) };
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

type M = jest.Mock;
interface FakePrisma {
  setting: { findUnique: M; upsert: M };
  contact: { findMany: M; findFirst: M; findUnique: M };
  activity: { groupBy: M; findMany: M };
  integrationEvent: { aggregate: M; findMany: M };
  leadAiIntent: { findMany: M; upsert: M };
  $executeRaw: M;
}

function makePrisma(over: Partial<FakePrisma> = {}) {
  const settings = new Map<string, string>();
  const prisma: FakePrisma = {
    setting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { value: settings.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        settings.set(where.key, create.value);
      }),
    },
    contact: {
      findMany: jest.fn(async (): Promise<unknown[]> => [
        { id: 1, phone: '0912345678', product_id: 3, created_at: ago(30), reminder_notes: '', source: { value: 'referral' }, stage: { value: 'follow_up_3' } },
      ]),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    activity: {
      groupBy: jest.fn(async (args: { _count?: unknown; where: { action?: { in?: string[] } } }) => {
        if (args._count) return [{ contact_id: 1, _count: { _all: 6 } }];
        return [{ contact_id: 1, _max: { created_at: args.where.action?.in ? ago(1) : ago(0.5) } }];
      }),
      findMany: jest.fn(async () => []),
    },
    integrationEvent: { aggregate: jest.fn(async () => ({ _max: { id: BigInt(10) } })), findMany: jest.fn(async (): Promise<unknown[]> => []) },
    leadAiIntent: { findMany: jest.fn(async (): Promise<unknown[]> => []), upsert: jest.fn(async () => ({})) },
    $executeRaw: jest.fn(async () => 1),
    ...over,
  };
  return { prisma, settings };
}

describe('LeadScoringService', () => {
  it('recompute: chấm theo quy tắc mặc định và ghi bằng SQL thô (không nhảy updated_at)', async () => {
    const { prisma } = makePrisma();
    const svc = new LeadScoringService(prisma as never, ON as never);
    expect(await svc.recompute([1], NOW)).toBe(1);
    const sql = (prisma.$executeRaw.mock.calls[0] as unknown[])[0] as { values: unknown[]; strings: string[] };
    expect(sql.strings.join('?')).toContain('UPDATE contacts SET lead_score');
    expect(sql.values[0]).toBe(100);
    expect(sql.values[1]).toBe('hot');
  });

  it('recompute: khách không còn (đã xoá) thì bỏ qua', async () => {
    const { prisma } = makePrisma({ contact: { findMany: jest.fn(async () => []), findFirst: jest.fn(), findUnique: jest.fn() } });
    const svc = new LeadScoringService(prisma as never, ON as never);
    expect(await svc.recompute([99], NOW)).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('saveRules chuẩn hoá rác về mặc định rồi getRules đọc lại đúng', async () => {
    const { prisma } = makePrisma();
    const svc = new LeadScoringService(prisma as never, ON as never);
    const saved = await svc.saveRules({ thresholds: { hot: 80, warm: 50 }, junk: 1 }, 7);
    expect(saved.thresholds).toEqual({ hot: 80, warm: 50 });
    expect((await svc.getRules()).thresholds).toEqual({ hot: 80, warm: 50 });
  });

  it('điểm ý định do agent ghi (lead_ai_intents) được cộng vào điểm; admin tắt thì bỏ', async () => {
    const { prisma } = makePrisma();
    prisma.contact.findMany = jest.fn(async () => [
      { id: 1, phone: null, product_id: null, created_at: ago(90), source: null, stage: null },
    ]);
    prisma.leadAiIntent.findMany = jest.fn(async () => [{ contact_id: 1, intent: 1 }]);
    const svc = new LeadScoringService(prisma as never, ON as never);
    await svc.recompute([1], NOW);
    const reasons = JSON.parse(((prisma.$executeRaw.mock.calls[0] as unknown[])[0] as { values: unknown[] }).values[2] as string);
    expect(reasons.at(-1)).toMatchObject({ key: 'ai_intent', points: 10 });
    await svc.saveRules({ ai_intent: { enabled: false } }, 1);
    await svc.recompute([1], NOW);
    const off = JSON.parse(((prisma.$executeRaw.mock.calls[1] as unknown[])[0] as { values: unknown[] }).values[2] as string);
    expect(off.some((r: { key: string }) => r.key === 'ai_intent')).toBe(false);
  });

  it('consumeOutbox lần đầu: chỉ đặt con trỏ, không chấm lại lịch sử', async () => {
    const { prisma, settings } = makePrisma();
    const svc = new LeadScoringService(prisma as never, ON as never);
    expect(await svc.consumeOutbox()).toBe(0);
    expect(settings.get('lead_scoring_outbox_cursor')).toBe('10');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('consumeOutbox: sự kiện contact + deal → chấm lại đúng khách, dời con trỏ', async () => {
    const { prisma, settings } = makePrisma();
    settings.set('lead_scoring_outbox_cursor', '10');
    prisma.integrationEvent.findMany = jest.fn(async () => [
      { id: BigInt(11), resource: 'contact', resource_id: '1', event_type: 'contact.updated', payload: {} },
      { id: BigInt(12), resource: 'deal', resource_id: '5', event_type: 'deal.won', payload: { contact_id: 1 } },
      { id: BigInt(13), resource: 'contact', resource_id: '2', event_type: 'contact.deleted', payload: {} },
    ]);
    const svc = new LeadScoringService(prisma as never, ON as never);
    expect(await svc.consumeOutbox()).toBe(3);
    const where = (prisma.contact.findMany.mock.calls[0] as unknown as [{ where: { id: { in: number[] } } }])[0].where;
    expect(where.id.in).toEqual([1]);
    expect(settings.get('lead_scoring_outbox_cursor')).toBe('13');
  });

  it('runOnce: cờ tổ chức tắt → bỏ qua, không đụng dữ liệu', async () => {
    const { prisma } = makePrisma();
    const off = { isEnabled: jest.fn(async () => false) };
    const svc = new LeadScoringService(prisma as never, off as never);
    expect(await svc.runOnce()).toEqual({ skipped: 'org-flag-off' });
    expect(off.isEnabled).toHaveBeenCalledWith('lead_scoring');
    expect(prisma.integrationEvent.aggregate).not.toHaveBeenCalled();
  });
});

describe('LeadScoringController.recomputeOne — phạm vi', () => {
  const user = { userId: 5, email: 'a', isAdmin: false, grants: {} };
  it('khách ngoài phạm vi → 404 và không chấm', async () => {
    const prisma = { contact: { findFirst: jest.fn(async () => ({ assigned_to: 9, created_by_id: 9 })) } };
    const scope = { ownerIds: jest.fn(async () => [5]) };
    const service = { recompute: jest.fn() };
    const c = new LeadScoringController(service as never, prisma as never, scope as never);
    await expect(c.recomputeOne(1, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.recompute).not.toHaveBeenCalled();
  });
  it('khách của mình → chấm', async () => {
    const prisma = { contact: { findFirst: jest.fn(async () => ({ assigned_to: 5, created_by_id: null })), findUnique: jest.fn(async () => ({ id: 1 })) } };
    const scope = { ownerIds: jest.fn(async () => [5]) };
    const service = { recompute: jest.fn() };
    const c = new LeadScoringController(service as never, prisma as never, scope as never);
    await c.recomputeOne(1, user);
    expect(service.recompute).toHaveBeenCalledWith([1]);
  });
});

describe('LeadIntentService — agent của khách chấm ý định qua MCP', () => {
  const user = { userId: 5, email: 'a', isAdmin: false, grants: {} } as never;

  it('setIntents: chỉ ghi khách trong phạm vi, chặn 0–1, rồi chấm lại điểm', async () => {
    const upsert = jest.fn(async () => ({}));
    const prisma = {
      contact: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ id: 1 }])
          .mockResolvedValueOnce([{ id: 1, lead_score: 80, lead_label: 'hot' }]),
      },
      leadAiIntent: { upsert },
    };
    const scope = { ownerIds: jest.fn(async () => [5]) };
    const scoring = { recompute: jest.fn(async () => 1) };
    const svc = new LeadIntentService(prisma as never, scope as never, scoring as never);
    const out = await svc.setIntents(user, [{ contact_id: 1, intent: 3, reason: 'muốn ký' }, { contact_id: 2, intent: 0.5 }], 'chatgpt');
    expect(out[0]).toMatchObject({ contact_id: 1, ok: true, lead_score: 80, lead_label: 'hot' });
    expect(out[1]).toMatchObject({ contact_id: 2, ok: false });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0] as unknown[])[0]).toMatchObject({ create: { contact_id: 1, intent: 1, reason: 'muốn ký', client_id: 'chatgpt', user_id: 5 } });
    expect(scoring.recompute).toHaveBeenCalledWith([1]);
  });

  it('setIntents: không có quyền contacts.view → không ghi gì', async () => {
    const prisma = { contact: { findMany: jest.fn() }, leadAiIntent: { upsert: jest.fn() } };
    const svc = new LeadIntentService(prisma as never, { ownerIds: jest.fn(async () => null) } as never, { recompute: jest.fn() } as never);
    const out = await svc.setIntents(user, [{ contact_id: 1, intent: 0.4 }], null);
    expect(out[0].ok).toBe(false);
    expect(prisma.leadAiIntent.upsert).not.toHaveBeenCalled();
  });

  it('listForAgent: chỉ khách chưa chấm/điểm cũ, kèm ghi chú', async () => {
    const now = new Date('2026-10-07T03:00:00Z');
    const prisma = {
      contact: { findMany: jest.fn(async () => [
        { id: 1, full_name: 'A', lead_score: 50, lead_label: 'warm', reminder_notes: 'nhắc lại', updated_at: new Date('2026-10-06T00:00:00Z') },
        { id: 2, full_name: 'B', lead_score: 20, lead_label: 'cold', reminder_notes: null, updated_at: new Date('2026-10-01T00:00:00Z') },
      ]) },
      leadAiIntent: { findMany: jest.fn(async () => [{ contact_id: 2, intent: 0.3, updated_at: new Date('2026-10-05T00:00:00Z') }]) },
      activity: { findMany: jest.fn(async () => [{ details: { content: 'Khách hỏi giá' } }]) },
    };
    const svc = new LeadIntentService(prisma as never, { ownerIds: jest.fn(async () => 'all') } as never, {} as never);
    const out = await svc.listForAgent(user, 10, true, now);
    expect(out.map((x) => x.id)).toEqual([1]);
    expect(out[0].notes).toContain('nhắc lại');
    expect(out[0].notes).toContain('Khách hỏi giá');
    expect(await svc.listForAgent(user, 10, false, now)).toHaveLength(2);
  });
});
