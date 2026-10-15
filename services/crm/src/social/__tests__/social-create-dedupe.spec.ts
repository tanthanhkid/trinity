import { ConflictException } from '@nestjs/common';
import { SocialPostsService } from '../social-posts.service';

const user = { userId: 1 } as never;

function setup(existing: boolean) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    socialPost: { findFirst: jest.fn(async () => (existing ? { id: 9 } : null)), create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 10, ...data })) },
    socialPostTarget: { createMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const svc = new SocialPostsService(prisma as never, {} as never, {} as never, {} as never);
  jest.spyOn(svc, 'validate').mockResolvedValue({ content: 'x', media: [], scheduledAt: new Date(Date.now() + 86_400_000), targets: [{ account: { id: 1, network: 'facebook' }, caption: null, options: {} }] } as never);
  jest.spyOn(svc, 'get').mockResolvedValue({ id: 10 } as never);
  return { svc, tx };
}

describe('SocialPostsService.create — dedupeSource (chống tạo lặp)', () => {
  it('khoá advisory + ghi khoá vào source khi chưa có', async () => {
    const { svc, tx } = setup(false);
    await svc.create(user, { content: 'x', targets: [{ account_id: 1 }], scheduled_at: new Date(Date.now() + 86_400_000).toISOString() } as never, { dedupeSource: 'csv-import:abc:2' });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.socialPost.create.mock.calls[0][0].data).toMatchObject({ source: 'csv-import:abc:2' });
  });

  it('đã có bài mang khoá ⇒ 409, không tạo', async () => {
    const { svc, tx } = setup(true);
    await expect(svc.create(user, { content: 'x', targets: [{ account_id: 1 }] } as never, { dedupeSource: 'csv-import:abc:2' })).rejects.toThrow(ConflictException);
    expect(tx.socialPost.create).not.toHaveBeenCalled();
  });
});
