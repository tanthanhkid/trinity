import { Prisma } from '@trinity/prisma';
import { BriefingAggregatorService } from '../briefing-aggregator.service';
import type { BriefingChannel } from '../briefing-channel';
import { BriefingsService } from '../briefings.service';
import type { BriefingConfig } from '../briefing.types';
import { DEFAULT_BRIEFING_CONFIG } from '../briefing.types';

/**
 * Prisma giả: dữ liệu cố định, lọc theo `assigned_to/created_by_id/assignee_id: { in: [...] }` y như scopeWhere sinh ra —
 * nhờ vậy test chứng minh số liệu THỰC SỰ đổi theo phạm vi, không chỉ kiểm hình dạng where.
 */
const NOW = new Date('2026-10-07T01:00:00Z'); // 08:00 VN, sáng → kỳ = hôm qua 06/10 VN
const YESTERDAY = new Date('2026-10-06T03:00:00Z');
const contacts = [
  { owner: 20, created_at: YESTERDAY }, { owner: 20, created_at: YESTERDAY },
  { owner: 21, created_at: YESTERDAY }, { owner: 99, created_at: YESTERDAY }, { owner: 99, created_at: YESTERDAY }, { owner: 99, created_at: YESTERDAY },
];
const deals = [
  { owner: 20, value: 100_000_000n }, { owner: 21, value: 50_000_000n }, { owner: 99, value: 900_000_000n },
];
const cards = [{ owner: 20 }, { owner: 99 }, { owner: 99 }];

function ownersIn(where: unknown): number[] | 'all' {
  const found: number[][] = [];
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (['assigned_to', 'created_by_id', 'created_by', 'assignee_id'].includes(k) && v && typeof v === 'object' && 'in' in v) found.push((v as { in: number[] }).in);
      else walk(v);
    }
  };
  walk(where);
  return found.length ? found[0] : 'all';
}
const inScope = (owner: number, o: number[] | 'all') => o === 'all' || o.includes(owner);
const inYesterday = (d: Date, w: unknown) => {
  const c = JSON.stringify(w);
  return c.includes('2026-10-05T17:00:00.000Z') ? d >= new Date('2026-10-05T17:00:00Z') && d < new Date('2026-10-06T17:00:00Z') : false;
};

function fakePrisma() {
  const briefings: Record<string, unknown>[] = [];
  const p = {
    contact: {
      count: jest.fn(async ({ where }) => {
        const o = ownersIn(where);
        if (JSON.stringify(where).includes('reminder_at')) return 0;
        return contacts.filter((c) => inScope(c.owner, o) && inYesterday(c.created_at, where)).length;
      }),
      findMany: jest.fn(async () => []),
    },
    activity: { count: jest.fn(async () => 0) },
    deal: {
      count: jest.fn(async () => 0),
      aggregate: jest.fn(async ({ where }) => {
        const o = ownersIn(where);
        const hit = JSON.stringify(where).includes('"won"') && JSON.stringify(where).includes('2026-10-05T17:00') ? deals.filter((d) => inScope(d.owner, o)) : [];
        return { _count: { _all: hit.length }, _sum: { value: hit.reduce((s, d) => s + d.value, 0n) } };
      }),
      groupBy: jest.fn(async () => []),
    },
    kanbanCard: { count: jest.fn(async ({ where }) => cards.filter((c) => inScope(c.owner, ownersIn(where))).length), findMany: jest.fn(async () => []) },
    user: {
      count: jest.fn(async () => 40),
      findMany: jest.fn(async () => [
        { id: 1, email: 'gd@t.vn', full_name: 'Giám đốc' },
        { id: 20, email: 'tl@t.vn', full_name: 'Trưởng nhóm' },
      ]),
    },
    briefing: {
      findMany: jest.fn(async () => briefings.map((b) => ({ user_id: b.user_id }))),
      create: jest.fn(async ({ data }) => {
        if (briefings.some((b) => b.user_id === data.user_id && b.slot === data.slot && b.day === data.day)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }
        briefings.push({ ...data, id: briefings.length + 1 });
        return { id: briefings.length };
      }),
      findUnique: jest.fn(async ({ where }) => {
        const k = where.user_id_slot_day;
        return briefings.find((b) => b.user_id === k.user_id && b.slot === k.slot && b.day === k.day) ?? null;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = briefings.find((b) => b.id === where.id);
        if (row) Object.assign(row, data);
        return { id: where.id };
      }),
    },
    role: { findMany: jest.fn(async () => [{ id: 1 }]) },
    userRole: { findMany: jest.fn(async () => [{ user_id: 1 }, { user_id: 20 }]) },
  };
  return { p, briefings };
}

