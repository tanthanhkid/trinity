/* eslint-disable @typescript-eslint/no-explicit-any */
import { listUnansweredMessagesTool, replyToCustomerTool } from '../tools/inbox-tools';

const recent = () => new Date(Date.now() - 60 * 60 * 1000);
const old = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
/** Tin cuối là của khách: hai mốc PHẢI bằng nhau (gọi `recent()` hai lần lệch nhau 1 ms ⇒ test chập chờn trên CI). */
const sameMoment = () => {
  const t = recent();
  return { last_inbound_at: t, last_message_at: t };
};

function deps(o: { zalo?: boolean; features?: Record<string, boolean> } = {}) {
  const features = { facebook_page: true, zalo_oa: true, ...o.features };
  return {
    orgFeatures: { isEnabled: jest.fn(async (k: string) => features[k as keyof typeof features] ?? false) },
    facebookMessenger: {
      listConversations: jest.fn(async () => [{ id: 3, customer_name: 'Lan', page_name: 'Trinity', last_message_preview: 'Giá?', last_inbound_at: recent(), can_reply: true, contact_id: 7 }]),
      reply: jest.fn(async () => ({})),
      syncConversation: jest.fn(async () => 0),
    },
    facebookComments: {
      listComments: jest.fn(async () => [{ id: '10', from_name: 'Minh', page_name: 'Trinity', message: 'ib', commented_at: recent(), post_id: '111_9', can_private_reply: true, contact_id: null }]),
      replyManually: jest.fn(async () => ({})),
    },
    zaloOa: o.zalo === false ? undefined : { sendText: jest.fn(async () => ({ message_id: 'z1' })) },
    prisma: {
      zaloOaThread: {
        findMany: jest.fn(async () => [
          { id: 5, display_name: 'Hoa', last_message_preview: 'Chào', ...sameMoment(), contact_id: null },
          { id: 6, display_name: 'Đã trả lời', last_message_preview: 'ok', last_inbound_at: old(), last_message_at: recent(), contact_id: null },
        ]),
        findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, display_name: 'Hoa', last_inbound_at: where.id === 9 ? old() : recent() })),
      },
      facebookConversation: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, customer_name: 'Lan', last_inbound_at: where.id === 9 ? old() : recent() })) },
      facebookComment: { findUnique: jest.fn(async () => ({ id: 10n, from_name: 'Minh', message: 'ib', actions: {}, commented_at: recent() })) },
    },
  } as any;
}
const ctx = (d: any, grants: Record<string, string> = { 'contacts.update': 'all' }) => ({ deps: d, baseUrl: 'https://crm.test', principal: { userId: 5, user: { userId: 5, grants } } as any });
const data = (r: any) => r.structured.data;

describe('list_unanswered_messages', () => {
  it('gom Messenger, bình luận, Zalo OA (chỉ thread có tin cuối của khách)', async () => {
    const d = deps();
    const out = data(await listUnansweredMessagesTool.run({}, ctx(d)));
    expect(out.messenger[0]).toMatchObject({ id: 'messenger:3', customer: 'Lan', can_reply: true });
    expect(out.facebook_comment[0]).toMatchObject({ id: 'facebook_comment:10', can_private_reply: true, post_link: 'https://www.facebook.com/111_9' });
    expect(out.zalo_oa.map((t: any) => t.id)).toEqual(['zalo_oa:5']);
    expect(d.facebookMessenger.listConversations).toHaveBeenCalledWith(20, { unanswered: true });
  });
  it('thiếu quyền sửa khách ⇒ không lộ hộp thư Zalo, ghi chú lý do', async () => {
    const out = data(await listUnansweredMessagesTool.run({ channel: 'zalo_oa' }, ctx(deps(), {})));
    expect(out.zalo_oa).toBeUndefined();
    expect(out.notes.join(' ')).toMatch(/quyền sửa khách/);
  });
});

describe('reply_to_customer', () => {
  it('chưa có lời đồng ý ⇒ chỉ xem trước, không gửi', async () => {
    const d = deps();
    const out = data(await replyToCustomerTool.run({ id: 'messenger:3', text: 'Dạ' }, ctx(d)));
    expect(out.sent).toBe(false);
    expect(d.facebookMessenger.reply).not.toHaveBeenCalled();
  });
  it('có lời đồng ý ⇒ gửi đúng kênh', async () => {
    const d = deps();
    await replyToCustomerTool.run({ id: 'messenger:3', text: 'Dạ', confirmed_by_user: 'ok gửi đi' }, ctx(d));
    expect(d.facebookMessenger.reply).toHaveBeenCalledWith(3, 'Dạ', expect.objectContaining({ userId: 5 }));
    await replyToCustomerTool.run({ id: 'facebook_comment:10', text: 'Dạ', comment_mode: 'private', confirmed_by_user: 'ok gửi đi' }, ctx(d));
    expect(d.facebookComments.replyManually).toHaveBeenCalledWith('10', { text: 'Dạ', mode: 'private' }, 5);
    await replyToCustomerTool.run({ id: 'zalo_oa:5', text: 'Dạ', confirmed_by_user: 'ok gửi đi' }, ctx(d));
    expect(d.zaloOa.sendText).toHaveBeenCalledWith(5, 'Dạ', 5);
  });
  it('ngoài cửa sổ kênh / id sai ⇒ báo lỗi, không gửi', async () => {
    const d = deps();
    await expect(replyToCustomerTool.run({ id: 'messenger:9', text: 'Dạ', confirmed_by_user: 'ok gửi đi' }, ctx(d))).rejects.toThrow(/24 giờ/);
    await expect(replyToCustomerTool.run({ id: 'zalo_oa:9', text: 'Dạ', confirmed_by_user: 'ok gửi đi' }, ctx(d))).rejects.toThrow(/48 giờ/);
    await expect(replyToCustomerTool.run({ id: 'x:1', text: 'Dạ' }, ctx(d))).rejects.toThrow(/id không hợp lệ/);
    expect(d.facebookMessenger.reply).not.toHaveBeenCalled();
    // Hỏi lại Facebook trước khi chặn (tin khách có thể chưa về qua webhook).
    expect(d.facebookMessenger.syncConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), true);
    expect(d.zaloOa.sendText).not.toHaveBeenCalled();
  });
});
