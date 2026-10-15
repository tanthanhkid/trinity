import { ForbiddenException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { RecordValidator } from '../../../custom-objects/record-validator.service';
import { ACTION_TOOLS, actionToolByName } from '../actions/action-registry';
import { AiActionsService } from '../actions/ai-actions.service';
import { ActionUserError, type ActionCtx, type ActionDeps } from '../actions/action-types';
import { McpServerService } from '../mcp-server.service';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { loadMcpSdk } from '../mcp-sdk';
import { describeSchemaTool } from '../tools/schema-tools';
import { getRecordTool, listRecordsTool } from '../tools/record-tools';
import { ToolUserError, type McpDeps, type ToolContext } from '../tools/tool-types';
import type { McpPrincipal } from '../mcp-auth.service';

const user = (grants: Grants, id = 5): AuthUser => ({ userId: id, email: 'u@x.vn', isAdmin: false, grants });
const FULL = { 'custom_records.view': 'all', 'custom_records.manage': 'all', 'contacts.view': 'all', 'contacts.create': 'all', 'kanban.view': 'own' } as unknown as Grants;
const READ_ONLY = { 'custom_records.view': 'all' } as unknown as Grants;

const OBJ = { id: 1, key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh', description: null, is_active: true, deleted_at: null, visible_role_ids: [] as number[], nav_order: 1 };
const HIDDEN = { ...OBJ, id: 2, key: 'luong', label: 'Lương', label_plural: 'Lương', visible_role_ids: [99] };
const field = (id: number, key: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, object_id: 1, key, label: key.toUpperCase(), type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: id, options: {}, help_text: null, deleted_at: null, ...extra,
});
const FIELDS = [
  field(1, 'ho_ten', 'text', { required: true, is_title: true }),
  field(2, 'tuoi', 'number'),
  field(3, 'lop', 'select', { options: { choices: [{ value: 'a', label: 'Lớp A' }, { value: 'b', label: 'Lớp B' }] } }),
  field(4, 'sdt', 'phone'),
  field(5, 'phu_huynh', 'relation', { options: { target_object_id: 2 } }),
];

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    userRole: { findMany: jest.fn().mockResolvedValue([{ role_id: 1 }]) },
    customObject: { findMany: jest.fn().mockResolvedValue([OBJ, HIDDEN]), findFirst: jest.fn().mockImplementation(async ({ where }: { where: { key: string } }) => [OBJ, HIDDEN].find((o) => o.key === where.key) ?? null) },
    customView: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    customField: { findMany: jest.fn().mockImplementation(async ({ where }: { where: { object_id: number | { in: number[] } } }) => (typeof where.object_id === 'number' ? (where.object_id === 1 ? FIELDS : []) : FIELDS)) },
    customRecord: { findFirst: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...over,
  };
}

function makeDeps(prisma: ReturnType<typeof makePrisma>, over: Partial<McpDeps & ActionDeps> = {}) {
  const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
  const validator = new RecordValidator(prisma as never, scope as never);
  return { prisma, scope, validator, records: { create: jest.fn().mockResolvedValue({ id: 77 }), update: jest.fn().mockResolvedValue({ id: 9 }) }, recordLists: { list: jest.fn(), getOne: jest.fn() }, ...over } as never as McpDeps & ActionDeps;
}

const principal = (u: AuthUser): McpPrincipal => ({ userId: u.userId, email: u.email, clientId: 'cli', scopes: ['crm.read', 'crm.write'], tokenId: BigInt(1), user: u });
const ctx = (deps: McpDeps, u: AuthUser): ToolContext => ({ principal: principal(u), deps, baseUrl: 'https://x' });
const action = (n: string) => actionToolByName(n)!;

