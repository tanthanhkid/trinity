/**
 * Tool MCP của chương trình con: luồng NHÁP → (người) DUYỆT → deploy → quay lui qua đúng đường MCP, chặn quyền/scope, cờ tắt ẩn tool,
 * chạy thử không ghi thật, và tool động của chương trình con `active` đi qua MCP SDK thật.
 */
import type { Grants } from '@trinity/rbac';
import { ExtensionsService } from '../../../extensions/extensions.service';
import { fakePrisma } from '../../../extensions/__tests__/fake-prisma';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { McpServerService } from '../mcp-server.service';
import type { McpPrincipal } from '../mcp-auth.service';
import { EXTENSION_TOOLS, EXTENSION_TOOL_NAMES } from '../tools/extension-tools';

const MANIFEST = { net: [] as string[], tables: { read: ['khach_hang'], write: [] }, schedule: '0 8 * * *' };
const BIG_CODE = `export default async function (ctx) {\n${'  // dòng chú thích dài để kiểm tra không bị cắt 500 ký tự\n'.repeat(40)}  return 1\n}`;

const principal = (grants: Record<string, unknown>, scopes = ['crm.read', 'crm.write']): McpPrincipal =>
  ({ userId: 5, email: 'a@x.vn', clientId: 'chatgpt', scopes, tokenId: 1n, user: { userId: 5, email: 'a@x.vn', isAdmin: false, grants: grants as unknown as Grants } }) as McpPrincipal;
const DRAFTER = { 'extensions.view': true, 'extensions.draft': true };

