import { getConversationMessagesTool, listConversationsTool } from '../tools/inbox-tools';
import { listGoogleReviewsTool, replyToGoogleReviewTool } from '../tools/google-review-tools';
import { ToolUserError } from '../tools/tool-types';

const grants = (update: boolean) => (update ? { 'contacts.update': 'all' } : {}) as never;
const principal = (update = true) => ({ userId: 7, user: { userId: 7, grants: grants(update) } }) as never;
const t0 = new Date('2026-10-15T03:00:00Z');

function deps() {
  return {
    orgFeatures: { isEnabled: jest.fn(async () => true) },
    zaloOa: {},
    prisma: {
      facebookConversation: {
        findMany: jest.fn(async () => [{ id: 12, page_id: '1', customer_name: 'An', contact_id: 3, last_message_preview: 'giá?', last_message_at: t0, last_inbound_at: t0, unread_count: 1 }]),
        findUnique: jest.fn(async () => ({ id: 12, customer_name: 'An', contact_id: 3, last_inbound_at: t0 })),
      },
      facebookPage: { findMany: jest.fn(async () => [{ page_id: '1', name: 'P' }]) },
      facebookMessage: { findMany: jest.fn(async () => [{ direction: 'out', text: 'Chào', sent_at: t0 }, { direction: 'in', text: 'giá?', sent_at: t0 }]) },
      zaloOaThread: {
        findMany: jest.fn(async () => [{ id: 5, display_name: 'Bình', contact_id: null, last_message_preview: 'hi', last_message_at: t0, last_inbound_at: null, unread_count: 0 }]),
        findUnique: jest.fn(async () => ({ id: 5, display_name: 'Bình', contact_id: null, last_inbound_at: null })),
      },
      zaloOaMessage: { findMany: jest.fn(async () => [{ direction: 'in', kind: 'image', text: null, created_at: t0 }]) },
    },
  } as any;
}
const ctx = (d: any, update = true) => ({ deps: d, baseUrl: 'https://crm.example', principal: principal(update) }) as never;

describe('list_conversations', () => {
  it('gom Messenger + Zalo, lọc theo tên', async () => {
    const d = deps();
    const r = (await listConversationsTool.run({ search: 'an' }, ctx(d))).structured as any;
    expect(r.data.messenger[0]).toMatchObject({ id: 'messenger:12', page: 'P', awaiting_reply: true, unread: 1 });
    expect(r.data.zalo_oa[0]).toMatchObject({ id: 'zalo_oa:5', awaiting_reply: false });
    expect(d.prisma.facebookConversation.findMany.mock.calls[0][0].where).toEqual({ customer_name: { contains: 'an', mode: 'insensitive' } });
  });

  it('search dạng dò chữ số ⇒ từ chối', async () => {
    await expect(listConversationsTool.run({ search: '0901' }, ctx(deps()))).rejects.toThrow(/Không hỗ trợ/);
  });

  it('không có quyền sửa khách hàng ⇒ bỏ Zalo, ghi chú', async () => {
    const r = (await listConversationsTool.run({}, ctx(deps(), false))).structured as any;
    expect(r.data.zalo_oa).toBeUndefined();
    expect(r.data.notes.join(' ')).toMatch(/Zalo/);
  });
});

describe('get_conversation_messages', () => {
  it('Messenger: cũ → mới, không đánh dấu đã đọc', async () => {
    const d = deps();
    const r = (await getConversationMessagesTool.run({ id: 'messenger:12' }, ctx(d))).structured as any;
    expect(r.data.messages.map((m: any) => m.from)).toEqual(['customer', 'business']);
    expect(d.prisma.facebookConversation.update).toBeUndefined();
  });

  it('Zalo: tin ảnh ghi kind; id sai ⇒ lỗi rõ', async () => {
    const r = (await getConversationMessagesTool.run({ id: 'zalo_oa:5' }, ctx(deps()))).structured as any;
    expect(r.data.messages[0]).toMatchObject({ from: 'customer', kind: 'image' });
    await expect(getConversationMessagesTool.run({ id: '12' }, ctx(deps()))).rejects.toBeInstanceOf(ToolUserError);
    await expect(getConversationMessagesTool.run({ id: 'zalo_oa:5' }, ctx(deps(), false))).rejects.toBeInstanceOf(ToolUserError);
  });
});

function gdeps(places = [{ id: 9, network: 'google_business', name: 'Cửa hàng' }]) {
  const posts = {
    gbpReviews: jest.fn(async () => ({ reviews: [{ id: 'r1', reviewer: 'Chi', stars: 5, comment: 'Tốt', reply: null }, { id: 'r2', reviewer: 'Dũng', stars: 3, comment: 'Ổn', reply: { comment: 'Cảm ơn', updated_at: null } }], average: 4, total: 2, next_page_token: null })),
    gbpReply: jest.fn(async () => ({})),
  };
  return { social: { posts, accounts: { list: jest.fn(async () => [...places, { id: 1, network: 'facebook', name: 'P' }]) } }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}

describe('đánh giá Google', () => {
  it('liệt kê, lọc chưa trả lời; một địa điểm thì tự chọn', async () => {
    const r = (await listGoogleReviewsTool.run({ unanswered_only: true }, ctx(gdeps()))).structured as any;
    expect(r.data.reviews.map((x: any) => x.review_id)).toEqual(['r1']);
    await expect(listGoogleReviewsTool.run({}, ctx(gdeps([])))).rejects.toThrow(/Chưa liên kết/);
  });

  it('trả lời: thiếu đồng ý ⇒ xem trước, có đồng ý ⇒ gửi', async () => {
    const d = gdeps();
    const r = (await replyToGoogleReviewTool.run({ review_id: 'r1', comment: 'Cảm ơn chị' }, ctx(d))).structured as any;
    expect(r.data.sent).toBe(false);
    expect(d.social.posts.gbpReply).not.toHaveBeenCalled();
    await replyToGoogleReviewTool.run({ review_id: 'r1', comment: 'Cảm ơn chị', confirmed_by_user: 'ok gửi đi' }, ctx(d));
    expect(d.social.posts.gbpReply).toHaveBeenCalledWith(9, 'r1', 'Cảm ơn chị', expect.anything());
  });

  it('review ở trang sau ⇒ tìm qua trang; không thấy ⇒ không cho xem trước rỗng', async () => {
    const d = gdeps();
    d.social.posts.gbpReviews
      .mockResolvedValueOnce({ reviews: [{ id: 'r1', reviewer: 'Chi', stars: 5, comment: 'Tốt', reply: null }], average: 4, total: 60, next_page_token: 'p2' })
      .mockResolvedValueOnce({ reviews: [{ id: 'r60', reviewer: 'Lan', stars: 2, comment: 'Chậm', reply: null }], average: 4, total: 60, next_page_token: null });
    const r = (await replyToGoogleReviewTool.run({ review_id: 'r60', comment: 'Xin lỗi chị' }, ctx(d))).structured as any;
    expect(r.data.preview.review.reviewer).toBe('Lan');
    expect(d.social.posts.gbpReviews).toHaveBeenLastCalledWith(9, 'p2');
    await expect(replyToGoogleReviewTool.run({ review_id: 'khong-co', comment: 'x' }, ctx(gdeps()))).rejects.toThrow(/Không tìm thấy/);
    const d2 = gdeps();
    await replyToGoogleReviewTool.run({ review_id: 'r1', comment: 'x', page_token: 'p11' }, ctx(d2));
    expect(d2.social.posts.gbpReviews).toHaveBeenCalledWith(9, 'p11');
  });
});
