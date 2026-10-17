import { BadRequestException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { encryptSecret } from '../../integrations/webhooks/secret-crypto';
import { signMetaBody } from '../facebook-signature';
import { FacebookLeadsService } from '../facebook-leads.service';
import { FacebookMessengerService, findVnPhone } from '../facebook-messenger.service';
import { FacebookPagesService } from '../facebook-pages.service';
import { FacebookWebhookService } from '../facebook-webhook.service';
import { GraphApiError } from '../graph-client';
import { signFacebookState } from '../facebook-oauth-state';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PAGE = { id: 1, page_id: '111', name: 'Trinity', default_assignee_id: 5, contact_source_id: 9, project_id: null, is_active: true, token_enc: '' };
const actor = { userId: 5 } as never;

beforeAll(() => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  process.env.JWT_SECRET = 'jwt';
  process.env.FACEBOOK_APP_ID = 'app';
  process.env.FACEBOOK_APP_SECRET = 'appsecret';
  process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN = 'vt';
  process.env.INTEGRATIONS_PUBLIC_BASE_URL = 'https://crm.example.vn';
  PAGE.token_enc = encryptSecret('PAGE_TOKEN', Buffer.from(KEY, 'base64'));
});

describe('FacebookWebhookService', () => {
  const messenger = { ingest: jest.fn().mockResolvedValue(true), ingestReferral: jest.fn().mockResolvedValue(false) };
  const leads = { handle: jest.fn().mockResolvedValue('created') };
  const comments = { ingest: jest.fn().mockResolvedValue(true) };
  const features = { isEnabled: jest.fn().mockResolvedValue(true) };
  const prisma = { facebookPage: { findMany: jest.fn().mockResolvedValue([{ page_id: '111' }]) } };
  const svc = new FacebookWebhookService(messenger as never, leads as never, comments as never, { handleEvent: jest.fn().mockResolvedValue(false) } as never, features as never, prisma as never);
  const payload = {
    object: 'page',
    entry: [{ id: '111', messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', text: 'hi' } }], changes: [{ field: 'leadgen', value: { leadgen_id: '999', form_id: 'f1' } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  beforeEach(() => jest.clearAllMocks());

  it('GET verify: đúng token trả challenge; sai ⇒ 403', () => {
    expect(svc.verify('subscribe', 'vt', '12345')).toBe('12345');
    expect(() => svc.verify('subscribe', 'sai', '1')).toThrow(ForbiddenException);
    expect(() => svc.verify('unsubscribe', 'vt', '1')).toThrow(ForbiddenException);
    expect(() => svc.verify('subscribe', undefined, '1')).toThrow(ForbiddenException);
  });

  it('chữ ký sai ⇒ 401 và KHÔNG xử lý gì', async () => {
    await expect(svc.receive(raw, 'sha256=' + '0'.repeat(64), payload)).rejects.toThrow(UnauthorizedException);
    await expect(svc.receive(raw, undefined, payload)).rejects.toThrow(UnauthorizedException);
    expect(messenger.ingest).not.toHaveBeenCalled();
    expect(leads.handle).not.toHaveBeenCalled();
  });

  it('chữ ký đúng: chuyển tin cho messenger, leadgen cho leads (page_id lấy từ entry)', async () => {
    expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), payload)).toBe(2);
    expect(messenger.ingest).toHaveBeenCalledWith('111', payload.entry[0].messaging![0]);
    expect(leads.handle).toHaveBeenCalledWith({ leadgen_id: '999', form_id: 'f1', page_id: '111' });
  });

  it('feed: bình luận chuyển cho bộ xử lý bình luận, không lẫn sang leads', async () => {
    const p = { object: 'page', entry: [{ id: '111', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: '111_1' } }] }] };
    const r = Buffer.from(JSON.stringify(p));
    expect(await svc.receive(r, signMetaBody(r, 'appsecret'), p)).toBe(1);
    expect(comments.ingest).toHaveBeenCalledWith('111', p.entry[0].changes[0].value);
    expect(leads.handle).not.toHaveBeenCalled();
  });

  describe('chuyển tiếp sang bản khác (FACEBOOK_WEBHOOK_FORWARD_URL)', () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const realFetch = global.fetch;
    const foreign = { object: 'page', entry: [{ id: '222', messaging: [{ sender: { id: 'u9' }, message: { mid: 'm9', text: 'chào' } }] }] };
    const fraw = Buffer.from(JSON.stringify(foreign));
    beforeEach(() => {
      process.env.FACEBOOK_WEBHOOK_FORWARD_URL = 'https://demo.example.vn/api/v1/facebook/webhook';
      global.fetch = fetchMock as never;
      prisma.facebookPage.findMany.mockResolvedValue([{ page_id: '111' }]);
    });
    afterEach(() => {
      delete process.env.FACEBOOK_WEBHOOK_FORWARD_URL;
      global.fetch = realFetch;
    });

    it('Page lạ ⇒ chuyển NGUYÊN body + chữ ký gốc, kèm header chống vòng', async () => {
      const sig = signMetaBody(fraw, 'appsecret');
      await svc.receive(fraw, sig, foreign);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://demo.example.vn/api/v1/facebook/webhook');
      expect(init.body).toBe(fraw);
      expect(init.headers).toMatchObject({ 'x-hub-signature-256': sig, 'x-trinity-forwarded': '1' });
    });

    it('Page của mình ⇒ không chuyển', async () => {
      await svc.receive(raw, signMetaBody(raw, 'appsecret'), payload);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sự kiện đã được chuyển tiếp ⇒ không chuyển nữa (chống vòng)', async () => {
      await svc.receive(fraw, signMetaBody(fraw, 'appsecret'), foreign, { forwarded: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('chữ ký sai ⇒ 401, không chuyển', async () => {
      await expect(svc.receive(fraw, 'sha256=' + '0'.repeat(64), foreign)).rejects.toThrow(UnauthorizedException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('bản kia lỗi mạng ⇒ lô này vẫn xử lý bình thường', async () => {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));
      expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), { ...payload, entry: [...payload.entry, ...foreign.entry] })).toBeGreaterThan(0);
    });

    it('không đặt URL ⇒ không chuyển', async () => {
      delete process.env.FACEBOOK_WEBHOOK_FORWARD_URL;
      await svc.receive(fraw, signMetaBody(fraw, 'appsecret'), foreign);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('cờ gói tắt ⇒ nhận 200 nhưng bỏ qua', async () => {
    features.isEnabled.mockResolvedValueOnce(false);
    expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), payload)).toBe(0);
    expect(messenger.ingest).not.toHaveBeenCalled();
  });

  it('lỗi tạm của leads được ném ra để Meta gửi lại; lỗi lưu tin không ném', async () => {
    messenger.ingest.mockRejectedValueOnce(new Error('db'));
    leads.handle.mockRejectedValueOnce(new GraphApiError(500, 2, null, 'tạm'));
    await expect(svc.receive(raw, signMetaBody(raw, 'appsecret'), payload)).rejects.toThrow(GraphApiError);
  });

  it('object không phải page ⇒ bỏ qua', async () => {
    const b = { object: 'instagram', entry: [] };
    const r = Buffer.from(JSON.stringify(b));
    expect(await svc.receive(r, signMetaBody(r, 'appsecret'), b)).toBe(0);
  });
});

