/**
 * Tích hợp THẬT với Deno: sandbox quyền, chạy thử không ghi, job theo lịch, tool qua ext-host, tự tắt khi lỗi liên tục.
 * Bỏ qua nếu máy không có `deno` (ví dụ máy CI thuần Node).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import type { Extension, ExtensionVersion } from '@prisma/client';
import { extensionsEnabled } from '../extension-flags';
import { ExtensionRunLog } from '../extension-run-log';
import { ExtensionsRuntime } from '../extensions.runtime';
import { runJob } from '../runner/job-runner';
import { fakePrisma, type FakePrisma } from './fake-prisma';

const hasDeno = spawnSync('deno', ['--version']).status === 0;
const d = hasDeno ? describe : describe.skip;
const LIMITS = { timeoutMs: 8000, memoryMb: 64 };

d('sandbox Deno — job một lần', () => {
  let srv: Server;
  let hostPort = '';
  beforeAll(async () => {
    srv = createServer((_q, r) => r.end('pong'));
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    hostPort = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((ok) => srv.close(ok)));
  const run = (code: string, net: string[] = [], limits = LIMITS) => runJob({ code, net, limits });

  it('job thường chạy xong, trả giá trị', async () => {
    const r = await run('export default () => ({ cong: 1 + 2 })');
    expect(r).toMatchObject({ outcome: 'ok', result: { cong: 3 } });
  });

  it('host được khai gọi được; host KHÔNG khai ⇒ permission_denied', async () => {
    expect((await run(`export default async () => (await (await fetch("http://${hostPort}/")).text())`, [hostPort])).result).toBe('pong');
    const denied = await run(`export default async () => (await fetch("http://127.0.0.1:59999/")).status`, [hostPort]);
    expect(denied.outcome).toBe('permission_denied');
    expect((await run('export default async () => (await fetch("https://example.com")).status')).outcome).toBe('permission_denied');
  });

  it.each([
    ['đọc file', 'export default () => Deno.readTextFileSync("/etc/hosts")', 'permission_denied'],
    ['ghi file', 'export default () => Deno.writeTextFileSync("/tmp/ext-pwn.txt", "x")', 'permission_denied'],
    ['đọc env', 'export default () => Deno.env.get("HOME")', 'permission_denied'],
    ['chạy lệnh', 'export default () => new Deno.Command("ls").outputSync()', 'permission_denied'],
    ['import tĩnh file', 'import x from "file:///etc/hosts" with { type: "text" }; export default () => x', 'permission_denied'],
    ['import mã từ mạng', 'import x from "https://deno.land/std/version.ts"; export default () => x', 'error'],
  ])('khoá quyền: %s', async (_n, code, outcome) => {
    expect((await run(code)).outcome).toBe(outcome);
  });

  it('vòng lặp vô hạn bị kill đúng giờ; hết bộ nhớ heap ⇒ oom; lỗi mã ⇒ error', async () => {
    const t0 = Date.now();
    expect((await run('export default () => { for (;;); }', [], { ...LIMITS, timeoutMs: 800 })).outcome).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await run('export default () => { const a: number[][] = []; for (;;) a.push(new Array(1e6).fill(1)); }', [], { timeoutMs: 20_000, memoryMb: 32 })).outcome).toBe('oom');
    expect((await run('export default () => { throw new Error("hỏng") }')).outcome).toBe('error');
  });
});

d('ExtensionsRuntime — chạy thử, lịch, tool, tự tắt', () => {
  let prisma: FakePrisma;
  let rt: ExtensionsRuntime;
  let port: { create: jest.Mock; list: jest.Mock };
  let notifications: { findUserIdsWithPermission: jest.Mock; createPendingLogs: jest.Mock };

  const mk = async (key: string, kind: 'job' | 'tool', code: string, manifest: Record<string, unknown>, status = 'active') => {
    const e = await prisma.extension.create({ data: { key, kind, name: key, status, created_by: 1, latest_version: 1 } });
    const v = await prisma.extensionVersion.create({ data: { extension_id: e.id, version: 1, code, manifest, review_status: 'approved', created_by: 1, reviewed_by: 7 } });
    await prisma.extension.update({ where: { id: e.id }, data: { active_version_id: v.id } });
    return { e: (await prisma.extension.findUnique({ where: { id: e.id } })) as unknown as Extension, v: v as unknown as ExtensionVersion };
  };
  const status = async (id: number) => (await prisma.extension.findUnique({ where: { id } }))!;

  beforeEach(() => {
    process.env.EXTENSIONS_ENABLED = 'true';
    prisma = fakePrisma();
    port = { create: jest.fn(async (_a: unknown, _t: string, rows: unknown[]) => ({ created: rows.length })), list: jest.fn(async () => ({ items: [{ id: 1, title: 'A' }], next_cursor: null })) };
    notifications = { findUserIdsWithPermission: jest.fn().mockResolvedValue([9]), createPendingLogs: jest.fn().mockResolvedValue({ created: 1 }) };
    rt = new ExtensionsRuntime(prisma as never, port as never, new ExtensionRunLog(prisma as never, notifications as never));
  });
  afterEach(async () => {
    await rt.onModuleDestroy();
    delete process.env.EXTENSIONS_ENABLED;
  });

  const JOB = `export default async function (ctx) {
    const doc = await ctx.records.list("doc", { limit: 5 });
    const w = await ctx.records.create("ghi", [{ a: 1 }, { a: 2 }]);
    let ngoai = "không bị chặn";
    try { await ctx.records.create("contacts", [{}]); } catch (e) { ngoai = String(e.message); }
    ctx.log("SĐT khách 0901234567 xong", ctx.dryRun);
    return { doc: doc.items.length, w, ngoai };
  }`;
  const MF = { net: [], tables: { read: ['doc'], write: ['ghi'] }, schedule: '0 8 * * *' };

  it('chạy thử: ghi chỉ ĐẾM, không gọi DataPort.create, bảng ngoài phạm vi 403, log che SĐT, có nhật ký dry_run', async () => {
    const { e, v } = await mk('thu', 'job', JOB, MF, 'draft');
    const r = await rt.dryRun(e, v, {}, 42);
    expect(r.outcome).toBe('ok');
    expect(r.would_write).toBe(2);
    expect(r.denied_requests).toBe(1);
    expect(port.create).not.toHaveBeenCalled();
    expect(port.list).toHaveBeenCalledWith({ extId: e.id, asUserId: 42 }, 'doc', { limit: 5, cursor: undefined });
    expect(r.result).toMatchObject({ doc: 1, w: { created: 2, dry_run: true } });
    expect((r.result as { ngoai: string }).ngoai).toContain('403');
    expect(r.log).toContain('***567');
    expect(r.log).not.toContain('0901234567');
    expect(prisma.extensionRun.rows[0]).toMatchObject({ mode: 'dry_run', outcome: 'ok' });
    expect((await status(e.id)).consecutive_failures).toBe(0); // chạy thử không tính vào cầu dao
  });

  it('chạy thử lỗi không làm hỏng cầu dao; lỗi mã được trả về trong log', async () => {
    const { e, v } = await mk('hong', 'job', 'export default () => { throw new Error("vỡ rồi") }', MF, 'draft');
    const r = await rt.dryRun(e, v, {}, 1);
    expect(r.outcome).toBe('error');
    expect(r.log).toContain('vỡ rồi');
    expect((await status(e.id)).consecutive_failures).toBe(0);
  });

  it('tool chạy thử: gọi theo tên + tham số', async () => {
    const code = 'export const tools = { cong: { description: "cộng", inputSchema: {type:"object"}, run: ({a,b}: {a:number,b:number}) => a + b } }';
    const { e, v } = await mk('cong', 'tool', code, { net: [], tables: { read: [], write: [] }, input_schema: { type: 'object' } }, 'draft');
    expect((await rt.dryRun(e, v, { tool: 'cong', args: { a: 2, b: 3 } }, 1)).result).toBe(5);
  });

  it('job theo lịch: đúng giờ mới chạy, GHI THẬT qua cổng, không chạy hai lần trong một phút', async () => {
    const { e } = await mk('lich', 'job', JOB, MF);
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 12, h - 7, m));
    expect(await rt.tick(at(7, 59))).toBe(0);
    expect(await rt.tick(at(8))).toBe(1);
    expect(await rt.tick(at(8))).toBe(0);
    expect(port.create).toHaveBeenCalledWith({ extId: e.id, asUserId: undefined }, 'ghi', [{ a: 1 }, { a: 2 }]);
    const run = prisma.extensionRun.rows.find((r) => r.mode === 'schedule')!;
    expect(run.outcome).toBe('ok');
    expect(run.log).toContain('ghi 2 dòng');
    expect((await status(e.id)).status).toBe('active');
  });

  it('TỰ TẮT (lịch mỗi 5 phút): đủ 3 lỗi liên tiếp ⇒ disabled, thông báo, dừng chạy', async () => {
    const { e } = await mk('xau5', 'job', 'export default () => { throw new Error("luôn lỗi") }', { ...MF, schedule: '*/5 * * * *' });
    const at = (m: number) => new Date(Date.UTC(2026, 9, 12, 1, m));
    for (const m of [0, 5, 10]) await rt.tick(at(m));
    const row = await status(e.id);
    expect(row).toMatchObject({ status: 'disabled', consecutive_failures: 3 });
    expect(row.disabled_reason).toContain('Tự tắt');
    expect(row.disabled_reason).toContain('luôn lỗi');
    expect(notifications.createPendingLogs).toHaveBeenCalledWith([9], 'extension.auto_disabled', expect.objectContaining({ title: expect.stringContaining('tự tắt') }));
    expect(await rt.tick(at(15))).toBe(0);
    expect(prisma.extensionRun.rows.filter((r) => r.mode === 'schedule')).toHaveLength(3);
  });

  it('một lần thành công xoá bộ đếm lỗi', async () => {
    const { e } = await mk('xen', 'job', 'export default (c) => { if (c.params === null && Date.now() % 2 === 0) throw new Error("x"); }', MF);
    await prisma.extension.update({ where: { id: e.id }, data: { consecutive_failures: 2 } });
    const log = new ExtensionRunLog(prisma as never, notifications as never);
    await log.noteOutcome(e.id, true, '');
    expect((await status(e.id)).consecutive_failures).toBe(0);
  });

  it('tool qua ext-host: nạp, xuất hiện trong danh sách, gọi được, tool khai nhiều tên; tắt thì biến mất', async () => {
    const code = 'export const tools = { cong: { description: "cộng hai số", inputSchema: { type: "object", properties: { a: { type: "number" } } }, run: ({a,b}: any) => a + b }, chao: { run: () => "xin chào" } }';
    const { e, v } = await mk('maytinh', 'tool', code, { net: [], tables: { read: [], write: [] }, input_schema: { type: 'object' } });
    await rt.activate(e, v);
    expect(rt.listActiveTools()).toEqual([{ extId: e.id, key: 'maytinh', tools: expect.arrayContaining([expect.objectContaining({ name: 'cong', description: 'cộng hai số' }), expect.objectContaining({ name: 'chao' })]) }]);
    expect(await rt.callTool('maytinh', 'cong', { a: 4, b: 5 })).toEqual({ ok: true, value: 9 });
    expect(await rt.callTool('maytinh', 'chao', {})).toEqual({ ok: true, value: 'xin chào' });
    await rt.deactivate(e.id);
    expect(rt.listActiveTools()).toEqual([]);
    expect(await rt.callTool('maytinh', 'cong', {})).toMatchObject({ ok: false, kind: 'unknown_tool' });
  });

  it('tool một hàm (export default) thành tool "run" lấy schema từ manifest', async () => {
    const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
    const { e, v } = await mk('nhan-doi', 'tool', 'export default ({ x }: { x: number }) => x * 2', { net: [], tables: { read: [], write: [] }, input_schema: schema });
    await rt.activate(e, v);
    expect(rt.listActiveTools()[0]?.tools).toEqual([{ name: 'run', description: 'nhan-doi', inputSchema: schema }]);
    expect(await rt.callTool('nhan-doi', 'run', { x: 21 })).toEqual({ ok: true, value: 42 });
  });

  it('tool bị khoá quyền: không đọc file / host lạ; lỗi lặp lại ⇒ tự tắt và tool biến khỏi danh sách', async () => {
    const code = 'export default async () => { await Deno.readTextFile("/etc/hosts") }';
    const { e, v } = await mk('doc-file', 'tool', code, { net: [], tables: { read: [], write: [] }, input_schema: { type: 'object' } });
    await rt.activate(e, v);
    for (let i = 0; i < 3; i++) {
      const r = await rt.callTool('doc-file', 'run', {});
      expect(r).toMatchObject({ ok: false, kind: 'tool_error' });
    }
    expect((await status(e.id)).status).toBe('disabled');
    expect(rt.listActiveTools()).toEqual([]);
  });

  it('tool nạp lỗi (cú pháp / tên tool xấu) ⇒ activate từ chối, không để lại gì', async () => {
    const bad = await mk('cu-phap', 'tool', 'export default (', { net: [], tables: { read: [], write: [] }, input_schema: { type: 'object' } });
    await expect(rt.activate(bad.e, bad.v)).rejects.toThrow(/Không nạp được tool/);
    const name = await mk('ten-xau', 'tool', 'export const tools = { "Tên Xấu": { run: () => 1 } }', { net: [], tables: { read: [], write: [] }, input_schema: { type: 'object' } });
    await expect(rt.activate(name.e, name.v)).rejects.toThrow(/không hợp lệ/);
    expect(rt.listActiveTools()).toEqual([]);
  });

  it('loại api chưa chạy; cờ tắt ⇒ mọi thứ im lặng và activate/dryRun từ chối', async () => {
    const api = await mk('api-1', 'job', 'export default () => 1', MF);
    await expect(rt.activate({ ...api.e, kind: 'api' } as Extension, api.v)).rejects.toThrow(/chưa chạy được/);
    delete process.env.EXTENSIONS_ENABLED;
    expect(extensionsEnabled()).toBe(false);
    await expect(rt.activate(api.e, api.v)).rejects.toThrow(/đang tắt/);
    await expect(rt.dryRun(api.e, api.v, {}, 1)).rejects.toThrow(/đang tắt/);
    expect(await rt.tick(new Date())).toBe(0);
    expect(rt.listActiveTools()).toEqual([]);
  });
});