function setup() {
  const prisma = fakePrisma();
  const runtime = {
    activate: jest.fn().mockResolvedValue(undefined),
    deactivate: jest.fn().mockResolvedValue(undefined),
    dryRun: jest.fn().mockResolvedValue({ run_id: 1, outcome: 'ok', duration_ms: 12, log: 'xong', result: { rows: 3 }, would_write: 3, data_requests: 1, denied_requests: 0 }),
    listActiveTools: jest.fn().mockReturnValue([]),
    callTool: jest.fn(),
  };
  const notifications = { findUserIdsWithPermission: jest.fn().mockResolvedValue([]), createPendingLogs: jest.fn() };
  const extensions = new ExtensionsService(prisma as never, runtime as never, notifications as never);
  const n = {} as never;
  const server = new McpServerService(n, n, n, n, n, n, n, n, { log: jest.fn().mockResolvedValue(undefined) } as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, n, n, n, n, n, n, n, n, n, extensions, runtime as never);
  const call = async (name: string, args: Record<string, unknown>, p = principal(DRAFTER)) => {
    const r = await server.execute(MCP_TOOLS.find((t) => t.name === name)!, args, p);
    return { error: r.isError ? r.content[0]?.text : undefined, data: (r.structuredContent as { data: Record<string, any> } | undefined)?.data }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { prisma, runtime, extensions, server, call };
}

describe('tool MCP chương trình con', () => {
  beforeEach(() => void (process.env.EXTENSIONS_ENABLED = 'true'));
  afterEach(() => void delete process.env.EXTENSIONS_ENABLED);

  it('đủ 8 tool đúng tên; KHÔNG có tool duyệt; mô tả dạy agent hợp đồng mã + quy trình nháp–duyệt', () => {
    expect(EXTENSION_TOOLS.map((t) => t.name).sort()).toEqual(['create_extension', 'deploy_extension', 'disable_extension', 'dry_run_extension', 'list_extensions', 'logs_extension', 'rollback_extension', 'update_extension']);
    expect(MCP_TOOLS.some((t) => /approve|reject|duyet/i.test(t.name) && EXTENSION_TOOL_NAMES.has(t.name))).toBe(false);
    const d = EXTENSION_TOOLS.find((t) => t.name === 'create_extension')!.description;
    for (const must of ['export default', 'ctx.records.create', 'manifest.net', 'NGƯỜI duyệt', 'NHÁP', 'dry_run_extension']) expect(d).toContain(must);
    expect(EXTENSION_TOOLS.filter((t) => t.scope === 'crm.write').map((t) => t.name).sort()).toEqual(['create_extension', 'deploy_extension', 'disable_extension', 'dry_run_extension', 'rollback_extension', 'update_extension']);
  });

  it('cờ TẮT ⇒ 8 tool bị ẩn khỏi tools/list và gọi vào bị từ chối rõ ràng', async () => {
    const s = setup();
    delete process.env.EXTENSIONS_ENABLED;
    const names = (s.server as unknown as { visibleTools(): { name: string }[] }).visibleTools().map((t) => t.name);
    expect(names.filter((n) => EXTENSION_TOOL_NAMES.has(n))).toEqual([]);
    expect((await s.call('create_extension', { key: 'a', kind: 'job', code: 'x', manifest: MANIFEST })).error).toContain('chưa được bật');
    process.env.EXTENSIONS_ENABLED = 'true';
    expect((s.server as unknown as { visibleTools(): { name: string }[] }).visibleTools().filter((t) => EXTENSION_TOOL_NAMES.has(t.name))).toHaveLength(8);
  });

  it('LUỒNG: tạo nháp → chạy thử → deploy bị chặn khi chưa duyệt → người duyệt → deploy → sửa → quay lui', async () => {
    const s = setup();
    const created = await s.call('create_extension', { key: 'dong-bo-sheet', kind: 'job', name: 'Đồng bộ Sheet', code: BIG_CODE, manifest: MANIFEST });
    expect(created.error).toBeUndefined();
    expect(created.data!.extension).toMatchObject({ key: 'dong-bo-sheet', status: 'draft' });

    const dry = await s.call('dry_run_extension', { key: 'dong-bo-sheet', params: { sheetUrl: 'x' } });
    expect(dry.data).toMatchObject({ version: 1, outcome: 'ok', would_write: 3 });
    expect(s.runtime.dryRun).toHaveBeenCalledWith(expect.objectContaining({ key: 'dong-bo-sheet' }), expect.objectContaining({ version: 1 }), { params: { sheetUrl: 'x' }, tool: undefined, args: undefined }, 5);

    const refused = await s.call('deploy_extension', { key: 'dong-bo-sheet' });
    expect(refused.error).toContain('NGƯỜI duyệt');
    expect(s.runtime.activate).not.toHaveBeenCalled();

    await s.extensions.approve(7, 'dong-bo-sheet', 1); // hành động của NGƯỜI qua web — không có tool MCP tương ứng
    const dep = await s.call('deploy_extension', { key: 'dong-bo-sheet' });
    expect(dep.data!.extension).toMatchObject({ status: 'active', active_version: 1 });
    expect(dep.data!.message).toBe('Đã bật chạy.');

    expect((await s.call('update_extension', { key: 'dong-bo-sheet', code: `${BIG_CODE}\n// v2`, note: 'v2' })).data!.version).toMatchObject({ version: 2, review_status: 'draft' });
    expect((await s.call('deploy_extension', { key: 'dong-bo-sheet', version: 2 })).error).toContain('chưa được NGƯỜI duyệt');
    await s.extensions.approve(7, 'dong-bo-sheet', 2);
    await s.call('deploy_extension', { key: 'dong-bo-sheet', version: 2 });
    expect((await s.call('rollback_extension', { key: 'dong-bo-sheet', version: 1 })).data!.extension).toMatchObject({ active_version: 1, status: 'active' });
    expect((await s.call('disable_extension', { key: 'dong-bo-sheet', reason: 'thử' })).data!.extension).toMatchObject({ status: 'disabled', disabled_reason: 'AI tắt: thử' });
  });

  it('list_extensions: danh sách, chi tiết phiên bản (kèm lý do từ chối), mã nguồn KHÔNG bị cắt 500 ký tự', async () => {
    const s = setup();
    await s.call('create_extension', { key: 'a-1', kind: 'tool', code: BIG_CODE, manifest: { net: [], tables: {} } });
    await s.extensions.reject(7, 'a-1', 1, 'xin quá nhiều quyền');
    expect((await s.call('list_extensions', {})).data!.extensions).toHaveLength(1);
    expect((await s.call('list_extensions', { key: 'a-1' })).data!.versions[0]).toMatchObject({ review_status: 'rejected', review_note: 'xin quá nhiều quyền' });
    const code = (await s.call('list_extensions', { key: 'a-1', version: 1 })).data!.version.code as string;
    expect(code).toBe(BIG_CODE);
    expect(code.length).toBeGreaterThan(1500);
  });

  it('CHẶN QUYỀN: thiếu extensions.draft không tạo/chạy thử/deploy; chỉ view thì chỉ đọc; thiếu scope crm.write bị từ chối', async () => {
    const s = setup();
    const viewer = principal({ 'extensions.view': true });
    for (const [name, args] of [['create_extension', { key: 'b', kind: 'job', code: 'x', manifest: MANIFEST }], ['update_extension', { key: 'b' }], ['dry_run_extension', { key: 'b' }], ['deploy_extension', { key: 'b' }], ['disable_extension', { key: 'b' }], ['rollback_extension', { key: 'b', version: 1 }]] as const) {
      expect((await s.call(name, { ...args }, viewer)).error).toContain('extensions.draft');
    }
    expect((await s.call('list_extensions', {}, viewer)).error).toBeUndefined();
    expect((await s.call('logs_extension', { key: 'zzz' }, principal({}))).error).toContain('extensions.view');
    expect((await s.call('create_extension', { key: 'c', kind: 'job', code: 'x', manifest: MANIFEST }, principal(DRAFTER, ['crm.read']))).error).toContain('insufficient_scope');
    expect(await s.prisma.extension.count()).toBe(0);
  });

  it('lỗi đầu vào trả nguyên văn tiếng Việt cho agent (host nội bộ, lịch quá dày, key xấu, không tìm thấy)', async () => {
    const s = setup();
    const bad = (o: Record<string, unknown>) => s.call('create_extension', { key: 'bad', kind: 'job', code: 'export default () => 1', manifest: MANIFEST, ...o });
    expect((await bad({ manifest: { ...MANIFEST, net: ['localhost:5432'] } })).error).toContain('địa chỉ nội bộ');
    expect((await bad({ manifest: { ...MANIFEST, schedule: '* * * * *' } })).error).toContain('quá dày');
    expect((await bad({ key: 'KEY LẠ' })).error).toContain('key chỉ gồm');
    expect((await s.call('logs_extension', { key: 'khong-co' })).error).toBeDefined();
  });

  it('logs_extension trả log đầy đủ (không cắt 500) theo thứ tự mới nhất trước', async () => {
    const s = setup();
    const e = (await s.call('create_extension', { key: 'lg', kind: 'job', code: 'x', manifest: MANIFEST })).data!.extension;
    for (const [i, outcome] of ['ok', 'error'].entries()) await s.prisma.extensionRun.create({ data: { extension_id: e.id, mode: 'schedule', outcome, log: `dòng ${i} `.repeat(300) } });
    const r = (await s.call('logs_extension', { key: 'lg' })).data!;
    expect(r.runs.map((x: { outcome: string }) => x.outcome)).toEqual(['error', 'ok']);
    expect(r.runs[0].log.length).toBeGreaterThan(1500);
  });
});

describe('tool động của chương trình con `active` — qua MCP SDK thật', () => {
  beforeEach(() => void (process.env.EXTENSIONS_ENABLED = 'true'));
  afterEach(() => void delete process.env.EXTENSIONS_ENABLED);

  it('hai khoá khác nhau cùng ra một tên tool (a+b vs a-b+run) ⇒ giữ tool đầu, tools/list không ném lỗi', async () => {
    const { extensionToolDefs } = await import('../tools/extension-dynamic');
    const schema = { type: 'object' };
    const defs = extensionToolDefs({
      listActiveTools: () => [
        { extId: 1, key: 'a', tools: [{ name: 'b', description: 'đầu', inputSchema: schema }] },
        { extId: 2, key: 'a-b', tools: [{ name: 'run', description: 'trùng', inputSchema: schema }] },
      ],
    } as never);
    expect(defs.map((d) => d.name)).toEqual(['ext_a_b']);
    expect(defs[0].description).toContain('đầu');
  });

  it('xuất hiện trong tools/list với schema từ manifest, gọi được, lỗi tool thành lỗi rõ ràng, tắt thì biến mất', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const s = setup();
    const schema = { type: 'object', properties: { ten: { type: 'string', description: 'Tên khách' }, so: { type: 'number' } }, required: ['ten'] };
    s.runtime.listActiveTools.mockReturnValue([{ extId: 1, key: 'tra-cuu', tools: [{ name: 'run', description: 'Tra cứu khách', inputSchema: schema }, { name: 'dem', description: 'Đếm', inputSchema: { type: 'object' } }] }]);
    s.runtime.callTool.mockResolvedValueOnce({ ok: true, value: { khach: 'Lan', sdt: '0901234567' } }).mockResolvedValueOnce({ ok: false, kind: 'tool_error', message: 'Error: vỡ' });
    const connect = async (p: McpPrincipal) => {
      const srv = (s.server as unknown as { buildServer(p: McpPrincipal): { connect(t: unknown): Promise<void>; close(): Promise<void> } }).buildServer(p);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '1' });
      await Promise.all([srv.connect(a), client.connect(b)]);
      return { client, srv };
    };
    const { client, srv } = await connect(principal(DRAFTER));
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['ext_tra_cuu', 'ext_tra_cuu_dem']));
    const t = tools.find((x) => x.name === 'ext_tra_cuu')!;
    expect(t.description).toContain('Tra cứu khách');
    expect((t.inputSchema as { required?: string[] }).required).toEqual(['ten']);

    const ok = await client.callTool({ name: 'ext_tra_cuu', arguments: { ten: 'Lan' } });
    expect(s.runtime.callTool).toHaveBeenCalledWith('tra-cuu', 'run', { ten: 'Lan' });
    expect(JSON.stringify(ok.structuredContent)).toContain('***567'); // đầu ra của mã khách vẫn bị che SĐT
    expect(JSON.stringify(ok.structuredContent)).not.toContain('0901234567');
    const bad = await client.callTool({ name: 'ext_tra_cuu_dem', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('tool_error');
    await client.close(); await srv.close();

    // người không có quyền view không gọi được
    const none = await connect(principal({}));
    const denied = await none.client.callTool({ name: 'ext_tra_cuu', arguments: { ten: 'x' } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain('extensions.view');
    await none.client.close(); await none.srv.close();

    s.runtime.listActiveTools.mockReturnValue([]);
    const after = await connect(principal(DRAFTER));
    expect((await after.client.listTools()).tools.some((x) => x.name.startsWith('ext_'))).toBe(false);
    await after.client.close(); await after.srv.close();
  });
});
