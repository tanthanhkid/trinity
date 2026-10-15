import { WebhookInboundService } from '../inbound/webhook-inbound.service';
import { generateInboundToken, hashInboundToken } from '../inbound/inbound-token';

/**
 * Phản hồi công khai của webhook vào phải GIỐNG HỆT cho số mới, số đã có (của người nhận hoặc người khác) và gửi lại —
 * người ngoài không dò được SĐT nào đã là khách. Nhật ký nội bộ vẫn ghi kết quả thật.
 */
const TOKEN = generateInboundToken();
const SRC = { id: 7, name: 'FB', is_active: true, token_hash: hashInboundToken(TOKEN), signing_secret_enc: null, default_assignee_id: 5, contact_source_id: 3, project_id: null };

function build(existing: { id: number; assigned_to: number } | null, receiptClaimed = true) {
  const tx = {
    $queryRaw: jest.fn(async () => (receiptClaimed ? [{ id: 1n }] : [])),
    $executeRaw: jest.fn(async () => 1),
    webhookInboundReceipt: { findUnique: jest.fn(async () => ({ contact_id: existing?.id ?? null })), update: jest.fn() },
    contact: { findFirst: jest.fn(async () => existing), findUnique: jest.fn(async () => existing) },
    activity: { create: jest.fn() },
  };
  const prisma = {
    webhookInboundSource: { findUnique: jest.fn(async () => SRC), update: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ id: 5, status: 'active', team_id: null, deleted_at: null })) },
    settingOption: { findUnique: jest.fn(async () => ({ group_key: 'contact_source', is_active: true })) },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const publicApi = { createContactInTx: jest.fn(async () => ({ id: 101 })) };
  const audit = { log: jest.fn(async () => undefined) };
  const svc = new WebhookInboundService(prisma as never, publicApi as never, audit as never);
  return { svc, audit, publicApi };
}
const req = (extra: object = {}) => {
  const body = { name: 'Khách', phone: '0900001501', ...extra };
  return { rawBody: Buffer.from(JSON.stringify(body)), body, signature: undefined };
};

describe('WebhookInboundService — phản hồi đồng nhất', () => {
  const OLD = process.env.INTEGRATIONS_WEBHOOKS_ENABLED;
  beforeAll(() => { process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'; });
  afterAll(() => { if (OLD === undefined) delete process.env.INTEGRATIONS_WEBHOOKS_ENABLED; else process.env.INTEGRATIONS_WEBHOOKS_ENABLED = OLD; });

  const PUBLIC = { httpStatus: 200, body: { status: 'accepted', contact_id: null } };

  it('số mới / số đã có của chính người nhận / số của người khác / gửi lại → cùng mã 200 và cùng body', async () => {
    const fresh = await build(null).svc.receive(TOKEN, req());
    const mine = await build({ id: 11, assigned_to: 5 }).svc.receive(TOKEN, req());
    const foreign = await build({ id: 12, assigned_to: 99 }).svc.receive(TOKEN, req());
    const replay = await build({ id: 13, assigned_to: 5 }, false).svc.receive(TOKEN, req({ external_id: 'e-1' }));
    for (const r of [fresh, mine, foreign, replay]) expect({ httpStatus: r.httpStatus, body: r.body }).toEqual(PUBLIC);
    expect(JSON.stringify(fresh.body)).toBe(JSON.stringify(foreign.body));
  });

  it('nhật ký nội bộ vẫn ghi kết quả thật (created / duplicate / replayed) và id khách', async () => {
    const a = build(null);
    await a.svc.receive(TOKEN, req());
    expect(a.audit.log).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: 200, resourceId: 101, metadata: expect.objectContaining({ result: 'created' }) }));
    const b = build({ id: 11, assigned_to: 5 });
    await b.svc.receive(TOKEN, req());
    expect(b.audit.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ result: 'duplicate' }) }));
    const c = build({ id: 13, assigned_to: 5 }, false);
    await c.svc.receive(TOKEN, req({ external_id: 'e-1' }));
    expect(c.audit.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ result: 'replayed' }) }));
  });
});