function build(cfg: Partial<BriefingConfig> = {}, channels?: BriefingChannel[]) {
  const { p, briefings } = fakePrisma();
  const aggregator = new BriefingAggregatorService(p as never);
  const permissions = { grantsFor: jest.fn(async (id: number) => ({ isAdmin: id === 1, grants: {} })) };
  const scope = { ownerIds: jest.fn(async (u: { userId: number }) => (u.userId === 1 ? 'all' : u.userId === 50 ? null : [20, 21])) };
  const config = {
    get: jest.fn(async () => ({ ...DEFAULT_BRIEFING_CONFIG, enabled: true, ...cfg })),
    featureOn: jest.fn(async () => true),
  };
  const sent: { to: number; text: string }[] = [];
  const chans: BriefingChannel[] = channels ?? [
    { name: 'in_app', isEnabled: () => true, send: async (d) => (sent.push({ to: d.recipient.id, text: d.content.text }), true) },
  ];
  const svc = new BriefingsService(p as never, permissions as never, scope as never, aggregator, config as never, chans);
  return { svc, sent, briefings, p, scope };
}

describe('BriefingsService — số liệu theo phạm vi quyền', () => {
  it('giám đốc (all) thấy cả công ty, trưởng nhóm (team) chỉ thấy nhóm — số khác nhau', async () => {
    const { svc, sent } = build();
    const res = await svc.runSlot('morning', undefined, NOW);
    expect(res.created).toBe(2);
    const gd = sent.find((s) => s.to === 1)!.text;
    const tl = sent.find((s) => s.to === 20)!.text;
    expect(gd).toContain('Khách mới hôm qua: 6');
    expect(tl).toContain('Khách mới hôm qua: 3');
    expect(gd).toContain('Việc quá hạn: 3.');
    expect(tl).toContain('Việc quá hạn: 1.');
    expect(gd).toContain('1,05 tỷ');
    expect(tl).toContain('150 triệu');
    expect(gd).toContain('Toàn công ty');
    expect(tl).toContain('Nhóm của bạn');
  });

  it('phạm vi rỗng → toàn số 0, không truy vấn dữ liệu (không tự nới)', async () => {
    const { p } = fakePrisma();
    const agg = new BriefingAggregatorService(p as never);
    const out = await agg.collect([], 'morning', NOW);
    expect(out.metrics.newContacts.value).toBe(0);
    expect(p.contact.count).not.toHaveBeenCalled();
    expect(out.scope).toBe('self');
  });

  it('người trong cùng phạm vi dùng chung một lần tổng hợp', async () => {
    const { svc, p } = build();
    await svc.runSlot('morning', undefined, NOW);
    // 2 nhóm phạm vi (all, [20,21]) × (cur+prev) = 4 lần count khách mới + 2 lần lịch hẹn nhắc
    expect(p.contact.count.mock.calls.length).toBe(6);
  });
});

