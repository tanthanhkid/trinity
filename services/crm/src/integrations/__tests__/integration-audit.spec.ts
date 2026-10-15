import {
  IntegrationAuditService,
  decodeAuditCursor,
  encodeAuditCursor,
  sanitizeMetadata,
  sanitizeText,
} from '@trinity/prisma';

describe('sanitizeMetadata — KHÔNG để SĐT đầy đủ/secret vào nhật ký', () => {
  it('khoá nhìn như secret/token/chữ ký → [redacted] bất kể giá trị', () => {
    const m = sanitizeMetadata({
      client_secret: 'abc', access_token: 'xyz', Authorization: 'Bearer abc', password: 'p',
      'x-trinity-signature': 't=1,v1=aa', api_key: 'k', ok_field: 'giữ',
    });
    expect(m).toEqual({
      client_secret: '[redacted]', access_token: '[redacted]', Authorization: '[redacted]', password: '[redacted]',
      'x-trinity-signature': '[redacted]', api_key: '[redacted]', ok_field: 'giữ',
    });
  });

  it('khoá SĐT → che còn 3 số cuối; SĐT lọt vào chuỗi tự do cũng bị che (mọi định dạng)', () => {
    const m = sanitizeMetadata({
      phone: '0912345678',
      contact_phone: '+84 912 345 678',
      note: 'khách 0912.345.678 và 84912345678 liên hệ lại',
      nested: { list: ['liên hệ 0987-654-321'] },
    }) as Record<string, unknown>;
    const json = JSON.stringify(m);
    for (const raw of ['0912345678', '912 345 678', '0912.345.678', '84912345678', '0987-654-321', '0987654321']) {
      expect(json).not.toContain(raw);
    }
    expect(m.phone).toBe('***678');
    expect(json).toContain('***678');
  });

  it('chuỗi Bearer + token dài trong text bị gỡ; số ngắn (id, mã HTTP) giữ nguyên', () => {
    const t = sanitizeText('401 với Authorization: Bearer abc.def-ghi token ' + 'a'.repeat(40) + ' id 12345');
    expect(t).not.toContain('abc.def-ghi');
    expect(t).not.toContain('a'.repeat(40));
    expect(t).toContain('12345');
  });

  it('cắt độ sâu / số khoá / số phần tử / độ dài chuỗi; BigInt → chuỗi; null/undefined an toàn', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitizeMetadata(deep))).toContain('[truncated]');
    const many: Record<string, number> = {};
    for (let i = 0; i < 100; i++) many[`k${i}`] = i;
    expect(Object.keys(sanitizeMetadata(many))).toHaveLength(30);
    expect((sanitizeMetadata({ arr: Array.from({ length: 100 }, (_, i) => i) }) as { arr: unknown[] }).arr).toHaveLength(20);
    expect(((sanitizeMetadata({ s: 'x'.repeat(1000) }) as { s: string }).s).length).toBeLessThanOrEqual(301);
    expect(sanitizeMetadata({ big: 5n })).toEqual({ big: '5' });
    expect(sanitizeMetadata(null)).toEqual({});
    expect(sanitizeMetadata(undefined)).toEqual({});
  });
});

describe('IntegrationAuditService.log', () => {
  const mk = () => {
    const prisma = { integrationAuditLog: { create: jest.fn().mockResolvedValue({ id: 1n }), findMany: jest.fn() } };
    return { prisma, svc: new IntegrationAuditService(prisma as never) };
  };

  it('KHÔNG BAO GIỜ ném lỗi ra caller khi DB hỏng', async () => {
    const { prisma, svc } = mk();
    prisma.integrationAuditLog.create.mockRejectedValue(new Error('db down'));
    await expect(svc.log({ channel: 'mcp', action: 'search', status: 'ok' })).resolves.toBeUndefined();
  });

  it('lọc metadata + error trước khi ghi; cắt đúng độ dài cột; số âm/NaN → an toàn', async () => {
    const { prisma, svc } = mk();
    await svc.log({
      channel: 'webhook_in', action: 'a'.repeat(300), status: 'error', clientId: 'c', userId: 5, resource: 'contact', resourceId: 12,
      httpStatus: 422, durationMs: Number.NaN, error: 'SĐT 0912345678 không hợp lệ',
      metadata: { phone: '0912345678', secret: 's' },
    });
    const d = prisma.integrationAuditLog.create.mock.calls[0][0].data;
    expect(d.action).toHaveLength(128);
    expect(d.resource_id).toBe('12');
    expect(d.duration_ms).toBeNull();
    expect(d.http_status).toBe(422);
    expect(d.error).not.toContain('0912345678');
    expect(d.metadata).toEqual({ phone: '***678', secret: '[redacted]' });
  });
});

describe('IntegrationAuditService.list — cursor', () => {
  const row = (id: bigint, ms: number) => ({
    id, created_at: new Date(ms), channel: 'mcp', client_id: null, user_id: null, action: 'x', resource: null,
    resource_id: null, status: 'ok', http_status: null, duration_ms: null, error: null, metadata: {},
  });

  it('cursor round-trip; chuỗi lạ bị từ chối', () => {
    const c = encodeAuditCursor(new Date(1_700_000_000_123), 77n);
    expect(c).toBe('1700000000123.77');
    expect(decodeAuditCursor(c)).toEqual({ createdAt: new Date(1_700_000_000_123), id: 77n });
    expect(decodeAuditCursor('abc')).toBeNull();
    expect(decodeAuditCursor('1.2; DROP')).toBeNull();
  });

  it('trả limit dòng + next_cursor khi còn; id BigInt → chuỗi; lọc ghép bằng AND', async () => {
    const prisma = { integrationAuditLog: { findMany: jest.fn().mockResolvedValue([row(5n, 3000), row(4n, 2000), row(3n, 1000)]) } };
    const svc = new IntegrationAuditService(prisma as never);
    const res = await svc.list({ channel: 'mcp', status: 'denied', userId: 7, limit: 2, cursor: '9000.10' });
    expect(res.data.map((r) => r.id)).toEqual(['5', '4']);
    expect(res.next_cursor).toBe('2000.4');
    const arg = prisma.integrationAuditLog.findMany.mock.calls[0][0];
    expect(arg.take).toBe(3);
    expect(arg.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
    expect(arg.where.AND).toEqual(
      expect.arrayContaining([{ channel: 'mcp' }, { status: 'denied' }, { user_id: 7 }]),
    );
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('hết dữ liệu → next_cursor null; limit kẹp 1..100', async () => {
    const prisma = { integrationAuditLog: { findMany: jest.fn().mockResolvedValue([row(1n, 1)]) } };
    const svc = new IntegrationAuditService(prisma as never);
    expect((await svc.list({ limit: 500 })).next_cursor).toBeNull();
    expect(prisma.integrationAuditLog.findMany.mock.calls[0][0].take).toBe(101);
  });
});
