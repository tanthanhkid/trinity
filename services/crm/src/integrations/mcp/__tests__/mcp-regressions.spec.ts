import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionCtx, type ActionDeps } from '../actions/action-types';
import { McpServerService } from '../mcp-server.service';
import type { McpPrincipal } from '../mcp-auth.service';
import { EXTENSION_TOOL_NAMES } from '../tools/extension-tools';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { CORE_EXTRAS, contactRecord, dealRecord, taskRecord } from '../tools/core-records';
import { CORE_TABLES } from '../tools/schema-core';
import { describeSchemaTool } from '../tools/schema-tools';
import { fetchTool } from '../tools/search-fetch';
import { getRecordTool, listRecordsTool } from '../tools/record-tools';
import { listDealsTool } from '../tools/deals-dashboard-tools';
import type { McpDeps, ToolContext } from '../tools/tool-types';

const user = (grants: Record<string, unknown>, id: number): AuthUser => ({ userId: id, email: `u${id}@x.vn`, isAdmin: false, grants: grants as Grants });
const scope = {
  ownerIds: jest.fn(async (u: AuthUser, p: string) => {
    const g = (u.grants as Record<string, unknown>)[p];
    if (g === undefined) return null;
    if (g === true || g === 'all') return 'all';
    return [u.userId];
  }),
};
const SALE = user({ 'contacts.view': 'own', 'deals.view': 'own', 'deals.manage': 'own', 'kanban.view': 'own', 'kanban.manage': 'own' }, 11);
const ADMIN = user({ 'contacts.view': 'all', 'deals.view': 'all', 'deals.manage': 'all', 'kanban.view': 'all', 'kanban.manage': 'all', 'custom_objects.manage': true, 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_records.delete': 'all' }, 1);
const principal = (u: AuthUser): McpPrincipal => ({ userId: u.userId, email: u.email, clientId: 'c', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: u });
const ctx = (deps: McpDeps, u: AuthUser): ToolContext => ({ principal: principal(u), deps, baseUrl: 'https://x' });

/** Prisma giả: kho khách có id 1 (đã xoá mềm), 2 (của người khác), 3 (của SALE). `where` được đọc để mô phỏng đúng lọc deleted_at + phạm vi. */
const CONTACTS = [
  { id: 1, deleted_at: new Date(), assigned_to: 11, created_by_id: 11 },
  { id: 2, deleted_at: null, assigned_to: 99, created_by_id: 99 },
  { id: 3, deleted_at: null, assigned_to: 11, created_by_id: 11 },
];
function flat(w: unknown): Record<string, unknown>[] {
  const o = w as { AND?: unknown[] };
  return o.AND ? o.AND.flatMap(flat) : [w as Record<string, unknown>];
}
function fakeContactFindMany({ where }: { where: unknown }) {
  const parts = flat(where);
  return Promise.resolve(CONTACTS.filter((c) => parts.every((p) => {
    if (p.deleted_at === null && c.deleted_at !== null) return false;
    const idf = p.id as { in?: number[] } | undefined;
    if (idf?.in && !idf.in.includes(c.id)) return false;
    const or = p.OR as { [k: string]: { in: number[] } }[] | undefined;
    if (or) return or.some((cond) => Object.entries(cond).some(([f, v]) => v.in.includes((c as unknown as Record<string, number>)[f])));
    return true;
  })).map((c) => ({ id: c.id })));
}

const deal = (id: number, contactId: number) => {
  const c = CONTACTS.find((x) => x.id === contactId)!;
  return { id, title: `Deal ${id}`, description: null, value: 10, status: 'open', note: null, assigned_to: 11, created_by: 11, contact_id: contactId, created_at: new Date(), updated_at: new Date(),
    assignee: { id: 11, full_name: 'Sale', email: 'a@x.vn' }, contact: { id: c.id, full_name: `Khách ${c.id}`, phone: '0900000000', assigned_to: c.assigned_to, created_by_id: c.created_by_id } };
};

function deps(over: Record<string, unknown> = {}) {
  const prisma = {
    contact: { findMany: jest.fn(fakeContactFindMany), findFirst: jest.fn(async ({ where }: { where: { id: number; deleted_at: null } }) => CONTACTS.find((c) => c.id === where.id && c.deleted_at === null) ?? null), findUnique: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    kanbanColumn: { findUnique: jest.fn().mockResolvedValue({ name: 'Mới', board_id: 1, is_archived: false }) },
    customObject: { findMany: jest.fn().mockResolvedValue([]) },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    customField: { findMany: jest.fn().mockResolvedValue([]) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return {
    prisma, scope,
    deals: { findAll: jest.fn().mockResolvedValue({ data: [deal(1, 1), deal(2, 2), deal(3, 3)], meta: { next_cursor: null } }), findOne: jest.fn(async (id: number) => deal(id, id)) },
    cards: { list: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
    ...over,
  } as never as McpDeps & ActionDeps & { prisma: typeof prisma };
}

describe('deal không lộ khách mà get_contact/list_contacts từ chối', () => {
  it('list_deals: khách đã xoá hoặc của người khác ⇒ contact_id = null; khách trong phạm vi ⇒ giữ', async () => {
    const out = await listDealsTool.run({}, ctx(deps(), SALE));
    const rows = (out.structured.data as { deals: { id: number; contact_id: number | null }[] }).deals;
    expect(rows.map((r) => r.contact_id)).toEqual([null, null, 3]);
  });
  it('admin (phạm vi all) vẫn không thấy khách đã xoá mềm', async () => {
    const out = await listDealsTool.run({}, ctx(deps(), ADMIN));
    expect((out.structured.data as { deals: { contact_id: number | null }[] }).deals.map((r) => r.contact_id)).toEqual([null, 2, 3]);
  });
  it('fetch deal:1 (khách đã xoá) và deal:2 (khách người khác) không lộ tên/SĐT khách; deal:3 thì có', async () => {
    const d = deps();
    for (const id of [1, 2]) {
      const t = JSON.stringify((await fetchTool.run({ id: `deal:${id}` }, ctx(d, SALE))).structured);
      expect(t).not.toContain(`Khách ${id}`);
      expect(t).not.toContain('0900000000');
      expect(t).not.toContain('Khách hàng:');
    }
    expect(JSON.stringify((await fetchTool.run({ id: 'deal:3' }, ctx(d, SALE))).structured)).toContain('Khách 3');
  });
  it('get_record deals: cùng luật', async () => {
    const d = deps();
    const hidden = (await getRecordTool.run({ object: 'deals', id: 1 }, ctx(d, SALE))).structured.data as { contact_id: number | null };
    const shown = (await getRecordTool.run({ object: 'deals', id: 3 }, ctx(d, SALE))).structured.data as { contact_id: number | null };
    expect(hidden.contact_id).toBeNull();
    expect(shown.contact_id).toBe(3);
  });
});

describe(' gắn khách ngoài phạm vi vào việc bị chặn ngay lúc nhận đề xuất', () => {
  const actx = (d: ActionDeps, u: AuthUser): ActionCtx => ({ deps: d, user: u });
  const createTask = actionToolByName('create_task')!;
  const updateRecord = actionToolByName('update_record')!;
  it('create_task: khách đã xoá / của người khác ⇒ ActionUserError "ngoài phạm vi"; khách của mình ⇒ ra nháp', async () => {
    const d = deps();
    const rbac = await import('../../../kanban/common/kanban-rbac.helper');
    jest.spyOn(rbac, 'loadKanbanAccessContext').mockResolvedValue({} as never);
    jest.spyOn(rbac, 'loadVisibleBoardOrNotFound').mockResolvedValue({ id: 1, name: 'Bảng' } as never);
    for (const id of [1, 2]) await expect(createTask.prepare({ title: 'T', column_id: 6, contact_id: id }, actx(d, SALE))).rejects.toThrow(/ngoài phạm vi quyền/);
    await expect(createTask.prepare({ title: 'T', column_id: 6, contact_id: 2 }, actx(d, SALE))).rejects.toBeInstanceOf(ActionUserError);
    const ok = await createTask.prepare({ title: 'T', column_id: 6, contact_id: 3 }, actx(d, SALE));
    expect(ok.params).toMatchObject({ contact_id: 3 });
  });
  it('update_record tasks: contact_id ngoài phạm vi ⇒ từ chối; null (gỡ liên kết) không bị kiểm', async () => {
    const d = deps();
    await expect(updateRecord.prepare({ object: 'tasks', id: 16, values: { contact_id: 2 } }, actx(d, SALE))).rejects.toThrow(/ngoài phạm vi quyền/);
    await expect(updateRecord.prepare({ object: 'tasks', id: 16, values: { contact_id: 1 } }, actx(d, ADMIN))).rejects.toThrow(/ngoài phạm vi quyền/);
  });
});

describe(' khoá của bản ghi lõi khớp describe_schema', () => {
  const keysOf = (key: 'contacts' | 'deals' | 'tasks') => new Set(((CORE_TABLES.find((t) => t.key === key)!.describe(ADMIN) as { fields: { key: string }[] }).fields).map((f) => f.key));
  const allowed = (key: 'contacts' | 'deals' | 'tasks') => new Set([...keysOf(key), ...Object.keys(CORE_EXTRAS[key])]);
  const stray = (rec: Record<string, unknown>, key: 'contacts' | 'deals' | 'tasks') => Object.keys(rec).filter((k) => !allowed(key).has(k));

  it('deal: có assigned_to (id) + contact_id, mọi khoá còn lại nằm trong schema hoặc read_only_fields', () => {
    const rec = dealRecord({ id: 1, title: 'x', description: null, value: 1, status: 'open', note: null, contact_id: 3, assigned_to: 11, assignee: 'Sale', created_at: 'a', updated_at: 'b' });
    expect(rec.assigned_to).toBe(11);
    expect(stray(rec, 'deals')).toEqual([]);
  });
  it('task: có contact_id (không chỉ contact), mọi khoá lạ được khai ở read_only_fields', () => {
    const rec = taskRecord({ id: 16, title: 't', description: 'd', due_at: null, priority: null, column_id: 6, board_id: 1, is_overdue: false, labels: [], assignee_ids: [11], contact: { id: 3, full_name: 'K' }, completed_at: null });
    expect(rec.contact_id).toBe(3);
    expect(stray(rec, 'tasks')).toEqual([]);
  });
  it('contact: assigned_to là id, tên ở assigned_to_name', () => {
    const rec = contactRecord({ id: 1, full_name: 'A', assigned_to: { id: 11, full_name: 'Sale' }, source_id: 1, stage_id: 2, contact_status_id: 3, stage: 's' });
    expect(rec.assigned_to).toBe(11);
    expect(rec.assigned_to_name).toBe('Sale');
    expect(stray(rec, 'contacts')).toEqual([]);
  });
  it('describe_schema khai read_only_fields cho từng bảng lõi', async () => {
    const out = await describeSchemaTool.run({ object: 'deals' }, ctx(deps(), ADMIN));
    const t = (out.structured.data as { tables: { read_only_fields: { key: string }[] }[] }).tables[0];
    expect(t.read_only_fields.map((f) => f.key)).toContain('assignee');
  });
  it('list_records tasks trả contact_id', async () => {
    const d = deps();
    (d.prisma as unknown as { kanbanBoard: unknown }).kanbanBoard = {};
    (d.cards.list as jest.Mock).mockResolvedValue({ cards: [{ id: 16, title: 't', description: null, due_at: null, priority: null, column_id: 6, board_id: 1, is_overdue: false, labels: [], assignee_ids: [11], contact: { id: 3, full_name: 'K' }, completed_at: null }], next_cursor: null });
    jest.spyOn(await import('../../../kanban/common/kanban-rbac.helper'), 'loadKanbanAccessContext').mockResolvedValue({} as never);
    const out = await listRecordsTool.run({ object: 'tasks' }, ctx(d, ADMIN));
    expect((out.structured.data as { records: { contact_id: number }[] }).records[0].contact_id).toBe(3);
  });
});

describe(' tool list thật khớp những gì describe_schema quảng cáo', () => {
  it('qua MCP SDK thật (tools/list): mọi tool mà describe_schema nói có đều được expose; mô tả record tools không còn "chỉ bảng tuỳ biến"', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const svc = new McpServerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { log: jest.fn() } as never, { hit: jest.fn() } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const server = (svc as unknown as { buildServer: (p: McpPrincipal) => { connect: (t: unknown) => Promise<void>; close: () => Promise<void> } }).buildServer(principal(ADMIN));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = (await client.listTools()).tools;
    const names = new Set(listed.map((t) => t.name));

    const d = deps();
    (d.prisma.customObject.findMany as jest.Mock).mockResolvedValue([{ id: 1, key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh', description: null, is_active: true, deleted_at: null, visible_role_ids: [], nav_order: 1 }]);
    const out = await describeSchemaTool.run({}, ctx(d, ADMIN));
    const data = out.structured.data as { tables: { tools: { read: string[]; write: string[] } }[]; structure: { tools: string[] } };
    const advertised = [...data.structure.tools, ...data.tables.flatMap((t) => [...t.tools.read, ...t.tools.write])];
    expect(advertised).toEqual(expect.arrayContaining(['add_field', 'archive_record']));
    expect(advertised.filter((n) => !names.has(n))).toEqual([]);
    // Cờ EXTENSIONS_ENABLED mặc định TẮT ⇒ 8 tool chương trình con bị ẩn khỏi tools/list.
    expect(names.size).toBe(MCP_TOOLS.filter((t) => !EXTENSION_TOOL_NAMES.has(t.name)).length);
    for (const n of ['list_records', 'get_record', 'create_record', 'update_record']) {
      const desc = listed.find((t) => t.name === n)!.description ?? '';
      expect(desc).toMatch(/deals/);
      expect(desc).not.toMatch(/MỘT BẢNG TUỲ BIẾN|chỉ cho bảng tuỳ biến|không dùng cho khách hàng/i);
    }
    await client.close(); await server.close();
  });
});
