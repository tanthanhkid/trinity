import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { buildContactScope, buildDealScope } from '../dashboard-overview.scope';
import { vnMonthRange, vnTodayRange } from '../dashboard-overview.util';
import { DashboardTasksService } from '../dashboard-tasks.service';
import { DashboardOverviewService } from '../dashboard-overview.service';
import {
  DashboardFilterQuery,
  composeScope,
  filterCacheKey,
  resolveFilterUserIds,
} from '../dashboard-overview.filter';
import { DashboardFilterRosterService } from '../dashboard-filter-roster.service';

/** RBAC quyền + phạm vi: người dùng = grants, KHÔNG còn role string. */
const u = (grants: Grants, userId = 7): AuthUser =>
  ({ userId, email: `u${userId}@t.vn`, isAdmin: false, grants }) as AuthUser;
const ALL = u({ 'reports.overview': 'all', 'contacts.view': 'all' });
const TEAM = (id = 20) => u({ 'reports.overview': 'team', 'contacts.view': 'team' }, id);
const OWN = (id = 42) => u({ 'reports.overview': 'own', 'contacts.view': 'own' }, id);

/** Mirror `ScopeService.ownerIds`: map quyền → owner ids. */
const mkScope = (owners: Record<string, number[] | 'all' | null>): ScopeService =>
  ({
    ownerIds: jest.fn(async (_u: AuthUser, p: string) => (p in owners ? owners[p] : null)),
  }) as unknown as ScopeService;

