/**
 * Loại màn (view) qua MCP: chỉ tạo đúng loại web Trinity render được (list/kanban/calendar/table); loại lạ bị từ chối kèm
 * danh sách loại hợp lệ + mô tả; list_screen_types liệt kê loại + trường phù hợp; mô tả tool trung tính (không ra lệnh cho AI).
 */
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { CustomViewsService } from '../../../custom-objects/custom-views.service';
import { unsupportedViewTypeMessage, VIEW_TYPE_INFO, VIEW_TYPES } from '../../../custom-objects/view-config';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionDeps } from '../actions/action-types';
import type { McpPrincipal } from '../mcp-auth.service';
import { McpServerService } from '../mcp-server.service';
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from '../mcp-tools.registry';
import { listScreenTypesTool } from '../tools/screen-types-tool';
import { ToolUserError, type McpDeps, type ToolContext } from '../tools/tool-types';

const ADMIN: AuthUser = { userId: 1, email: 'a@x.vn', isAdmin: false, grants: { 'custom_objects.manage': true, 'custom_records.view': 'all', 'custom_records.manage': 'all' } as unknown as Grants };
const SALE: AuthUser = { userId: 2, email: 's@x.vn', isAdmin: false, grants: { 'custom_records.view': 'own' } as unknown as Grants };
const principal = (u: AuthUser): McpPrincipal => ({ userId: u.userId, email: u.email, clientId: 'c', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: u });

/** Mỗi loại hợp lệ + trường cấu hình bắt buộc phải có mặt trong lời từ chối để AI hỏi lại người dùng đúng các lựa chọn. */
const expectFullList = (msg: string) => {
  for (const t of VIEW_TYPES) expect(msg).toContain(t);
  expect(msg).toContain('group_by');
  expect(msg).toContain('date_field');
  expect(msg).toMatch(/người dùng chọn/);
};

const DEF = { id: 11, key: 'don_hang', label: 'Đơn hàng', label_plural: 'Đơn hàng', is_active: true, deleted_at: null, visible_role_ids: [], nav_order: 1, description: null, code_prefix: 'DH', show_in_nav: true };
const field = (id: number, key: string, label: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, object_id: 11, key, label, type, required: false, is_unique: false, is_title: id === 1, show_in_list: true, sort_order: id * 10, options: {}, help_text: null, deleted_at: null, ...extra });
const FIELDS = [
  field(1, 'ten_don', 'Tên đơn', 'text'),
  field(2, 'trang_thai', 'Trạng thái', 'select', { options: { choices: [{ value: 'moi', label: 'Mới' }, { value: 'xong', label: 'Xong' }] } }),
  field(3, 'ngay_giao', 'Ngày giao', 'date'),
];

function deps(fields = FIELDS) {
  const prisma = {
    customObject: { findMany: jest.fn().mockResolvedValue([DEF]), findFirst: jest.fn().mockResolvedValue(DEF) },
    customField: { findMany: jest.fn().mockResolvedValue(fields) },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    role: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockImplementation(async (q: { sql: string }) => (q.sql.includes('trinity_pick_code_prefix') ? [{ p: 'DH' }] : [{ taken: false }])),
  };
  return { prisma, views: new CustomViewsService(prisma as never), menu: { resolve: jest.fn().mockResolvedValue([]) } } as unknown as ActionDeps & McpDeps;
}
const actx = (d: ActionDeps) => ({ deps: d, user: ADMIN });
const tctx = (d: McpDeps, u: AuthUser = ADMIN): ToolContext => ({ principal: principal(u), deps: d, baseUrl: 'https://x' });

