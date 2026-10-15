import type { AuthUser } from '@trinity/rbac-nest';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionDeps } from '../actions/action-types';
import { listSalesOrdersTool } from '../tools/sales-records-tools';

const me: AuthUser = { userId: 11, email: 'sale@x.vn', isAdmin: false, grants: { 'kanban.manage': 'team', 'kanban.view': 'team', 'deals.view': 'all' } as never };
const createTask = actionToolByName('create_task')!;

function taskDeps(scope: number[] | 'all' = [11, 12, 13]) {
  const people = [
    { id: 12, full_name: 'Nguyễn Văn Nam', email: 'nam@x.vn' },
    { id: 13, full_name: 'Trần Thị Nam Phương', email: 'phuong@x.vn' },
    { id: 20, full_name: 'Lê Nam Ngoài', email: 'ngoai@x.vn' },
  ];
  const inScope = (id: number) => scope === 'all' || scope.includes(id);
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ full_name: 'Sale Một' })),
      findFirst: jest.fn(async ({ where }: any) => people.find((p) => p.email === String(where.email.equals).toLowerCase() && inScope(p.id)) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        people.filter((p) => (where.full_name.equals ? p.full_name.toLowerCase() === String(where.full_name.equals).toLowerCase() : p.full_name.toLowerCase().includes(String(where.full_name.contains).toLowerCase())) && (!where.id || where.id.in.includes(p.id))),
      ),
    },
    kanbanColumn: { findUnique: jest.fn(async () => ({ name: 'Cần làm', board_id: 1, is_archived: false })) },
    kanbanBoard: { findMany: jest.fn(async () => []) },
  };
  const cards = { create: jest.fn(async (_u: unknown, _a: unknown, dto: any) => ({ id: 9, title: dto.title })) };
  return { prisma, scope: { ownerIds: jest.fn(async () => scope) }, cards } as unknown as ActionDeps & { cards: typeof cards };
}

beforeEach(async () => {
  const rbac = await import('../../../kanban/common/kanban-rbac.helper');
  jest.spyOn(rbac, 'loadKanbanAccessContext').mockResolvedValue({ owner: [11], roleIds: [] } as never);
  jest.spyOn(rbac, 'loadVisibleBoardOrNotFound').mockResolvedValue({ id: 1, name: 'Việc' } as never);
});
afterEach(() => jest.restoreAllMocks());

describe('create_task — giao việc cho người khác trong phạm vi quyền', () => {
  it('bỏ trống assignee ⇒ giao cho chính người dùng', async () => {
    const d = taskDeps();
    const r = await createTask.prepare({ title: 'Gọi khách', column_id: 6 }, { deps: d, user: me });
    expect(r.params).toMatchObject({ assignee_id: 11 });
    expect(r.summary).toMatch(/giao cho bạn/);
  });

  it('email đúng người trong phạm vi ⇒ giao cho người đó; tên khớp một người ⇒ cũng được', async () => {
    const d = taskDeps();
    expect((await createTask.prepare({ title: 'T', column_id: 6, assignee: 'NAM@x.vn' }, { deps: d, user: me })).params).toMatchObject({ assignee_id: 12 });
    const r = await createTask.prepare({ title: 'T', column_id: 6, assignee: 'Nguyễn Văn Nam' }, { deps: d, user: me });
    expect(r.params).toMatchObject({ assignee_id: 12 });
    expect(r.summary).toMatch(/giao cho Nguyễn Văn Nam/);
  });

  it('nhiều người trùng tên ⇒ hỏi lại; ngoài phạm vi ⇒ không tìm thấy', async () => {
    const d = taskDeps();
    await expect(createTask.prepare({ title: 'T', column_id: 6, assignee: 'Nam' }, { deps: d, user: me })).rejects.toThrow(/Có nhiều người khớp/);
    await expect(createTask.prepare({ title: 'T', column_id: 6, assignee: 'ngoai@x.vn' }, { deps: d, user: me })).rejects.toBeInstanceOf(ActionUserError);
    await expect(createTask.prepare({ title: 'T', column_id: 6, assignee: 'Lê Nam Ngoài' }, { deps: d, user: me })).rejects.toThrow(/Không tìm thấy/);
  });

  it('lúc chạy kiểm lại phạm vi: người đã ra ngoài phạm vi ⇒ từ chối; trong phạm vi ⇒ thẻ giao đúng người', async () => {
    const d = taskDeps();
    await createTask.execute({ title: 'T', column_id: 6, assignee_id: 12 }, { deps: d, user: me }, 1);
    expect(d.cards.create.mock.calls[0][2]).toMatchObject({ assignee_ids: [12] });
    const narrowed = taskDeps([11]);
    await expect(createTask.execute({ title: 'T', column_id: 6, assignee_id: 12 }, { deps: narrowed, user: me }, 1)).rejects.toThrow(/không còn trong phạm vi/);
  });
});

