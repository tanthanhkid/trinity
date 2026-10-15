import { StaleWorkService } from './stale-work.service';
import { normalizeStaleConfig, vietnamClock, DEFAULT_STALE_CONFIG } from './stale-work.config';
import { scanStale } from './stale-work.scan';
import type { AuthUser } from '@trinity/rbac-nest';

/**
 * Cây: D(1) ← L(2) ← A(3), L(2) ← A2(4); E(5) ← B(6) là nhánh khác. F(7) đã khoá.
 */
const TREE: Record<number, number | null> = { 1: null, 2: 1, 3: 2, 4: 2, 5: null, 6: 5 };
const childrenOf = (id: number): number[] => Object.keys(TREE).map(Number).filter((k) => TREE[k] === id);
const subtree = (id: number): number[] => [id, ...childrenOf(id).flatMap(subtree)];

const NOW = new Date('2026-10-07T02:00:00Z'); // 09:00 giờ VN
const st = (o: Partial<{ silent_contacts: number; silent_deals: number; overdue_tasks: number; missed_reminders: number }>) => ({
  silent_contacts: 0, silent_deals: 0, overdue_tasks: 0, missed_reminders: 0, ...o,
});

function make(stats: Record<number, ReturnType<typeof st>>, settings: Record<string, string> = {}, enabled = true) {
  const store = new Map(Object.entries(settings));
  const prisma = {
    user: {
      findMany: jest.fn(async () => [...Object.keys(TREE).map(Number).map((id) => ({ id, manager_id: TREE[id] })), { id: 7, manager_id: 2 }].filter((u) => u.id !== 7)),
    },
    setting: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { value: store.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => void store.set(where.key, create.value)),
    },
    contact: { groupBy: jest.fn(async () => Object.entries(stats).filter(([, s]) => s.silent_contacts).map(([id, s]) => ({ assigned_to: Number(id), _count: { _all: s.silent_contacts } }))) },
    deal: { groupBy: jest.fn(async () => []) },
    kanbanCard: { groupBy: jest.fn(async () => Object.entries(stats).filter(([, s]) => s.overdue_tasks).map(([id, s]) => ({ assignee_id: Number(id), _count: { _all: s.overdue_tasks } }))) },
    $queryRaw: jest.fn(async () => []),
  };
  const scope = {
    ownerIds: jest.fn(async (u: AuthUser) => subtree(u.userId)),
  };
  const notifications = { createPendingLogs: jest.fn(async () => ({ created: 1 })) };
  const svc = new StaleWorkService(prisma as never, scope as never, notifications as never, { isEnabled: jest.fn(async () => enabled) } as never);
  return { svc, prisma, scope, notifications, store };
}

const stats = { 3: st({ silent_contacts: 4 }), 2: st({ overdue_tasks: 1 }), 6: st({ silent_contacts: 9 }) };
const user = (userId: number): AuthUser => ({ userId, email: '', isAdmin: false, grants: {} });

describe('StaleWorkService — phạm vi theo cây cấp bậc', () => {
  it('sale chỉ nhận việc của mình (không thấy của đồng nghiệp/nhánh khác)', async () => {
    const { svc } = make(stats);
    const ds = await svc.buildDigests(NOW);
    const a = ds.find((d) => d.recipient_id === 3);
    expect(a?.own.silent_contacts).toBe(4);
    expect(a?.team).toEqual(st({}));
    expect(ds.find((d) => d.recipient_id === 4)).toBeUndefined(); // A2 không có việc → không nhận
  });

  it('trưởng nhóm nhận của mình + của cấp dưới; cấp trên trực tiếp nhận tổng nhánh', async () => {
    const { svc } = make(stats);
    const ds = await svc.buildDigests(NOW);
    const l = ds.find((d) => d.recipient_id === 2);
    expect(l?.own.overdue_tasks).toBe(1);
    expect(l?.team.silent_contacts).toBe(4); // của A
    const d = ds.find((d) => d.recipient_id === 1);
    expect(d?.own).toEqual(st({}));
    expect(d?.team).toEqual(st({ silent_contacts: 4, overdue_tasks: 1 }));
  });

  it('nhánh khác không rò sang: E(5) chỉ thấy B(6), D(1) không thấy B', async () => {
    const { svc } = make(stats);
    const ds = await svc.buildDigests(NOW);
    expect(ds.find((x) => x.recipient_id === 5)?.team.silent_contacts).toBe(9);
    expect(ds.find((x) => x.recipient_id === 1)?.team.silent_contacts).toBe(4);
    expect(ds.find((x) => x.recipient_id === 6)?.team).toEqual(st({}));
  });

  it('chủ việc đã khoá/không còn trong danh sách active → không nhận và không kéo cấp trên', async () => {
    const { svc } = make({ 7: st({ silent_contacts: 5 }) });
    expect(await svc.buildDigests(NOW)).toEqual([]);
  });

  it('summaryFor: sale chỉ thấy mình, trưởng nhóm thấy thêm team', async () => {
    const { svc } = make(stats);
    const sale = await svc.summaryFor(user(3), NOW);
    expect(sale.own.silent_contacts).toBe(4);
    expect(sale.team).toEqual(st({}));
    const lead = await svc.summaryFor(user(2), NOW);
    expect(lead.team.silent_contacts).toBe(4);
    expect(lead.team.silent_contacts).not.toBe(13);
  });
});

