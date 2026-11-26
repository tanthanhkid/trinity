import { ConflictException } from '@nestjs/common';
import { ChannelBlockedError } from '../../channel-guard/channel-guard.errors';
import { SocialPostsService } from '../social-posts.service';

const target = { account: { id: 1, network: 'facebook' }, caption: null, options: {} };
const validated = { content: 'Xin chào', media: [], scheduledAt: null, targets: [target, { ...target, account: { id: 2, network: 'facebook' } }] };

function setup(opts: { dupe?: boolean; guard?: Record<string, unknown> } = {}) {
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    socialPost: { findFirst: jest.fn(async () => (opts.dupe ? { id: 9 } : null)), create: jest.fn(async () => ({ id: 5, source: 'csv:1' })) },
    socialPostTarget: { createMany: jest.fn(async () => ({ count: 2 })) },
  };
  const prisma: any = {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    socialPostTarget: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
    socialPost: { findUnique: jest.fn() },
    socialAccount: { findUnique: jest.fn() },
  };
  const guard = { assertOutbound: jest.fn(async () => undefined), reserve: jest.fn(async () => undefined), blockReason: jest.fn(async () => null), autoPause: jest.fn(async () => null), ...opts.guard };
  const svc = new SocialPostsService(prisma, {} as never, {} as never, { get: () => ({}) } as never, undefined, guard as never);
  jest.spyOn(svc, 'validate').mockResolvedValue(validated as never);
  jest.spyOn(svc, 'get').mockResolvedValue({ id: 5 } as never);
  jest.spyOn(svc, 'refreshStatus').mockResolvedValue(undefined);
  jest.spyOn(svc, 'kick').mockReturnValue(undefined as never);
  return { svc, prisma, tx, guard };
}
const user = { userId: 1 } as never;

describe('đăng bài — hạn mức và khoá kênh', () => {
  it('bản nhập trùng (dedupe) bị từ chối TRƯỚC khi giữ chỗ hạn mức', async () => {
    const { svc, guard } = setup({ dupe: true });
    await expect(svc.create(user, { content: 'x' } as never, { dedupeSource: 'csv:1' })).rejects.toBeInstanceOf(ConflictException);
    expect(guard.reserve).not.toHaveBeenCalled();
  });

  it('tạo thành công: giữ chỗ đúng số kênh đích, CÙNG transaction (truyền tx)', async () => {
    const { svc, guard, tx } = setup();
    await svc.create(user, { content: 'x' } as never);
    expect(guard.reserve).toHaveBeenCalledWith('post', 2, tx);
  });

  it('hết hạn mức ⇒ transaction hỏng, không tạo bài', async () => {
    const { svc, tx } = setup({ guard: { reserve: jest.fn(async () => { throw new ChannelBlockedError('channel_quota', 'hết'); }) } });
    await expect(svc.create(user, { content: 'x' } as never)).rejects.toBeInstanceOf(ChannelBlockedError);
    expect(tx.socialPost.create).not.toHaveBeenCalled();
  });

  it('trả lời đánh giá Google bị chặn khi kênh bị khoá; gỡ bài trên mạng thì KHÔNG bị chặn (gỡ nội dung)', async () => {
    const locked = { assertOutbound: jest.fn(async () => { throw new ChannelBlockedError('channel_locked', 'Kênh đang bị tạm khoá'); }) };
    const { svc, prisma } = setup({ guard: locked });
    await expect(svc.gbpReply(1, 'r1', 'Cảm ơn', user)).rejects.toThrow(/tạm khoá/);
    prisma.socialPostTarget.findUnique.mockResolvedValue(null);
    await expect(svc.deleteRemote(1)).rejects.toThrow(/Không tìm thấy/); // qua được cổng, dừng ở bước tìm bài
    expect(locked.assertOutbound).toHaveBeenCalledTimes(1);
  });

  it('retry() giữ chỗ 1 lượt; cập nhật lỗi thì hoàn lại', async () => {
    const { svc, prisma, guard } = setup({ guard: { refund: jest.fn(async () => undefined) } });
    prisma.socialPostTarget.findUnique.mockResolvedValue({ id: 7, post_id: 3, account_id: 1, status: 'failed' });
    prisma.socialAccount.findUnique.mockResolvedValue({ id: 1, status: 'active' });
    await svc.retry(7);
    expect(guard.reserve).toHaveBeenCalledWith('post', 1);
    prisma.socialPostTarget.update.mockRejectedValueOnce(new Error('db'));
    await expect(svc.retry(7)).rejects.toThrow('db');
    expect((guard as any).refund).toHaveBeenCalledWith('post');
  });

  it('sửa bài thêm kênh đích: chỉ giữ chỗ phần tăng thêm, cùng transaction', async () => {
    const { svc, tx, guard } = setup();
    const post = { id: 5, updated_at: new Date(), media: [] };
    jest.spyOn(svc, 'editable').mockResolvedValue({ post, live: [{ id: 1 }] } as never);
    (tx as any).socialPostTarget.deleteMany = jest.fn(async () => ({ count: 1 }));
    (tx as any).socialPost.update = jest.fn(async () => ({}));
    await svc.update(user, 5, { content: 'x', scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } as never);
    expect(guard.reserve).toHaveBeenCalledWith('post', 1, tx); // 2 kênh đích − 1 kênh đang chờ
  });
});

describe('đăng bài — nhánh tạm dừng tự động', () => {
  const row = { id: 7, post_id: 3, account_id: 1, attempts: 2 };
  function paused(code: 'channel_paused' | 'channel_locked') {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const s = setup({ guard: { blockReason: jest.fn(async () => ({ code, message: 'đang chặn', until: new Date(until) })) } });
    s.prisma.socialPostTarget.findUnique.mockResolvedValue(row);
    s.prisma.socialPost.findUnique.mockResolvedValue({ id: 3, content: 'x', media: [] });
    s.prisma.socialAccount.findUnique.mockResolvedValue({ id: 1, network: 'facebook', status: 'active' });
    return { ...s, until };
  }

  it('tạm dừng: xếp lại tới hết tạm dừng và TRẢ LẠI lượt thử (attempts giảm 1) để không cạn lượt thử lại', async () => {
    const { svc, prisma, until } = paused('channel_paused');
    expect(await svc.processOne(7)).toBe('retry');
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ status: 'queued', attempts: { decrement: 1 }, next_attempt_at: new Date(until) }),
    });
  });

  it('tạm dừng do Graph chỉ áp cho Facebook/Instagram: TikTok/YouTube hỏi guard với phạm vi "other"', async () => {
    const { svc, prisma, guard } = paused('channel_paused');
    prisma.socialAccount.findUnique.mockResolvedValue({ id: 1, network: 'youtube', status: 'active' });
    (guard.blockReason as jest.Mock).mockClear();
    await svc.processOne(7);
    expect(guard.blockReason).toHaveBeenCalledWith('auto', 'other');
    prisma.socialAccount.findUnique.mockResolvedValue({ id: 1, network: 'instagram', status: 'active' });
    await svc.processOne(7);
    expect(guard.blockReason).toHaveBeenLastCalledWith('auto', 'meta');
  });

  it('khoá kênh: báo lỗi, không xếp lại', async () => {
    const { svc, prisma } = paused('channel_locked');
    expect(await svc.processOne(7)).toBe('failed');
    expect(prisma.socialPostTarget.update).toHaveBeenCalledWith({ where: { id: 7 }, data: expect.objectContaining({ status: 'failed' }) });
  });
});
