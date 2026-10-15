import { BadRequestException, NotFoundException } from '@nestjs/common';
import { can } from '@trinity/rbac';
import { wrapData } from '../ai-output';
import { isUserConfirmation } from '../actions/user-confirmation';
import { isWithinMessagingWindow } from '../../../facebook/channel';
import { PRIVATE_REPLY_WINDOW_MS, postLink, privateReplied } from '../../../facebook/facebook-comments.service';
import { ZaloOaMessagingService } from '../../../zalo-oa/zalo-oa-messaging.service';
import { vnIso } from './ai-activity-tool';
import { ToolUserError, rejectDigitProbe, type McpDeps, type ToolDef } from './tool-types';

/**
 * Hộp thư chung cho AI: tin/bình luận khách CHƯA ai trả lời trên Messenger, bình luận Fanpage, Zalo OA — và trả lời từ đó.
 * Trả lời đi thẳng tới khách ⇒ hai bước (xem trước → `confirmed_by_user`). Giữ luật kênh: Messenger 24 giờ, Zalo OA 48 giờ,
 * nhắn riêng bình luận 1 lần trong 7 ngày.
 */
const INBOX_URL = '/settings?tab=integrations&muc=facebook';
const SINCE_MS = 7 * 24 * 60 * 60 * 1000;

const canZalo = (grants: Parameters<typeof can>[0]) => can(grants, 'contacts.update');

async function zaloOn(deps: Pick<McpDeps, 'zaloOa' | 'orgFeatures'>): Promise<boolean> {
  return Boolean(deps.zaloOa) && (await deps.orgFeatures.isEnabled('zalo_oa'));
}