describe('StaleWorkService.runOnce', () => {
  it('gửi thông báo đúng người, nội dung tiếng Việt, rồi đánh dấu đã gửi hôm nay', async () => {
    const { svc, notifications, store } = make(stats);
    const r = await svc.runOnce(NOW);
    expect(r.sent).toBe(5); // 3, 2, 1, 6, 5
    const call = notifications.createPendingLogs.mock.calls.find((c) => (c as unknown as [number[]])[0][0] === 3) as unknown as [number[], string, { body: string; title: string }];
    expect(call[1]).toBe('stale_work.digest');
    expect(call[2].body).toBe('Của bạn: 4 khách im lặng quá 7 ngày.');
    expect(store.get('stale_work_last_digest')).toBe('2026-10-07');
  });

  it('chưa tới giờ gửi (07:00 VN < 08) → không gửi', async () => {
    const { svc, notifications } = make(stats);
    const r = await svc.runOnce(new Date('2026-10-07T00:00:00Z'));
    expect(r).toEqual({ sent: 0, skipped: 'chua-den-gio' });
    expect(notifications.createPendingLogs).not.toHaveBeenCalled();
  });

  it('đã gửi hôm nay → không gửi lần hai; force vẫn gửi', async () => {
    const { svc, notifications } = make(stats, { stale_work_last_digest: '2026-10-07' });
    expect(await svc.runOnce(NOW)).toEqual({ sent: 0, skipped: 'da-gui-hom-nay' });
    expect((await svc.runOnce(NOW, true)).sent).toBe(5);
    expect(notifications.createPendingLogs).toHaveBeenCalled();
  });

  it('cờ tổ chức stale_reminders=false → bỏ qua', async () => {
    const { svc, notifications } = make(stats, {}, false);
    expect(await svc.runOnce(NOW, true)).toEqual({ sent: 0, skipped: 'org-flag-off' });
    expect(notifications.createPendingLogs).not.toHaveBeenCalled();
  });

  it('N cấu hình trong Cài đặt đi vào nội dung và truy vấn', async () => {
    const { svc, prisma, notifications } = make(stats);
    await svc.saveConfig({ contact_days: 3 }, 1);
    await svc.runOnce(NOW, true);
    const where = (prisma.contact.groupBy.mock.calls[0] as unknown as [{ where: { created_at: { lt: Date } } }])[0].where;
    expect(where.created_at.lt.getTime()).toBe(NOW.getTime() - 3 * 86_400_000);
    const body = (notifications.createPendingLogs.mock.calls.find((c) => (c as unknown as [number[]])[0][0] === 3) as unknown as [unknown, unknown, { body: string }])[2].body;
    expect(body).toContain('quá 3 ngày');
  });
});

describe('scanStale', () => {
  it('gộp 4 loại theo chủ việc, bỏ chủ null', async () => {
    const prisma = {
      contact: { groupBy: jest.fn(async () => [{ assigned_to: 3, _count: { _all: 2 } }]) },
      deal: { groupBy: jest.fn(async () => [{ assigned_to: 3, _count: { _all: 1 } }]) },
      kanbanCard: { groupBy: jest.fn(async () => [{ assignee_id: 3, _count: { _all: 5 } }, { assignee_id: null, _count: { _all: 9 } }]) },
      $queryRaw: jest.fn(async () => [{ owner: 3, n: 4 }]),
    };
    const m = await scanStale(prisma as never, DEFAULT_STALE_CONFIG, NOW);
    expect([...m.entries()]).toEqual([[3, { silent_contacts: 2, silent_deals: 1, overdue_tasks: 5, missed_reminders: 4 }]]);
  });
});

describe('config + giờ VN', () => {
  it('normalizeStaleConfig: rác về mặc định, giá trị hợp lệ giữ nguyên', () => {
    expect(normalizeStaleConfig({ contact_days: 0, deal_days: 'x', digest_hour: 24 })).toEqual(DEFAULT_STALE_CONFIG);
    expect(normalizeStaleConfig({ contact_days: 10, digest_hour: 9 })).toEqual({ ...DEFAULT_STALE_CONFIG, contact_days: 10, digest_hour: 9 });
  });
  it('vietnamClock: 18:00Z = 01:00 ngày hôm sau theo VN', () => {
    expect(vietnamClock(new Date('2026-10-06T18:00:00Z'))).toEqual({ hour: 1, date: '2026-10-07' });
  });
});
