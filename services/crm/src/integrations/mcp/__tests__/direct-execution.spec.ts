import { ForbiddenException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { ActionUserError, type ActionToolDef } from '../actions/action-types';
import { actionToolByName } from '../actions/action-registry';
import { AiActionsService } from '../actions/ai-actions.service';
import type { McpPrincipal } from '../mcp-auth.service';
import { McpServerService } from '../mcp-server.service';
import { MCP_TOOLS } from '../mcp-tools.registry';

const user = (grants: Grants, id = 5): AuthUser => ({ userId: id, email: 'u@x.vn', isAdmin: false, grants });
const WRITER = { 'contacts.update': 'all', 'contacts.create': 'all' } as unknown as Grants;
const principal = (grants: Grants, scopes = ['crm.read', 'crm.write']): McpPrincipal => ({ userId: 5, email: 'u@x.vn', clientId: 'cli', scopes, tokenId: BigInt(1), user: user(grants) });

const row = { id: 77, user_id: 5, client_id: 'cli', tool: 'add_contact_note', params: { a: 1 }, summary: 'Tạo thử', details: [], status: 'approved' };

/** Tool THẬT của registry (run() tra theo tên) với prepare/execute bị spy thay bằng mock. Quyền thật: contacts.update. */
function fakeTool(over: { prepare?: jest.Mock; execute?: jest.Mock } = {}): ActionToolDef {
  const real = actionToolByName('add_contact_note')!;
  jest.spyOn(real, 'prepare').mockImplementation(over.prepare ?? jest.fn().mockResolvedValue({ params: { a: 1 }, summary: 'Tạo thử', details: [] }));
  jest.spyOn(real, 'execute').mockImplementation(over.execute ?? jest.fn().mockResolvedValue({ contact_id: 9 }));
  return real;
}
afterEach(() => jest.restoreAllMocks());

function makeService(opts: { setting?: string | null | Error; limit?: { allowed: boolean; retryAfterSec: number } } = {}) {
  const prisma = {
    setting: { findUnique: jest.fn().mockImplementation(async () => { if (opts.setting instanceof Error) throw opts.setting; return opts.setting === undefined || opts.setting === null ? null : { value: opts.setting }; }), upsert: jest.fn().mockResolvedValue({}) },
    aiActionDraft: { create: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue(row) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const limiter = { hit: jest.fn().mockResolvedValue(opts.limit ?? { allowed: true, retryAfterSec: 0 }) };
  const notifications = { createPendingLogs: jest.fn() };
  const z = {} as never;
  const svc = new AiActionsService(prisma as never, z, z, z, z, z, notifications as never, audit as never, limiter as never, z, z, z, z, z, z, z, z, z, z, z, z, z);
  return { svc, prisma, audit, limiter, notifications };
}

describe('AiActionsService.executeNow — ghi thẳng', () => {
  it('chạy tool ngay với người dùng đã kết nối, đánh dấu executed + result, ghi audit, không gửi thông báo chờ duyệt', async () => {
    const { svc, prisma, audit, notifications } = makeService();
    const tool = fakeTool();
    const p = principal(WRITER);
    const out = await svc.executeNow(tool, { x: 1 }, p);
    expect(out).toEqual({ id: 77, status: 'executed', summary: 'Tạo thử', result: { contact_id: 9 } });
    expect(tool.execute).toHaveBeenCalledWith({ a: 1 }, expect.objectContaining({ user: p.user }), 77);
    expect(prisma.aiActionDraft.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'approved', user_id: 5, client_id: 'cli', tool: 'add_contact_note' }) });
    expect(prisma.aiActionDraft.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { status: 'executed', result: { contact_id: 9 } } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_action.execute', status: 'ok', userId: 5 }));
    expect(notifications.createPendingLogs).not.toHaveBeenCalled();
  });

  it('thiếu quyền ⇒ 403, nhật ký failed, tool.execute KHÔNG chạy', async () => {
    const { svc, prisma, audit } = makeService();
    const tool = fakeTool();
    await expect(svc.executeNow(tool, {}, principal({} as Grants))).rejects.toBeInstanceOf(ForbiddenException);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(prisma.aiActionDraft.update).toHaveBeenCalledWith({ where: { id: 77 }, data: expect.objectContaining({ status: 'failed' }) });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_action.execute', status: 'denied' }));
  });

  it('prepare (quyền/phạm vi/DTO) ném lỗi ⇒ không tạo dòng nào, không chạy gì', async () => {
    const { svc, prisma } = makeService();
    const tool = fakeTool({ prepare: jest.fn().mockRejectedValue(new ForbiddenException('ngoài phạm vi')) });
    await expect(svc.executeNow(tool, {}, principal(WRITER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('execute lỗi ⇒ dòng chuyển failed, lỗi trả lại cho AI', async () => {
    const { svc, prisma } = makeService();
    const tool = fakeTool({ execute: jest.fn().mockRejectedValue(new ForbiddenException('hết quyền')) });
    await expect(svc.executeNow(tool, {}, principal(WRITER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.aiActionDraft.update).toHaveBeenCalledWith({ where: { id: 77 }, data: expect.objectContaining({ status: 'failed' }) });
  });

  it('vượt trần ghi mỗi phút ⇒ ActionUserError, chưa chạm dữ liệu', async () => {
    const { svc, prisma } = makeService({ limit: { allowed: false, retryAfterSec: 12 } });
    const tool = fakeTool();
    await expect(svc.executeNow(tool, {}, principal(WRITER))).rejects.toBeInstanceOf(ActionUserError);
    expect(tool.prepare).not.toHaveBeenCalled();
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });
});

describe('AiActionsService — cài đặt "Yêu cầu duyệt thay đổi do AI"', () => {
  it('mặc định TẮT; bật khi = "true"; lỗi đọc ⇒ coi là BẬT (fail-closed)', async () => {
    expect(await makeService({ setting: null }).svc.requiresApproval()).toBe(false);
    expect(await makeService({ setting: 'false' }).svc.requiresApproval()).toBe(false);
    expect(await makeService({ setting: 'true' }).svc.requiresApproval()).toBe(true);
    expect(await makeService({ setting: new Error('db down') }).svc.requiresApproval()).toBe(true);
  });
  it('setRequireApproval lưu vào Setting KV và ghi audit', async () => {
    const { svc, prisma, audit } = makeService();
    expect(await svc.setRequireApproval(true, 3)).toEqual({ require_approval: true });
    expect(prisma.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'ai_require_approval' }, update: { value: 'true', updated_by: 3 } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ai_action.setting', userId: 3 }));
  });
});

describe('MCP write tool — ghi thẳng hay nháp theo cài đặt', () => {
  const tool = MCP_TOOLS.find((t) => t.name === 'create_contact')!;
  const server = (actions: unknown) => new McpServerService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, actions as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const actions = (requires: boolean) => ({
    requiresApproval: jest.fn().mockResolvedValue(requires),
    executeNow: jest.fn().mockResolvedValue({ id: 5, status: 'executed', summary: 'Tạo khách A', result: { contact_id: 31 } }),
    createDraft: jest.fn().mockResolvedValue({ id: 6, status: 'pending', summary: 's', expires_at: new Date(), review_url: 'https://x/ai-actions?id=6', duplicate: false }),
  });

  it('cài đặt TẮT (mặc định) ⇒ thực hiện ngay và trả kết quả thật', async () => {
    const a = actions(false);
    const r = await server(a).execute(tool, { full_name: 'A', phone: '0901234567', source_id: 1 }, principal(WRITER));
    expect(r.isError).toBeUndefined();
    expect(a.executeNow).toHaveBeenCalledTimes(1);
    expect(a.createDraft).not.toHaveBeenCalled();
    const data = (r.structuredContent as { data: { status: string; result: { contact_id: number } } }).data;
    expect(data.status).toBe('executed');
    expect(data.result.contact_id).toBe(31);
    expect(r.content[0].text).not.toContain('chờ người dùng duyệt');
  });

  it('cài đặt BẬT ⇒ luồng cũ: chỉ tạo nháp chờ duyệt', async () => {
    const a = actions(true);
    const r = await server(a).execute(tool, { full_name: 'A', phone: '0901234567', source_id: 1 }, principal(WRITER));
    expect(a.createDraft).toHaveBeenCalledTimes(1);
    expect(a.executeNow).not.toHaveBeenCalled();
    expect((r.structuredContent as { data: { status: string } }).data.status).toBe('pending');
    expect(r.content[0].text).toContain('chờ người dùng duyệt');
  });

  it('token chỉ có crm.read ⇒ insufficient_scope, không ghi gì', async () => {
    const a = actions(false);
    const r = await server(a).execute(tool, { full_name: 'A' }, principal(WRITER, ['crm.read']));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('insufficient_scope');
    expect(a.executeNow).not.toHaveBeenCalled();
    expect(a.createDraft).not.toHaveBeenCalled();
  });

  it('người dùng thiếu quyền contacts.create ⇒ lỗi từ chối, không ghi gì', async () => {
    const a = actions(false);
    const r = await server(a).execute(tool, { full_name: 'A' }, principal({} as Grants));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('contacts.create');
    expect(a.executeNow).not.toHaveBeenCalled();
  });

  it('service ném 403 (ngoài phạm vi) ⇒ lỗi tool, không phải thành công', async () => {
    const a = actions(false);
    a.executeNow.mockRejectedValue(new ForbiddenException('Bạn không còn quyền'));
    const r = await server(a).execute(tool, { full_name: 'A', phone: '0901234567', source_id: 1 }, principal(WRITER));
    expect(r.isError).toBe(true);
  });
});
