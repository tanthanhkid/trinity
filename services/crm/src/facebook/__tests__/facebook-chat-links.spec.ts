import { BadRequestException } from '@nestjs/common';
import { encryptSecret } from '../../integrations/webhooks/secret-crypto';
import { signMetaBody } from '../facebook-signature';
import { FacebookChatLinksService, messengerUrl, newLinkCode } from '../facebook-chat-links.service';
import { FacebookMessengerService, referralRef } from '../facebook-messenger.service';
import { FacebookWebhookService } from '../facebook-webhook.service';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PAGE = { id: 1, page_id: '111', name: 'Trinity', default_assignee_id: 5, contact_source_id: 9, project_id: null, is_active: true, connected_by: 6, token_enc: '' };
const LINK = { id: 4, code: 'abcd2345', name: 'Tờ rơi quán', page_id: '111', source_id: 12, is_active: true, clicks: 0, chats: 0, created_by: 5 };

beforeAll(() => {
  process.env.INTEGRATIONS_SECRET_KEY = KEY;
  process.env.FACEBOOK_APP_ID = 'app';
  process.env.FACEBOOK_APP_SECRET = 'appsecret';
  process.env.INTEGRATIONS_PUBLIC_BASE_URL = 'https://crm.example.vn';
  PAGE.token_enc = encryptSecret('PAGE_TOKEN', Buffer.from(KEY, 'base64'));
});

describe('referralRef', () => {
  it('đọc ref ở referral / postback.referral / message.referral; tin echo ⇒ null', () => {
    expect(referralRef({ referral: { ref: 'abc', source: 'SHORTLINK' } })).toBe('abc');
    expect(referralRef({ postback: { payload: 'GET_STARTED', referral: { ref: 'xyz' } } })).toBe('xyz');
    expect(referralRef({ message: { mid: 'm1', referral: { ref: ' q1 ' } } })).toBe('q1');
    expect(referralRef({ message: { mid: 'm1', is_echo: true, referral: { ref: 'abc' } } })).toBeNull();
    expect(referralRef({ message: { mid: 'm1', text: 'hi' } })).toBeNull();
  });
});

