import {
  INTEGRATION_EVENT_META,
  INTEGRATION_EVENT_TYPES,
  IntegrationEventsService,
  isIntegrationEventType,
  publishIntegrationEvent,
  snapshotContact,
  snapshotDeal,
  snapshotPosOrder,
  toJsonValue,
} from '@trinity/prisma';
import { changedContactFields } from '../../contacts/helpers/contact-events.helper';

const mkClient = () => ({ integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) } });

describe('catalog sự kiện', () => {
  it('đủ 24 sự kiện (11 cốt lõi, gồm khôi phục khách + 3 bản ghi tuỳ biến + 2 Zalo OA + 4 Messenger/Fanpage + 2 đăng bài + 1 thanh toán + 1 đơn online), mỗi sự kiện có resource + nhãn tiếng Việt', () => {
    expect([...INTEGRATION_EVENT_TYPES].sort()).toEqual(
      [
        'contact.created', 'contact.updated', 'contact.stage_changed', 'contact.assigned', 'contact.deleted', 'contact.restored',
        'deal.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'pos.order.completed',
        'custom_record.created', 'custom_record.updated', 'custom_record.deleted',
        'zalo_oa.message_received', 'zalo_oa.message_sent',
        'messenger.message_received', 'messenger.message_sent', 'messenger.broadcast_finished', 'facebook.comment_received',
        'social_post.published', 'social_post.failed', 'payment.received', 'store_order.created',
      ].sort(),
    );
    for (const t of INTEGRATION_EVENT_TYPES) {
      expect(INTEGRATION_EVENT_META[t].resource.length).toBeGreaterThan(0);
      expect(INTEGRATION_EVENT_META[t].label.length).toBeGreaterThan(2);
    }
    expect(isIntegrationEventType('deal.won')).toBe(true);
    expect(isIntegrationEventType('lead.created')).toBe(false);
  });
});

describe('publishIntegrationEvent', () => {
  it('ghi đúng cột: resource suy từ catalog, resource_id dạng chuỗi, actor mặc định null', async () => {
    const c = mkClient();
    const contact = snapshotContact({ id: 12, phone: '0912345678', assigned_to: 3 });
    await publishIntegrationEvent(c as never, 'contact.created', { contact }, { resourceId: 12 });
    expect(c.integrationEvent.create).toHaveBeenCalledTimes(1);
    expect(c.integrationEvent.create.mock.calls[0][0].data).toMatchObject({
      event_type: 'contact.created', resource: 'contact', resource_id: '12', actor_user_id: null,
      payload: { contact: { id: 12, phone: '0912345678', assigned_to: 3 } },
    });
    await publishIntegrationEvent(c as never, 'pos.order.completed', { order: {} as never }, { resourceId: 'x', actorUserId: 9 });
    expect(c.integrationEvent.create.mock.calls[1][0].data).toMatchObject({ resource: 'pos_order', actor_user_id: 9 });
  });

  it('lỗi insert KHÔNG bị nuốt (cùng transaction ⇒ lỗi outbox = lỗi ghi)', async () => {
    const c = mkClient();
    c.integrationEvent.create.mockRejectedValue(new Error('boom'));
    await expect(
      publishIntegrationEvent(c as never, 'contact.deleted', { contact: snapshotContact({ id: 1 }) }, { resourceId: 1 }),
    ).rejects.toThrow('boom');
  });

  it('toJsonValue: BigInt → chuỗi, Date → ISO, bỏ undefined (Prisma Json không nhận BigInt)', () => {
    expect(toJsonValue({ a: 10n, d: new Date('2026-10-04T00:00:00Z'), u: undefined, n: null })).toEqual({
      a: '10', d: '2026-10-04T00:00:00.000Z', n: null,
    });
  });
});

