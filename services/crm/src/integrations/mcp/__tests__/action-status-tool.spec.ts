import { z } from 'zod';
import { statusTool } from '../tools/action-tools';
import { ToolUserError } from '../tools/tool-types';
import { auditTarget, McpServerService } from '../mcp-server.service';
import { MCP_TOOLS } from '../mcp-tools.registry';

describe('get_action_status nhận action_id (id là tên cũ)', () => {
  const run = (args: Record<string, unknown>) => {
    const statusFor = jest.fn().mockResolvedValue({ action_id: 7, status: 'executed' });
    const p = statusTool.run(args, { deps: { actions: { statusFor } } as never, principal: { userId: 1 } as never, baseUrl: 'https://x' });
    return { p, statusFor };
  };
  it('schema có action_id; mô tả nói action_id', () => {
    const shape = z.object(statusTool.input(z));
    expect(shape.safeParse({ action_id: 7 }).success).toBe(true);
    expect(shape.safeParse({ id: 7 }).success).toBe(true);
    expect(statusTool.description).toContain('action_id');
  });
  it('action_id ⇒ hỏi đúng thao tác', async () => {
    const { p, statusFor } = run({ action_id: 7 });
    await p;
    expect(statusFor).toHaveBeenCalledWith({ userId: 1 }, 7);
  });
  it('id (cũ) vẫn chạy', async () => {
    const { p, statusFor } = run({ id: 8 });
    await p;
    expect(statusFor).toHaveBeenCalledWith({ userId: 1 }, 8);
  });
  it('thiếu cả hai / hai số khác nhau ⇒ lỗi người dùng', async () => {
    await expect(run({}).p).rejects.toBeInstanceOf(ToolUserError);
    await expect(run({ action_id: 7, id: 8 }).p).rejects.toThrow(/khác nhau/);
  });
});

describe('list_records mô tả: total chỉ có ở trang đầu; lọc select nhận nhãn', () => {
  it('mô tả nêu rõ', async () => {
    const { listRecordsTool } = await import('../tools/record-tools');
    expect(listRecordsTool.description).toMatch(/total .*chỉ có ở trang đầu/);
    expect(listRecordsTool.description).toMatch(/gửi nhãn cũng được/);
  });
});

describe('audit: resourceId có cả khi gọi get_action_status bằng action_id hoặc id', () => {
  const tool = MCP_TOOLS.find((t) => t.name === 'get_action_status')!;
  const call = async (args: Record<string, unknown>) => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const actions = { statusFor: jest.fn().mockResolvedValue({ action_id: 7, status: 'executed' }) };
    const svc = new McpServerService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, actions as never,
      audit as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const principal = { userId: 1, clientId: 'c', scopes: ['crm.read'], user: { grants: {} } } as never;
    await svc.execute(tool, args, principal);
    return audit.log.mock.calls[0][0];
  };
  it('action_id ⇒ resourceId = action_id', async () => {
    expect(await call({ action_id: 7 })).toMatchObject({ action: 'get_action_status', resource: 'ai_action_draft', resourceId: 7 });
  });
  it('id (bí danh cũ) ⇒ vẫn có resourceId', async () => {
    expect(await call({ id: 8 })).toMatchObject({ resourceId: 8 });
  });
  it('auditTarget: id chuỗi "kind:..." giữ nguyên hành vi cũ; không có gì ⇒ rỗng', () => {
    expect(auditTarget({ id: 'contact:5' })).toEqual({ resource: 'contact', resourceId: 'contact:5' });
    expect(auditTarget({})).toEqual({});
  });
});
