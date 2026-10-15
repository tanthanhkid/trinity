import { cancelMessengerBroadcastTool, cancelScheduledPostTool } from '../tools/cancel-tools';
import { ToolUserError } from '../tools/tool-types';

const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example', principal: { user: { userId: 7 } } }) as never;
const post = (o: Record<string, unknown> = {}) => ({
  id: 5, status: 'scheduled', content: 'Khai trương', scheduled_at: new Date(Date.now() + 86_400_000),
  targets: [{ id: 11, account_id: 3, account_name: 'Fanpage', status: 'queued' }], ...o,
});

function sdeps(p = post()) {
  return { social: { posts: { get: jest.fn(async () => p), cancel: jest.fn(async () => ({ ...p, status: 'cancelled', targets: p.targets.map((t: any) => ({ ...t, status: 'cancelled' })) })) }, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}

describe('cancel_scheduled_post', () => {
  it('thiếu đồng ý ⇒ chỉ xem trước; có đồng ý ⇒ chuyển "đã huỷ" (không xoá)', async () => {
    const d = sdeps();
    const r = (await cancelScheduledPostTool.run({ post_id: 5 }, ctx(d))).structured as any;
    expect(r.data).toMatchObject({ cancelled: false, preview: { channels: ['Fanpage'] } });
    expect(d.social.posts.cancel).not.toHaveBeenCalled();
    const ok = (await cancelScheduledPostTool.run({ post_id: 5, confirmed_by_user: 'ok huỷ đi' }, ctx(d))).structured as any;
    expect(d.social.posts.cancel).toHaveBeenCalledWith(5);
    expect(ok.data).toMatchObject({ cancelled: true, status: 'cancelled' });
  });

  it('vừa tới giờ đăng đúng lúc huỷ ⇒ báo kênh đã chạy, không báo huỷ hết', async () => {
    const d = sdeps();
    d.social.posts.cancel.mockResolvedValueOnce({ ...post(), status: 'publishing', targets: [{ id: 11, account_id: 3, account_name: 'Fanpage', status: 'publishing' }] });
    const r = (await cancelScheduledPostTool.run({ post_id: 5, confirmed_by_user: 'ok huỷ đi' }, ctx(d))).structured as any;
    expect(r.data).toMatchObject({ cancelled: false, already_started: [{ account: 'Fanpage', status: 'publishing' }] });
  });

  it('bài đã đăng một phần ⇒ không huỷ', async () => {
    const d = sdeps(post({ status: 'partial', targets: [{ id: 11, account_id: 3, account_name: 'F', status: 'published' }, { id: 12, account_id: 4, account_name: 'Y', status: 'queued' }] }));
    await expect(cancelScheduledPostTool.run({ post_id: 5, confirmed_by_user: 'ok huỷ đi' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
    expect(d.social.posts.cancel).not.toHaveBeenCalled();
  });
});

function bdeps(status = 'scheduled') {
  const b = { id: 4, name: 'Khai giảng', page_name: 'P', text: 'Lớp mới', status, scheduled_at: new Date(Date.now() + 3_600_000), total: 0, sent: 0, failed: 0, skipped: 0, audience: {} };
  return { facebookBroadcasts: { get: jest.fn(async () => b), cancelPending: jest.fn(async () => ({ ...b, status: 'cancelled' })) }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}

describe('cancel_messenger_broadcast', () => {
  it('lượt chờ gửi: xem trước rồi huỷ khi có đồng ý', async () => {
    const d = bdeps();
    expect(((await cancelMessengerBroadcastTool.run({ broadcast_id: 4 }, ctx(d))).structured as any).data.cancelled).toBe(false);
    expect(d.facebookBroadcasts.cancelPending).not.toHaveBeenCalled();
    await cancelMessengerBroadcastTool.run({ broadcast_id: 4, confirmed_by_user: 'đồng ý huỷ' }, ctx(d));
    expect(d.facebookBroadcasts.cancelPending).toHaveBeenCalledWith(4);
  });

  it('đang gửi / nháp ⇒ không huỷ ở đây', async () => {
    for (const st of ['sending', 'draft', 'done']) {
      const d = bdeps(st);
      await expect(cancelMessengerBroadcastTool.run({ broadcast_id: 4, confirmed_by_user: 'ok huỷ đi' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
      expect(d.facebookBroadcasts.cancelPending).not.toHaveBeenCalled();
    }
  });
});