export const listUnansweredMessagesTool: ToolDef = {
  name: 'list_unanswered_messages',
  title: 'Tin và bình luận khách chưa trả lời / List unanswered customer messages',
  description:
    'Tin nhắn và bình luận của khách CHƯA ai trả lời, gom từ: Messenger của Fanpage (channel = messenger), bình luận dưới bài Fanpage (channel = facebook_comment, 7 ngày gần nhất), Zalo OA (channel = zalo_oa, cần quyền sửa khách hàng). ' +
    'Mỗi mục có id (dùng cho reply_to_customer), tên khách, nội dung gần nhất, thời điểm, can_reply (còn trong cửa sổ kênh cho phép trả lời: Messenger 24 giờ, Zalo OA 48 giờ), reply_deadline, contact_url. ' +
    'Bình luận có can_private_reply (còn nhắn riêng được: 1 lần, trong 7 ngày). Chỉ đọc. / ' +
    'Customer messages and comments nobody has answered yet across Messenger, Facebook Page comments (last 7 days) and Zalo OA, with ids for reply_to_customer and whether the channel still allows a reply. Read-only.',
  permissions: ['integrations.webhooks'],
  input: (z) => ({
    channel: z.enum(['messenger', 'facebook_comment', 'zalo_oa']).optional().describe('Chỉ một kênh; bỏ trống = tất cả / Only this channel'),
    limit: z.number().int().min(1).max(50).optional().describe('Tối đa mỗi kênh (mặc định 20) / Max per channel'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const want = (c: string) => !args.channel || args.channel === c;
    const contactUrl = (id: number | null) => (id ? `${baseUrl}/contacts/${id}` : null);
    const fbOn = await deps.orgFeatures.isEnabled('facebook_page');
    const out: Record<string, unknown> = {};
    const notes: string[] = [];

    if (want('messenger')) {
      if (!fbOn || !deps.facebookMessenger) notes.push('Messenger: tính năng Fanpage đang tắt hoặc chưa có trên máy chủ.');
      else {
        const rows = await deps.facebookMessenger.listConversations(limit, { unanswered: true });
        out.messenger = rows.map((c) => ({
          id: `messenger:${c.id}`,
          customer: c.customer_name,
          page: c.page_name,
          last_message: c.last_message_preview,
          at: c.last_inbound_at ? vnIso(c.last_inbound_at) : null,
          can_reply: c.can_reply,
          reply_deadline: c.last_inbound_at ? vnIso(new Date(c.last_inbound_at.getTime() + 24 * 3600 * 1000)) : null,
          contact_url: contactUrl(c.contact_id),
        }));
      }
    }
    if (want('facebook_comment')) {
      if (!fbOn || !deps.facebookComments) notes.push('Bình luận Fanpage: tính năng Fanpage đang tắt hoặc chưa có trên máy chủ.');
      else {
        const rows = await deps.facebookComments.listComments({ limit, unanswered: true, since: new Date(Date.now() - SINCE_MS) });
        out.facebook_comment = rows.map((r) => ({
          id: `facebook_comment:${r.id}`,
          customer: r.from_name,
          page: r.page_name,
          message: r.message,
          at: vnIso(r.commented_at),
          post_link: /^\d+_\d+$/.test(r.post_id) ? postLink(r.post_id) : null,
          can_reply: true,
          can_private_reply: r.can_private_reply,
          contact_url: contactUrl(r.contact_id),
        }));
      }
    }
    if (want('zalo_oa')) {
      if (!(await zaloOn(deps))) notes.push('Zalo OA: tính năng đang tắt hoặc chưa kết nối.');
      else if (!canZalo(principal.user.grants)) notes.push('Zalo OA: cần quyền sửa khách hàng để xem hộp thư Zalo.');
      else {
        const rows = await deps.prisma.zaloOaThread.findMany({ where: { last_inbound_at: { not: null } }, orderBy: { last_message_at: 'desc' }, take: 300 });
        out.zalo_oa = rows
          .filter((t) => t.last_inbound_at && (!t.last_message_at || t.last_inbound_at.getTime() >= t.last_message_at.getTime()))
          .slice(0, limit)
          .map((t) => ({
            id: `zalo_oa:${t.id}`,
            customer: t.display_name,
            last_message: t.last_message_preview,
            at: vnIso(t.last_inbound_at as Date),
            can_reply: ZaloOaMessagingService.inConsultWindow(t.last_inbound_at),
            reply_deadline: vnIso(new Date((t.last_inbound_at as Date).getTime() + 48 * 3600 * 1000)),
            contact_url: contactUrl(t.contact_id),
          }));
      }
    }
    const res = wrapData({ ...out, notes, manage_url: `${baseUrl}${INBOX_URL}` });
    return { structured: res, text: JSON.stringify(res) };
  },
};

export const replyToCustomerTool: ToolDef = {
  name: 'reply_to_customer',
  title: 'Trả lời khách (Messenger, bình luận, Zalo OA) / Reply to a customer',
  description:
    'Trả lời một tin/bình luận lấy từ list_unanswered_messages hoặc list_conversations (id dạng messenger:12, facebook_comment:34, zalo_oa:5). ' +
    'Bình luận: comment_mode = public (trả lời dưới bình luận, ai cũng thấy) hoặc private (nhắn riêng qua Messenger — Facebook chỉ cho 1 lần mỗi bình luận, trong 7 ngày). ' +
    'Luật kênh: Messenger chỉ trả lời trong 24 giờ kể từ tin cuối của khách; Zalo OA trong 48 giờ — quá hạn thì máy chủ từ chối, báo người dùng. ' +
    'Bước 1: gọi KHÔNG có confirmed_by_user ⇒ không gửi gì, trả bản xem trước. Đưa người dùng xem nội dung. Bước 2: người dùng đồng ý thì gọi lại y hệt, thêm confirmed_by_user = câu đồng ý chép nguyên văn. Cần scope crm.write. / ' +
    'Replies to a Messenger conversation, a Facebook Page comment (public or one-time private reply) or a Zalo OA thread. Call once without confirmed_by_user for a preview, then again with the user approval verbatim.',
  permissions: ['integrations.webhooks'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: (z) => ({
    id: z.string().max(60).describe('id từ list_unanswered_messages, vd messenger:12 / Item id'),
    text: z.string().min(1).max(2000).describe('Nội dung trả lời / Reply text'),
    comment_mode: z.enum(['public', 'private']).optional().describe('Chỉ cho bình luận: public (mặc định) hoặc private / For comments only'),
    confirmed_by_user: z.string().max(300).optional().describe('Lời người dùng đồng ý gửi, chép nguyên văn; bỏ trống ở lần gọi đầu / User approval verbatim; omit for preview'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const m = /^(messenger|facebook_comment|zalo_oa):(\d{1,19})$/.exec(String(args.id ?? '').trim());
    if (!m) throw new ToolUserError('id không hợp lệ — lấy id từ list_unanswered_messages (vd messenger:12). / Invalid id.');
    const [, channel, rawId] = m;
    const text = String(args.text ?? '').trim();
    const mode = args.comment_mode === 'private' ? 'private' : 'public';
    let preview: Record<string, unknown>;
    if (channel === 'messenger') {
      if (!deps.facebookMessenger || !(await deps.orgFeatures.isEnabled('facebook_page'))) throw new ToolUserError('Messenger chưa bật trên máy chủ này. / Messenger is not available.');
      const c = await deps.prisma.facebookConversation.findUnique({ where: { id: Number(rawId) } });
      if (!c) throw new ToolUserError('Không tìm thấy hội thoại. / Conversation not found.');
      if (!isWithinMessagingWindow(c.last_inbound_at)) throw new ToolUserError('Đã quá 24 giờ kể từ tin cuối của khách — Messenger không cho gửi. / Outside the 24-hour window.');
      preview = { channel, customer: c.customer_name, text };
    } else if (channel === 'facebook_comment') {
      if (!deps.facebookComments || !(await deps.orgFeatures.isEnabled('facebook_page'))) throw new ToolUserError('Bình luận Fanpage chưa bật trên máy chủ này. / Facebook comments are not available.');
      const c = await deps.prisma.facebookComment.findUnique({ where: { id: BigInt(rawId) } });
      if (!c) throw new ToolUserError('Không tìm thấy bình luận. / Comment not found.');
      if (mode === 'private' && (privateReplied(c.actions) || Date.now() - c.commented_at.getTime() > PRIVATE_REPLY_WINDOW_MS)) {
        throw new ToolUserError('Không nhắn riêng được nữa (đã nhắn 1 lần hoặc quá 7 ngày) — dùng comment_mode = public. / Private reply no longer allowed.');
      }
      preview = { channel, customer: c.from_name, comment: c.message, comment_mode: mode, text };
    } else {
      if (!(await zaloOn(deps)) || !deps.zaloOa) throw new ToolUserError('Zalo OA chưa bật hoặc chưa kết nối. / Zalo OA is not available.');
      if (!canZalo(principal.user.grants)) throw new ToolUserError('Cần quyền sửa khách hàng để nhắn Zalo OA. / Missing contacts.update permission.');
      const t = await deps.prisma.zaloOaThread.findUnique({ where: { id: Number(rawId) } });
      if (!t) throw new ToolUserError('Không tìm thấy hội thoại Zalo. / Zalo thread not found.');
      if (!ZaloOaMessagingService.inConsultWindow(t.last_inbound_at)) throw new ToolUserError('Đã quá 48 giờ kể từ tin cuối của khách — Zalo không cho gửi tin tư vấn. / Outside the 48-hour window.');
      preview = { channel, customer: t.display_name, text };
    }
    if (!isUserConfirmation(args.confirmed_by_user)) {
      const out = wrapData({ sent: false, preview, next_step: 'CHƯA GỬI. Đưa người dùng xem nội dung sẽ gửi; người dùng đồng ý thì gọi lại với confirmed_by_user.' });
      return { structured: out, text: JSON.stringify(out) };
    }
    try {
      if (channel === 'messenger') await deps.facebookMessenger!.reply(Number(rawId), text, principal.user);
      else if (channel === 'facebook_comment') await deps.facebookComments!.replyManually(rawId, { text, mode }, principal.userId);
      else await deps.zaloOa!.sendText(Number(rawId), text, principal.userId);
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw new ToolUserError(err.message);
      throw err;
    }
    const out = wrapData({ sent: true, ...preview, manage_url: `${baseUrl}${INBOX_URL}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};

/** Hội thoại (Messenger + Zalo OA), mới nhắn trước — cả hội thoại đã trả lời. Chỉ đọc, không đánh dấu đã đọc. */
export const listConversationsTool: ToolDef = {
  name: 'list_conversations',
  title: 'Các hội thoại Messenger và Zalo OA / List inbox conversations',
  description:
    'Các hội thoại với khách trong hộp thư chung của Trinity, mới nhắn trước: Messenger của Fanpage (channel = messenger) và Zalo OA (channel = zalo_oa, cần quyền sửa khách hàng). Gồm cả hội thoại đã trả lời; muốn chỉ những tin chưa ai trả lời thì dùng list_unanswered_messages. ' +
    'Mỗi hội thoại có id (dùng cho get_conversation_messages và reply_to_customer), tên khách, tin gần nhất, last_message_at, unread (số tin chưa đọc), awaiting_reply (tin cuối là của khách), can_reply (còn trong cửa sổ kênh: Messenger 24 giờ, Zalo OA 48 giờ), contact_url. ' +
    'search lọc theo tên khách. Chỉ đọc, không đánh dấu đã đọc. / ' +
    'Inbox conversations across Messenger and Zalo OA, newest first, including answered ones; ids work with get_conversation_messages and reply_to_customer. Read-only.',
  permissions: ['integrations.webhooks'],
  input: (z) => ({
    channel: z.enum(['messenger', 'zalo_oa']).optional().describe('Chỉ một kênh; bỏ trống = cả hai / Only this channel'),
    search: z.string().max(100).optional().describe('Tìm theo tên khách / Filter by customer name'),
    limit: z.number().int().min(1).max(50).optional().describe('Tối đa mỗi kênh (mặc định 20) / Max per channel'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const q = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined;
    if (q) rejectDigitProbe(q); // tìm theo tên, không cho dò số điện thoại / mã
    const want = (c: string) => !args.channel || args.channel === c;
    const contactUrl = (id: number | null) => (id ? `${baseUrl}/contacts/${id}` : null);
    const out: Record<string, unknown> = {};
    const notes: string[] = [];
    if (want('messenger')) {
      if (!(await deps.orgFeatures.isEnabled('facebook_page'))) notes.push('Messenger: tính năng Fanpage đang tắt.');
      else {
        const rows = await deps.prisma.facebookConversation.findMany({
          where: q ? { customer_name: { contains: q, mode: 'insensitive' } } : undefined,
          orderBy: { last_message_at: 'desc' },
          take: limit,
        });
        const pages = await deps.prisma.facebookPage.findMany({ select: { page_id: true, name: true } });
        const names = new Map(pages.map((p) => [p.page_id, p.name]));
        out.messenger = rows.map((c) => ({
          id: `messenger:${c.id}`,
          customer: c.customer_name,
          page: names.get(c.page_id) ?? null,
          last_message: c.last_message_preview,
          last_message_at: vnIso(c.last_message_at),
          unread: c.unread_count,
          awaiting_reply: Boolean(c.last_inbound_at && c.last_inbound_at.getTime() >= c.last_message_at.getTime()),
          can_reply: isWithinMessagingWindow(c.last_inbound_at),
          contact_url: contactUrl(c.contact_id),
        }));
      }
    }
    if (want('zalo_oa')) {
      if (!(await zaloOn(deps))) notes.push('Zalo OA: tính năng đang tắt hoặc chưa kết nối.');
      else if (!canZalo(principal.user.grants)) notes.push('Zalo OA: cần quyền sửa khách hàng để xem hộp thư Zalo.');
      else {
        const rows = await deps.prisma.zaloOaThread.findMany({
          where: q ? { display_name: { contains: q, mode: 'insensitive' } } : undefined,
          orderBy: [{ last_message_at: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          take: limit,
        });
        out.zalo_oa = rows.map((t) => ({
          id: `zalo_oa:${t.id}`,
          customer: t.display_name,
          last_message: t.last_message_preview,
          last_message_at: t.last_message_at ? vnIso(t.last_message_at) : null,
          unread: t.unread_count,
          awaiting_reply: Boolean(t.last_inbound_at && (!t.last_message_at || t.last_inbound_at.getTime() >= t.last_message_at.getTime())),
          can_reply: ZaloOaMessagingService.inConsultWindow(t.last_inbound_at),
          contact_url: contactUrl(t.contact_id),
        }));
      }
    }
    const res = wrapData({ ...out, notes, manage_url: `${baseUrl}${INBOX_URL}` });
    return { structured: res, text: JSON.stringify(res) };
  },
};

/** Nội dung một hội thoại, cũ → mới. Chỉ đọc: KHÔNG đánh dấu đã đọc (nhân viên vẫn thấy tin mới trong hộp thư). */
export const getConversationMessagesTool: ToolDef = {
  name: 'get_conversation_messages',
  title: 'Đọc nội dung một hội thoại / Read a conversation',
  description:
    'Các tin trong một hội thoại Messenger hoặc Zalo OA, cũ tới mới: from (customer = khách, business = Page/OA hoặc nhân viên trả lời), text, at (giờ Việt Nam). ' +
    'id lấy từ list_conversations hoặc list_unanswered_messages (dạng messenger:12, zalo_oa:5). Zalo OA cần quyền sửa khách hàng. Tin không phải chữ (ảnh, sticker, tệp) ghi kind. Số điện thoại bị che. Chỉ đọc, không đánh dấu đã đọc. / ' +
    'Messages of one Messenger or Zalo OA conversation, oldest first, with sender (customer/business), text and time. Read-only; does not mark as read.',
  permissions: ['integrations.webhooks'],
  input: (z) => ({
    id: z.string().min(3).max(40).describe('id hội thoại, vd "messenger:12" hoặc "zalo_oa:5" / Conversation id'),
    limit: z.number().int().min(1).max(50).optional().describe('Số tin gần nhất (mặc định 30, tối đa 50) / Number of latest messages'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, baseUrl, principal }) {
    const m = /^(messenger|zalo_oa):(\d{1,9})$/.exec(String(args.id ?? '').trim());
    if (!m) throw new ToolUserError('id phải có dạng messenger:<số> hoặc zalo_oa:<số> (lấy từ list_conversations). / id must look like messenger:12 or zalo_oa:5.');
    const [, channel, raw] = m;
    const id = Number(raw);
    const take = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 30;
    const contactUrl = (cid: number | null) => (cid ? `${baseUrl}/contacts/${cid}` : null);
    if (channel === 'messenger') {
      if (!(await deps.orgFeatures.isEnabled('facebook_page'))) throw new ToolUserError('Tính năng "Fanpage Facebook" đang tắt. / The Facebook Page feature is turned off.');
      const c = await deps.prisma.facebookConversation.findUnique({ where: { id } });
      if (!c) throw new ToolUserError(`Không có hội thoại ${args.id}. / Conversation not found.`);
      const rows = await deps.prisma.facebookMessage.findMany({ where: { conversation_id: id }, orderBy: { sent_at: 'desc' }, take });
      const res = wrapData({
        id: `messenger:${id}`,
        customer: c.customer_name,
        can_reply: isWithinMessagingWindow(c.last_inbound_at),
        contact_url: contactUrl(c.contact_id),
        messages: rows.reverse().map((r) => ({ from: r.direction === 'in' ? 'customer' : 'business', text: r.text, at: vnIso(r.sent_at) })),
      });
      return { structured: res, text: JSON.stringify(res) };
    }
    if (!(await zaloOn(deps))) throw new ToolUserError('Zalo OA chưa bật hoặc chưa kết nối. / Zalo OA is not available.');
    if (!canZalo(principal.user.grants)) throw new ToolUserError('Cần quyền sửa khách hàng để xem hộp thư Zalo OA. / Missing contacts.update permission.');
    const t = await deps.prisma.zaloOaThread.findUnique({ where: { id } });
    if (!t) throw new ToolUserError(`Không có hội thoại ${args.id}. / Conversation not found.`);
    const rows = await deps.prisma.zaloOaMessage.findMany({ where: { thread_id: id, status: { not: 'failed' } }, orderBy: { id: 'desc' }, take });
    const res = wrapData({
      id: `zalo_oa:${id}`,
      customer: t.display_name,
      can_reply: ZaloOaMessagingService.inConsultWindow(t.last_inbound_at),
      contact_url: contactUrl(t.contact_id),
      messages: rows.reverse().map((r) => ({ from: r.direction === 'in' ? 'customer' : 'business', kind: r.kind === 'text' ? undefined : r.kind, text: r.text, at: vnIso(r.created_at) })),
    });
    return { structured: res, text: JSON.stringify(res) };
  },
};

export const INBOX_TOOLS: readonly ToolDef[] = [listUnansweredMessagesTool, listConversationsTool, getConversationMessagesTool, replyToCustomerTool];
