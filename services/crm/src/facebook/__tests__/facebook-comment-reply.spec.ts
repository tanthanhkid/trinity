/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FacebookCommentsService, commentAnswered, privateReplied } from '../facebook-comments.service';
import { awaitingReply } from '../facebook-messenger.service';
import { GraphApiError } from '../graph-client';

const PAGE = { id: 1, page_id: '111', name: 'Trinity', is_active: true };
const NOW = new Date('2026-10-14T10:00:00Z');
const comment = (o: Record<string, unknown> = {}) => ({
  id: 10n, comment_id: '111_9_1', page_id: '111', post_id: '111_9', from_name: 'Lan', message: 'Giá?', status: 'received',
  actions: {}, contact_id: 77, commented_at: new Date('2026-10-13T10:00:00Z'), ...o,
});

function make(row: Record<string, unknown> | null = comment()) {
  const prisma: Record<string, any> = {
    facebookComment: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    facebookConversation: { upsert: jest.fn(async () => ({ id: 4, contact_id: null })), update: jest.fn(async () => ({})) },
    facebookMessage: { create: jest.fn(async () => ({ id: 2n })) },
    contact: { findUnique: jest.fn(async () => ({ assigned_to: 5 })) },
    integrationEvent: { create: jest.fn(async () => ({ id: 1n })) },
  };
  const graph = {
    replyToComment: jest.fn(async () => ({ id: 'r1' })),
    privateReply: jest.fn(async () => ({ message_id: 'm.1', recipient_id: 'psid1' })),
  };
  const pages = { activePageWithToken: jest.fn(async () => ({ page: PAGE, token: 'TK' })), markTokenInvalid: jest.fn() };
  const svc = new FacebookCommentsService(prisma as never, graph as never, pages as never, {} as never);
  const saved = () => (prisma.facebookComment.update.mock.calls.at(-1) as unknown as [{ data: Record<string, any> }])[0].data;
  return { svc, prisma, graph, pages, saved };
}

describe('trả lời tay bình luận', () => {
  it('công khai: gọi Graph, ghi vào actions.manual, đổi trạng thái "replied"', async () => {
    const { svc, graph, saved } = make();
    const r = await svc.replyManually('10', { text: ' Dạ giá 500k ạ ', mode: 'public' }, 5, NOW);
    expect(graph.replyToComment).toHaveBeenCalledWith('TK', '111_9_1', 'Dạ giá 500k ạ');
    expect(saved()).toMatchObject({ status: 'replied', actions: { manual: [{ mode: 'public', text: 'Dạ giá 500k ạ', id: 'r1', by: 5 }] } });
    expect(r.answered).toBe(true);
  });

  it('nhắn riêng: tạo/ghép hội thoại Messenger bằng PSID trả về', async () => {
    const { svc, graph, prisma, saved } = make();
    await svc.replyManually('10', { text: 'Em nhắn riêng ạ', mode: 'private' }, 5, NOW);
    expect(graph.privateReply).toHaveBeenCalledWith('TK', '111', '111_9_1', 'Em nhắn riêng ạ');
    expect(prisma.facebookConversation.upsert).toHaveBeenCalled();
    expect(prisma.facebookMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ mid: 'm.1', direction: 'out' }) });
    expect(saved().actions.manual[0].mode).toBe('private');
  });

  it('luật đã xử lý (done) giữ nguyên trạng thái, chỉ thêm trả lời tay', async () => {
    const { svc, saved } = make(comment({ status: 'done', actions: { public_reply: { text: 'a', id: 'x' } } }));
    await svc.replyManually('10', { text: 'Thêm', mode: 'public' }, 5, NOW);
    expect(saved().status).toBeUndefined();
    expect(saved().actions.public_reply.id).toBe('x');
  });

  it('nhắn riêng lần hai / quá 7 ngày ⇒ từ chối, không gọi Facebook', async () => {
    const twice = make(comment({ actions: { private_reply: { text: 'a', message_id: 'm.0' } } }));
    await expect(twice.svc.replyManually('10', { text: 'x', mode: 'private' }, 5, NOW)).rejects.toThrow(/một lần/);
    const old = make(comment({ commented_at: new Date('2026-10-01T00:00:00Z') }));
    await expect(old.svc.replyManually('10', { text: 'x', mode: 'private' }, 5, NOW)).rejects.toThrow(/7 ngày/);
    expect(twice.graph.privateReply).not.toHaveBeenCalled();
    expect(old.graph.privateReply).not.toHaveBeenCalled();
  });

  it('id sai / không có ⇒ 404; nội dung trống ⇒ 400', async () => {
    await expect(make().svc.replyManually('abc', { text: 'x', mode: 'public' }, 5, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(make(null).svc.replyManually('10', { text: 'x', mode: 'public' }, 5, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(make().svc.replyManually('10', { text: '  ', mode: 'public' }, 5, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Facebook từ chối ⇒ 400 có lời giải thích, không ghi gì', async () => {
    const { svc, graph, prisma } = make();
    graph.replyToComment.mockRejectedValueOnce(new GraphApiError(403, 200, null, 'Permissions error'));
    await expect(svc.replyManually('10', { text: 'x', mode: 'public' }, 5, NOW)).rejects.toThrow(/Không trả lời bình luận được/);
    expect(prisma.facebookComment.update).not.toHaveBeenCalled();
  });
});

describe('đã trả lời chưa', () => {
  it('bình luận', () => {
    expect(commentAnswered({ status: 'received', actions: {} })).toBe(false);
    expect(commentAnswered({ status: 'test', actions: { public_reply: { text: 'a' } } })).toBe(false);
    expect(commentAnswered({ status: 'failed', actions: { public_reply: { text: 'a', error: 'x' } } })).toBe(false);
    expect(commentAnswered({ status: 'done', actions: { private_reply: { text: 'a', message_id: 'm' } } })).toBe(true);
    expect(commentAnswered({ status: 'skipped', actions: {} })).toBe(true);
    expect(commentAnswered({ status: 'replied', actions: { manual: [{ mode: 'public', text: 'a', id: 'r', by: 1, at: '' }] } })).toBe(true);
    expect(privateReplied({ manual: [{ mode: 'private', text: 'a', id: 'm', by: 1, at: '' }] })).toBe(true);
  });
  it('hội thoại Messenger: tin cuối là của khách', () => {
    const t = new Date('2026-10-14T09:00:00Z');
    expect(awaitingReply({ last_inbound_at: t, last_message_at: t })).toBe(true);
    expect(awaitingReply({ last_inbound_at: t, last_message_at: new Date(t.getTime() + 1000) })).toBe(false);
    expect(awaitingReply({ last_inbound_at: null, last_message_at: t })).toBe(false);
  });
});
