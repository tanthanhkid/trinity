import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { RBAC_META } from '@trinity/rbac-nest';
import { ZaloOaController } from '../zalo-oa.controller';
import { ZaloOaMessagingService } from '../zalo-oa-messaging.service';
import { ZaloOaWebhookService } from '../zalo-oa-webhook.service';
import { computeZaloMac } from '../zalo-oa-signature';
import { ZaloApiError } from '../zalo-oa.errors';

process.env.ZALO_OA_APP_ID = 'APP';
process.env.ZALO_WEBHOOK_SECRET = 'OASECRET';

const signed = (ev: object) => {
  const raw = Buffer.from(JSON.stringify({ app_id: 'APP', ...ev }));
  const ts = String((ev as { timestamp: unknown }).timestamp);
  return { raw, sig: `mac=${computeZaloMac('APP', raw, ts, 'OASECRET')}` };
};

function webhookSetup(enabled = true) {
  const threads = {
    upsertThread: jest.fn(async () => ({ id: 5, last_message_at: null, contact_id: null, display_name: null })),
    record: jest.fn(async () => ({ id: 1n })),
    updateProfile: jest.fn(),
  };
  const linker = { findOrCreate: jest.fn(async () => 42) };
  const tokens = { getAccessToken: jest.fn(async () => ({ token: 'AT', oaId: 'OA1', connectedBy: 9 })) };
  const api = { getProfile: jest.fn(async () => ({ display_name: 'Lan', avatar: null, phone: '84912345678' })) };
  const feature = { isEnabled: jest.fn(async () => enabled) };
  const svc = new ZaloOaWebhookService(threads as never, linker as never, tokens as never, api as never, feature as never);
  return { svc, threads, linker, api };
}

describe('ZaloOaWebhookService', () => {
  const inbound = { event_name: 'user_send_text', timestamp: '1700000000000', sender: { id: 'U1' }, recipient: { id: 'OA1' }, message: { msg_id: 'M1', text: 'chào shop' } };

  it('chữ ký sai/thiếu ⇒ 401, không ghi gì', async () => {
    const { svc, threads } = webhookSetup();
    const { raw } = signed(inbound);
    await expect(svc.receive(raw, 'mac=' + '0'.repeat(64))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.receive(raw, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(threads.record).not.toHaveBeenCalled();
  });

  it('user_send_text: tạo hội thoại, ghi tin vào, lấy hồ sơ + ghép/tạo khách', async () => {
    const { svc, threads, linker } = webhookSetup();
    const { raw, sig } = signed(inbound);
    expect(await svc.receive(raw, sig)).toEqual({ ok: true, handled: true });
    expect(threads.upsertThread).toHaveBeenCalledWith('OA1', 'U1');
    expect(threads.record).toHaveBeenCalledWith(expect.objectContaining({ threadId: 5, direction: 'in', kind: 'text', msgId: 'M1', text: 'chào shop', status: 'received' }));
    expect(linker.findOrCreate).toHaveBeenCalledWith({ zaloUserId: 'U1', phone: '84912345678', name: 'Lan', ownerUserId: 9 });
    expect(threads.updateProfile).toHaveBeenCalledWith(5, { name: 'Lan', avatar: null, phone: '84912345678' }, 42);
  });

  it('webhook gửi lại (tin trùng) ⇒ record trả null, không lấy hồ sơ lần nữa', async () => {
    const { svc, threads, api } = webhookSetup();
    threads.record.mockResolvedValueOnce(null as never);
    const { raw, sig } = signed(inbound);
    expect(await svc.receive(raw, sig)).toEqual({ ok: true, handled: false });
    expect(api.getProfile).not.toHaveBeenCalled();
  });

  it('oa_send_text: user là người NHẬN, ghi chiều out', async () => {
    const { svc, threads } = webhookSetup();
    const ev = { event_name: 'oa_send_text', timestamp: '1700000000001', sender: { id: 'OA1' }, recipient: { id: 'U2' }, message: { msg_id: 'M2', text: 'ok' } };
    const { raw, sig } = signed(ev);
    await svc.receive(raw, sig);
    expect(threads.upsertThread).toHaveBeenCalledWith('OA1', 'U2');
    expect(threads.record).toHaveBeenCalledWith(expect.objectContaining({ direction: 'out', status: 'sent' }));
  });

  it('tin ảnh: kind attachment; sự kiện lạ: 200 nhưng bỏ qua; lỗi lấy hồ sơ không làm hỏng việc nhận tin', async () => {
    const { svc, threads, api } = webhookSetup();
    api.getProfile.mockRejectedValueOnce(new ZaloApiError(-216, 'x') as never);
    const img = { event_name: 'user_send_image', timestamp: '5', sender: { id: 'U1' }, recipient: { id: 'OA1' }, message: { msg_id: 'M3', attachments: [{ type: 'image', payload: { url: 'http://i' } }] } };
    const a = signed(img);
    expect(await svc.receive(a.raw, a.sig)).toEqual({ ok: true, handled: true });
    expect(threads.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'attachment', text: null }));
    const other = signed({ event_name: 'user_seen_message', timestamp: '6' });
    expect(await svc.receive(other.raw, other.sig)).toEqual({ ok: true, handled: false });
  });

  it('cờ zalo_oa tắt ⇒ 200 nhưng không xử lý', async () => {
    const { svc, threads } = webhookSetup(false);
    const { raw, sig } = signed(inbound);
    expect(await svc.receive(raw, sig)).toEqual({ ok: true, handled: false });
    expect(threads.upsertThread).not.toHaveBeenCalled();
  });
});

