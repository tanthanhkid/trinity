import { ChannelNotificationsService, THROTTLE_MS } from './channel-notifications.service';
import { autoResultLine } from '../facebook/facebook-comments.service';

function make(opts: { owner?: number | null; managers?: number[]; recent?: { recipient_id: number }[] } = {}) {
  const prisma: any = {
    contact: { findUnique: jest.fn(async () => ({ assigned_to: opts.owner ?? null })) },
    notificationLog: { findMany: jest.fn(async () => opts.recent ?? []) },
  };
  const notifications: any = {
    findUserIdsWithPermission: jest.fn(async () => opts.managers ?? [1]),
    createPendingLogs: jest.fn(async () => ({ created: 1 })),
  };
  return { svc: new ChannelNotificationsService(prisma, notifications), prisma, notifications };
}

describe('ChannelNotificationsService', () => {
  it('bình luận: báo người phụ trách + người nhận mặc định của Page + quản lý kết nối, kèm kết quả luật và khách mới', async () => {
    const { svc, notifications } = make({ owner: 7, managers: [1, 7] });
    await svc.notify({ event: 'facebook.comment_received', channelName: 'AiiLab', defaultAssignee: 9, contactId: 280, contactCreated: true, fromName: 'Thành', text: 'Học thử được không?', autoResult: 'Luật "Ảnh bìa": đã trả lời công khai, đã nhắn riêng', actionUrl: '/x' });
    const [users, ev, content] = notifications.createPendingLogs.mock.calls[0];
    expect(new Set(users)).toEqual(new Set([7, 9, 1]));
    expect(ev).toBe('facebook.comment_received');
    expect(content.title).toBe('Bình luận mới trên AiiLab');
    expect(content.body).toContain('Thành: Học thử được không?');
    expect(content.body).toContain('đã nhắn riêng');
    expect(content.body).toContain('đã tạo khách mới');
    expect(content.action_url).toBe('/x');
  });

  it('tin nhắn liên tiếp cùng hội thoại trong 3 phút ⇒ không báo lại người đã được báo', async () => {
    const { svc, notifications, prisma } = make({ managers: [1, 2], recent: [{ recipient_id: 1 }] });
    await svc.notify({ event: 'messenger.message_received', channelName: 'AiiLab', fromName: 'Lan', text: 'alo', actionUrl: '/inbox?kenh=facebook', threadKey: 'fb:3' });
    expect(prisma.notificationLog.findMany.mock.calls[0][0].where.created_at.gte.getTime()).toBeGreaterThan(Date.now() - THROTTLE_MS - 1000);
    expect(notifications.createPendingLogs.mock.calls[0][0]).toEqual([2]);
  });

  it('không ai nhận ⇒ không tạo; lỗi ⇒ nuốt, không làm hỏng việc nhận tin', async () => {
    const a = make({ managers: [] });
    await a.svc.notify({ event: 'zalo_oa.message_received', channelName: 'Zalo OA', actionUrl: '/inbox?kenh=zalo' });
    expect(a.notifications.createPendingLogs).not.toHaveBeenCalled();
    const b = make();
    b.notifications.createPendingLogs.mockRejectedValueOnce(new Error('db down'));
    await expect(b.svc.notify({ event: 'zalo_oa.message_received', channelName: 'Zalo OA', actionUrl: '/x' })).resolves.toBeUndefined();
  });
});

describe('autoResultLine', () => {
  it('mô tả việc luật đã làm', () => {
    expect(autoResultLine(null, 'received', {})).toBeNull();
    expect(autoResultLine('A', 'test', {})).toBe('Luật "A" (chạy thử)');
    expect(autoResultLine('A', 'done', { public_reply: { text: 'x', id: '1' }, private_reply: { text: 'y', message_id: 'm' } } as never)).toBe('Luật "A": đã trả lời công khai, đã nhắn riêng');
  });
});