describe('snapshot', () => {
  it('snapshotContact CHỈ chứa trường lõi — không CCCD/CMND/địa chỉ/custom_fields dù row có', () => {
    const snap = snapshotContact({
      id: 1, phone: '0900000001', full_name: 'A',
      ...({ cccd: '123456789012', cmnd: '123', permanent_address: 'x', custom_fields: { k: 1 } } as object),
    } as never);
    expect(Object.keys(snap).sort()).toEqual(
      ['assigned_to', 'contact_status_id', 'created_at', 'created_by_id', 'deleted_at', 'email', 'full_name', 'id',
       'phone', 'phone_2', 'stage_id', 'project_id', 'source_id', 'team_id', 'updated_at', 'zalo_account'].sort(),
    );
    expect(JSON.stringify(snap)).not.toContain('123456789012');
  });

  it('snapshotDeal: value BigInt → chuỗi; snapshotPosOrder: mọi tiền → chuỗi', () => {
    expect(snapshotDeal({ id: 1, title: 't', value: 5_000_000n, status: 'won', assigned_to: 2, created_by: 3 }).value).toBe('5000000');
    expect(snapshotDeal({ id: 1, title: 't', status: 'open', assigned_to: 2, created_by: 3 }).value).toBeNull();
    const o = snapshotPosOrder({
      id: 1, code: 'c', status: 'paid', order_type: 'dine_in', table_id: null, shift_id: 1, note: null, subtotal: 10n,
      discount_type: 'none', discount_amount: 0n, total: 10n, created_by: 1, paid_by: 1, paid_at: new Date(0), created_at: new Date(0),
      items: [{ product_id: 1, product_name: 'p', unit_price: 10n, quantity: 1, line_total: 10n }],
      payments: [{ method: 'cash', amount: 10n, reference: null }],
    });
    expect(() => JSON.stringify(o)).not.toThrow();
    expect(o.total).toBe('10');
  });
});

describe('changedContactFields', () => {
  it('đọc từ data đã ghi: bỏ key undefined, đổi tên quan hệ → cột', () => {
    expect(
      changedContactFields({
        full_name: 'x', email: undefined, assigned_user: { connect: { id: 1 } },
        stage: { disconnect: true }, team: { connect: { id: 2 } },
      }),
    ).toEqual(['assigned_to', 'full_name', 'stage_id', 'team_id']);
    expect(changedContactFields({})).toEqual([]);
  });
});

describe('IntegrationEventsService', () => {
  const mkPrisma = () => ({
    integrationEvent: {
      create: jest.fn().mockResolvedValue({ id: 1n }),
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn(),
    },
  });

  it('publish(null, …) ghi qua prisma; publish(tx, …) ghi qua tx (không đụng prisma)', async () => {
    const prisma = mkPrisma();
    const tx = mkClient();
    const svc = new IntegrationEventsService(prisma as never);
    const payload = { contact: snapshotContact({ id: 1 }) };
    await svc.publish(null, 'contact.deleted', payload, { resourceId: 1 });
    expect(prisma.integrationEvent.create).toHaveBeenCalledTimes(1);
    await svc.publish(tx as never, 'contact.deleted', payload, { resourceId: 1 });
    expect(tx.integrationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.integrationEvent.create).toHaveBeenCalledTimes(1);
  });

  it('fetchPending: chỉ dispatched_at null, id tăng dần, kẹp limit 1..500', async () => {
    const prisma = mkPrisma();
    prisma.integrationEvent.findMany.mockResolvedValue([]);
    const svc = new IntegrationEventsService(prisma as never);
    await svc.fetchPending(10_000);
    expect(prisma.integrationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dispatched_at: null }, orderBy: { id: 'asc' }, take: 500 }),
    );
  });

  it('markDispatched: bỏ qua mảng rỗng; chỉ cập nhật dòng còn dispatched_at null', async () => {
    const prisma = mkPrisma();
    const svc = new IntegrationEventsService(prisma as never);
    expect(await svc.markDispatched([])).toBe(0);
    expect(prisma.integrationEvent.updateMany).not.toHaveBeenCalled();
    expect(await svc.markDispatched([1n, 2n])).toBe(2);
    expect(prisma.integrationEvent.updateMany.mock.calls[0][0].where).toEqual({ id: { in: [1n, 2n] }, dispatched_at: null });
  });

  it('purge: đã dispatch >30 ngày + chưa dispatch >90 ngày, xoá theo lô', async () => {
    const prisma = mkPrisma();
    const now = new Date('2026-10-04T00:00:00Z');
    prisma.integrationEvent.findMany
      .mockResolvedValueOnce([{ id: 1n }, { id: 2n }]) // lô dispatched (2 < 2000 ⇒ dừng)
      .mockResolvedValueOnce([{ id: 9n }]); // lô stale
    prisma.integrationEvent.deleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
    const svc = new IntegrationEventsService(prisma as never);
    expect(await svc.purge(now)).toEqual({ dispatched: 2, stale: 1 });
    const w1 = prisma.integrationEvent.findMany.mock.calls[0][0].where;
    expect(w1.dispatched_at.not).toBeNull();
    expect(w1.dispatched_at.lt).toEqual(new Date('2026-09-04T00:00:00Z'));
    const w2 = prisma.integrationEvent.findMany.mock.calls[1][0].where;
    expect(w2.dispatched_at).toBeNull();
    expect(w2.created_at.lt).toEqual(new Date('2026-07-06T00:00:00Z'));
  });
});