describe('ZaloOaMessagingService', () => {
  function setup(lastInbound: Date | null) {
    const prisma = { zaloOaThread: { findFirst: jest.fn(async () => null) } };
    const api = { sendText: jest.fn(async () => ({ msg_id: 'S1' })), sendZns: jest.fn(async () => ({ msg_id: 'Z1', quota: null })) };
    const tokens = { getAccessToken: jest.fn(async () => ({ token: 'AT', oaId: 'OA1', connectedBy: 1 })), getConnection: jest.fn(async () => ({ oa_id: 'OA1' })), markNeedsReauth: jest.fn(), status: jest.fn(async () => ({ connected: true })) };
    const threads = { get: jest.fn(async () => ({ id: 3, zalo_user_id: 'U1', last_inbound_at: lastInbound })), record: jest.fn() };
    const linker = { phoneVariants: (p: string) => [p] };
    const svc = new ZaloOaMessagingService(prisma as never, api as never, tokens as never, threads as never, linker as never);
    return { svc, api, tokens, threads };
  }
  const h = (n: number) => new Date(Date.now() - n * 3600_000);

  it('trong 48h: gửi + ghi tin out', async () => {
    const { svc, api, threads } = setup(h(47));
    expect(await svc.sendText(3, ' xin chào ', 8)).toEqual({ message_id: 'S1' });
    expect(api.sendText).toHaveBeenCalledWith('AT', 'U1', 'xin chào');
    expect(threads.record).toHaveBeenCalledWith(expect.objectContaining({ direction: 'out', status: 'sent', sentBy: 8 }));
  });

  it('Zalo đã nhận tin nhưng ghi lịch sử lỗi: vẫn trả message_id, không ném (tránh gửi lại hai lần)', async () => {
    const { svc, api, threads } = setup(h(1));
    threads.record.mockRejectedValueOnce(new Error('db down'));
    expect(await svc.sendText(3, 'x', 1)).toEqual({ message_id: 'S1' });
    expect(api.sendText).toHaveBeenCalledTimes(1);
  });

  it('quá 48h hoặc khách chưa từng nhắn: chặn trước khi gọi Zalo', async () => {
    for (const last of [h(49), null]) {
      const { svc, api } = setup(last);
      await expect(svc.sendText(3, 'x', 1)).rejects.toBeInstanceOf(BadRequestException);
      expect(api.sendText).not.toHaveBeenCalled();
    }
  });

  it('Zalo báo token lỗi: đánh dấu cần kết nối lại, ghi tin failed, báo tiếng Việt', async () => {
    const { svc, api, tokens, threads } = setup(h(1));
    api.sendText.mockRejectedValueOnce(new ZaloApiError(-216, 'invalid') as never);
    await expect(svc.sendText(3, 'x', 1)).rejects.toThrow(/kết nối lại/);
    expect(tokens.markNeedsReauth).toHaveBeenCalledWith('OA1', expect.any(String));
    expect(threads.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('ZNS: chuẩn hoá SĐT về 84…, SĐT sai bị chặn; MessageChannel.send trả ok=false thay vì ném', async () => {
    const { svc, api } = setup(null);
    await svc.sendZns({ phone: '0912345678', templateId: '1', templateData: { a: 'b' }, sentBy: 1 });
    expect(api.sendZns).toHaveBeenCalledWith('AT', expect.objectContaining({ phone: '84912345678', templateId: '1' }));
    await expect(svc.sendZns({ phone: '123', templateId: '1', templateData: {}, sentBy: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(await svc.send({ to: { phone: '123' }, template: { id: '1', data: {} } })).toMatchObject({ ok: false });
    expect(await svc.send({ to: { phone: '0912345678' }, template: { id: '1', data: {} } })).toEqual({ ok: true, messageId: 'Z1' });
  });
});

describe('RBAC của ZaloOaController', () => {
  const meta = (name: keyof ZaloOaController) => Reflect.getMetadata(RBAC_META, ZaloOaController.prototype[name] as object);

  it('kết nối/ngắt/ZNS cần integrations.webhooks; hộp thư cần contacts.update', () => {
    for (const m of ['connect', 'disconnect', 'zns'] as const) expect(meta(m)).toMatchObject({ kind: 'can', permissions: ['integrations.webhooks'] });
    for (const m of ['status', 'list', 'messages', 'reply', 'read', 'link'] as const) expect(meta(m)).toMatchObject({ kind: 'can', permissions: ['contacts.update'] });
  });
  it('chỉ webhook và callback là public', () => {
    expect(meta('hook')).toEqual({ kind: 'public' });
    expect(meta('callback')).toEqual({ kind: 'public' });
  });
});
