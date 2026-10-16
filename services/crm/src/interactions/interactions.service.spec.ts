import { InteractionsService } from './interactions.service';

const T = (h: number) => new Date(Date.UTC(2026, 9, 16, h));
function make(opts: { features?: Record<string, boolean>; comments?: any[]; convs?: any[]; threads?: any[] } = {}) {
  const prisma: any = {
    facebookComment: { findMany: jest.fn(async () => opts.comments ?? []), count: jest.fn(async () => 2) },
    facebookConversation: { findMany: jest.fn(async () => opts.convs ?? []) },
    zaloOaThread: { findMany: jest.fn(async () => opts.threads ?? []) },
    facebookPage: { findMany: jest.fn(async () => [{ page_id: 'p1', name: 'AiiLab' }]) },
    facebookCommentRule: { findMany: jest.fn(async () => [{ id: 1, name: 'Ảnh bìa' }]) },
    facebookMessage: { count: jest.fn(async () => 4) },
    zaloOaMessage: { count: jest.fn(async () => 1) },
  };
  const features: any = { get: jest.fn(async () => ({ inbox: true, facebook_page: true, zalo_oa: true, ...(opts.features ?? {}) })) };
  return { svc: new InteractionsService(prisma, features), prisma };
}
const ALL = { 'integrations.webhooks': true, 'contacts.update': 'all' } as any;
const comment = (o: any = {}) => ({ id: 9n, page_id: 'p1', post_id: 'p1_5', from_name: 'Thành', message: 'Học thử?', commented_at: T(7), contact_id: 280, rule_id: 1, status: 'done', actions: { public_reply: { text: 'x', id: 'r1' }, private_reply: { text: 'y', message_id: 'm1' } }, hidden: false, ...o });

describe('InteractionsService', () => {
  it('gộp bình luận + Messenger + Zalo, mới nhất trước; trạng thái auto/staff/unanswered/answered', async () => {
    const { svc } = make({
      comments: [comment(), comment({ id: 10n, commented_at: T(3), rule_id: null, status: 'received', actions: {} }), comment({ id: 11n, commented_at: T(2), rule_id: null, status: 'received', actions: { manual: [{ mode: 'public', text: 'ok', id: 'r', by: 1, at: '' }] } })],
      convs: [{ id: 3, page_id: 'p1', customer_name: 'Lan', contact_id: 5, last_message_preview: 'giá?', last_message_at: T(6), last_inbound_at: T(6) }],
      threads: [{ id: 8, display_name: 'Hoa', contact_id: null, last_message_preview: 'cảm ơn', last_message_at: T(5), last_inbound_at: T(4) }],
    });
    const r = await svc.list(ALL);
    expect(r.data.map((i) => [i.key, i.status])).toEqual([
      ['fb-comment:9', 'auto'], ['fb-conv:3', 'unanswered'], ['zalo-thread:8', 'answered'], ['fb-comment:10', 'unanswered'], ['fb-comment:11', 'staff'],
    ]);
    expect(r.data[0]).toMatchObject({ channel_name: 'AiiLab', rule_name: 'Ảnh bìa', post_url: 'https://www.facebook.com/p1_5', auto_result: 'Luật "Ảnh bìa": đã trả lời công khai, đã nhắn riêng' });
  });

  it('lọc chưa trả lời; theo quyền/công tắc thì không truy vấn kênh đó', async () => {
    const a = make({ comments: [comment(), comment({ id: 10n, rule_id: null, status: 'received', actions: {} })] });
    expect((await a.svc.list(ALL, { status: 'unanswered' })).data.map((i) => i.key)).toEqual(['fb-comment:10']);
    const b = make({ features: { zalo_oa: false } });
    await b.svc.list({ 'contacts.update': 'all' } as any);
    expect(b.prisma.facebookComment.findMany).not.toHaveBeenCalled();
    expect(b.prisma.zaloOaThread.findMany).not.toHaveBeenCalled();
  });

  it('sources: Fanpage tắt hoặc Hộp thư tắt ⇒ không thấy Facebook', async () => {
    expect((await make({ features: { facebook_page: false } }).svc.sources(ALL)).facebook).toBe(false)
    expect((await make({ features: { inbox: false } }).svc.sources(ALL)).facebook).toBe(false)
    expect((await make().svc.sources(ALL)).facebook).toBe(true)
  });

  it('số hôm nay', async () => {
    const { svc } = make();
    const s = await svc.stats(ALL, T(8));
    expect(s).toMatchObject({ messages_today: 5, comments_today: 2, auto_handled_today: 2 });
  });
});
