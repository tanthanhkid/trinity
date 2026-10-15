/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';
import { FacebookCommentsService, fillTemplate, matchesKeywords, normalizePostId, normalizeVi } from '../facebook-comments.service';
import { GraphApiError } from '../graph-client';

const PAGE = { id: 1, page_id: '111', name: 'Trinity', default_assignee_id: 5, connected_by: 5, contact_source_id: 9, project_id: null, is_active: true };
const rule = (o: Record<string, unknown> = {}) => ({
  id: 3, name: 'Giá', page_id: null, post_id: null, keywords: ['giá'], exclude_keywords: [], public_replies: ['Đã nhắn {ten} nhé'],
  private_reply: 'Chào {ten}, giá ở đây', hide_if_phone: true, once_per_user: true, mode: 'live', is_active: true, position: 0, ...o,
});
const change = (o: Record<string, unknown> = {}) => ({ item: 'comment', verb: 'add', comment_id: '111_9_1', post_id: '111_9', from: { id: 'u1', name: 'Lan' }, message: 'Cho xin GIA', created_time: 1760000000, ...o });

function make(rules: unknown[] = [rule()], opts: { dupComment?: boolean; contactByPhone?: boolean; createErr?: unknown; convContact?: number } = {}) {
  const prisma: Record<string, any> = {
    facebookComment: {
      create: jest.fn(async () => { if (opts.createErr) throw opts.createErr; return { id: 10n }; }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => (where.rule_id && opts.dupComment ? { id: 1n } : null)),
      update: jest.fn(async () => ({})),
    },
    facebookCommentRule: { findMany: jest.fn(async () => rules) },
    contact: {
      findFirst: jest.fn(async ({ where }: { where: { id?: number } }) => (opts.contactByPhone || where.id ? { id: where.id ?? 77 } : null)),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => ({ assigned_to: 5 })),
    },
    integrationEvent: { create: jest.fn(async () => ({ id: 1n })) },
    user: { findUnique: jest.fn(async () => ({ id: 5, status: 'active', team_id: null, deleted_at: null })) },
    facebookConversation: {
      findUnique: jest.fn(async () => (opts.convContact ? { contact_id: opts.convContact } : null)),
      upsert: jest.fn(async () => ({ id: 4, contact_id: opts.convContact ?? null })),
      update: jest.fn(async () => ({})),
    },
    facebookMessage: { create: jest.fn(async () => ({ id: 2n })) },
    activity: { create: jest.fn(async () => ({})) },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma)),
  };
  const graph = {
    replyToComment: jest.fn(async () => ({ id: 'r1' })),
    privateReply: jest.fn(async () => ({ message_id: 'm.1', recipient_id: 'psid1' })),
    hideComment: jest.fn(async () => ({})),
  };
  const pages = { activePageWithToken: jest.fn(async () => ({ page: PAGE, token: 'TK' })), markTokenInvalid: jest.fn() };
  const publicApi = { createContactInTx: jest.fn(async () => ({ id: 50 })) };
  const svc = new FacebookCommentsService(prisma as never, graph as never, pages as never, publicApi as never);
  const saved = () => (prisma.facebookComment.update.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0].data;
  return { svc, prisma, graph, pages, publicApi, saved };
}

describe('so khớp và mẫu câu', () => {
  it('bỏ dấu, không phân biệt hoa thường; rỗng = mọi bình luận; loại trừ thắng', () => {
    expect(normalizeVi('  Đặt  HÀNG ')).toBe('dat hang');
    expect(matchesKeywords('cho xin GIÁ ạ', ['gia'], [])).toBe(true);
    expect(matchesKeywords('hay quá', ['giá', 'inbox'], [])).toBe(false);
    expect(matchesKeywords('gì cũng được', [], [])).toBe(true);
    expect(matchesKeywords('giá rẻ thế, lừa đảo à', ['giá'], ['lừa đảo'])).toBe(false);
    expect(matchesKeywords(null, ['  '], [])).toBe(true);
  });
  it('{ten} thay bằng tên, không có tên thì "bạn"', () => {
    expect(fillTemplate('Chào {ten}!', 'Lan')).toBe('Chào Lan!');
    expect(fillTemplate('Chào { TEN }', null)).toBe('Chào bạn');
  });
  it('link bài ⇒ id <page>_<post>; không đọc được ⇒ 400', () => {
    expect(normalizePostId('111_222', null)).toBe('111_222');
    expect(normalizePostId('https://www.facebook.com/112063448580724_1004637925993518', null)).toBe('112063448580724_1004637925993518');
    expect(normalizePostId('https://www.facebook.com/trinity/posts/1234567', '111')).toBe('111_1234567');
    expect(normalizePostId('https://www.facebook.com/permalink.php?story_fbid=987654&id=111', '111')).toBe('111_987654');
    expect(normalizePostId('', '111')).toBeNull();
    expect(() => normalizePostId('https://facebook.com/abc', '111')).toThrow(BadRequestException);
  });
});

