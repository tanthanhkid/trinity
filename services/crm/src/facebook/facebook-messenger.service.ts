import { Optional, BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { FacebookPage } from '@prisma/client';
import { Prisma, PrismaService } from '@trinity/prisma';
import { publishMessengerEvent } from './facebook-events';
import type { AuthUser } from '@trinity/rbac-nest';
import { isWithinMessagingWindow, type ChannelSendResult, type MessagingChannel } from './channel';
import { FacebookPagesService } from './facebook-pages.service';
import { GraphApiError, GraphClient } from './graph-client';
import { ChannelNotificationsService } from '../notifications/channel-notifications.service';
import { PublicApiService } from '../public-api/public-api.service';

interface Referral {
  ref?: string;
  source?: string;
  type?: string;
}
export interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[]; referral?: Referral; quick_reply?: { payload?: string } };
  /** Khách mở link m.me?ref=… khi đã có hội thoại (trường webhook `messaging_referrals`). */
  referral?: Referral;
  /** Bấm "Bắt đầu" lần đầu: link m.me?ref=… đi kèm trong `postback.referral`. */
  postback?: { payload?: string; title?: string; referral?: Referral };
}

/** Mã `ref` của link mở chat trong một sự kiện Messenger (ở bất kỳ chỗ nào Meta đặt nó); không có ⇒ null. */
export function referralRef(ev: MessagingEvent): string | null {
  if (ev.message?.is_echo) return null;
  const ref = ev.referral?.ref ?? ev.postback?.referral?.ref ?? ev.message?.referral?.ref;
  return typeof ref === 'string' && ref.trim() ? ref.trim().slice(0, 32) : null;
}

/** Khách tạo từ Messenger trong khoảng này trước khi `ref` tới (tin đầu tới trước referral) vẫn được đổi sang nguồn của link. */
const LATE_REFERRAL_MS = 10 * 60_000;

export const MAX_TEXT = 2000;
const preview = (t: string | null): string | null => (t ? t.slice(0, 200) : null);