describe('FacebookMessengerService', () => {
  const mk = () => {
    const prisma = {
      facebookFlowRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      facebookMessage: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
      facebookConversation: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ id: 3, psid: 'u1', contact_id: null, customer_name: 'Khách A' }), update: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      contact: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ assigned_to: 5 }) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 5, status: 'active', team_id: 2, deleted_at: null }) },
      activity: { create: jest.fn() },
      integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const graph = { getUserName: jest.fn().mockResolvedValue('Khách A'), getConversationName: jest.fn().mockResolvedValue(null), sendText: jest.fn().mockResolvedValue({ message_id: 'm.out1' }) };
    const pages = { activePageWithToken: jest.fn().mockResolvedValue({ page: { ...PAGE, connected_by: 6 }, token: 'PAGE_TOKEN' }), markTokenInvalid: jest.fn() };
    const publicApi = { createContactInTx: jest.fn().mockResolvedValue({ id: 77 }) };
    return { prisma, graph, pages, publicApi, svc: new FacebookMessengerService(prisma as never, graph as never, pages as never, publicApi as never) };
  };

  it('tin khách: tạo hội thoại, tăng chưa đọc, đặt last_inbound_at', async () => {
    const { svc, prisma } = mk();
    expect(await svc.ingest('111', { sender: { id: 'u1' }, recipient: { id: '111' }, timestamp: 1_700_000_000_000, message: { mid: 'm1', text: 'xin chào' } })).toBe(true);
    const arg = prisma.facebookConversation.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ page_id_psid: { page_id: '111', psid: 'u1' } });
    expect(arg.create).toMatchObject({ customer_name: 'Khách A', unread_count: 1 });
    expect(arg.update.unread_count).toEqual({ increment: 1 });
    expect(prisma.facebookMessage.create.mock.calls[0][0].data).toMatchObject({ mid: 'm1', direction: 'in', text: 'xin chào' });
  });

  it('webhook ra ngoài: tin khách ⇒ messenger.message_received (định danh, người phụ trách); trả lời ⇒ message_sent origin agent; echo tới trước ⇒ không phát lần hai', async () => {
    const { svc, prisma } = mk();
    await svc.ingest('111', { sender: { id: 'u1' }, recipient: { id: '111' }, message: { mid: 'm1', text: 'gọi 0912345678' } });
    const ev = prisma.integrationEvent.create.mock.calls[0][0].data;
    expect(ev).toMatchObject({ event_type: 'messenger.message_received', resource: 'messenger_conversation', resource_id: '3' });
    expect(ev.payload).toEqual({ conversation_id: 3, page_id: '111', contact_id: 77, contact_assigned_to: 5, origin: 'customer' });
    prisma.integrationEvent.create.mockClear();
    prisma.facebookConversation.findUnique.mockResolvedValue({ id: 3, page_id: '111', psid: 'u1', contact_id: 77, last_inbound_at: new Date() });
    prisma.facebookMessage.create.mockResolvedValue({ id: 9n });
    await svc.reply(3, 'chào chị', { userId: 5 } as never);
    expect(prisma.integrationEvent.create.mock.calls[0][0].data).toMatchObject({ event_type: 'messenger.message_sent', actor_user_id: 5, payload: { origin: 'agent' } });
    prisma.integrationEvent.create.mockClear();
    prisma.facebookMessage.findUnique.mockResolvedValue({ id: 9n });
    prisma.facebookMessage.update.mockResolvedValue({ id: 9n });
    await svc.reply(3, 'chào chị', { userId: 5 } as never);
    expect(prisma.integrationEvent.create).not.toHaveBeenCalled();
  });

  it('quá 24 giờ theo dữ liệu đã lưu ⇒ kéo tin từ Facebook trước; khách có nhắn mới thì gửi được', async () => {
    const { svc, prisma, graph } = mk();
    const old = new Date(Date.now() - 3 * 86_400_000);
    const fresh = new Date(Date.now() - 60_000);
    const conv = { id: 3, page_id: '111', psid: 'u1', contact_id: null, last_inbound_at: old, last_message_at: old };
    prisma.facebookConversation.findUnique.mockResolvedValueOnce(conv).mockResolvedValue({ ...conv, last_inbound_at: fresh, last_message_at: fresh });
    prisma.facebookMessage.create.mockResolvedValue({ id: 9n });
    Object.assign(graph, {
      getRecentMessages: jest.fn().mockResolvedValue([
        { id: 'm_new', created_time: fresh.toISOString(), from: { id: 'u1' }, message: 'còn hàng không' },
        { id: 'm_old', created_time: old.toISOString(), from: { id: 'u1' }, message: 'tin cũ' },
      ]),
    });
    await svc.reply(3, 'Dạ còn ạ', { userId: 5 } as never);
    expect((graph as unknown as { getRecentMessages: jest.Mock }).getRecentMessages).toHaveBeenCalledWith('111', 'u1', 'PAGE_TOKEN');
    // Chỉ tin mới hơn tin cuối đã lưu được ghi; rồi tin trả lời đi được.
    const mids = prisma.facebookMessage.create.mock.calls.map((c) => c[0].data.mid);
    expect(mids[0]).toBe('m_new');
    expect(mids).not.toContain('m_old');
    expect(graph.sendText).toHaveBeenCalledWith('PAGE_TOKEN', 'u1', 'Dạ còn ạ');
  });

  it('Facebook cũng không có tin mới ⇒ vẫn chặn vì quá 24 giờ', async () => {
    const { svc, prisma, graph } = mk();
    const old = new Date(Date.now() - 3 * 86_400_000);
    prisma.facebookConversation.findUnique.mockResolvedValue({ id: 3, page_id: '111', psid: 'u1', contact_id: null, last_inbound_at: old, last_message_at: old });
    Object.assign(graph, { getRecentMessages: jest.fn().mockResolvedValue([]) });
    await expect(svc.reply(3, 'Dạ', { userId: 5 } as never)).rejects.toThrow(/24 giờ/);
    expect(graph.sendText).not.toHaveBeenCalled();
  });

  it('người nhắn lần đầu ⇒ tạo khách (SĐT trống, nguồn của Page, người nhận khách của Page), ghép hội thoại, ghi timeline', async () => {
    const { svc, prisma, publicApi } = mk();
    await svc.ingest('111', { sender: { id: 'u1' }, recipient: { id: '111' }, message: { mid: 'm1', text: 'shop ơi còn hàng không' } });
    const [, data, owner, origin] = publicApi.createContactInTx.mock.calls[0];
    expect(data).toMatchObject({ phone: '', full_name: 'Khách A', source_id: 9 });
    expect(owner).toEqual({ id: 5, team_id: 2 });
    expect(origin).toBe('facebook_messenger');
    expect(prisma.facebookConversation.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { contact_id: 77 } });
    const act = prisma.activity.create.mock.calls[0][0].data;
    expect(act).toMatchObject({ contact_id: 77, action: 'note' });
    expect(act.details).toEqual({ description: 'Khách nhắn Page "Trinity" qua Messenger: shop ơi còn hàng không', source: 'facebook_messenger' });
  });

  it('tin có SĐT trùng khách cũ ⇒ ghép vào khách đó, không tạo mới', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 40 });
    await svc.ingest('111', { sender: { id: 'u1' }, message: { mid: 'm1', text: 'số em 0912 345 678 nhé' } });
    expect(prisma.contact.findFirst.mock.calls[0][0].where.phone.in).toEqual(['0912345678', '84912345678', '+84912345678']);
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(prisma.activity.create.mock.calls[0][0].data.contact_id).toBe(40);
  });

  it('khách đã ghép: tin có SĐT ⇒ điền vào khách đang trống SĐT; không tạo khách mới', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.facebookConversation.upsert.mockResolvedValueOnce({ id: 3, psid: 'u1', contact_id: 50, customer_name: 'Khách A' });
    await svc.ingest('111', { sender: { id: 'u1' }, message: { mid: 'm5', text: '+84 987.654.321' } });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({ where: { id: 50, phone: '' }, data: { phone: '0987654321' } });
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });

  it('người nhận khách và người kết nối Page đều nghỉ ⇒ không tạo khách, vẫn lưu tin', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.user.findUnique.mockResolvedValue({ id: 5, status: 'inactive', team_id: null, deleted_at: null });
    expect(await svc.ingest('111', { sender: { id: 'u1' }, message: { mid: 'm6', text: 'hi' } })).toBe(true);
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
    expect(prisma.facebookMessage.create).toHaveBeenCalled();
  });

  it('echo của Page: không tạo khách; khách đã ghép thì ghi timeline "Page trả lời"', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.facebookConversation.upsert.mockResolvedValueOnce({ id: 3, psid: 'u1', contact_id: 50, customer_name: 'Khách A' });
    await svc.ingest('111', { sender: { id: '111' }, recipient: { id: 'u1' }, message: { mid: 'm7', text: 'dạ còn ạ', is_echo: true } });
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(prisma.activity.create.mock.calls[0][0].data.details.description).toBe('Page "Trinity" trả lời qua Messenger: dạ còn ạ');
  });

  it('echo (Page gửi từ Inbox FB): direction out, không tăng chưa đọc, psid = recipient', async () => {
    const { svc, prisma } = mk();
    await svc.ingest('111', { sender: { id: '111' }, recipient: { id: 'u1' }, message: { mid: 'm2', text: 'ok', is_echo: true } });
    const arg = prisma.facebookConversation.upsert.mock.calls[0][0];
    expect(arg.where.page_id_psid.psid).toBe('u1');
    expect(arg.update).not.toHaveProperty('unread_count');
    expect(prisma.facebookMessage.create.mock.calls[0][0].data.direction).toBe('out');
  });

  it('trùng mid ⇒ bỏ qua; không có message (delivery/read) ⇒ bỏ qua; Page lạ ⇒ bỏ qua', async () => {
    const { svc, prisma, pages } = mk();
    prisma.facebookMessage.findUnique.mockResolvedValueOnce({ id: 1n });
    expect(await svc.ingest('111', { sender: { id: 'u1' }, message: { mid: 'm1', text: 'x' } })).toBe(false);
    expect(await svc.ingest('111', { sender: { id: 'u1' } })).toBe(false);
    pages.activePageWithToken.mockResolvedValueOnce(null);
    expect(await svc.ingest('999', { sender: { id: 'u1' }, message: { mid: 'm9', text: 'x' } })).toBe(false);
    expect(prisma.facebookMessage.create).not.toHaveBeenCalled();
  });

  it('tệp đính kèm không có text ⇒ ghi nhãn', async () => {
    const { svc, prisma } = mk();
    await svc.ingest('111', { sender: { id: 'u1' }, message: { mid: 'm3', attachments: [{}] } });
    expect(prisma.facebookMessage.create.mock.calls[0][0].data.text).toBe('[Tệp đính kèm]');
  });

  it('reply trong 24h: gửi RESPONSE và lưu tin kèm người gửi', async () => {
    const { svc, prisma, graph } = mk();
    prisma.facebookConversation.findUnique.mockResolvedValue({ id: 3, page_id: '111', psid: 'u1', last_inbound_at: new Date(Date.now() - 3600_000) });
    prisma.facebookMessage.create.mockResolvedValue({ id: 10n, mid: 'm.out1' });
    const r = await svc.reply(3, '  Chào anh  ', actor);
    expect(graph.sendText).toHaveBeenCalledWith('PAGE_TOKEN', 'u1', 'Chào anh');
    expect(prisma.facebookMessage.create.mock.calls[0][0].data).toMatchObject({ mid: 'm.out1', direction: 'out', sent_by_user_id: 5 });
    expect(r.id).toBe('10');
    expect(prisma.activity.create).not.toHaveBeenCalled(); // hội thoại chưa gắn khách
  });

  it('reply: hội thoại đã gắn khách ⇒ ghi lịch sử thao tác kèm người gửi; echo tới trước thì không ghi lần hai', async () => {
    const { svc, prisma } = mk();
    prisma.facebookConversation.findUnique.mockResolvedValue({ id: 3, page_id: '111', psid: 'u1', contact_id: 40, last_inbound_at: new Date(Date.now() - 3600_000) });
    prisma.facebookMessage.create.mockResolvedValue({ id: 10n, mid: 'm.out1' });
    await svc.reply(3, 'Dạ bên em gọi lại ngay', actor);
    expect(prisma.activity.create.mock.calls[0][0].data).toMatchObject({
      contact_id: 40, created_by: 5, details: { description: 'Nhân viên trả lời qua Messenger: Dạ bên em gọi lại ngay', source: 'facebook_messenger' },
    });
    prisma.activity.create.mockClear();
    prisma.facebookMessage.findUnique.mockResolvedValue({ id: 11n, mid: 'm.out1' });
    prisma.facebookMessage.update.mockResolvedValue({ id: 11n, mid: 'm.out1' });
    await svc.reply(3, 'Tin thứ hai', actor);
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('reply quá 24h: 400 và KHÔNG gọi Graph', async () => {
    const { svc, prisma, graph } = mk();
    prisma.facebookConversation.findUnique.mockResolvedValue({ id: 3, page_id: '111', psid: 'u1', last_inbound_at: new Date(Date.now() - 25 * 3600_000) });
    await expect(svc.reply(3, 'hi', actor)).rejects.toThrow(BadRequestException);
    expect(graph.sendText).not.toHaveBeenCalled();
  });

  it('reply: Meta báo ngoài cửa sổ (đồng hồ lệch) ⇒ 400; token chết ⇒ 503 và đánh dấu Page', async () => {
    const { svc, prisma, graph, pages } = mk();
    prisma.facebookConversation.findUnique.mockResolvedValue({ id: 3, page_id: '111', psid: 'u1', last_inbound_at: new Date() });
    graph.sendText.mockRejectedValueOnce(new GraphApiError(400, 10, 2018278, 'outside'));
    await expect(svc.reply(3, 'hi', actor)).rejects.toThrow(BadRequestException);
    graph.sendText.mockRejectedValueOnce(new GraphApiError(400, 190, null, 'expired'));
    await expect(svc.reply(3, 'hi', actor)).rejects.toThrow(ServiceUnavailableException);
    expect(pages.markTokenInvalid).toHaveBeenCalledWith('111');
  });

  it('reply: nội dung trống/quá dài ⇒ 400', async () => {
    const { svc } = mk();
    await expect(svc.reply(3, '   ', actor)).rejects.toThrow(BadRequestException);
    await expect(svc.reply(3, 'a'.repeat(2001), actor)).rejects.toThrow(BadRequestException);
  });

  it('không đọc được hồ sơ người nhắn ⇒ lấy tên từ hội thoại của Page; vẫn không có ⇒ tên tạm', async () => {
    const { svc, prisma, graph, publicApi } = mk();
    graph.getUserName.mockResolvedValue(null);
    graph.getConversationName.mockResolvedValueOnce('Đạt Nguyễn');
    await svc.ingest('111', { sender: { id: 'u1' }, message: { mid: 'm1', text: 'hi' } });
    expect(graph.getConversationName).toHaveBeenCalledWith('111', 'u1', 'PAGE_TOKEN');
    expect(prisma.facebookConversation.upsert.mock.calls[0][0].create.customer_name).toBe('Đạt Nguyễn');
    prisma.facebookConversation.upsert.mockResolvedValueOnce({ id: 4, psid: '1234568904', contact_id: null, customer_name: null });
    await svc.ingest('111', { sender: { id: '1234568904' }, message: { mid: 'm2', text: 'hi' } });
    expect(publicApi.createContactInTx.mock.calls[1][1].full_name).toBe('Khách Messenger 8904');
  });

  it('khách mang tên tạm: lấy được tên ở tin sau ⇒ đổi tên khách (chỉ khi còn đúng tên tạm)', async () => {
    const { svc, prisma } = mk();
    prisma.facebookConversation.upsert.mockResolvedValueOnce({ id: 3, psid: '1234568904', contact_id: 50, customer_name: 'Đạt Nguyễn' });
    await svc.ingest('111', { sender: { id: '1234568904' }, message: { mid: 'm8', text: 'alo' } });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({ where: { id: 50, full_name: 'Khách Messenger 8904' }, data: { full_name: 'Khách A' } });
  });

  it('refreshMissingNames: hội thoại chưa có tên ⇒ lấy tên, đổi tên tạm của khách', async () => {
    const { svc, prisma, graph } = mk();
    prisma.facebookConversation.findMany.mockResolvedValueOnce([{ id: 3, psid: '1234568904', contact_id: 50 }, { id: 4, psid: 'u2', contact_id: null }]);
    graph.getUserName.mockResolvedValue(null);
    graph.getConversationName.mockResolvedValueOnce('Đạt Nguyễn').mockResolvedValueOnce(null);
    expect(await svc.refreshMissingNames('111')).toBe(1);
    expect(prisma.facebookConversation.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { customer_name: 'Đạt Nguyễn' } });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({ where: { id: 50, full_name: 'Khách Messenger 8904' }, data: { full_name: 'Đạt Nguyễn' } });
    expect(prisma.facebookConversation.update).toHaveBeenCalledTimes(1);
  });
});

