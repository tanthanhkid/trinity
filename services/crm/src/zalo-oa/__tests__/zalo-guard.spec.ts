import { ChannelBlockedError } from '../../channel-guard/channel-guard.errors';
import { ZaloOaMessagingService } from '../zalo-oa-messaging.service';

function make(guard: Record<string, unknown>, sendZns: jest.Mock) {
  const prisma = { zaloOaThread: { findFirst: jest.fn(async () => null) } };
  const tokens = { getAccessToken: jest.fn(async () => ({ token: 'T' })) };
  const linker = { phoneVariants: (p: string) => [p] };
  return new ZaloOaMessagingService(prisma as never, { sendZns } as never, tokens as never, {} as never, linker as never, guard as never);
}
const zns = { phone: '0912345678', templateId: 't1', templateData: {}, sentBy: 1 };

describe('Zalo OA — ChannelGuard', () => {
  it('ZNS hết hạn mức: send() trả đúng lời báo của guard (không thành "Gửi Zalo OA thất bại"), không gọi API Zalo', async () => {
    const sendZns = jest.fn();
    const guard = { reserve: jest.fn(async () => { throw new ChannelBlockedError('channel_quota', 'Đã hết hạn mức tin gửi hàng loạt của gói (200 tin/ngày).'); }), refund: jest.fn(), assertOutbound: jest.fn() };
    const r = await make(guard, sendZns).send({ to: { phone: '0912345678' }, template: { id: 't1', data: {} }, sentBy: 1 } as never);
    expect(r).toEqual({ ok: false, messageId: null, error: 'Đã hết hạn mức tin gửi hàng loạt của gói (200 tin/ngày).' });
    expect(sendZns).not.toHaveBeenCalled();
  });

  it('ZNS: giữ chỗ phạm vi "other" (tạm dừng do Graph không áp cho Zalo); Zalo không nhận ⇒ hoàn hạn mức', async () => {
    const sendZns = jest.fn(async () => { throw new Error('mạng lỗi'); });
    const guard = { reserve: jest.fn(async () => undefined), refund: jest.fn(async () => undefined), assertOutbound: jest.fn() };
    await expect(make(guard, sendZns).sendZns(zns)).rejects.toThrow();
    expect(guard.reserve).toHaveBeenCalledWith('bulk_message', 1, undefined, 'other');
    expect(guard.refund).toHaveBeenCalledWith('bulk_message');
  });

  it('ZNS gửi được ⇒ không hoàn', async () => {
    const sendZns = jest.fn(async () => ({ msg_id: 'm1', quota: null }));
    const guard = { reserve: jest.fn(async () => undefined), refund: jest.fn(), assertOutbound: jest.fn() };
    await make(guard, sendZns).sendZns(zns);
    expect(guard.refund).not.toHaveBeenCalled();
  });
});