describe('BriefingsService — chạy theo lịch', () => {
  it('idempotent: chạy lại cùng slot/ngày không gửi trùng', async () => {
    const { svc, sent } = build();
    await svc.runSlot('morning', undefined, NOW);
    const again = await svc.runSlot('morning', undefined, NOW);
    expect(sent).toHaveLength(2);
    expect(again.created).toBe(0);
  });

  it('runDue: tắt trong cấu hình → không làm gì; chưa đến giờ → không gửi; đến giờ → gửi', async () => {
    expect(await build({ enabled: false }).svc.runDue(NOW)).toEqual({ skipped: 'config-off' });
    const early = build();
    expect(await early.svc.runDue(new Date('2026-10-07T00:00:00Z'))).toEqual([]);
    const due = build();
    const r = (await due.svc.runDue(NOW)) as { slot: string; created: number }[];
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ slot: 'morning', created: 2 });
  });

  it('không có AI: bản tin theo lịch dựng bằng mẫu từ số liệu', async () => {
    const { svc, briefings } = build();
    await svc.runSlot('morning', undefined, NOW);
    expect(briefings[0].text).toContain('Khách mới hôm qua');
    expect(briefings[0]).not.toHaveProperty('audio_key');
  });

  it('một kênh lỗi không chặn kênh khác; kênh tắt thì bỏ qua', async () => {
    const ok: string[] = [];
    const chans: BriefingChannel[] = [
      { name: 'loi', isEnabled: () => true, send: async () => { throw new Error('kenh loi'); } },
      { name: 'in_app', isEnabled: () => true, send: async () => (ok.push('in_app'), true) },
      { name: 'zalo', isEnabled: () => false, send: async () => (ok.push('zalo'), true) },
    ];
    const { svc } = build({}, chans);
    const res = await svc.runSlot('morning', undefined, NOW);
    expect(res.channels).toEqual({ in_app: 2 });
    expect(ok).not.toContain('zalo');
  });
});

describe('BriefingsService — agent của khách viết bản tin qua MCP', () => {
  it('agentData: số liệu + danh sách chi tiết theo phạm vi + bản mẫu; không có quyền → null', async () => {
    const { svc, p } = build();
    const out = await svc.agentData({ userId: 20, email: 'tl@t.vn', isAdmin: false, grants: {} } as never, 'morning', NOW);
    expect(out?.data.metrics.newContacts.value).toBe(3);
    expect(out?.template.text).toContain('Nhóm của bạn');
    expect(out?.details).toMatchObject({ new_contacts: [], overdue_tasks: [], callbacks: [], hot_leads: [] });
    expect(p.contact.findMany).toHaveBeenCalled();
    expect(await svc.agentData({ userId: 50, email: 'x', isAdmin: false, grants: {} } as never, 'morning', NOW)).toBeNull();
  });

  it('saveFromAgent: tạo bản tin của CHÍNH người dùng + báo trong app; lưu lần hai thì thay nội dung, không báo lại', async () => {
    const { svc, briefings, sent } = build();
    const me = { userId: 20, email: 'tl@t.vn', isAdmin: false, grants: {} } as never;
    const first = await svc.saveFromAgent(me, 'morning', 'Bản tin của agent', 'Hôm qua có 3 khách mới.', NOW);
    expect(first).toMatchObject({ created: true, notified: true });
    expect(briefings[0]).toMatchObject({ user_id: 20, slot: 'morning', day: '2026-10-07', title: 'Bản tin của agent' });
    const again = await svc.saveFromAgent(me, 'morning', 'Bản sửa', 'Nội dung mới.', NOW);
    expect(again).toMatchObject({ created: false, notified: false });
    expect(briefings).toHaveLength(1);
    expect(briefings[0].text).toBe('Nội dung mới.');
    expect(sent).toHaveLength(1);
  });

  it('saveFromAgent: không có quyền reports.overview → lỗi, không ghi', async () => {
    const { svc, briefings } = build();
    await expect(svc.saveFromAgent({ userId: 50, email: 'x', isAdmin: false, grants: {} } as never, 'evening', 't', 'x', NOW)).rejects.toThrow('reports.overview');
    expect(briefings).toHaveLength(0);
  });
});