describe('FacebookLeadsService', () => {
  const mk = () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1n }]),
      $executeRaw: jest.fn(),
      contact: { findFirst: jest.fn().mockResolvedValue(null) },
      activity: { create: jest.fn() },
      facebookLeadReceipt: { update: jest.fn() },
    };
    const prisma = {
      facebookLeadReceipt: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 5, status: 'active', team_id: 2, deleted_at: null }) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const lead = { id: '999', field_data: [{ name: 'full_name', values: ['Lê B'] }, { name: 'phone_number', values: ['0900000003'] }, { name: 'email', values: ['b@x.vn'] }, { name: 'nhu_cau', values: ['mua gói'] }] };
    const graph = { getLead: jest.fn().mockResolvedValue(lead) };
    const pages = { activePageWithToken: jest.fn().mockResolvedValue({ page: PAGE, token: 'PAGE_TOKEN' }), markTokenInvalid: jest.fn() };
    const publicApi = { createContactInTx: jest.fn().mockResolvedValue({ id: 42 }) };
    return { tx, prisma, graph, pages, publicApi, lead, svc: new FacebookLeadsService(prisma as never, graph as never, pages as never, publicApi as never) };
  };
  const change = { leadgen_id: '999', page_id: '111', form_id: 'f1' };

  it('lead mới: tạo khách qua lõi webhook vào (owner = sale của Page, origin facebook_lead) + activity + receipt', async () => {
    const { svc, publicApi, tx } = mk();
    expect(await svc.handle(change)).toBe('created');
    const [, data, owner, origin] = publicApi.createContactInTx.mock.calls[0];
    expect(data).toMatchObject({ phone: '0900000003', full_name: 'Lê B', email: 'b@x.vn', source_id: 9 });
    expect(owner).toEqual({ id: 5, team_id: 2 });
    expect(origin).toBe('facebook_lead');
    expect(tx.activity.create.mock.calls[0][0].data.details.description).toContain('nhu_cau: mua gói');
    expect(tx.facebookLeadReceipt.update.mock.calls[0][0].data).toEqual({ contact_id: 42, result: 'created' });
  });

  it('trùng SĐT/email: không tạo khách mới, chỉ ghi activity vào khách cũ', async () => {
    const { svc, publicApi, tx } = mk();
    tx.contact.findFirst.mockResolvedValueOnce({ id: 77 });
    expect(await svc.handle(change)).toBe('duplicate');
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(tx.activity.create.mock.calls[0][0].data.contact_id).toBe(77);
    const where = tx.contact.findFirst.mock.calls[0][0].where;
    expect(where.phone.in).toEqual(['0900000003', '84900000003', '+84900000003']);
  });

  it('khớp theo email khi SĐT không khớp', async () => {
    const { svc, tx } = mk();
    tx.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 78 });
    expect(await svc.handle(change)).toBe('duplicate');
    expect(tx.contact.findFirst.mock.calls[1][0].where.email).toEqual({ equals: 'b@x.vn', mode: 'insensitive' });
  });

  it('đã xử lý leadgen_id (Meta gửi lại) ⇒ không gọi Graph, không tạo', async () => {
    const { svc, prisma, graph } = mk();
    prisma.facebookLeadReceipt.findUnique.mockResolvedValue({ id: 1n });
    expect(await svc.handle(change)).toBe('already_processed');
    expect(graph.getLead).not.toHaveBeenCalled();
  });

  it('đua: INSERT receipt trong transaction không chiếm được ⇒ already_processed', async () => {
    const { svc, tx, publicApi } = mk();
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await svc.handle(change)).toBe('already_processed');
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });

  it('không có SĐT lẫn email ⇒ ghi receipt no_contact_info, không tạo khách', async () => {
    const { svc, graph, prisma, publicApi } = mk();
    graph.getLead.mockResolvedValue({ id: '999', field_data: [{ name: 'full_name', values: ['Ẩn danh'] }] });
    expect(await svc.handle(change)).toBe('no_contact_info');
    expect(prisma.facebookLeadReceipt.create.mock.calls[0][0].data.result).toBe('no_contact_info');
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });

  it('chỉ có email và chưa khớp khách nào ⇒ no_contact_info (cột phone bắt buộc)', async () => {
    const { svc, graph, publicApi } = mk();
    graph.getLead.mockResolvedValue({ id: '999', field_data: [{ name: 'email', values: ['c@x.vn'] }] });
    expect(await svc.handle(change)).toBe('no_contact_info');
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });

  it('sale nhận không còn hoạt động ⇒ không tạo khách, ghi receipt owner_inactive', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.user.findUnique.mockResolvedValue({ id: 5, status: 'locked', team_id: null, deleted_at: null });
    expect(await svc.handle(change)).toBe('owner_inactive');
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });

  it('Graph báo token chết (190) ⇒ đánh dấu Page, bỏ qua (không ném)', async () => {
    const { svc, graph, pages } = mk();
    graph.getLead.mockRejectedValue(new GraphApiError(400, 190, null, 'x'));
    expect(await svc.handle(change)).toBe('skipped');
    expect(pages.markTokenInvalid).toHaveBeenCalledWith('111');
  });

  it('Graph lỗi 5xx ⇒ ném để Meta gửi lại', async () => {
    const { svc, graph } = mk();
    graph.getLead.mockRejectedValue(new GraphApiError(503, 2, null, 'tạm'));
    await expect(svc.handle(change)).rejects.toThrow(GraphApiError);
  });

  it.each([
    ['HTTP 400 code 4 (app rate limit)', 400, 4],
    ['HTTP 400 code 17 (user rate limit)', 400, 17],
    ['HTTP 400 code 613 (call rate limit)', 400, 613],
    ['HTTP 429', 429, null],
  ])('Graph giới hạn tần suất (%s) ⇒ ném để Meta gửi lại, không mất lead', async (_n, status, code) => {
    const { svc, graph } = mk();
    graph.getLead.mockRejectedValue(new GraphApiError(status, code, null, 'rate'));
    await expect(svc.handle(change)).rejects.toThrow(GraphApiError);
  });

  it('Page chưa kết nối / leadgen_id rác ⇒ skipped', async () => {
    const { svc, pages, graph } = mk();
    pages.activePageWithToken.mockResolvedValueOnce(null);
    expect(await svc.handle(change)).toBe('skipped');
    expect(await svc.handle({ leadgen_id: "1'; DROP", page_id: '111' })).toBe('skipped');
    expect(graph.getLead).not.toHaveBeenCalled();
  });
});