describe('registry', () => {
  it('có đủ 5 tool; KHÔNG có tool xoá cứng; mọi tool sửa cấu trúc đều cần custom_objects.manage', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['describe_schema', 'list_records', 'get_record', 'create_record', 'update_record']));
    expect(names.filter((n) => /delete|remove|drop/i.test(n))).toEqual([]);
    const structure = ['create_objects', 'create_object', 'update_object', 'add_field', 'update_field', 'archive_field', 'list_object_templates', 'install_object_template'];
    for (const n of structure) expect(MCP_TOOLS.find((t) => t.name === n)?.permissions).toEqual(['custom_objects.manage']);
  });
  it('đọc: không cần scope ghi; ghi: crm.write + quyền custom_records.manage, readOnlyHint=false', () => {
    const by = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
    for (const n of ['describe_schema', 'list_records', 'get_record']) { expect(by(n).scope).toBeUndefined(); expect(by(n).annotations).toBeUndefined(); }
    for (const n of ['create_record', 'update_record']) {
      expect(by(n).scope).toBe('crm.write');
      // quyền kiểm THEO BẢNG (tuỳ biến hoặc lõi) bên trong tool, không còn ở cấp tool.
      expect(by(n).permissions).toEqual([]);
      expect(by(n).annotations?.readOnlyHint).toBe(false);
    }
    expect(ACTION_TOOLS.length).toBe(28);
  });
  it('mô tả bảo model gọi describe_schema trước; input hợp lệ theo zod', () => {
    const { z } = loadMcpSdk();
    for (const n of ['list_records', 'get_record', 'create_record', 'update_record']) expect(MCP_TOOLS.find((t) => t.name === n)!.description).toContain('describe_schema');
    const c = z.object(MCP_TOOLS.find((t) => t.name === 'create_record')!.input(z));
    expect(c.safeParse({ object: 'hoc_sinh', values: { ho_ten: 'An' } }).success).toBe(true);
    expect(c.safeParse({ object: 'hoc_sinh' }).success).toBe(false);
    expect(z.object(MCP_TOOLS.find((t) => t.name === 'list_records')!.input(z)).safeParse({ object: 'x', limit: 51 }).success).toBe(false);
  });
});

describe('describe_schema', () => {
  it('trả bảng tuỳ biến người dùng thấy, kèm trường/kiểu/lựa chọn/quan hệ + quyền; bảng bị ẩn theo vai trò không lộ', async () => {
    const out = await describeSchemaTool.run({}, ctx(makeDeps(makePrisma()), user(FULL)));
    const tables = (out.structured.data as { tables: Record<string, unknown>[] }).tables;
    const hs = tables.find((t) => t.key === 'hoc_sinh') as { fields: { key: string; type: string; required: boolean; choices?: unknown[]; relation?: { table: string } }[]; permissions: Record<string, boolean>; kind: string };
    expect(hs.kind).toBe('custom');
    expect(hs.permissions).toEqual({ view: true, create: true, update: true, archive: false });
    expect(hs.fields.map((f) => f.key)).toEqual(['ho_ten', 'tuoi', 'lop', 'sdt', 'phu_huynh']);
    expect(hs.fields[0]).toMatchObject({ type: 'text', required: true });
    expect(hs.fields[2].choices).toEqual([{ value: 'a', label: 'Lớp A' }, { value: 'b', label: 'Lớp B' }]);
    expect(hs.fields[4].relation?.table).toBe('(bảng bạn không có quyền xem)');
    expect(tables.find((t) => t.key === 'luong')).toBeUndefined();
    expect(JSON.stringify(out.structured)).not.toContain('Lương');
  });
  it('user chỉ có quyền xem: create/update = false, tool ghi rỗng; lọc bảng lõi theo quyền thật', async () => {
    const out = await describeSchemaTool.run({}, ctx(makeDeps(makePrisma()), user(READ_ONLY)));
    const tables = (out.structured.data as { tables: { key: string; permissions: Record<string, boolean>; tools: { write: string[] } }[] }).tables;
    expect(tables.map((t) => t.key)).toEqual(['hoc_sinh']);
    expect(tables[0].permissions).toEqual({ view: true, create: false, update: false, archive: false });
    expect(tables[0].tools.write).toEqual([]);
    const full = await describeSchemaTool.run({}, ctx(makeDeps(makePrisma()), user(FULL)));
    expect((full.structured.data as { tables: { key: string }[] }).tables.map((t) => t.key)).toEqual(['contacts', 'tasks', 'hoc_sinh']);
  });
  it('không có custom_records.view thì không thấy bảng tuỳ biến nào; hỏi bảng lạ ⇒ ToolUserError', async () => {
    const deps = makeDeps(makePrisma());
    const none = await describeSchemaTool.run({}, ctx(deps, user({} as Grants)));
    expect((none.structured.data as { tables: unknown[] }).tables).toEqual([]);
    await expect(describeSchemaTool.run({ object: 'luong' }, ctx(deps, user(FULL)))).rejects.toBeInstanceOf(ToolUserError);
  });
  it('SĐT trong giá trị mặc định/nhãn vẫn đi qua wrapData (notice có mặt)', async () => {
    const out = await describeSchemaTool.run({ object: 'hoc_sinh' }, ctx(makeDeps(makePrisma()), user(FULL)));
    expect(out.structured.notice).toContain('DỮ LIỆU');
  });
});

