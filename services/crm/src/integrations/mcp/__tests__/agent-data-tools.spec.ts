import type { AuthUser } from '@trinity/rbac-nest';
import type { McpPrincipal } from '../mcp-auth.service';
import { McpServerService } from '../mcp-server.service';
import { MCP_TOOLS } from '../mcp-tools.registry';
import type { McpDeps, ToolContext } from '../tools/tool-types';
import { ForbiddenToolError, ToolUserError } from '../tools/tool-types';

/** Tool thay cho AI chạy trên máy chủ (máy chủ không gọi AI): agent của khách đọc dữ liệu rồi ghi kết quả về Trinity qua MCP. */
const user: AuthUser = { userId: 7, email: 'a@t.vn', isAdmin: false, grants: { 'reports.overview': 'own', 'contacts.view': 'own' } } as never;
const principal = (scopes = ['crm.read', 'crm.write']): McpPrincipal => ({ userId: 7, email: 'a@t.vn', clientId: 'chatgpt', scopes, tokenId: BigInt(1), user });
const tool = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;

function deps(on = true) {
  return {
    briefings: {
      featureOn: jest.fn(async () => on),
      agentData: jest.fn(async () => ({ data: { metrics: { overdueTasks: 2 } }, details: { new_contacts: [{ id: 1, name: 'Khách 0901234567' }] }, template: { title: 'T', text: 'x' } })),
      saveFromAgent: jest.fn(async () => ({ id: 11, created: true, notified: true })),
    },
    leadScoring: { featureOn: jest.fn(async () => on) },
    leadIntents: {
      listForAgent: jest.fn(async () => [{ id: 3, name: 'B', notes: 'gọi 0912 345 678' }]),
      setIntents: jest.fn(async () => [{ contact_id: 3, ok: true, lead_score: 72, lead_label: 'hot' }]),
    },
  } as unknown as McpDeps;
}
const ctx = (d: McpDeps): ToolContext => ({ principal: principal(), deps: d, baseUrl: 'https://crm.example/' });

describe('MCP — bản tin do agent viết', () => {
  it('đăng ký đủ 4 tool; tool ghi cần crm.write và không phá huỷ', () => {
    for (const n of ['get_briefing_data', 'save_briefing', 'list_leads_to_score', 'set_lead_intent']) expect(tool(n)).toBeDefined();
    expect(tool('get_briefing_data').scope).toBeUndefined();
    expect(tool('save_briefing')).toMatchObject({ scope: 'crm.write', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(tool('set_lead_intent')).toMatchObject({ scope: 'crm.write', annotations: { readOnlyHint: false, destructiveHint: false } });
  });

  it('get_briefing_data: trả số liệu + chi tiết, SĐT bị che', async () => {
    const d = deps();
    const out = await tool('get_briefing_data').run({ slot: 'morning' }, ctx(d));
    expect(d.briefings.agentData).toHaveBeenCalledWith(user, 'morning');
    expect(out.text).toContain('overdueTasks');
    expect(out.text).not.toContain('0901234567');
  });

  it('save_briefing: lưu cho chính người dùng, trả link; thiếu nội dung thì lỗi người dùng', async () => {
    const d = deps();
    const out = await tool('save_briefing').run({ slot: 'evening', title: ' Bản tin ', text: 'Hôm nay ổn.' }, ctx(d));
    expect(d.briefings.saveFromAgent).toHaveBeenCalledWith(user, 'evening', 'Bản tin', 'Hôm nay ổn.');
    expect((out.structured.data as { url: string }).url).toBe('https://crm.example/briefings?id=11');
    await expect(tool('save_briefing').run({ title: 'x', text: '  ' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
  });

  it('tính năng tắt → từ chối, không đọc/ghi', async () => {
    const d = deps(false);
    await expect(tool('get_briefing_data').run({}, ctx(d))).rejects.toBeInstanceOf(ForbiddenToolError);
    await expect(tool('set_lead_intent').run({ items: [{ contact_id: 3, intent: 1 }] }, ctx(d))).rejects.toBeInstanceOf(ForbiddenToolError);
    expect(d.briefings.agentData).not.toHaveBeenCalled();
    expect(d.leadIntents.setIntents).not.toHaveBeenCalled();
  });
});

describe('MCP — chấm ý định lead do agent', () => {
  it('list_leads_to_score: mặc định chỉ khách chưa chấm; che SĐT trong ghi chú', async () => {
    const d = deps();
    const out = await tool('list_leads_to_score').run({ limit: 5 }, ctx(d));
    expect(d.leadIntents.listForAgent).toHaveBeenCalledWith(user, 5, true);
    expect(out.text).not.toContain('0912 345 678');
  });

  it('set_lead_intent: ghi kèm client_id của ứng dụng AI; items sai định dạng → lỗi người dùng', async () => {
    const d = deps();
    const out = await tool('set_lead_intent').run({ items: [{ contact_id: 3, intent: 0.9, reason: 'muốn ký' }] }, ctx(d));
    expect(d.leadIntents.setIntents).toHaveBeenCalledWith(user, [{ contact_id: 3, intent: 0.9, reason: 'muốn ký' }], 'chatgpt');
    expect(out.text).toContain('"lead_label":"hot"');
    await expect(tool('set_lead_intent').run({ items: [{ contact_id: 'x', intent: 2 }] }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
  });

  it('nhật ký audit không ghi SĐT thô trong args', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const s = new McpServerService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      audit as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await s.execute(tool('save_briefing'), { title: 'Gọi 0912345678', text: 'x' }, principal(['crm.read']));
    const meta = JSON.stringify(audit.log.mock.calls[0][0].metadata);
    expect(meta).not.toContain('0912345678');
  });

  it('kết nối chỉ có crm.read → save_briefing/set_lead_intent bị chặn insufficient_scope', async () => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const s = new McpServerService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      audit as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const r = await s.execute(tool('save_briefing'), { title: 't', text: 'x' }, principal(['crm.read']));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('insufficient_scope');
    const r2 = await s.execute(tool('set_lead_intent'), { items: [] }, principal(['crm.read']));
    expect(r2.content[0].text).toContain('insufficient_scope');
  });
});

describe('MCP — tools/list + tools/call qua SDK thật (InMemoryTransport)', () => {
  it('4 tool mới có trong tools/list với schema hợp lệ; gọi save_briefing qua giao thức trả link bản tin', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const d = deps();
    const svc = new McpServerService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never, { hit: jest.fn().mockResolvedValue({ allowed: true }) } as never, {} as never, {} as never,
      d.briefings as never, d.leadScoring as never, d.leadIntents as never, {} as never, {} as never, {} as never, {} as never);
    const server = (svc as unknown as { buildServer: (p: McpPrincipal) => { connect: (t: unknown) => Promise<void> } }).buildServer(principal());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = (await client.listTools()).tools;
    for (const n of ['get_briefing_data', 'save_briefing', 'list_leads_to_score', 'set_lead_intent']) {
      const t = listed.find((x) => x.name === n);
      expect(t?.inputSchema.type).toBe('object');
    }
    const r = (await client.callTool({ name: 'save_briefing', arguments: { slot: 'morning', title: 'Sáng nay', text: 'Có 2 việc quá hạn.' } })) as { isError?: boolean; structuredContent?: { data?: { briefing_id?: number } } };
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.data?.briefing_id).toBe(11);
  });
});