describe('danh mục loại màn', () => {
  it('đúng 4 loại web render được, mỗi loại có mô tả song ngữ; kanban cần group_by, calendar cần date_field', () => {
    expect(VIEW_TYPE_INFO.map((i) => i.type)).toEqual([...VIEW_TYPES]);
    expect([...VIEW_TYPES]).toEqual(['list', 'kanban', 'calendar', 'table']);
    for (const i of VIEW_TYPE_INFO) expect(i.summary).toMatch(/ \/ /);
    expect(Object.keys(VIEW_TYPE_INFO.find((i) => i.type === 'kanban')!.requires)).toEqual(['group_by']);
    expect(Object.keys(VIEW_TYPE_INFO.find((i) => i.type === 'calendar')!.requires)).toEqual(['date_field']);
  });
  it('lời từ chối: nêu loại người dùng xin + đủ các loại hợp lệ kèm mô tả; thiếu type ⇒ nói thiếu', () => {
    const m = unsupportedViewTypeMessage('bieu_do_3d');
    expect(m).toContain('“bieu_do_3d” chưa được Trinity hỗ trợ');
    expectFullList(m);
    expect(unsupportedViewTypeMessage(undefined)).toMatch(/^Thiếu loại màn/);
  });
  it('REST (CustomViewsService.check) cũng từ chối với cùng danh sách', () => {
    const svc = new CustomViewsService({} as never);
    try {
      svc.check({ obj: DEF, fields: [] } as never, { key: 'x', label: 'X', type: 'gantt' as never, config: {} }, []);
      throw new Error('không bị từ chối');
    } catch (e) {
      expectFullList(String((e as Error).message));
    }
  });
});

describe('tool tạo / sửa màn: loại lạ bị từ chối với danh sách', () => {
  it('create_view.prepare: gantt ⇒ ActionUserError liệt kê đủ loại', async () => {
    const err = await tool('create_view').prepare({ object: 'don_hang', label: 'L', type: 'gantt' }, actx(deps())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expectFullList((err as Error).message);
  });
  it('update_view.prepare: đổi sang loại lạ ⇒ từ chối', async () => {
    const d = deps();
    Object.assign((d as unknown as { prisma: Record<string, unknown> }).prisma.customView as object, { findFirst: jest.fn().mockResolvedValue({ key: 'ds', label: 'DS', type: 'list', config: {}, icon: null, show_in_nav: false }) });
    await expect(tool('update_view').prepare({ object: 'don_hang', view: 'ds', type: 'map' }, actx(d))).rejects.toThrow(/chưa được Trinity hỗ trợ/);
  });
  it('propose_workspace: view loại lạ trong gói ⇒ từ chối trước khi dựng gì', async () => {
    const goi = { title: 'G', objects: [{ key: 'don_hang2', label: 'Đơn', fields: [{ label: 'Tên', type: 'text' }] }], views: [{ object: 'don_hang2', label: 'Biểu đồ', type: 'chart' }] };
    const err = await tool('propose_workspace').prepare(goi, actx(deps())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expectFullList((err as Error).message);
  });
  it('create_view hợp lệ: kanban theo trường select, calendar theo trường ngày', async () => {
    const k = await tool('create_view').prepare({ object: 'don_hang', label: 'Pipeline', type: 'kanban', type_words: 'kanban theo trạng thái', group_by: 'trang_thai' }, actx(deps()));
    expect(k.summary).toContain('Kanban theo “trang_thai”');
    const c = await tool('create_view').prepare({ object: 'don_hang', label: 'Lịch giao', type: 'calendar', type_words: 'xem theo lịch', date_field: 'ngay_giao' }, actx(deps()));
    expect(c.summary).toContain('Lịch (tháng) theo “ngay_giao”');
  });
});

describe('qua MCP SDK thật: schema enum + lỗi kiểm tham số có danh sách', () => {
  async function connect() {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const svc = new McpServerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { log: jest.fn() } as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const server = (svc as unknown as { buildServer: (p: McpPrincipal) => { connect: (t: unknown) => Promise<void>; close: () => Promise<void> } }).buildServer(principal(ADMIN));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, server };
  }
  const text = (r: unknown) => (((r as { content?: unknown }).content as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? '').join('');

  it('tools/list: type là enum đúng 4 loại ở create_view, update_view, propose_workspace.views; có list_screen_types', async () => {
    const { client, server } = await connect();
    const tools = (await client.listTools()).tools;
    const props = (n: string) => (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }> }).properties;
    expect(props('create_view').type.enum).toEqual([...VIEW_TYPES]);
    expect(props('update_view').type.enum).toEqual([...VIEW_TYPES]);
    expect(props('propose_workspace').views.items!.properties.type.enum).toEqual([...VIEW_TYPES]);
    expect((tools.find((t) => t.name === 'create_view')!.inputSchema as { required: string[] }).required).toEqual(expect.arrayContaining(['object', 'label', 'type']));
    expect(tools.some((t) => t.name === 'list_screen_types')).toBe(true);
    await client.close(); await server.close();
  });
  it('tools/call create_view type lạ / thiếu type, propose_workspace view lạ ⇒ isError + danh sách loại', async () => {
    const { client, server } = await connect();
    const r1 = await client.callTool({ name: 'create_view', arguments: { object: 'don_hang', label: 'Màn 3D', type: 'bieu_do_3d' } });
    expect(r1.isError).toBe(true);
    expectFullList(text(r1));
    const r2 = await client.callTool({ name: 'create_view', arguments: { object: 'don_hang', label: 'Màn' } });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toContain('Thiếu loại màn');
    const r3 = await client.callTool({ name: 'propose_workspace', arguments: { title: 'G', objects: [{ label: 'Đơn' }], views: [{ object: 'don', label: 'B', type: 'dashboard' }] } });
    expect(r3.isError).toBe(true);
    expectFullList(text(r3));
    await client.close(); await server.close();
  });
});