describe('FacebookCommentsService.ingest', () => {
  it('luật thật: trả lời công khai + nhắn riêng, tạo khách, gắn hội thoại Messenger', async () => {
    const t = make();
    expect(await t.svc.ingest('111', change())).toBe(true);
    expect(t.graph.replyToComment).toHaveBeenCalledWith('TK', '111_9_1', 'Đã nhắn Lan nhé');
    expect(t.graph.privateReply).toHaveBeenCalledWith('TK', '111', '111_9_1', 'Chào Lan, giá ở đây');
    expect(t.graph.hideComment).not.toHaveBeenCalled(); // không có SĐT
    expect(t.publicApi.createContactInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ full_name: 'Lan', source_id: 9 }), { id: 5, team_id: null }, 'facebook_comment');
    expect(t.prisma.facebookConversation.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { page_id_psid: { page_id: '111', psid: 'psid1' } } }));
    expect(t.saved()).toMatchObject({ status: 'done', contact_id: 50, rule_id: 3, hidden: false });
    expect(t.prisma.activity.create).toHaveBeenCalled();
    // Webhook ra ngoài: tin nhắn riêng (Messenger, origin comment_reply) + bình luận mới (định danh, kết quả luật).
    const evs = t.prisma.integrationEvent.create.mock.calls.map((c: any) => c[0].data);
    expect(evs.map((e: any) => e.event_type)).toEqual(['messenger.message_sent', 'facebook.comment_received']);
    expect(evs[0].payload).toMatchObject({ conversation_id: 4, page_id: '111', contact_id: 50, origin: 'comment_reply' });
    expect(evs[1].payload).toEqual({ comment_id: 10, page_id: '111', post_id: '111_9', contact_id: 50, contact_assigned_to: 5, auto_reply_status: 'done' });
  });

  it('người đã nhắn Messenger trước (PSID có khách) ⇒ dùng khách đó, không tạo trùng, không đổi khách của hội thoại', async () => {
    const t = make([rule()], { convContact: 1 });
    await t.svc.ingest('111', change());
    expect(t.publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(t.saved()).toMatchObject({ contact_id: 1, status: 'done' });
    expect(t.prisma.facebookConversation.update).not.toHaveBeenCalled();
  });

  it('hội thoại mới tạo từ nhắn riêng ⇒ gắn khách vừa tạo', async () => {
    const t = make();
    await t.svc.ingest('111', change());
    expect(t.prisma.facebookConversation.update).toHaveBeenCalledWith({ where: { id: 4 }, data: { contact_id: 50 } });
  });

  it('luật thử: không gửi gì ra Facebook, chỉ ghi lại', async () => {
    const t = make([rule({ mode: 'test' })]);
    await t.svc.ingest('111', change());
    expect(t.graph.replyToComment).not.toHaveBeenCalled();
    expect(t.graph.privateReply).not.toHaveBeenCalled();
    expect(t.saved()).toMatchObject({ status: 'test' });
  });

  it('có SĐT: ghép khách cũ theo số, điền số, ẩn bình luận', async () => {
    const t = make([rule()], { contactByPhone: true });
    await t.svc.ingest('111', change({ message: 'giá sao, gọi 0912 345 678' }));
    expect(t.publicApi.createContactInTx).not.toHaveBeenCalled();
    expect(t.graph.hideComment).toHaveBeenCalledWith('TK', '111_9_1');
    expect(t.saved()).toMatchObject({ contact_id: 77, hidden: true });
    expect((t.saved().actions as Record<string, unknown>).phone_saved).toBe(true);
  });

  it('bình luận của chính Page, sự kiện không phải bình luận mới, Meta gửi lại ⇒ bỏ qua', async () => {
    const t = make();
    expect(await t.svc.ingest('111', change({ from: { id: '111', name: 'Trinity' } }))).toBe(false);
    expect(await t.svc.ingest('111', change({ verb: 'edited' }))).toBe(false);
    expect(await t.svc.ingest('111', change({ item: 'reaction' }))).toBe(false);
    expect(t.prisma.facebookComment.create).not.toHaveBeenCalled();
    const dup = make([rule()], { createErr: Object.assign(new Error('dup'), { code: 'P2002' }) });
    expect(await dup.svc.ingest('111', change())).toBe(false);
    expect(dup.graph.replyToComment).not.toHaveBeenCalled();
  });

  it('mỗi người một lần mỗi bài', async () => {
    const t = make([rule()], { dupComment: true });
    await t.svc.ingest('111', change());
    expect(t.graph.replyToComment).not.toHaveBeenCalled();
    expect(t.saved()).toMatchObject({ status: 'skipped' });
  });

  it('không luật nào khớp ⇒ received, vẫn tạo khách', async () => {
    const t = make([rule({ keywords: ['inbox'] })]);
    await t.svc.ingest('111', change());
    expect(t.graph.replyToComment).not.toHaveBeenCalled();
    expect(t.saved()).toMatchObject({ status: 'received', rule_id: null, contact_id: 50 });
  });

  it('Facebook từ chối hết ⇒ failed, token hỏng thì đánh dấu Page', async () => {
    const t = make();
    const tokenErr = new GraphApiError(401, 190, null, 'expired');
    t.graph.replyToComment.mockRejectedValueOnce(tokenErr);
    t.graph.privateReply.mockRejectedValueOnce(tokenErr);
    await t.svc.ingest('111', change());
    expect(t.saved()).toMatchObject({ status: 'failed' });
    expect(String(t.saved().note)).toMatch(/kết nối lại Fanpage/);
    expect(t.pages.markTokenInvalid).toHaveBeenCalledWith('111');
  });
});

describe('dryRun', () => {
  it('không ghi, không gửi', async () => {
    const t = make();
    (t.prisma as unknown as { facebookPage: unknown }).facebookPage = { findFirst: jest.fn(async () => ({ page_id: '111' })), findUnique: jest.fn() };
    const r = await t.svc.dryRun({ message: 'giá? 0912345678', from_name: 'Lan' });
    expect(r.matched_rule).toEqual({ id: 3, name: 'Giá', mode: 'live' });
    expect(r.phone_found).toBe('0912345678');
    expect(r.actions).toMatchObject({ public_reply: { text: 'Đã nhắn Lan nhé' }, hide: {} });
    expect(t.graph.replyToComment).not.toHaveBeenCalled();
    expect(t.prisma.facebookComment.create).not.toHaveBeenCalled();
  });
});