/** SĐT Việt Nam đầu tiên trong tin (0…/84…/+84…, cho phép dấu cách/chấm/gạch) → dạng 0xxxxxxxxx; không có ⇒ null. */
export function findVnPhone(text: string | null): string | null {
  if (!text) return null;
  for (const m of text.matchAll(/(?<![\d+])(?:\+?84|0)(?:[\s.-]?\d){9}(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, '');
    const local = digits.startsWith('84') ? `0${digits.slice(2)}` : digits;
    if (/^0[35789]\d{8}$/.test(local)) return local;
  }
  return null;
}
const phoneVariants = (local: string): string[] => [local, `84${local.slice(1)}`, `+84${local.slice(1)}`];

/** Tên tạm khi chưa lấy được tên Facebook; lấy được tên sau thì chỉ thay khách còn đúng tên tạm này (không đè tên đã sửa tay). */
export const placeholderName = (psid: string): string => `Khách Messenger ${psid.slice(-4)}`;

/**
 * Messenger: nhận tin (webhook `messages`), lưu hội thoại, trả lời trong cửa sổ 24h.
 * Chính sách: https://developers.facebook.com/docs/messenger-platform/send-messages
 * Cũng là `MessagingChannel` tối thiểu.
 */
/** Tin cuối của hội thoại là của khách (tin vào ghi cả `last_inbound_at` lẫn `last_message_at`; tin ra chỉ đẩy `last_message_at`). */
export function awaitingReply(c: { last_inbound_at: Date | null; last_message_at: Date | null }): boolean {
  return Boolean(c.last_inbound_at && (!c.last_message_at || c.last_inbound_at.getTime() >= c.last_message_at.getTime()));
}

@Injectable()
export class FacebookMessengerService implements MessagingChannel {
  readonly key = 'facebook' as const;
  private readonly logger = new Logger(FacebookMessengerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphClient,
    private readonly pages: FacebookPagesService,
    private readonly publicApi: PublicApiService,
    @Optional() private readonly notices?: ChannelNotificationsService,
  ) {}

  /** Lưu 1 sự kiện tin nhắn. Trùng `mid` ⇒ bỏ qua (Meta gửi lại khi lỗi). Trả true nếu có ghi mới. */
  async ingest(pageId: string, ev: MessagingEvent): Promise<boolean> {
    const m = ev.message;
    if (!m?.mid) return false; // delivery/read/postback...: không phải tin nhắn
    const echo = m.is_echo === true;
    const psid = echo ? ev.recipient?.id : ev.sender?.id;
    if (!psid) return false;
    const ctx = await this.pages.activePageWithToken(pageId);
    if (!ctx) return false;
    if (await this.prisma.facebookMessage.findUnique({ where: { mid: m.mid }, select: { id: true } })) return false;
    const text = (m.text ?? (m.attachments?.length ? '[Tệp đính kèm]' : null))?.slice(0, 5000) ?? null;
    const at = ev.timestamp ? new Date(ev.timestamp) : new Date();
    const name = echo ? null : await this.nameFor(pageId, psid, ctx.token);
    let notice: { convId: number; contactId: number | null; created: boolean } | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const conv = await tx.facebookConversation.upsert({
          where: { page_id_psid: { page_id: pageId, psid } },
          create: { page_id: pageId, psid, customer_name: name, last_message_at: at, last_message_preview: preview(text), last_inbound_at: echo ? null : at, unread_count: echo ? 0 : 1 },
          update: {
            last_message_at: at,
            last_message_preview: preview(text),
            ...(echo ? {} : { last_inbound_at: at, unread_count: { increment: 1 } }),
            ...(name ? { customer_name: name } : {}),
          },
        });
        await tx.facebookMessage.create({ data: { conversation_id: conv.id, mid: m.mid as string, direction: echo ? 'out' : 'in', text, sent_at: at } });
        if (name && conv.contact_id) await this.renamePlaceholder(tx, conv.contact_id, psid, name);
        const contactId = echo ? conv.contact_id : await this.linkContact(tx, ctx.page, conv, text);
        if (!echo) notice = { convId: conv.id, contactId: contactId ?? conv.contact_id, created: false };
        await publishMessengerEvent(tx, { ...conv, page_id: pageId, contact_id: contactId ?? conv.contact_id }, echo ? 'out' : 'in', echo ? 'page' : 'customer');
        if (contactId) {
          const who = echo ? `Page "${ctx.page.name}" trả lời qua Messenger` : `Khách nhắn Page "${ctx.page.name}" qua Messenger`;
          await tx.activity.create({
            data: {
              contact_id: contactId,
              action: 'note',
              details: { description: `${who}: ${text ?? ''}`.slice(0, 2000), source: 'facebook_messenger' },
              metadata: { facebook_page_id: pageId, psid, mid: m.mid as string, direction: echo ? 'out' : 'in' } as Prisma.InputJsonObject,
              created_by: null,
            },
          });
        }
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false; // đua với echo của tin ta vừa gửi
      throw err;
    }
    if (notice) {
      const nn = notice as { convId: number; contactId: number | null; created: boolean };
      await this.notices?.notify({
        event: 'messenger.message_received', channelName: ctx.page.name, defaultAssignee: ctx.page.default_assignee_id, contactId: nn.contactId,
        contactCreated: nn.created, fromName: name, text, actionUrl: `/inbox?kenh=facebook&hoi_thoai=${nn.convId}`, threadKey: `fb:${nn.convId}`,
      });
    }
    return true;
  }

  /**
   * Khách vào chat qua link/QR (`ref` = mã link): gắn link vào hội thoại (lần đầu — "nguồn" là link đầu tiên), tạo khách với nguồn
   * của link (chưa có khách) và ghi lịch sử. Meta gửi lại webhook ⇒ chỉ xử lý khi hội thoại CHƯA gắn link (idempotent).
   */
  async ingestReferral(pageId: string, ev: MessagingEvent): Promise<boolean> {
    const ref = referralRef(ev);
    const psid = ev.sender?.id;
    if (!ref || !psid) return false;
    const link = await this.prisma.facebookChatLink.findUnique({ where: { code: ref } });
    if (!link || link.page_id !== pageId || !link.is_active) return false;
    const ctx = await this.pages.activePageWithToken(pageId);
    if (!ctx) return false;
    const existing = await this.prisma.facebookConversation.findUnique({ where: { page_id_psid: { page_id: pageId, psid } }, select: { entry_link_id: true } });
    if (existing?.entry_link_id) return false;
    const at = ev.timestamp ? new Date(ev.timestamp) : new Date();
    const name = existing ? null : await this.nameFor(pageId, psid, ctx.token);
    const sourceId = link.source_id ?? ctx.page.contact_source_id;
    return this.prisma.$transaction(async (tx) => {
      const conv = await tx.facebookConversation.upsert({
        where: { page_id_psid: { page_id: pageId, psid } },
        create: { page_id: pageId, psid, customer_name: name, last_message_at: at },
        update: {},
      });
      // Meta gửi lại / hai sự kiện cùng lúc: chỉ lượt "giành" được hội thoại chưa gắn link mới ghi tiếp.
      const claimed = await tx.facebookConversation.updateMany({ where: { id: conv.id, entry_link_id: null }, data: { entry_link_id: link.id } });
      if (!claimed.count) return false;
      await tx.facebookChatLink.update({ where: { id: link.id }, data: { chats: { increment: 1 } } });
      let contactId = conv.contact_id;
      if (contactId) {
        // Tin đầu tới trước referral ⇒ khách vừa tạo với nguồn mặc định của Page: đổi sang nguồn của link.
        if (link.source_id && link.source_id !== ctx.page.contact_source_id) {
          await tx.contact.updateMany({
            where: { id: contactId, source_id: ctx.page.contact_source_id, created_at: { gte: new Date(Date.now() - LATE_REFERRAL_MS) } },
            data: { source_id: link.source_id },
          });
        }
      } else {
        contactId = await this.linkContact(tx, ctx.page, conv, null, sourceId);
      }
      if (contactId) {
        await tx.activity.create({
          data: {
            contact_id: contactId,
            action: 'note',
            details: { description: `Khách mở chat Page "${ctx.page.name}" qua link "${link.name}"`.slice(0, 2000), source: 'facebook_messenger' },
            metadata: { facebook_page_id: pageId, psid, chat_link_id: link.id, chat_link_code: link.code } as Prisma.InputJsonObject,
            created_by: null,
          },
        });
      }
      return true;
    });
  }

  /**
   * Ghép người nhắn với khách CRM (lần đầu nhắn ⇒ khách mới; Messenger không cho SĐT nên khách mới để trống SĐT).
   * Tin có SĐT Việt Nam: chưa ghép thì ghép vào khách có SĐT đó (nếu có); khách đang trống SĐT thì điền vào.
   * Người phụ trách = người nhận khách của Page (`default_assignee_id`), nghỉ việc thì người đã kết nối Page; cả hai nghỉ ⇒ không tạo.
   */
  private async linkContact(
    tx: Prisma.TransactionClient,
    page: FacebookPage,
    conv: { id: number; psid: string; contact_id: number | null; customer_name: string | null },
    text: string | null,
    sourceId: number = page.contact_source_id,
  ): Promise<number | null> {
    const phone = findVnPhone(text);
    if (conv.contact_id) {
      if (phone) await tx.contact.updateMany({ where: { id: conv.contact_id, phone: '' }, data: { phone } });
      return conv.contact_id;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fb:${page.page_id}:${conv.psid}`}))`;
    let contactId: number | null = null;
    if (phone) {
      const byPhone = await tx.contact.findFirst({ where: { phone: { in: phoneVariants(phone) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
      contactId = byPhone?.id ?? null;
    }
    if (!contactId) {
      const owner = await this.ownerFor(tx, page);
      if (!owner) {
        this.logger.warn(`Không tạo khách từ Messenger (Page ${page.page_id}): người nhận khách và người kết nối Page đều không còn hoạt động`);
        return null;
      }
      const created = await this.publicApi.createContactInTx(
        tx,
        {
          phone: phone ?? '',
          full_name: conv.customer_name ?? placeholderName(conv.psid),
          source_id: sourceId,
          project_id: page.project_id,
        },
        owner,
        'facebook_messenger',
      );
      contactId = created.id;
    }
    await tx.facebookConversation.update({ where: { id: conv.id }, data: { contact_id: contactId } });
    return contactId;
  }

  private async ownerFor(tx: Prisma.TransactionClient, page: FacebookPage): Promise<{ id: number; team_id: number | null } | null> {
    for (const id of [page.default_assignee_id, page.connected_by]) {
      const u = await tx.user.findUnique({ where: { id }, select: { id: true, status: true, team_id: true, deleted_at: true } });
      if (u && u.status === 'active' && u.deleted_at === null) return { id: u.id, team_id: u.team_id };
    }
    return null;
  }

  private async nameFor(pageId: string, psid: string, token: string): Promise<string | null> {
    const known = await this.prisma.facebookConversation.findUnique({ where: { page_id_psid: { page_id: pageId, psid } }, select: { customer_name: true } });
    if (known?.customer_name) return null;
    return (await this.graph.getUserName(psid, token)) ?? (await this.graph.getConversationName(pageId, psid, token));
  }

  private renamePlaceholder(tx: Prisma.TransactionClient, contactId: number, psid: string, name: string) {
    return tx.contact.updateMany({ where: { id: contactId, full_name: placeholderName(psid) }, data: { full_name: name } });
  }

  /**
   * Lấy lại tên cho các hội thoại của Page chưa có tên (gọi khi bấm "Kiểm tra token").
   * Khách còn tên tạm "Khách Messenger xxxx" thì đổi sang tên Facebook. Trả số hội thoại đã có tên.
   */
  async refreshMissingNames(pageId: string): Promise<number> {
    const ctx = await this.pages.activePageWithToken(pageId);
    if (!ctx) return 0;
    const convs = await this.prisma.facebookConversation.findMany({
      where: { page_id: pageId, customer_name: null },
      orderBy: { last_message_at: 'desc' },
      take: 20,
      select: { id: true, psid: true, contact_id: true },
    });
    let named = 0;
    for (const c of convs) {
      const name = await this.nameFor(pageId, c.psid, ctx.token);
      if (!name) continue;
      await this.prisma.$transaction(async (tx) => {
        await tx.facebookConversation.update({ where: { id: c.id }, data: { customer_name: name } });
        if (c.contact_id) await this.renamePlaceholder(tx, c.contact_id, c.psid, name);
      });
      named++;
    }
    return named;
  }

  /** `unanswered`: chỉ hội thoại có tin cuối là của khách (chưa ai trả lời). */
  async listConversations(limit = 50, opts: { unanswered?: boolean } = {}) {
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.facebookConversation.findMany({
      where: opts.unanswered ? { last_inbound_at: { not: null } } : undefined,
      orderBy: { last_message_at: 'desc' },
      take: opts.unanswered ? 300 : take,
    });
    const kept = opts.unanswered ? rows.filter(awaitingReply).slice(0, take) : rows;
    const pages = await this.prisma.facebookPage.findMany({ select: { page_id: true, name: true } });
    const names = new Map(pages.map((p) => [p.page_id, p.name]));
    return kept.map((c) => ({ ...c, page_name: names.get(c.page_id) ?? c.page_id, can_reply: isWithinMessagingWindow(c.last_inbound_at), awaiting_reply: awaitingReply(c) }));
  }

  private readonly lastSync = new Map<number, number>();

  /**
   * Kéo tin gần nhất của hội thoại thẳng từ Facebook và ghi tin còn thiếu (như webhook). Bù khi webhook không về — vd app Meta
   * trỏ webhook sang bản cài khác, hoặc Page tắt lúc khách nhắn. Mỗi hội thoại tối đa một lần mỗi phút; lỗi Facebook thì bỏ qua.
   * Trả số tin mới.
   */
  async syncConversation(conv: { id: number; page_id: string; psid: string; last_message_at: Date | null }, force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - (this.lastSync.get(conv.id) ?? 0) < 60_000) return 0;
    this.lastSync.set(conv.id, now);
    const ctx = await this.pages.activePageWithToken(conv.page_id);
    if (!ctx) return 0;
    let msgs: Awaited<ReturnType<GraphClient['getRecentMessages']>>;
    try {
      msgs = await this.graph.getRecentMessages(conv.page_id, conv.psid, ctx.token);
    } catch (err) {
      this.logger.warn(`Đồng bộ hội thoại ${conv.id} từ Facebook lỗi: ${(err as Error).message}`);
      return 0;
    }
    let added = 0;
    // Chỉ tin mới hơn tin cuối đã lưu: không kéo lùi "tin cuối" của hội thoại.
    const after = conv.last_message_at?.getTime() ?? 0;
    for (const m of [...msgs].reverse()) {
      if ((Date.parse(m.created_time) || 0) <= after) continue;
      const fromPage = m.from?.id === conv.page_id;
      const ev: MessagingEvent = {
        sender: { id: fromPage ? conv.page_id : conv.psid },
        recipient: { id: fromPage ? conv.psid : conv.page_id },
        timestamp: Date.parse(m.created_time) || undefined,
        message: { mid: m.id, text: m.message || undefined, ...(fromPage ? { is_echo: true } : {}) },
      };
      if (await this.ingest(conv.page_id, ev)) added++;
    }
    return added;
  }

  /** Tin của 1 hội thoại (cũ → mới) và đánh dấu đã đọc. */
  async messages(conversationId: number, limit = 100) {
    let conv = await this.prisma.facebookConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Không tìm thấy hội thoại');
    if (await this.syncConversation(conv)) conv = (await this.prisma.facebookConversation.findUnique({ where: { id: conversationId } })) ?? conv;
    const rows = await this.prisma.facebookMessage.findMany({ where: { conversation_id: conversationId }, orderBy: { sent_at: 'desc' }, take: Math.min(Math.max(limit, 1), 200) });
    if (conv.unread_count > 0) await this.prisma.facebookConversation.update({ where: { id: conv.id }, data: { unread_count: 0 } });
    return { conversation: { ...conv, unread_count: 0, can_reply: isWithinMessagingWindow(conv.last_inbound_at) }, messages: rows.reverse().map((m) => ({ ...m, id: m.id.toString() })) };
  }

  /** `MessagingChannel`: gửi thẳng theo (pageId, psid), KHÔNG kiểm cửa sổ — dùng `reply` cho nhân viên. */
  async sendText(pageId: string, psid: string, text: string): Promise<ChannelSendResult> {
    const ctx = await this.pages.activePageWithToken(pageId);
    if (!ctx) throw new BadRequestException('Fanpage chưa kết nối hoặc đã tắt');
    try {
      return { externalId: (await this.graph.sendText(ctx.token, psid, text)).message_id };
    } catch (err) {
      throw await this.mapSendError(err, pageId);
    }
  }

  private async mapSendError(err: unknown, pageId: string): Promise<Error> {
    if (!(err instanceof GraphApiError)) return err as Error;
    if (err.isOutsideWindow) return new BadRequestException('Đã quá 24 giờ kể từ tin nhắn gần nhất của khách — Messenger không cho gửi tin chủ động.');
    if (err.isTokenError) {
      await this.pages.markTokenInvalid(pageId);
      return new ServiceUnavailableException('Token Fanpage đã hết hạn hoặc bị thu hồi — hãy kết nối lại Fanpage.');
    }
    if (err.isPermissionError) return new ServiceUnavailableException('Facebook từ chối: ứng dụng chưa có quyền pages_messaging cho Fanpage này.');
    this.logger.warn(`Gửi tin lỗi code=${err.code}`);
    return new ServiceUnavailableException('Facebook không nhận tin nhắn, thử lại sau.');
  }

  /** Nhân viên trả lời: CHỈ trong 24h kể từ tin khách gần nhất. */
  async reply(conversationId: number, rawText: string, actor: AuthUser) {
    const text = rawText?.trim();
    if (!text) throw new BadRequestException('Nội dung tin nhắn trống');
    if (text.length > MAX_TEXT) throw new BadRequestException(`Tin nhắn tối đa ${MAX_TEXT} ký tự`);
    let conv = await this.prisma.facebookConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('Không tìm thấy hội thoại');
    // Theo dữ liệu đã lưu thì quá 24 giờ: hỏi lại Facebook trước khi chặn (tin khách có thể chưa về qua webhook).
    if (!isWithinMessagingWindow(conv.last_inbound_at) && (await this.syncConversation(conv, true))) {
      conv = (await this.prisma.facebookConversation.findUnique({ where: { id: conversationId } })) ?? conv;
    }
    if (!isWithinMessagingWindow(conv.last_inbound_at)) {
      throw new BadRequestException('Đã quá 24 giờ kể từ tin nhắn gần nhất của khách — Messenger không cho gửi tin chủ động.');
    }
    const sent = await this.sendText(conv.page_id, conv.psid, text);
    const now = new Date();
    // Nhân viên đã vào trả lời ⇒ kịch bản tự động đang dở dừng lại (không chen tin máy vào cuộc nói chuyện).
    await this.prisma.facebookFlowRun.updateMany({
      where: { conversation_id: conv.id, status: { in: ['waiting_button', 'waiting_answer', 'scheduled'] } },
      data: { status: 'stopped', step_id: null, due_at: null, note: 'Nhân viên đã trả lời' },
    });
    return this.prisma.$transaction(async (tx) => {
      await tx.facebookConversation.update({ where: { id: conv.id }, data: { last_message_at: now, last_message_preview: preview(text) } });
      const existing = await tx.facebookMessage.findUnique({ where: { mid: sent.externalId } });
      // Echo của tin này có thể đã tới trước: gắn người gửi vào bản ghi đó.
      const row = existing
        ? await tx.facebookMessage.update({ where: { id: existing.id }, data: { sent_by_user_id: actor.userId } })
        : await tx.facebookMessage.create({ data: { conversation_id: conv.id, mid: sent.externalId, direction: 'out', text, sent_by_user_id: actor.userId, sent_at: now } });
      // Echo tới trước thì `ingest` đã ghi lịch sử khách; còn không thì ghi ở đây để tin nhân viên trả lời hiện trong "Lịch sử thao tác".
      if (!existing) await publishMessengerEvent(tx, conv, 'out', 'agent', actor.userId);
      if (!existing && conv.contact_id) {
        await tx.activity.create({
          data: {
            contact_id: conv.contact_id,
            action: 'note',
            details: { description: `Nhân viên trả lời qua Messenger: ${text}`.slice(0, 2000), source: 'facebook_messenger' },
            metadata: { facebook_page_id: conv.page_id, psid: conv.psid, mid: sent.externalId, direction: 'out' } as Prisma.InputJsonObject,
            created_by: actor.userId,
          },
        });
      }
      return { ...row, id: row.id.toString() };
    });
  }
}