describe('list_records / get_record', () => {
  it('chuyển tham số cho service đọc với người dùng đã gỡ phone_full; filter → JSON; limit kẹp 50', async () => {
    const deps = makeDeps(makePrisma());
    (deps.recordLists.list as jest.Mock).mockResolvedValue({ items: [{ id: 1, title: 'An', data: { sdt: '***678' } }], next_cursor: 'abc', total: 1 });
    const u = user(FULL);
    const out = await listRecordsTool.run({ object: 'hoc_sinh', filter: { lop: 'a' }, search: 'An', sort: 'title', dir: 'asc', limit: 500 }, ctx(deps, u));
    expect(deps.recordLists.list).toHaveBeenCalledWith(u, 'hoc_sinh', expect.objectContaining({ q: 'An', filter: '{"lop":"a"}', sort: 'title', dir: 'asc', limit: 50 }), { qInText: true });
    expect((out.structured.data as { next_cursor: string }).next_cursor).toBe('abc');
  });
  it('chặn dò chữ số trong search; khoá bảng sai định dạng; bảng không thấy ⇒ chỉ đường describe_schema', async () => {
    const deps = makeDeps(makePrisma());
    await expect(listRecordsTool.run({ object: 'hoc_sinh', search: '09012345' }, ctx(deps, user(FULL)))).rejects.toThrow(/chữ số/);
    await expect(listRecordsTool.run({ object: 'Học Sinh;--' }, ctx(deps, user(FULL)))).rejects.toBeInstanceOf(ToolUserError);
    const { NotFoundException } = jest.requireActual('@nestjs/common');
    (deps.recordLists.getOne as jest.Mock).mockRejectedValue(new NotFoundException('Không tìm thấy tính năng này'));
    await expect(getRecordTool.run({ object: 'luong', id: 1 }, ctx(deps, user(FULL)))).rejects.toThrow(/describe_schema/);
  });
  it('get_record có cả id và code trỏ hai bản ghi khác nhau ⇒ lỗi rõ; cùng bản ghi ⇒ chạy', async () => {
    const refs = { resolveCodes: jest.fn().mockResolvedValue(new Map([['HS001', { type: 'record', table_key: 'hoc_sinh', id: 3, code: 'HS001' }]])) };
    const deps = makeDeps(makePrisma(), { refs } as never);
    (deps.recordLists.getOne as jest.Mock).mockResolvedValue({ id: 3, title: 'An', data: {} });
    await expect(getRecordTool.run({ code: 'HS001', id: 4 }, ctx(deps, user(FULL)))).rejects.toThrow(/không cùng một bản ghi/);
    await expect(getRecordTool.run({ code: 'HS001', id: 4 }, ctx(deps, user(FULL)))).rejects.toBeInstanceOf(ToolUserError);
    const ok = await getRecordTool.run({ code: 'HS001', id: 3 }, ctx(deps, user(FULL)));
    expect((ok.structured.data as { id: number }).id).toBe(3);
    const upd = action('update_record').prepare({ object: 'hoc_sinh', code: 'HS001', id: 4, values: { tuoi: 1 } }, { deps, user: user(FULL) } as ActionCtx);
    await expect(upd).rejects.toThrow(/không cùng một bản ghi/);
  });
  it('get_record che SĐT dạng khoá phone khi service lỡ trả đủ (lớp phòng thủ thứ hai)', async () => {
    const deps = makeDeps(makePrisma());
    (deps.recordLists.getOne as jest.Mock).mockResolvedValue({ id: 3, title: 'An', data: { sdt: '0987654321', ghi_chu: 'gọi 0987654321' } });
    const out = await getRecordTool.run({ object: 'hoc_sinh', id: 3 }, ctx(deps, user(FULL)));
    expect(JSON.stringify(out.structured)).not.toContain('0987654321');
  });
});