describe('FacebookMessengerService.ingestReferral', () => {
  const mk = () => {
    const prisma = {
      facebookChatLink: { findUnique: jest.fn().mockResolvedValue(LINK), update: jest.fn() },
      facebookConversation: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 3, psid: 'u1', contact_id: null, customer_name: 'Khách A' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      contact: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 5, status: 'active', team_id: 2, deleted_at: null }) },
      activity: { create: jest.fn() },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const graph = { getUserName: jest.fn().mockResolvedValue('Khách A'), getConversationName: jest.fn().mockResolvedValue(null) };
    const pages = { activePageWithToken: jest.fn().mockResolvedValue({ page: PAGE, token: 'PAGE_TOKEN' }) };
    const publicApi = { createContactInTx: jest.fn().mockResolvedValue({ id: 77 }) };
    return { prisma, publicApi, svc: new FacebookMessengerService(prisma as never, graph as never, pages as never, publicApi as never) };
  };
  const ev = { sender: { id: 'u1' }, recipient: { id: '111' }, timestamp: 1_700_000_000_000, referral: { ref: 'abcd2345', source: 'SHORTLINK', type: 'OPEN_THREAD' } };

  it('người mới qua link: tạo hội thoại gắn link, tăng số khách vào chat, tạo khách với NGUỒN CỦA LINK, ghi lịch sử', async () => {
    const { svc, prisma, publicApi } = mk();
    expect(await svc.ingestReferral('111', ev)).toBe(true);
    expect(prisma.facebookConversation.updateMany).toHaveBeenCalledWith({ where: { id: 3, entry_link_id: null }, data: { entry_link_id: 4 } });
    expect(prisma.facebookChatLink.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { chats: { increment: 1 } } });
    expect(publicApi.createContactInTx.mock.calls[0][1]).toMatchObject({ full_name: 'Khách A', source_id: 12, phone: '' });
    expect(prisma.activity.create.mock.calls[0][0].data.details.description).toBe('Khách mở chat Page "Trinity" qua link "Tờ rơi quán"');
  });

  it('link không đặt nguồn ⇒ khách mới mang nguồn mặc định của Page', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.facebookChatLink.findUnique.mockResolvedValueOnce({ ...LINK, source_id: null });
    await svc.ingestReferral('111', ev);
    expect(publicApi.createContactInTx.mock.calls[0][1].source_id).toBe(9);
  });

  it('mã của Page khác / link tắt / không có mã ⇒ bỏ qua', async () => {
    const { svc, prisma } = mk();
    prisma.facebookChatLink.findUnique.mockResolvedValueOnce({ ...LINK, page_id: '222' });
    expect(await svc.ingestReferral('111', ev)).toBe(false);
    prisma.facebookChatLink.findUnique.mockResolvedValueOnce({ ...LINK, is_active: false });
    expect(await svc.ingestReferral('111', ev)).toBe(false);
    expect(await svc.ingestReferral('111', { sender: { id: 'u1' }, message: { mid: 'm1', text: 'hi' } })).toBe(false);
    expect(prisma.facebookConversation.upsert).not.toHaveBeenCalled();
  });

  it('hội thoại đã gắn link (Meta gửi lại) ⇒ không đếm lại, không ghi thêm', async () => {
    const { svc, prisma } = mk();
    prisma.facebookConversation.findUnique.mockResolvedValueOnce({ entry_link_id: 4 });
    expect(await svc.ingestReferral('111', ev)).toBe(false);
    prisma.facebookConversation.updateMany.mockResolvedValueOnce({ count: 0 }); // đua: lượt khác vừa gắn
    expect(await svc.ingestReferral('111', ev)).toBe(false);
    expect(prisma.facebookChatLink.update).not.toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('tin đầu tới trước referral (khách đã tạo với nguồn Page) ⇒ đổi sang nguồn của link nếu khách vừa tạo, không tạo khách mới', async () => {
    const { svc, prisma, publicApi } = mk();
    prisma.facebookConversation.findUnique.mockResolvedValueOnce({ entry_link_id: null });
    prisma.facebookConversation.upsert.mockResolvedValueOnce({ id: 3, psid: 'u1', contact_id: 50, customer_name: 'Khách A' });
    expect(await svc.ingestReferral('111', ev)).toBe(true);
    const arg = prisma.contact.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ id: 50, source_id: 9 });
    expect(arg.where.created_at.gte).toBeInstanceOf(Date);
    expect(arg.data).toEqual({ source_id: 12 });
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(prisma.activity.create.mock.calls[0][0].data.contact_id).toBe(50);
  });
});

