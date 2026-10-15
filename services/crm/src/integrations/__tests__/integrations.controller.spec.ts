import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { integrationFlags } from '@trinity/prisma';
import { IntegrationsController } from '../integrations.controller';
import { QueryAuditLogsDto } from '../dto/query-audit-logs.dto';
import { IntegrationOutboxPurgeService } from '../integration-outbox-purge.service';

const ENV_KEYS = ['INTEGRATIONS_WEBHOOKS_ENABLED', 'INTEGRATIONS_MCP_ENABLED'] as const;

describe('cờ tích hợp — mặc định TẮT', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
  afterEach(() => ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

  it('không đặt env = TẮT; chỉ "true"/"1" mới bật; giá trị lạ = tắt', () => {
    expect(integrationFlags.webhooksEnabled()).toBe(false);
    expect(integrationFlags.mcpEnabled()).toBe(false);
    expect(integrationFlags.anyEnabled()).toBe(false);
    for (const v of ['TRUE', ' true ', '1']) {
      process.env.INTEGRATIONS_MCP_ENABLED = v;
      expect(integrationFlags.mcpEnabled()).toBe(true);
    }
    for (const v of ['yes', '0', 'false', '', 'on']) {
      process.env.INTEGRATIONS_MCP_ENABLED = v;
      expect(integrationFlags.mcpEnabled()).toBe(false);
    }
  });

  it('GET /integrations/status luôn trả 200 kèm cờ (để FE phân biệt "tắt" với "không quyền")', () => {
    const c = new IntegrationsController({} as never);
    expect(c.status()).toEqual({ webhooks_enabled: false, mcp_enabled: false, secret_key_configured: false, mcp_base_url_configured: false, mcp_url: null });
    process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true';
    expect(c.status()).toEqual({ webhooks_enabled: true, mcp_enabled: false, secret_key_configured: false, mcp_base_url_configured: false, mcp_url: null });
  });

  it('GET /integrations/audit-logs: cả 2 cờ tắt → 404 và KHÔNG đụng DB; bật 1 cờ → trả dữ liệu, ánh xạ query', async () => {
    const audit = { list: jest.fn().mockResolvedValue({ data: [{ id: '1' }], next_cursor: 'c' }) };
    const c = new IntegrationsController(audit as never);
    await expect(c.auditLogs({} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.list).not.toHaveBeenCalled();

    process.env.INTEGRATIONS_MCP_ENABLED = 'true';
    const q = plainToInstance(QueryAuditLogsDto, { channel: 'mcp', status: 'denied', user_id: '7', from: '2026-10-01', limit: '20' });
    const res = await c.auditLogs(q);
    expect(res).toEqual({ data: [{ id: '1' }], meta: { next_cursor: 'c' } });
    expect(audit.list).toHaveBeenCalledWith({
      channel: 'mcp', status: 'denied', userId: 7, from: new Date('2026-10-01'), to: undefined, cursor: undefined, limit: 20,
    });
  });
});

describe('QueryAuditLogsDto', () => {
  const errs = async (o: object) => (await validate(plainToInstance(QueryAuditLogsDto, o))).map((e) => e.property);
  it('hợp lệ / từ chối kênh, trạng thái, cursor, limit sai', async () => {
    expect(await errs({ channel: 'mcp', status: 'ok', limit: '50', cursor: '1700000000123.5' })).toEqual([]);
    expect(await errs({ channel: 'sms' })).toContain('channel');
    expect(await errs({ status: 'weird' })).toContain('status');
    expect(await errs({ cursor: "1; DROP TABLE x" })).toContain('cursor');
    expect(await errs({ limit: '1000' })).toContain('limit');
    expect(await errs({ user_id: 'abc' })).toContain('user_id');
    expect(await errs({ from: 'không phải ngày' })).toContain('from');
  });
});

describe('IntegrationOutboxPurgeService — job mới mặc định TẮT', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { jest.useFakeTimers(); ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => { jest.useRealTimers(); ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('cờ tắt → KHÔNG tạo timer, không dọn gì', async () => {
    const events = { purge: jest.fn() };
    const svc = new IntegrationOutboxPurgeService(events as never);
    svc.onModuleInit();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(jest.getTimerCount()).toBe(0);
    expect(events.purge).not.toHaveBeenCalled();
  });

  it('cờ bật → dọn sau 5 phút rồi mỗi 6 giờ; onModuleDestroy gỡ timer; lỗi purge không ném', async () => {
    process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true';
    const events = { purge: jest.fn().mockResolvedValue({ dispatched: 0, stale: 0 }) };
    const svc = new IntegrationOutboxPurgeService(events as never);
    svc.onModuleInit();
    expect(jest.getTimerCount()).toBe(2);
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(events.purge).toHaveBeenCalledTimes(1);
    events.purge.mockRejectedValue(new Error('db'));
    await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(events.purge).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