describe('create_record (tạo nháp, validate sớm)', () => {
  const run = (args: Record<string, unknown>, deps = makeDeps(makePrisma()), u = user(FULL)) => action('create_record').prepare(args, { deps, user: u } as ActionCtx);
  it('dữ liệu đúng ⇒ có params + summary + chi tiết (nhãn lựa chọn, SĐT che)', async () => {
    const p = await run({ object: 'hoc_sinh', values: { ho_ten: 'Nguyễn An', tuoi: 9, lop: 'a', sdt: '0987654321' } });
    expect(p.params).toEqual({ object: 'hoc_sinh', values: { ho_ten: 'Nguyễn An', tuoi: 9, lop: 'a', sdt: '0987654321' } });
    expect(p.summary).toContain('Nguyễn An');
    expect(p.details.find((d) => d.label === 'LOP')?.value).toBe('Lớp A');
    expect(JSON.stringify(p.details)).not.toContain('0987654321');
    expect(JSON.stringify(p.summary)).not.toContain('0987654321');
  });
  it('sai kiểu / thiếu bắt buộc / trường lạ / lựa chọn lạ ⇒ ActionUserError nêu lỗi theo trường', async () => {
    await expect(run({ object: 'hoc_sinh', values: { ho_ten: 'An', tuoi: 'chín' } })).rejects.toThrow(/tuoi/);
    await expect(run({ object: 'hoc_sinh', values: { tuoi: 9 } })).rejects.toThrow(/ho_ten.*bắt buộc/);
    await expect(run({ object: 'hoc_sinh', values: { ho_ten: 'An', khong_co: 1 } })).rejects.toThrow(/khong_co.*không tồn tại/);
    await expect(run({ object: 'hoc_sinh', values: { ho_ten: 'An', lop: 'z' } })).rejects.toBeInstanceOf(ActionUserError);
  });
  it('bảng không thấy được (ẩn theo vai trò) hoặc không tồn tại ⇒ cùng một lỗi, không lộ', async () => {
    const a = String(await run({ object: 'luong', values: { x: 1 } }).catch((e: Error) => e.message));
    const b = String(await run({ object: 'khong_ton_tai', values: { x: 1 } }).catch((e: Error) => e.message));
    expect(a).toContain('describe_schema');
    expect(a.replace('luong', 'K')).toBe(b.replace('khong_ton_tai', 'K'));
  });
  it('tham số rác: values không phải object, rỗng, khoá bảng sai', async () => {
    await expect(run({ object: 'hoc_sinh', values: [1] })).rejects.toBeInstanceOf(ActionUserError);
    await expect(run({ object: 'hoc_sinh', values: {} })).rejects.toBeInstanceOf(ActionUserError);
    await expect(run({ object: '../x', values: { a: 1 } })).rejects.toBeInstanceOf(ActionUserError);
  });
  it('execute ghi qua CustomRecordsService với người DUYỆT, trả record_id', async () => {
    const deps = makeDeps(makePrisma());
    const approver = user(FULL, 42);
    const r = await action('create_record').execute({ object: 'hoc_sinh', values: { ho_ten: 'An' } }, { deps, user: approver } as ActionCtx, 1);
    expect(deps.records.create).toHaveBeenCalledWith(approver, 'hoc_sinh', { data: { ho_ten: 'An' } });
    expect(r).toEqual({ record_id: 77, object: 'hoc_sinh' });
  });
});