describe('dashboard-overview util', () => {
  it('đầu tháng VN = 17:00 UTC ngày cuối tháng trước', () => {
    const r = vnMonthRange(0, new Date('2026-09-30T10:00:00Z'));
    expect(r.start.toISOString()).toBe('2026-08-31T17:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });
  it('qua 0h VN thì đã sang tháng mới', () => {
    const r = vnMonthRange(0, new Date('2026-09-30T17:30:00Z'));
    expect(r.start.toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });
  it('tháng trước của tháng 1 lùi sang năm trước', () => {
    const r = vnMonthRange(1, new Date('2026-01-15T00:00:00Z'));
    expect(r.start.toISOString()).toBe('2025-11-30T17:00:00.000Z');
  });
  it('hôm nay VN dài 24h', () => {
    const r = vnTodayRange(new Date('2026-09-30T10:00:00Z'));
    expect(r.end.getTime() - r.start.getTime()).toBe(86_400_000);
    expect(r.start.toISOString()).toBe('2026-09-29T17:00:00.000Z');
  });
});

describe('dashboard-overview scope', () => {
  it('mảng owner: lọc assigned_to | created_by_id, chỉ khách chưa xoá', () => {
    expect(buildContactScope([7, 8])).toEqual({
      AND: [
        { OR: [{ assigned_to: { in: [7, 8] } }, { created_by_id: { in: [7, 8] } }] },
        { deleted_at: null },
      ],
    });
    expect(buildDealScope([7, 8])).toEqual({
      OR: [{ assigned_to: { in: [7, 8] } }, { created_by: { in: [7, 8] } }],
    });
  });
  it("owner 'all': toàn bộ (chỉ loại xoá mềm)", () => {
    expect(buildContactScope('all')).toEqual({ AND: [{}, { deleted_at: null }] });
    expect(buildDealScope('all')).toEqual({});
  });
  it('owner rỗng: khớp KHÔNG AI (không tự nới)', () => {
    expect(buildDealScope([])).toEqual({
      OR: [{ assigned_to: { in: [] } }, { created_by: { in: [] } }],
    });
  });
});

describe('DashboardTasksService', () => {
  const build = (scope = mkScope({ 'reports.overview': 'all', 'contacts.view': 'all' })) => {
    const prisma = {
      kanbanCard: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      contact: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      userRole: { findMany: jest.fn().mockResolvedValue([{ role_id: 3 }]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { prisma, svc: new DashboardTasksService(prisma as never, scope) };
  };

  it('scope team vẫn CHỈ lấy việc của chính mình, không mở rộng cấp dưới', async () => {
    const { prisma, svc } = build();
    await svc.getTasks(TEAM(42));
    const where = prisma.kanbanCard.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { assignee_id: { in: [42] } },
      { assignees: { some: { user_id: { in: [42] } } } },
    ]);
    expect(prisma.contact.findMany.mock.calls[0][0].where.assigned_to).toEqual({ in: [42] });
  });

  it('board lọc theo id vai trò của user; người giữ kanban.boards thấy mọi board ĐANG BẬT', async () => {
    const { prisma, svc } = build();
    await svc.getTasks(OWN());
    const normal = prisma.kanbanCard.findMany.mock.calls[0][0].where.board;
    expect(normal.AND[0]).toEqual({ is_active: true });
    expect(normal.AND[1].OR).toEqual([
      { visibility_role_ids: { isEmpty: true } },
      { visibility_role_ids: { hasSome: [3] } },
    ]);
    await svc.getTasks(u({ 'reports.overview': 'own', 'kanban.boards': true }));
    const admin = prisma.kanbanCard.findMany.mock.calls[1][0].where.board;
    expect(admin.AND[0]).toEqual({ is_active: true });
    expect(admin.AND[1].OR).toBeUndefined();
  });

  it('gộp + sắp theo hạn, đánh dấu quá hạn, ẩn tên khách ngoài phạm vi contacts.view', async () => {
    const { prisma, svc } = build();
    const past = new Date(Date.now() - 3 * 86_400_000);
    const soon = new Date(Date.now() + 60_000);
    prisma.kanbanCard.findMany.mockResolvedValue([
      { id: 1, title: 'Gửi tài liệu', contact_id: 99, due_at: soon, priority: 'high' },
    ]);
    prisma.kanbanCard.count.mockResolvedValue(1);
    prisma.contact.findMany
      .mockResolvedValueOnce([{ id: 5, full_name: 'Khách A', reminder_notes: null, reminder_at: past }])
      .mockResolvedValueOnce([{ id: 5, full_name: 'Khách A' }]); // tên khách 99 nằm ngoài phạm vi → không trả (chỉ 5 trong phạm vi contacts.view)
    prisma.contact.count.mockResolvedValue(1);
    const r = await svc.getTasks(OWN());
    expect(r.items.map((i) => i.key)).toEqual(['c5', 'k1']);
    expect(r.items[0]).toMatchObject({ overdue: true, title: 'Nhắc liên hệ lại', contact_name: 'Khách A' });
    expect(r.items[1].contact_name).toBeNull();
    expect(r.total).toBe(2);
  });

  it('nhắc liên hệ lại ngoài phạm vi contacts.view → ẩn tên khách (không lộ qua reminder)', async () => {
    const { prisma, svc } = build();
    const past = new Date(Date.now() - 3 * 86_400_000);
    prisma.kanbanCard.findMany.mockResolvedValue([]);
    prisma.contact.findMany
      .mockResolvedValueOnce([{ id: 7, full_name: 'Khách B', reminder_notes: null, reminder_at: past }])
      .mockResolvedValueOnce([]); // contacts.view không phủ khách 7
    prisma.contact.count.mockResolvedValue(1);
    const r = await svc.getTasks(OWN());
    expect(r.items[0].contact_name).toBeNull();
  });
});

describe('DashboardOverviewService', () => {
  const mk = (deals: { findMany: jest.Mock; groupBy: jest.Mock; count: jest.Mock }, contactCount = 3) => {
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      contact: { count: jest.fn().mockResolvedValue(contactCount) },
      deal: deals,
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const scope = mkScope({ 'reports.overview': 'all' });
    return { redis, prisma, svc: new DashboardOverviewService(prisma as never, scope, redis as never) };
  };

  it('doanh thu null khi không có thương vụ thắng (KHÔNG bịa 0)', async () => {
    const { svc, redis } = mk({
      groupBy: jest.fn().mockResolvedValue([{ status: 'open', _count: { _all: 2 } }]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
    });
    const r = await svc.getOverview(ALL);
    expect(r.revenue).toEqual({ this_month: null, last_month: null });
    expect(r.deal_status).toEqual({ open: 2, won: 0, lost: 0 });
    expect(r.months).toHaveLength(6);
    expect(r.opportunities_by_month).toEqual([1, 1, 1, 1, 1, 1]);
    expect(r.opportunities.new_this_month).toBe(1);
    expect(r.scope_label).toBe('toàn hệ thống');
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('dashboard:overview:v3:'), expect.any(String), 'EX', 300);
  });

  it('cộng đúng doanh thu tháng, bỏ deal value null', async () => {
    const now = new Date();
    const { svc } = mk({
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([
        { value: BigInt(1_000_000), updated_at: now },
        { value: BigInt(500_000), updated_at: now },
        { value: null, updated_at: now },
      ]),
      count: jest.fn().mockResolvedValue(0),
    }, 0);
    const r = await svc.getOverview(ALL);
    expect(r.revenue.this_month).toBe(1_500_000);
    expect(r.revenue.last_month).toBeNull();
  });
});

describe('bộ lọc Tổng quan', () => {
  // cây: quản lý 10 → trưởng nhóm 20 → nhân viên 30,31 ; quản lý 11 → trưởng nhóm 21 → nhân viên 32
  const rows = [
    [10, null], [20, 10], [30, 20], [31, 20], [11, null], [21, 11], [32, 21],
  ].map(([id, manager_id]) => ({ id, manager_id })) as { id: number; manager_id: number | null }[];
  const prisma = { user: { findMany: jest.fn(async () => rows) } };
  const q = (o: DashboardFilterQuery) => o;

  it('scope own: BỎ QUA bộ lọc (hành vi cũ, không 403)', async () => {
    expect(await resolveFilterUserIds(prisma as never, OWN(), q({ dept_head_id: 10 }))).toBeNull();
    expect(filterCacheKey(OWN(), q({ dept_head_id: 10 }))).toBe('');
    expect(await resolveFilterUserIds(prisma as never, u({}), q({ dept_head_id: 10 }))).toBeNull();
  });
  it('scope >= team: phòng → cả cây + chính người đó', async () => {
    const ids = await resolveFilterUserIds(prisma as never, ALL, q({ dept_head_id: 10 }));
    expect([...(ids ?? [])].sort()).toEqual([10, 20, 30, 31]);
    expect(await resolveFilterUserIds(prisma as never, TEAM(), q({ dept_head_id: 10 }))).not.toBeNull();
  });
  it('Team → chính trưởng nhóm + thành viên; Nhân viên → đúng 1 người', async () => {
    const t = await resolveFilterUserIds(prisma as never, ALL, q({ team_lead_id: 20 }));
    expect([...(t ?? [])].sort()).toEqual([20, 30, 31]);
    expect(await resolveFilterUserIds(prisma as never, ALL, q({ user_id: 5 }))).toEqual([5]);
  });
  it('kết hợp = GIAO; nhân viên ngoài team → rỗng (không nới)', async () => {
    expect(await resolveFilterUserIds(prisma as never, ALL, q({ team_lead_id: 20, user_id: 30 }))).toEqual([30]);
    expect(await resolveFilterUserIds(prisma as never, ALL, q({ dept_head_id: 10, user_id: 32 }))).toEqual([]);
  });
  it('không có tham số → null (không lọc), không đụng DB', async () => {
    prisma.user.findMany.mockClear();
    expect(await resolveFilterUserIds(prisma as never, ALL, q({}))).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
  it('composeScope: AND bên trong phạm vi, không leak', () => {
    expect(composeScope('all', null)).toBe('all');
    expect(composeScope('all', [1, 2])).toEqual([1, 2]);
    expect(composeScope([1, 2, 3], null)).toEqual([1, 2, 3]);
    expect(composeScope([1, 2, 3], [2, 9])).toEqual([2]);
    expect(composeScope([1], [9])).toEqual([]);
  });

  it('Tasks: không lọc = chỉ mình; lọc = người được chọn TRONG phạm vi; ngoài phạm vi → rỗng', async () => {
    const p = {
      kanbanCard: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      contact: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      userRole: { findMany: jest.fn().mockResolvedValue([]) },
      user: prisma.user,
    };
    const svc = new DashboardTasksService(p as never, mkScope({ 'reports.overview': 'all', 'contacts.view': 'all' }));
    await svc.getTasks(ALL);
    expect(p.contact.findMany.mock.calls[0][0].where.assigned_to).toEqual({ in: [7] });
    await svc.getTasks(ALL, { team_lead_id: 20 });
    expect(p.kanbanCard.findMany.mock.calls[1][0].where.OR[0]).toEqual({ assignee_id: { in: [20, 30, 31] } });
    // scope `team` = [20, 30]: lọc phòng 10 → giao với phạm vi → chỉ [20, 30]
    const narrow = new DashboardTasksService(p as never, mkScope({ 'reports.overview': [20, 30], 'contacts.view': 'all' }));
    await narrow.getTasks(TEAM(20), { dept_head_id: 10 });
    expect(p.kanbanCard.findMany.mock.calls[2][0].where.OR[0]).toEqual({ assignee_id: { in: [20, 30] } });
    // scope own gửi tham số lọc vẫn CHỈ thấy việc của mình
    await svc.getTasks(OWN(), { user_id: 99 });
    expect(p.kanbanCard.findMany.mock.calls[3][0].where.OR[0]).toEqual({ assignee_id: { in: [42] } });
  });

  it('Overview: lọc đổi scope + cache key; lọc rỗng → 0, nhãn "theo bộ lọc"', async () => {
    const p = {
      user: prisma.user,
      contact: { count: jest.fn().mockResolvedValue(0) },
      deal: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const svc = new DashboardOverviewService(p as never, mkScope({ 'reports.overview': 'all' }), redis as never);
    const r = await svc.getOverview(ALL, { team_lead_id: 20 });
    expect(r.scope_label).toBe('theo bộ lọc');
    expect(p.deal.groupBy.mock.calls[0][0].where).toEqual({
      OR: [{ assigned_to: { in: [20, 30, 31] } }, { created_by: { in: [20, 30, 31] } }],
    });
    expect(redis.set.mock.calls[0][0]).toContain(':0.20.0:');
    const empty = await svc.getOverview(ALL, { dept_head_id: 10, user_id: 32 });
    expect(empty.customers.total).toBe(0);
    // scope own gửi lọc → không ảnh hưởng phạm vi/nhãn
    const own = new DashboardOverviewService(p as never, mkScope({ 'reports.overview': [42] }), redis as never);
    const o = await own.getOverview(OWN(), { dept_head_id: 11 });
    expect(o.scope_label).toBe('cá nhân');
  });
});

describe('DashboardFilterRosterService', () => {
  // 1 → 2 → 3 (3 lá), 4 → 5 (5 lá), 6 độc lập (lá)
  const rows = [
    { id: 1, full_name: 'A', manager_id: null },
    { id: 2, full_name: 'B', manager_id: 1 },
    { id: 3, full_name: 'C', manager_id: 2 },
    { id: 4, full_name: 'D', manager_id: null },
    { id: 5, full_name: 'E', manager_id: 4 },
    { id: 6, full_name: 'F', manager_id: null },
  ];
  const p = { user: { findMany: jest.fn().mockResolvedValue(rows) } };

  it('403 với scope own; scope all nhận 3 nhóm theo chiều cao cây (không theo tên vai trò)', async () => {
    const svc = new DashboardFilterRosterService(p as never, mkScope({ 'reports.overview': 'all' }));
    await expect(svc.getRoster(OWN())).rejects.toThrow();
    const r = await svc.getRoster(ALL);
    expect(r.dept_heads.map((x) => x.id)).toEqual([1]);
    expect(r.team_leads).toEqual([
      { id: 2, full_name: 'B', manager_id: 1 },
      { id: 4, full_name: 'D', manager_id: null },
    ]);
    expect(r.sales.map((x) => x.id)).toEqual([3, 5, 6]);
  });

  it('chỉ trả người TRONG phạm vi reports.overview (không leak ngoài phạm vi)', async () => {
    const svc = new DashboardFilterRosterService(p as never, mkScope({ 'reports.overview': [2, 3] }));
    const r = await svc.getRoster(TEAM(2));
    expect(r.dept_heads).toEqual([]);
    expect(r.team_leads.map((x) => x.id)).toEqual([2]);
    expect(r.sales.map((x) => x.id)).toEqual([3]);
  });
});