describe('list_sales_orders — lọc theo khách, đếm số đơn theo khách', () => {
  function salesDeps() {
    const prisma = {
      contact: {
        findFirst: jest.fn(async ({ where }: any) => (where.code === 'KH012' ? { id: 5 } : null)),
        findMany: jest.fn(async ({ where }: any) => (where.phone ? [{ id: 5 }, { id: 6 }] : [{ id: 5, code: 'KH012', full_name: 'Chị Lan' }, { id: 7, code: 'KH020', full_name: 'Anh Bình' }])),
      },
      connectorRecord: {
        findMany: jest.fn(async () => []),
        groupBy: jest.fn(async () => [{ contact_id: 5, _count: { _all: 2 }, _sum: { amount: 300000n } }, { contact_id: 7, _count: { _all: 1 }, _sum: { amount: 50000n } }]),
      },
      storeOrder: { groupBy: jest.fn(async () => [{ contact_id: 5, _count: { _all: 1 }, _sum: { total: 100000n } }, { contact_id: 7, _count: { _all: 1 }, _sum: { total: 20000n } }]) },
    };
    return { prisma, scope: { ownerIds: jest.fn(async () => 'all') }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
  }
  const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.test', principal: { userId: 11, user: me } as any });
  const data = (r: any) => (r.structured as any).data;

  it('đếm theo khách gồm cả đơn trang bán hàng; min_orders lọc khách mua nhiều lần', async () => {
    const d = salesDeps();
    const out = data(await listSalesOrdersTool.run({ group_by_contact: true, min_orders: 3 }, ctx(d)));
    expect(out.customers).toEqual([{ contact_id: 5, code: 'KH012', name: 'Chị Lan', orders: 3, store_orders: 1, total: 400000 }]);
    expect(out.customers_matched).toBe(1);
  });

  it('lọc theo mã khách / SĐT ⇒ contact_id tương ứng; không có khách khớp ⇒ rỗng, không truy vấn đơn', async () => {
    const d = salesDeps();
    await listSalesOrdersTool.run({ contact_code: 'kh012' }, ctx(d));
    expect(d.prisma.connectorRecord.findMany.mock.calls[0][0].where.contact_id).toEqual({ in: [5] });
    await listSalesOrdersTool.run({ phone: '+84912345678' }, ctx(d));
    expect(d.prisma.connectorRecord.findMany.mock.calls[1][0].where.contact_id).toEqual({ in: [5, 6] });
    const empty = data(await listSalesOrdersTool.run({ contact_code: 'KHONGCO' }, ctx(d)));
    expect(empty.count).toBe(0);
    expect(d.prisma.connectorRecord.findMany).toHaveBeenCalledTimes(2);
  });

  it('from/to sai dạng hoặc ngày không tồn tại ⇒ lỗi rõ; đếm theo khách mà không có khách khớp ⇒ đúng dạng kết quả đếm', async () => {
    await expect(listSalesOrdersTool.run({ from: '15/10/2026' }, ctx(salesDeps()))).rejects.toThrow(/YYYY-MM-DD/);
    await expect(listSalesOrdersTool.run({ from: '2026-02-31' }, ctx(salesDeps()))).rejects.toThrow(/YYYY-MM-DD/);
    const out = data(await listSalesOrdersTool.run({ contact_code: 'KHONGCO', group_by_contact: true }, ctx(salesDeps())));
    expect(out).toMatchObject({ customers: [], customers_matched: 0 });
  });
});