describe('update_record', () => {
  const row = { id: 9, object_id: 1, title: 'An', owner_id: 5, created_by: 5, data: { ho_ten: 'An', tuoi: 9, sdt: '0987654321' }, deleted_at: null };
  const deps = () => { const p = makePrisma(); p.customRecord.findFirst.mockResolvedValue(row); return makeDeps(p); };
  const run = (args: Record<string, unknown>, d = deps(), u = user(FULL)) => action('update_record').prepare(args, { deps: d, user: u } as ActionCtx);
  it('chỉ trường đổi vào chi tiết (cũ → mới); SĐT che; summary nêu trường đổi', async () => {
    const p = await run({ object: 'hoc_sinh', id: 9, values: { tuoi: 10 } });
    expect(p.params).toEqual({ object: 'hoc_sinh', id: 9, values: { tuoi: 10 } });
    expect(p.details.find((d) => d.label === 'TUOI')?.value).toBe('9 → 10');
    expect(p.summary).toContain('TUOI');
    expect(JSON.stringify(p)).not.toContain('0987654321');
  });
  it('sai kiểu bị báo lỗi; không đổi gì thì báo; bản ghi không có/ngoài phạm vi ⇒ cùng thông báo', async () => {
    await expect(run({ object: 'hoc_sinh', id: 9, values: { tuoi: 'abc' } })).rejects.toThrow(/tuoi/);
    await expect(run({ object: 'hoc_sinh', id: 9, values: { tuoi: 9 } })).rejects.toThrow(/Không có thay đổi/);
    const gone = deps(); (gone.prisma.customRecord.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(run({ object: 'hoc_sinh', id: 9, values: { tuoi: 10 } }, gone)).rejects.toThrow(/ngoài phạm vi/);
    const scoped = deps(); (scoped.scope.ownerIds as jest.Mock).mockResolvedValue([77]);
    await expect(run({ object: 'hoc_sinh', id: 9, values: { tuoi: 10 } }, scoped)).rejects.toThrow(/ngoài phạm vi/);
  });
  it('đổi trường tiêu đề ⇒ summary nêu tên MỚI ("An → Bình"), không chỉ tên cũ', async () => {
    const p = await run({ object: 'hoc_sinh', id: 9, values: { ho_ten: 'Bình' } });
    expect(p.summary).toContain('"An → Bình"');
    const q = await run({ object: 'hoc_sinh', id: 9, values: { tuoi: 10 } });
    expect(q.summary).toContain('"An"');
    expect(q.summary).not.toContain('→');
  });
  it('execute gọi update của service với người duyệt', async () => {
    const d = deps(); const approver = user(FULL, 42);
    await action('update_record').execute({ object: 'hoc_sinh', id: 9, values: { tuoi: 10 } }, { deps: d, user: approver } as ActionCtx, 1);
    expect(d.records.update).toHaveBeenCalledWith(approver, 'hoc_sinh', 9, { data: { tuoi: 10 } });
  });
});

describe('McpServerService.execute — quyền + scope', () => {
  const server = () => new McpServerService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const tool = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
  it('thiếu custom_records.manage ⇒ create_record bị từ chối; thiếu view ⇒ list_records bị từ chối', async () => {
    const s = server();
    const deps = makeDeps(makePrisma());
    await expect(action('create_record').prepare({ object: 'hoc_sinh', values: { a: 1 } }, { deps, user: user(READ_ONLY) } as ActionCtx)).rejects.toThrow(/custom_records\.manage/);
    const r2 = await s.execute(tool('list_records'), { object: 'hoc_sinh' }, principal(user({} as Grants)));
    expect(r2.isError).toBe(true); expect(r2.content[0].text).toContain('custom_records.view');
  });
  it('token chỉ có crm.read ⇒ create_record/update_record bị từ chối vì thiếu scope ghi', async () => {
    const p = { ...principal(user(FULL)), scopes: ['crm.read'] };
    const r = await server().execute(tool('update_record'), { object: 'hoc_sinh', id: 1, values: { a: 1 } }, p);
    expect(r.isError).toBe(true); expect(r.content[0].text).toContain('insufficient_scope');
  });
});

describe('duyệt nháp ⇒ bản ghi (AiActionsService.approve)', () => {
  it('approve chạy create_record qua service ghi với quyền người duyệt và lưu result', async () => {
    const draft = { id: 11, user_id: 42, client_id: 'cli', tool: 'create_record', params: { object: 'hoc_sinh', values: { ho_ten: 'An' } }, summary: 's', details: [], status: 'approved', result: null, error: null, created_at: new Date(), decided_at: new Date(), expires_at: new Date(Date.now() + 1e6) };
    const prisma = { aiActionDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(draft), update: jest.fn().mockResolvedValue(draft) }, oauthClient: { findMany: jest.fn().mockResolvedValue([]) } };
    const records = { create: jest.fn().mockResolvedValue({ id: 123 }) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new AiActionsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, audit as never, {} as never, records as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const approver = user(FULL, 42);
    await svc.approve(approver, 11);
    expect(records.create).toHaveBeenCalledWith(approver, 'hoc_sinh', { data: { ho_ten: 'An' } });
    expect(prisma.aiActionDraft.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { result: { record_id: 123, object: 'hoc_sinh' } } });
  });
  it('mất quyền custom_records.manage lúc duyệt ⇒ 403, nháp chuyển failed, không ghi', async () => {
    const draft = { id: 12, user_id: 42, client_id: 'cli', tool: 'update_record', params: { object: 'hoc_sinh', id: 9, values: { tuoi: 1 } }, summary: 's', details: [], status: 'approved', result: null, error: null, created_at: new Date(), decided_at: new Date(), expires_at: new Date(Date.now() + 1e6) };
    const prisma = { aiActionDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(draft), update: jest.fn().mockResolvedValue(draft) }, oauthClient: { findMany: jest.fn().mockResolvedValue([]) } };
    const records = { update: jest.fn() };
    const svc = new AiActionsService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { log: jest.fn().mockResolvedValue(undefined) } as never, {} as never, records as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(svc.approve(user(READ_ONLY, 42), 12)).rejects.toBeInstanceOf(ForbiddenException);
    expect(records.update).not.toHaveBeenCalled();
    expect(prisma.aiActionDraft.update).toHaveBeenCalledWith({ where: { id: 12 }, data: expect.objectContaining({ status: 'failed' }) });
  });
});