describe('list_screen_types', () => {
  it('không truyền bảng: 4 loại + mô tả + trường bắt buộc + loại không hỗ trợ; ai cũng đọc được', async () => {
    const out = await listScreenTypesTool.run({}, tctx(deps(), SALE));
    const data = out.structured.data as { screen_types: { type: string; requires: Record<string, string> }[]; not_supported: string; can_create: boolean };
    expect(data.screen_types.map((t) => t.type)).toEqual([...VIEW_TYPES]);
    expect(data.screen_types.find((t) => t.type === 'kanban')!.requires).toHaveProperty('group_by');
    expect(data.not_supported).toMatch(/biểu đồ/);
    expect(data.can_create).toBe(false);
    expect(listScreenTypesTool.permissions).toEqual([]);
  });
  it('có bảng: trả trường select cho kanban, trường ngày cho calendar', async () => {
    const out = await listScreenTypesTool.run({ object: 'don_hang' }, tctx(deps()));
    const o = (out.structured.data as { object: Record<string, unknown> }).object;
    expect(o.kanban_group_by_fields).toEqual([{ key: 'trang_thai', label: 'Trạng thái', type: 'select' }]);
    expect(o.calendar_date_fields).toEqual([{ key: 'ngay_giao', label: 'Ngày giao', type: 'date' }]);
    expect(o).not.toHaveProperty('kanban_missing');
  });
  it('bảng thiếu trường select/ngày ⇒ nói rõ thiếu gì; bảng lõi ⇒ không tạo màn; bảng lạ ⇒ lỗi', async () => {
    const out = await listScreenTypesTool.run({ object: 'don_hang' }, tctx(deps([FIELDS[0]])));
    const o = (out.structured.data as { object: Record<string, unknown> }).object;
    expect(o.kanban_missing).toMatch(/select/);
    expect(o.calendar_missing).toMatch(/date/);
    const core = await listScreenTypesTool.run({ object: 'deals' }, tctx(deps()));
    expect((core.structured.data as { object: { kind: string } }).object.kind).toBe('core');
    const d = deps();
    ((d as unknown as { prisma: { customObject: { findMany: jest.Mock } } }).prisma.customObject.findMany).mockResolvedValue([]);
    await expect(listScreenTypesTool.run({ object: 'khong_co' }, tctx(d))).rejects.toBeInstanceOf(ToolUserError);
  });
});

describe('mô tả trung tính', () => {
  it('tool màn không chứa câu ra lệnh cho AI; có nhắc người dùng chọn loại + list_screen_types', () => {
    // Tiếng Anh: không phân biệt hoa thường. Tiếng Việt: chữ IN HOA kiểu ra lệnh ("PHẢI", "LUÔN"…); "trường bắt buộc" là mô tả, được phép.
    const imperativeEn = /\b(you must|must|always|never|important)\b/i;
    const imperativeVi = /PHẢI|LUÔN|BẮT BUỘC|GỌI ĐẦU TIÊN|CHỈ quản trị|hãy /;
    for (const n of ['create_view', 'update_view', 'list_screen_types']) {
      const t = MCP_TOOLS.find((x) => x.name === n)!;
      expect(t.description).not.toMatch(imperativeEn);
      expect(t.description).not.toMatch(imperativeVi);
    }
    expect(MCP_TOOLS.find((t) => t.name === 'create_view')!.description).toMatch(/do người dùng chọn.*list_screen_types/);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('list_screen_types');
  });
});

function tool(n: string) {
  return actionToolByName(n)!;
}
