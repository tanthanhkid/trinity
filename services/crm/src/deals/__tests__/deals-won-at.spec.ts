import { DealsService } from '../deals.service';

jest.mock('@trinity/prisma', () => ({
  ...jest.requireActual('@trinity/prisma'),
  publishIntegrationEvent: jest.fn().mockResolvedValue(undefined),
  snapshotDeal: jest.fn((d) => d),
}));

const user = { userId: 1, email: 'a@t', isAdmin: true, grants: {} } as never;

function build(existing: { status: string } | null = { status: 'open' }) {
  const tx = {
    deal: {
      create: jest.fn(async ({ data }) => ({ id: 1, title: 't', ...data })),
      update: jest.fn(async ({ data }) => ({ id: 1, title: 't', status: data.status ?? 'open', ...data })),
    },
  };
  const prisma = {
    user: { findFirst: jest.fn(async () => ({ id: 2, full_name: 'x', email: 'x@t' })) },
    contact: { findUnique: jest.fn() },
    deal: {
      findUnique: jest.fn(async () => (existing ? { id: 1, created_by: 1, assigned_to: 2, ...existing } : null)),
    },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const scope = { ownerIds: jest.fn(async () => 'all') };
  const notifications = { notifyDealAssigned: jest.fn().mockResolvedValue(undefined) };
  const svc = new DealsService(prisma as never, notifications as never, scope as never);
  return { svc, tx };
}

describe('DealsService — won_at (ngày thắng)', () => {
  it('tạo deal ở won → won_at = lúc tạo; tạo ở open → won_at null', async () => {
    const a = build();
    await a.svc.create({ title: 't', assigned_to: 2, status: 'won' } as never, user);
    expect(a.tx.deal.create.mock.calls[0][0].data.won_at).toBeInstanceOf(Date);

    const b = build();
    await b.svc.create({ title: 't', assigned_to: 2 } as never, user);
    expect(b.tx.deal.create.mock.calls[0][0].data.won_at).toBeNull();
  });

  it('chuyển open → won ghi won_at; lưu lại won KHÔNG đổi mốc cũ; rời won xoá won_at', async () => {
    const open = build({ status: 'open' });
    await open.svc.update(1, { status: 'won' } as never, user);
    expect(open.tx.deal.update.mock.calls[0][0].data.won_at).toBeInstanceOf(Date);

    const already = build({ status: 'won' });
    await already.svc.update(1, { status: 'won', note: 'n' } as never, user);
    expect(already.tx.deal.update.mock.calls[0][0].data).not.toHaveProperty('won_at');

    const reopen = build({ status: 'won' });
    await reopen.svc.update(1, { status: 'open' } as never, user);
    expect(reopen.tx.deal.update.mock.calls[0][0].data.won_at).toBeNull();

    const noStatus = build({ status: 'won' });
    await noStatus.svc.update(1, { title: 'x' } as never, user);
    expect(noStatus.tx.deal.update.mock.calls[0][0].data).not.toHaveProperty('won_at');
  });
});