describe('FacebookChatLinksService', () => {
  const mk = () => {
    const prisma = {
      facebookChatLink: {
        findMany: jest.fn().mockResolvedValue([LINK]),
        findUnique: jest.fn().mockResolvedValue(LINK),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 9, clicks: 0, chats: 0, ...data })),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...LINK, ...data })),
        delete: jest.fn(),
      },
      facebookConversation: { updateMany: jest.fn() },
      facebookPage: { findUnique: jest.fn().mockResolvedValue({ id: 1 }), findMany: jest.fn().mockResolvedValue([{ page_id: '111', name: 'Trinity' }]) },
      settingOption: { findFirst: jest.fn().mockResolvedValue({ id: 12 }), findMany: jest.fn().mockResolvedValue([{ id: 12, label: 'Tờ rơi' }]) },
      $transaction: jest.fn(),
    };
    return { prisma, svc: new FacebookChatLinksService(prisma as never) };
  };

  it('mã link: 8 ký tự, không có ký tự dễ nhầm (0 o 1 l i)', () => {
    for (let i = 0; i < 50; i++) expect(newLinkCode()).toMatch(/^[a-hjkmnp-z2-9]{8}$/);
    expect(messengerUrl('111', 'abc')).toBe('https://m.me/111?ref=abc');
  });

  it('danh sách: link qua Trinity (đếm lượt mở), link Messenger, tên Page, nhãn nguồn', async () => {
    const { svc } = mk();
    const [l] = await svc.list();
    expect(l).toMatchObject({ url: 'https://crm.example.vn/api/v1/facebook/go/abcd2345', messenger_url: 'https://m.me/111?ref=abcd2345', page_name: 'Trinity', source_label: 'Tờ rơi' });
  });

  it('tạo: bắt buộc tên + Page đã kết nối; nguồn phải thuộc nhóm contact_source', async () => {
    const { svc, prisma } = mk();
    await expect(svc.create({ name: ' ', page_id: '111' }, 5)).rejects.toThrow(BadRequestException);
    prisma.facebookPage.findUnique.mockResolvedValueOnce(null);
    await expect(svc.create({ name: 'QR bàn 5', page_id: '999' }, 5)).rejects.toThrow('Chọn Fanpage đã kết nối');
    prisma.settingOption.findFirst.mockResolvedValueOnce(null);
    await expect(svc.create({ name: 'QR bàn 5', page_id: '111', source_id: 3 }, 5)).rejects.toThrow('Nguồn khách không hợp lệ');
    const l = await svc.create({ name: 'QR bàn 5', page_id: '111', source_id: 12 }, 5);
    expect(prisma.facebookChatLink.create.mock.calls[0][0].data).toMatchObject({ name: 'QR bàn 5', page_id: '111', source_id: 12, created_by: 5, is_active: true });
    expect(l.url).toMatch(/^https:\/\/crm\.example\.vn\/api\/v1\/facebook\/go\/[a-z2-9]{8}$/);
  });

  it('mở link: đếm lượt rồi chuyển m.me kèm ref; link tắt ⇒ Messenger không ref, không đếm; mã lạ ⇒ null', async () => {
    const { svc, prisma } = mk();
    expect(await svc.open('abcd2345')).toBe('https://m.me/111?ref=abcd2345');
    expect(prisma.facebookChatLink.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { clicks: { increment: 1 } } });
    prisma.facebookChatLink.update.mockClear();
    prisma.facebookChatLink.findUnique.mockResolvedValueOnce({ ...LINK, is_active: false });
    expect(await svc.open('abcd2345')).toBe('https://m.me/111');
    expect(prisma.facebookChatLink.update).not.toHaveBeenCalled();
    prisma.facebookChatLink.findUnique.mockResolvedValueOnce(null);
    expect(await svc.open('khongco')).toBeNull();
  });
});

describe('FacebookWebhookService + link mở chat', () => {
  it('sự kiện có ref: xử lý referral TRƯỚC tin nhắn cùng sự kiện', async () => {
    const order: string[] = [];
    const messenger = {
      ingestReferral: jest.fn().mockImplementation(async () => { order.push('ref'); return true; }),
      ingest: jest.fn().mockImplementation(async () => { order.push('msg'); return true; }),
    };
    const svc = new FacebookWebhookService(messenger as never, {} as never, {} as never, { handleEvent: jest.fn().mockResolvedValue(false) } as never, { isEnabled: jest.fn().mockResolvedValue(true) } as never, { facebookPage: { findMany: jest.fn().mockResolvedValue([{ page_id: '111' }]) } } as never);
    const p = { object: 'page', entry: [{ id: '111', messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', text: 'hi', referral: { ref: 'abcd2345' } } }] }] };
    const raw = Buffer.from(JSON.stringify(p));
    expect(await svc.receive(raw, signMetaBody(raw, 'appsecret'), p)).toBe(2);
    expect(order).toEqual(['ref', 'msg']);
  });
});