describe('FacebookPagesService', () => {
  const mk = () => {
    const prisma = {
      settingOption: { findMany: jest.fn().mockResolvedValue([{ id: 9, label: 'Facebook' }]), findUnique: jest.fn().mockResolvedValue({ group_key: 'contact_source', is_active: true }) },
      facebookPage: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
      socialAccount: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'active', deleted_at: null }) },
    };
    const graph = {
      exchangeCode: jest.fn().mockResolvedValue('SHORT'),
      toLongLived: jest.fn().mockResolvedValue('LONG'),
      listPages: jest.fn().mockResolvedValue([{ id: '111', name: 'Trinity', access_token: 'PT1' }, { id: '222', name: 'Hai', access_token: 'PT2' }]),
      grantedPermissions: jest.fn().mockResolvedValue(['pages_show_list', 'pages_messaging']),
      subscribePage: jest.fn().mockResolvedValue(undefined),
      unsubscribePage: jest.fn().mockResolvedValue(undefined),
      ensureGetStarted: jest.fn().mockResolvedValue(true),
      debugToken: jest.fn().mockResolvedValue({ is_valid: true, expires_at: 0 }),
    };
    const scope = { ownerIds: jest.fn().mockResolvedValue([5]) };
    return { prisma, graph, scope, svc: new FacebookPagesService(prisma as never, graph as never, scope as never) };
  };

  it('connectUrl: có state ký, scope đủ, redirect_uri đúng; thiếu env ⇒ 503', () => {
    const { svc } = mk();
    const url = new URL(svc.connectUrl(actor).url);
    expect(url.host).toBe('www.facebook.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://crm.example.vn/api/v1/facebook/oauth/callback');
    expect(url.searchParams.get('scope')).toContain('pages_messaging');
    expect(url.searchParams.get('scope')).not.toContain('leads_retrieval');
    expect(url.searchParams.get('scope')).toContain('pages_messaging');
    const saved = process.env.FACEBOOK_APP_SECRET;
    process.env.FACEBOOK_APP_SECRET = '';
    expect(() => svc.connectUrl(actor)).toThrow(ServiceUnavailableException);
    process.env.FACEBOOK_APP_SECRET = saved;
  });

  it('callback: lưu từng Page với token MÃ HOÁ, đăng ký webhook, mặc định gán người bấm', async () => {
    const { svc, prisma, graph } = mk();
    const r = await svc.handleCallback('CODE', signFacebookState(5));
    expect(r).toEqual({ connected: 2, failed: 0, posting: 0 });
    expect(graph.exchangeCode).toHaveBeenCalledWith('CODE', 'https://crm.example.vn/api/v1/facebook/oauth/callback');
    expect(graph.subscribePage).toHaveBeenCalledWith('111', 'PT1', ['messages', 'messaging_postbacks', 'messaging_referrals']);
    const arg = prisma.facebookPage.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ page_id: '111', default_assignee_id: 5, contact_source_id: 9, subscribed: true, token_status: 'active' });
    expect(arg.create.token_enc).toMatch(/^v1\./);
    // Token thô không nằm ở đâu ngoài bản mã (bỏ bản mã ra trước khi kiểm — base64 ngẫu nhiên có thể chứa đúng 'PT1').
    const plain = JSON.stringify(arg).split(arg.create.token_enc).join('').split(arg.update?.token_enc ?? '\u0000').join('');
    expect(plain).not.toContain('PT1');
  });

  it('callback: một Page lỗi không làm hỏng Page khác; subscribe lỗi vẫn lưu với subscribed=false', async () => {
    const { svc, prisma, graph } = mk();
    graph.subscribePage.mockRejectedValueOnce(new GraphApiError(400, 200, null, 'perm'));
    prisma.facebookPage.upsert.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('db'));
    expect(await svc.handleCallback('CODE', signFacebookState(5))).toEqual({ connected: 1, failed: 1, posting: 0 });
    expect(prisma.facebookPage.upsert.mock.calls[0][0].create.subscribed).toBe(false);
  });

  it('callback: state sai/hết hạn ⇒ 400, không gọi Facebook', async () => {
    const { svc, graph } = mk();
    await expect(svc.handleCallback('CODE', 'rac.rac')).rejects.toThrow(BadRequestException);
    await expect(svc.handleCallback('CODE', signFacebookState(5, Date.now() - 20 * 60_000))).rejects.toThrow(BadRequestException);
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });

  it('list không lộ token_enc', async () => {
    const { svc, prisma } = mk();
    prisma.facebookPage.findMany.mockResolvedValue([{ ...PAGE }]);
    expect(JSON.stringify(await svc.list())).not.toContain('token_enc');
  });

  it('update: gán người ngoài phạm vi ⇒ 403; nguồn sai nhóm ⇒ 400', async () => {
    const { svc, prisma } = mk();
    prisma.facebookPage.findUnique.mockResolvedValue(PAGE);
    prisma.facebookPage.update.mockResolvedValue(PAGE);
    await expect(svc.update(1, { default_assignee_id: 99 }, actor)).rejects.toThrow(ForbiddenException);
    await expect(svc.update(1, { default_assignee_id: 5 }, actor)).resolves.toBeDefined();
    prisma.settingOption.findUnique.mockResolvedValue({ group_key: 'khac', is_active: true });
    await expect(svc.update(1, { contact_source_id: 3 }, actor)).rejects.toThrow(BadRequestException);
  });

  it('checkToken: token còn sống ⇒ đăng ký lại đủ trường (messages, messaging_postbacks, messaging_referrals)', async () => {
    const { svc, prisma, graph } = mk();
    prisma.facebookPage.findUnique.mockResolvedValue({ ...PAGE, subscribed: false });
    prisma.facebookPage.update.mockImplementation(async ({ data }: { data: unknown }) => ({ ...PAGE, ...(data as object) }));
    graph.debugToken.mockResolvedValueOnce({ is_valid: true, expires_at: 0, data_access_expires_at: 0 });
    const view = await svc.checkToken(1);
    expect(graph.subscribePage).toHaveBeenCalledWith('111', 'PAGE_TOKEN', ['messages', 'messaging_postbacks', 'messaging_referrals']);
    expect(graph.ensureGetStarted).toHaveBeenCalledWith('PAGE_TOKEN');
    expect(view.subscribed).toBe(true);
  });

  it('nút "Bắt đầu": bật lỗi chỉ ghi log, Page vẫn đăng ký; subscribe lỗi hẳn thì không bật', async () => {
    const { svc, prisma, graph } = mk();
    graph.ensureGetStarted.mockRejectedValueOnce(new GraphApiError(400, 200, null, 'perm'));
    expect(await svc.handleCallback('CODE', signFacebookState(5))).toEqual({ connected: 2, failed: 0, posting: 0 });
    expect(prisma.facebookPage.upsert.mock.calls[0][0].create.subscribed).toBe(true);
    graph.ensureGetStarted.mockClear();
    graph.subscribePage.mockRejectedValue(new GraphApiError(400, 200, null, 'perm'));
    await svc.handleCallback('CODE', signFacebookState(5));
    expect(graph.ensureGetStarted).not.toHaveBeenCalled();
  });

  it('checkToken: token chết ⇒ invalid; ngắt kết nối huỷ đăng ký rồi giữ dòng', async () => {
    const { svc, prisma, graph } = mk();
    prisma.facebookPage.findUnique.mockResolvedValue(PAGE);
    prisma.facebookPage.update.mockImplementation(async ({ data }: { data: unknown }) => ({ ...PAGE, ...(data as object) }));
    graph.debugToken.mockRejectedValueOnce(new GraphApiError(400, 190, null, 'x'));
    expect((await svc.checkToken(1)).token_status).toBe('invalid');
    await svc.disconnect(1);
    expect(graph.unsubscribePage).toHaveBeenCalledWith('111', 'PAGE_TOKEN');
    expect(prisma.facebookPage.delete).not.toHaveBeenCalled();
    expect(prisma.facebookPage.update).toHaveBeenLastCalledWith({ where: { id: 1 }, data: { is_active: false, token_enc: '', subscribed: false } });
  });

  describe('nối một lần: nhận tin + đăng bài', () => {
    const POSTING = ['pages_show_list', 'pages_messaging', 'pages_read_engagement', 'pages_manage_posts'];
    const withTasks = (g: ReturnType<typeof mk>['graph'], tasks: string[]) =>
      g.listPages.mockResolvedValue([{ id: '111', name: 'Trinity', access_token: 'PT1', tasks, picture: { data: { url: 'http://img/1.png' } } }]);

    it('connectUrl xin hợp quyền nhận tin và đăng bài, không trùng', () => {
      const { svc } = mk();
      const scope = new URL(svc.connectUrl(actor).url).searchParams.get('scope')!.split(',');
      expect(scope).toEqual(expect.arrayContaining(['pages_messaging', 'pages_manage_posts', 'pages_manage_metadata']));
      expect(new Set(scope).size).toBe(scope.length);
    });

    it('Page mới + có quyền đăng ⇒ tạo ở cả facebook_pages (is_active) và social_accounts (active)', async () => {
      const { svc, prisma, graph } = mk();
      withTasks(graph, ['CREATE_CONTENT', 'MESSAGING']);
      graph.grantedPermissions.mockResolvedValue(POSTING);
      expect(await svc.handleCallback('CODE', signFacebookState(5))).toEqual({ connected: 1, failed: 0, posting: 1 });
      expect(prisma.facebookPage.upsert.mock.calls[0][0].create.is_active).toBe(true);
      const c = prisma.socialAccount.create.mock.calls[0][0].data;
      expect(c).toMatchObject({ network: 'facebook', external_id: '111', status: 'active', avatar_url: 'http://img/1.png', connected_by: 5, token_expires_at: null });
      expect(c.access_token_enc).toMatch(/^v1\./);
      expect(c.scopes).toBe('pages_show_list pages_read_engagement pages_manage_posts');
    });

    it('thiếu pages_manage_posts hoặc không có task đăng ⇒ không tạo social_accounts', async () => {
      const { svc, prisma, graph } = mk();
      withTasks(graph, ['CREATE_CONTENT']);
      expect((await svc.handleCallback('CODE', signFacebookState(5))).posting).toBe(0);
      withTasks(graph, ['MESSAGING']);
      graph.grantedPermissions.mockResolvedValue(POSTING);
      expect((await svc.handleCallback('CODE', signFacebookState(5))).posting).toBe(0);
      expect(prisma.socialAccount.create).not.toHaveBeenCalled();
      expect(prisma.socialAccount.update).not.toHaveBeenCalled();
    });

    it('nối lại KHÔNG bật lại Page is_active=false: nhánh update không có is_active', async () => {
      const { svc, prisma } = mk();
      await svc.handleCallback('CODE', signFacebookState(5));
      for (const call of prisma.facebookPage.upsert.mock.calls) expect(call[0].update).not.toHaveProperty('is_active');
    });

    it('kênh đăng bài đang disabled ⇒ chỉ làm mới token, giữ disabled; reauth ⇒ bật lại active', async () => {
      const { svc, prisma, graph } = mk();
      withTasks(graph, ['MANAGE']);
      graph.grantedPermissions.mockResolvedValue(POSTING);
      prisma.socialAccount.findUnique.mockResolvedValueOnce({ id: 7, status: 'disabled' });
      expect((await svc.handleCallback('CODE', signFacebookState(5))).posting).toBe(0);
      const d = prisma.socialAccount.update.mock.calls[0][0].data;
      expect(d).not.toHaveProperty('status');
      expect(d.access_token_enc).toMatch(/^v1\./);
      prisma.socialAccount.findUnique.mockResolvedValueOnce({ id: 8, status: 'reauth' });
      expect((await svc.handleCallback('CODE', signFacebookState(5))).posting).toBe(1);
      expect(prisma.socialAccount.update.mock.calls[1][0].data).toMatchObject({ status: 'active', last_error: null });
    });

    it('bật lại Page đã ngắt (token rỗng) ⇒ 400; Page còn token bật được', async () => {
      const { svc, prisma } = mk();
      prisma.facebookPage.findUnique.mockResolvedValue({ ...PAGE, is_active: false, token_enc: '' });
      await expect(svc.update(1, { is_active: true }, actor)).rejects.toThrow('Kết nối lại Facebook để bật lại Page này');
      prisma.facebookPage.findUnique.mockResolvedValue({ ...PAGE, is_active: false });
      prisma.facebookPage.update.mockResolvedValue(PAGE);
      await expect(svc.update(1, { is_active: true }, actor)).resolves.toBeDefined();
    });

    it('activePageWithToken bỏ qua Page tắt hoặc token rỗng, không ném lỗi giải mã', async () => {
      const { svc, prisma } = mk();
      prisma.facebookPage.findUnique.mockResolvedValue({ ...PAGE, is_active: false, token_enc: '' });
      expect(await svc.activePageWithToken('111')).toBeNull();
      prisma.facebookPage.findUnique.mockResolvedValue({ ...PAGE, token_enc: '' });
      expect(await svc.activePageWithToken('111')).toBeNull();
    });

    it('list thêm posting từ social_accounts', async () => {
      const { svc, prisma } = mk();
      prisma.facebookPage.findMany.mockResolvedValue([{ ...PAGE }, { ...PAGE, id: 2, page_id: '222' }]);
      prisma.socialAccount.findMany.mockResolvedValue([{ external_id: '111', status: 'disabled' }]);
      const rows = await svc.list();
      expect(rows.map((r) => r.posting)).toEqual(['removed', null]);
    });
  });
});

describe('findVnPhone', () => {
  it('nhận 0…/84…/+84… có dấu cách, chấm, gạch; bỏ số không phải di động VN', () => {
    expect(findVnPhone('gọi 0912345678')).toBe('0912345678');
    expect(findVnPhone('sdt: +84 912-345-678')).toBe('0912345678');
    expect(findVnPhone('84912345678')).toBe('0912345678');
    expect(findVnPhone('mã đơn 1234567890123')).toBeNull();
    expect(findVnPhone('0212345678')).toBeNull();
    expect(findVnPhone(null)).toBeNull();
  });
});
