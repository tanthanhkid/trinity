import { Optional, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FacebookCommentRule, FacebookPage } from '@prisma/client';
import { Prisma, PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import { trackProductEvent } from '@trinity/logger';
import { publishMessengerEvent } from './facebook-events';
import { FacebookPagesService } from './facebook-pages.service';
import { findVnPhone } from './facebook-messenger.service';
import { GraphApiError, GraphClient } from './graph-client';
import { ChannelNotificationsService } from '../notifications/channel-notifications.service';
import { PublicApiService } from '../public-api/public-api.service';

/** Giá trị `changes[].value` của webhook `feed` (chỉ phần dùng tới). Docs: webhooks-for-pages › feed. */
export interface FeedChange {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  from?: { id?: string; name?: string };
  message?: string;
  created_time?: number | string;
}

/** Sự kiện sản phẩm khi lưu luật: chỉ đếm số hành động, không gửi tên luật hay nội dung trả lời. */
export function trackCommentRuleSaved(
  rule: Pick<FacebookCommentRule, 'public_replies' | 'private_reply' | 'hide_if_phone'>,
  created: boolean,
  userId: number | null,
): void {
  const actions = (rule?.public_replies?.length ? 1 : 0) + (rule?.private_reply?.trim() ? 1 : 0) + (rule?.hide_if_phone ? 1 : 0);
  trackProductEvent('comment_rule_saved', userId, { created, actions });
}

export type CommentRuleInput = {
  name: string;
  page_id?: string | null;
  post_id?: string | null;
  keywords?: string[];
  exclude_keywords?: string[];
  public_replies?: string[];
  private_reply?: string | null;
  hide_if_phone?: boolean;
  once_per_user?: boolean;
  mode?: 'test' | 'live';
  is_active?: boolean;
  position?: number;
};

export interface PlannedActions {
  public_reply?: { text: string; id?: string; error?: string };
  private_reply?: { text: string; message_id?: string; error?: string };
  hide?: { done?: boolean; error?: string };
  phone_saved?: boolean;
  /** Nhân viên trả lời tay từ Trinity (công khai dưới bình luận hoặc nhắn riêng qua Messenger). */
  manual?: ManualCommentReply[];
}

export interface ManualCommentReply {
  mode: 'public' | 'private';
  text: string;
  id: string;
  by: number | null;
  at: string;
}

/** Facebook chỉ cho nhắn riêng (Private Reply) trong 7 ngày kể từ lúc bình luận, mỗi bình luận một lần. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Bình luận đã có người/luật trả lời (công khai hoặc nhắn riêng thành công), hoặc luật bỏ qua vì đã trả lời người này. */
export function commentAnswered(c: { status: string; actions: unknown }): boolean {
  const a = (c.actions ?? {}) as PlannedActions;
  return c.status === 'skipped' || Boolean(a.public_reply?.id || a.private_reply?.message_id || a.manual?.length);
}

/** Đã nhắn riêng cho bình luận này chưa (luật hoặc tay) — Facebook chỉ cho một lần. */
export function privateReplied(actions: unknown): boolean {
  const a = (actions ?? {}) as PlannedActions;
  return Boolean(a.private_reply?.message_id || a.manual?.some((m) => m.mode === 'private'));
}

const MAX_TEXT = 2000;
const MAX_WORDS = 30;

/** Chuẩn hoá để so từ khoá: chữ thường, bỏ dấu tiếng Việt (đ→d), gộp khoảng trắng. */
export function normalizeVi(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Bình luận khớp luật (không xét Page/bài): chứa một từ khoá (rỗng = mọi bình luận) và không chứa từ loại trừ. */
export function matchesKeywords(message: string | null, keywords: string[], exclude: string[]): boolean {
  const m = normalizeVi(message ?? '');
  const has = (w: string) => {
    const k = normalizeVi(w);
    return k.length > 0 && m.includes(k);
  };
  if (exclude.some(has)) return false;
  return keywords.filter((k) => normalizeVi(k)).length === 0 || keywords.some(has);
}

/** Thay {ten} bằng tên người bình luận (không có tên thì "bạn"). */
export function fillTemplate(text: string, name: string | null): string {
  return text.replace(/\{\s*ten\s*\}/gi, name?.trim() || 'bạn').slice(0, MAX_TEXT);
}

export const cleanList = (v: string[] | undefined): string[] =>
  [...new Set((v ?? []).map((x) => String(x).trim()).filter(Boolean).map((x) => x.slice(0, MAX_TEXT)))].slice(0, MAX_WORDS);
const placeholderName = (fromId: string | null): string => `Khách bình luận ${fromId ? fromId.slice(-4) : ''}`.trim();
export const postLink = (postId: string): string => `https://www.facebook.com/${postId}`;

/**
 * Tự xử lý bình luận trên bài của Page — mô phỏng ManyChat "Comment Automation":
 * bình luận mới (webhook `feed`) ⇒ lưu, tạo/ghép khách, chạy luật đầu tiên khớp: trả lời công khai + nhắn riêng (Private Reply),
 * có SĐT thì điền vào khách và (tuỳ luật) ẩn bình luận. Luật chế độ "thử" chỉ ghi lại việc SẼ làm, không gửi gì ra Facebook.
 */
@Injectable()
export class FacebookCommentsService {
  private readonly logger = new Logger(FacebookCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphClient,
    private readonly pages: FacebookPagesService,
    private readonly publicApi: PublicApiService,
    @Optional() private readonly notices?: ChannelNotificationsService,
  ) {}

  /** Một thay đổi `feed`. Chỉ xử lý bình luận MỚI của người khác (bỏ bình luận của chính Page ⇒ không tự trả lời mình). */
  async ingest(pageId: string, v: FeedChange): Promise<boolean> {
    if (v.item !== 'comment' || v.verb !== 'add' || !v.comment_id || !v.post_id) return false;
    const fromId = v.from?.id ?? null;
    if (fromId === pageId) return false;
    const ctx = await this.pages.activePageWithToken(pageId);
    if (!ctx) return false;
    const message = v.message?.slice(0, 5000) ?? null;
    const phone = findVnPhone(message);
    const at = toDate(v.created_time);
    let row: { id: bigint };
    try {
      row = await this.prisma.facebookComment.create({
        data: {
          comment_id: v.comment_id,
          page_id: pageId,
          post_id: v.post_id,
          parent_id: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null,
          from_id: fromId,
          from_name: v.from?.name?.slice(0, 200) ?? null,
          message,
          commented_at: at,
          phone,
        },
        select: { id: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return false; // Meta gửi lại
      throw err;
    }

    // Khách có sẵn (SĐT, bình luận trước). Chưa có thì CHỜ nhắn riêng xong: PSID có thể trỏ tới khách Messenger cũ.
    let contactId = await this.findContact(ctx.page, { fromId, phone });
    let psid: string | null = null;
    const rule = await this.matchRule(pageId, v.post_id, message);
    let status = 'received';
    let note: string | null = null;
    let actions: PlannedActions = {};
    if (rule) {
      const dup = rule.once_per_user && fromId
        ? await this.prisma.facebookComment.findFirst({
          where: { post_id: v.post_id, from_id: fromId, rule_id: rule.id, status: { in: ['done', 'test'] }, id: { not: row.id } },
          select: { id: true },
        })
        : null;
      if (dup) {
        status = 'skipped';
        note = 'Người này đã được trả lời ở bài này rồi (luật chỉ trả lời mỗi người một lần mỗi bài).';
      } else {
        actions = this.plan(rule, v.from?.name ?? null, phone);
        if (rule.mode === 'live') {
          ({ actions, psid } = await this.execute(ctx, v.comment_id, actions));
          const errs = [actions.public_reply?.error, actions.private_reply?.error, actions.hide?.error].filter(Boolean);
          const ok = [actions.public_reply?.id, actions.private_reply?.message_id, actions.hide?.done].some(Boolean);
          status = errs.length && !ok ? 'failed' : 'done';
          note = errs.length ? errs.join(' · ').slice(0, 500) : null;
        } else {
          status = 'test';
          note = 'Luật đang ở chế độ thử: chỉ ghi lại, chưa gửi gì lên Facebook.';
        }
      }
    }
    if (!contactId && psid) contactId = await this.contactOfConversation(pageId, psid);
    let contactCreated = false;
    if (!contactId) { contactId = await this.createContact(ctx.page, { fromId, fromName: v.from?.name ?? null, phone }); contactCreated = !!contactId; }
    if (psid && actions.private_reply?.message_id) await this.rememberConversation(pageId, psid, actions.private_reply.message_id, actions.private_reply.text, contactId);
    if (phone && contactId) {
      const r = await this.prisma.contact.updateMany({ where: { id: contactId, phone: '' }, data: { phone } });
      if (r.count) actions.phone_saved = true;
    }
    await this.prisma.facebookComment.update({
      where: { id: row.id },
      data: { contact_id: contactId, rule_id: rule?.id ?? null, status, note, actions: actions as Prisma.InputJsonObject, hidden: Boolean(actions.hide?.done) },
    });
    if (contactId) await this.logActivity(contactId, ctx.page, v, message, rule, status, actions);
    const owner = contactId ? await this.prisma.contact.findUnique({ where: { id: contactId }, select: { assigned_to: true } }) : null;
    await publishIntegrationEvent(
      this.prisma,
      'facebook.comment_received',
      { comment_id: Number(row.id), page_id: pageId, post_id: v.post_id, contact_id: contactId, contact_assigned_to: owner?.assigned_to ?? null, auto_reply_status: status },
      { resourceId: row.id.toString(), actorUserId: null },
    ).catch((e) => this.logger.warn(`Sự kiện webhook bình luận lỗi: ${(e as Error).message}`));
    await this.notices?.notify({
      event: 'facebook.comment_received', channelName: ctx.page.name, defaultAssignee: ctx.page.default_assignee_id, contactId, contactCreated,
      fromName: v.from?.name ?? null, text: message, autoResult: autoResultLine(rule?.name ?? null, status, actions),
      actionUrl: '/inbox?kenh=tuong-tac',
    });
    return true;
  }

  /** Việc luật sẽ làm (chưa gửi). */
  plan(rule: FacebookCommentRule, name: string | null, phone: string | null): PlannedActions {
    const a: PlannedActions = {};
    if (rule.public_replies.length) a.public_reply = { text: fillTemplate(rule.public_replies[Math.floor(Math.random() * rule.public_replies.length)], name) };
    if (rule.private_reply?.trim()) a.private_reply = { text: fillTemplate(rule.private_reply, name) };
    if (rule.hide_if_phone && phone) a.hide = {};
    return a;
  }

  private async execute(ctx: { page: FacebookPage; token: string }, commentId: string, a: PlannedActions): Promise<{ actions: PlannedActions; psid: string | null }> {
    const out: PlannedActions = { ...a };
    let psid: string | null = null;
    if (a.public_reply) {
      try {
        out.public_reply = { ...a.public_reply, id: (await this.graph.replyToComment(ctx.token, commentId, a.public_reply.text)).id };
      } catch (err) {
        out.public_reply = { ...a.public_reply, error: await this.explain(err, ctx.page.page_id, 'trả lời bình luận') };
      }
    }
    if (a.private_reply) {
      try {
        const r = await this.graph.privateReply(ctx.token, ctx.page.page_id, commentId, a.private_reply.text);
        out.private_reply = { ...a.private_reply, message_id: r.message_id };
        psid = r.recipient_id ?? null;
      } catch (err) {
        out.private_reply = { ...a.private_reply, error: await this.explain(err, ctx.page.page_id, 'nhắn riêng') };
      }
    }
    if (a.hide) {
      try {
        await this.graph.hideComment(ctx.token, commentId);
        out.hide = { done: true };
      } catch (err) {
        out.hide = { error: await this.explain(err, ctx.page.page_id, 'ẩn bình luận') };
      }
    }
    return { actions: out, psid };
  }

  /**
   * Private Reply trả về PSID của người bình luận: tạo sẵn hội thoại Messenger gắn đúng khách, để khi khách nhắn lại
   * tin vào cùng khách hàng (không đẻ khách trùng). Hội thoại đã gắn khách thì GIỮ khách đó (không ghi đè).
   * Tin của Page lưu luôn (echo tới sau trùng `mid` sẽ bị bỏ qua).
   */
  private async rememberConversation(pageId: string, psid: string, mid: string, text: string, contactId: number | null): Promise<void> {
    try {
      const now = new Date();
      const conv = await this.prisma.facebookConversation.upsert({
        where: { page_id_psid: { page_id: pageId, psid } },
        create: { page_id: pageId, psid, contact_id: contactId, last_message_at: now, last_message_preview: text.slice(0, 200) },
        update: { last_message_at: now, last_message_preview: text.slice(0, 200) },
      });
      if (contactId && !conv.contact_id) await this.prisma.facebookConversation.update({ where: { id: conv.id }, data: { contact_id: contactId } });
      const saved = await this.prisma.facebookMessage.create({ data: { conversation_id: conv.id, mid, direction: 'out', text, sent_at: now } }).catch(() => null);
      if (saved) await publishMessengerEvent(this.prisma, { ...conv, page_id: pageId, contact_id: conv.contact_id ?? contactId }, 'out', 'comment_reply');
    } catch (err) {
      this.logger.warn(`Lưu hội thoại sau nhắn riêng lỗi: ${(err as Error).message}`);
    }
  }

  private async explain(err: unknown, pageId: string, what: string): Promise<string> {
    if (!(err instanceof GraphApiError)) {
      this.logger.warn(`Bình luận: ${what} lỗi ${(err as Error).message}`);
      return `Không ${what} được (lỗi máy chủ).`;
    }
    if (err.isTokenError) {
      await this.pages.markTokenInvalid(pageId);
      return `Không ${what} được: token Fanpage hết hạn, hãy kết nối lại Fanpage.`;
    }
    if (err.isPermissionError) return `Không ${what} được: ứng dụng Facebook chưa có quyền (cần kết nối lại Fanpage sau khi bật quyền).`;
    return `Không ${what} được: Facebook báo "${err.message.slice(0, 160)}".`;
  }

  /** Luật đầu tiên (theo position, id) đang bật và khớp Page, bài, từ khoá. */
  async matchRule(pageId: string, postId: string, message: string | null): Promise<FacebookCommentRule | null> {
    const rules = await this.prisma.facebookCommentRule.findMany({
      where: { is_active: true, AND: [{ OR: [{ page_id: null }, { page_id: pageId }] }, { OR: [{ post_id: null }, { post_id: postId }] }] },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return rules.find((r) => matchesKeywords(message, r.keywords, r.exclude_keywords)) ?? null;
  }

  /**
   * Khách sẵn có của người bình luận: SĐT trùng khách cũ ⇒ khách đó; đã bình luận trước ⇒ khách lần trước.
   * Không thấy thì ingest thử khách Messenger (theo PSID sau nhắn riêng) rồi mới tạo khách mới
   * (nguồn = nguồn khách của Page, người phụ trách = người nhận khách của Page). Không biết người bình luận và không có SĐT ⇒ không tạo.
   */
  private async findContact(page: FacebookPage, p: { fromId: string | null; phone: string | null }): Promise<number | null> {
    if (p.phone) {
      const byPhone = await this.prisma.contact.findFirst({ where: { phone: { in: phoneVariants(p.phone) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
      if (byPhone) return byPhone.id;
    }
    if (p.fromId) {
      const before = await this.prisma.facebookComment.findFirst({ where: { page_id: page.page_id, from_id: p.fromId, contact_id: { not: null } }, orderBy: { id: 'desc' }, select: { contact_id: true } });
      if (before?.contact_id) {
        const alive = await this.prisma.contact.findFirst({ where: { id: before.contact_id, deleted_at: null }, select: { id: true } });
        if (alive) return alive.id;
      }
    }
    return null;
  }

  /** Khách Messenger sẵn có của người này (PSID lấy từ lần nhắn riêng). */
  private async contactOfConversation(pageId: string, psid: string): Promise<number | null> {
    const conv = await this.prisma.facebookConversation.findUnique({ where: { page_id_psid: { page_id: pageId, psid } }, select: { contact_id: true } });
    if (!conv?.contact_id) return null;
    const alive = await this.prisma.contact.findFirst({ where: { id: conv.contact_id, deleted_at: null }, select: { id: true } });
    return alive?.id ?? null;
  }

  private async createContact(page: FacebookPage, p: { fromId: string | null; fromName: string | null; phone: string | null }): Promise<number | null> {
    if (!p.fromId && !p.phone) return null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fbc:${page.page_id}:${p.fromId ?? p.phone}`}))`;
      const owner = await this.ownerFor(tx, page);
      if (!owner) {
        this.logger.warn(`Không tạo khách từ bình luận (Page ${page.page_id}): người nhận khách và người kết nối Page đều không còn hoạt động`);
        return null;
      }
      const created = await this.publicApi.createContactInTx(
        tx,
        { phone: p.phone ?? '', full_name: p.fromName?.trim() || placeholderName(p.fromId), source_id: page.contact_source_id, project_id: page.project_id },
        owner,
        'facebook_comment',
      );
      return created.id;
    });
  }

  private async ownerFor(tx: Prisma.TransactionClient, page: FacebookPage): Promise<{ id: number; team_id: number | null } | null> {
    for (const id of [page.default_assignee_id, page.connected_by]) {
      const u = await tx.user.findUnique({ where: { id }, select: { id: true, status: true, team_id: true, deleted_at: true } });
      if (u && u.status === 'active' && u.deleted_at === null) return { id: u.id, team_id: u.team_id };
    }
    return null;
  }

  private async logActivity(contactId: number, page: FacebookPage, v: FeedChange, message: string | null, rule: FacebookCommentRule | null, status: string, a: PlannedActions) {
    const lines = [`Khách bình luận bài trên Page "${page.name}": ${message ?? ''}`];
    const verb = status === 'test' ? 'sẽ' : 'đã';
    if (rule && (status === 'done' || status === 'test')) {
      if (a.public_reply && !a.public_reply.error) lines.push(`Trinity ${verb} trả lời công khai (luật "${rule.name}"): ${a.public_reply.text}`);
      if (a.private_reply && !a.private_reply.error) lines.push(`Trinity ${verb} nhắn riêng qua Messenger: ${a.private_reply.text}`);
      if (a.hide && !a.hide.error) lines.push(`Trinity ${verb} ẩn bình luận vì có số điện thoại.`);
    }
    await this.prisma.activity.create({
      data: {
        contact_id: contactId,
        action: 'note',
        details: { description: lines.join('\n').slice(0, 2000), source: 'facebook_comment' },
        metadata: { facebook_page_id: page.page_id, post_id: v.post_id ?? null, comment_id: v.comment_id ?? null, post_url: v.post_id ? postLink(v.post_id) : null } as Prisma.InputJsonObject,
        created_by: null,
      },
    });
  }

  /* ---------- Màn quản trị & AI ---------- */

  /**
   * Nhân viên trả lời tay một bình luận: `public` = trả lời công khai dưới bình luận; `private` = nhắn riêng qua Messenger
   * (Facebook chỉ cho một lần mỗi bình luận, trong 7 ngày). Tin nhắn riêng tạo/ghép hội thoại Messenger như luật tự động.
   */
  async replyManually(id: string, input: { text: string; mode: 'public' | 'private' }, actorUserId: number | null, now = new Date()) {
    const text = input.text?.trim() ?? '';
    if (!text) throw new BadRequestException('Nội dung trả lời trống');
    if (text.length > MAX_TEXT) throw new BadRequestException(`Trả lời tối đa ${MAX_TEXT} ký tự`);
    if (input.mode !== 'public' && input.mode !== 'private') throw new BadRequestException('Cách trả lời phải là public hoặc private');
    if (!/^\d{1,19}$/.test(id)) throw new NotFoundException('Không tìm thấy bình luận');
    const c = await this.prisma.facebookComment.findUnique({ where: { id: BigInt(id) } });
    if (!c) throw new NotFoundException('Không tìm thấy bình luận');
    if (input.mode === 'private') {
      if (privateReplied(c.actions)) throw new BadRequestException('Đã nhắn riêng cho bình luận này rồi — Facebook chỉ cho nhắn riêng một lần mỗi bình luận. Tiếp tục trong hộp thư Messenger.');
      if (now.getTime() - c.commented_at.getTime() > PRIVATE_REPLY_WINDOW_MS) throw new BadRequestException('Bình luận đã quá 7 ngày — Facebook không cho nhắn riêng nữa. Hãy trả lời công khai.');
    }
    const ctx = await this.pages.activePageWithToken(c.page_id);
    if (!ctx) throw new BadRequestException('Fanpage chưa kết nối hoặc đã tắt');
    let replyId: string;
    let psid: string | null = null;
    try {
      if (input.mode === 'public') replyId = (await this.graph.replyToComment(ctx.token, c.comment_id, text)).id;
      else {
        const r = await this.graph.privateReply(ctx.token, c.page_id, c.comment_id, text);
        replyId = r.message_id;
        psid = r.recipient_id ?? null;
      }
    } catch (err) {
      throw new BadRequestException(await this.explain(err, c.page_id, input.mode === 'public' ? 'trả lời bình luận' : 'nhắn riêng'));
    }
    const prev = (c.actions ?? {}) as PlannedActions;
    const manual: ManualCommentReply = { mode: input.mode, text, id: replyId, by: actorUserId, at: now.toISOString() };
    const actions: PlannedActions = { ...prev, manual: [...(prev.manual ?? []), manual] };
    const row = await this.prisma.facebookComment.update({
      where: { id: c.id },
      data: { actions: actions as Prisma.InputJsonObject, ...(c.status === 'received' || c.status === 'test' || c.status === 'failed' ? { status: 'replied', note: null } : {}) },
    });
    if (psid) await this.rememberConversation(c.page_id, psid, replyId, text, c.contact_id);
    return { ...row, id: row.id.toString(), answered: true };
  }

  async listComments(opts: { limit?: number; status?: string; pageId?: string; postId?: string; since?: Date; unanswered?: boolean } = {}) {
    const rows = await this.prisma.facebookComment.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.pageId ? { page_id: opts.pageId } : {}),
        ...(opts.postId ? { post_id: opts.postId } : {}),
        ...(opts.since ? { created_at: { gte: opts.since } } : {}),
      },
      orderBy: { created_at: 'desc' },
      // Lọc "chưa trả lời" nằm trong JSON `actions` ⇒ lấy rộng rồi lọc.
      take: opts.unanswered ? 300 : Math.min(Math.max(opts.limit ?? 50, 1), 100),
    });
    const kept = opts.unanswered ? rows.filter((r) => !commentAnswered(r)).slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 100)) : rows;
    const pages = await this.prisma.facebookPage.findMany({ select: { page_id: true, name: true } });
    const names = new Map(pages.map((p) => [p.page_id, p.name]));
    const ruleIds = [...new Set(kept.map((r) => r.rule_id).filter((x): x is number => x != null))];
    const rules = ruleIds.length ? await this.prisma.facebookCommentRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } }) : [];
    const ruleNames = new Map(rules.map((r) => [r.id, r.name]));
    return kept.map((r) => ({
      ...r,
      id: r.id.toString(),
      answered: commentAnswered(r),
      can_private_reply: !privateReplied(r.actions) && Date.now() - r.commented_at.getTime() <= PRIVATE_REPLY_WINDOW_MS,
      page_name: names.get(r.page_id) ?? r.page_id,
      rule_name: r.rule_id ? (ruleNames.get(r.rule_id) ?? null) : null,
      post_url: postLink(r.post_id),
    }));
  }

  listRules() {
    return this.prisma.facebookCommentRule.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  }

  async createRule(input: CommentRuleInput, userId: number) {
    const rule = await this.prisma.facebookCommentRule.create({ data: { ...this.sanitize(input, true), created_by: userId } as Prisma.FacebookCommentRuleUncheckedCreateInput });
    trackCommentRuleSaved(rule, true, userId);
    return rule;
  }

  async updateRule(id: number, input: Partial<CommentRuleInput>) {
    await this.findRule(id);
    return this.prisma.facebookCommentRule.update({ where: { id }, data: this.sanitize(input, false) });
  }

  async deleteRule(id: number) {
    await this.findRule(id);
    await this.prisma.facebookCommentRule.delete({ where: { id } });
  }

  /** "Thử luật": chạy so khớp với một bình luận mẫu, KHÔNG ghi gì và KHÔNG gửi gì. */
  async dryRun(input: { message: string; page_id?: string | null; post_id?: string | null; from_name?: string | null }) {
    const page = input.page_id
      ? await this.prisma.facebookPage.findUnique({ where: { page_id: input.page_id }, select: { page_id: true } })
      : await this.prisma.facebookPage.findFirst({ where: { is_active: true }, orderBy: { id: 'asc' }, select: { page_id: true } });
    const pageId = page?.page_id ?? input.page_id ?? '';
    const message = (input.message ?? '').slice(0, 5000);
    const phone = findVnPhone(message);
    const rule = await this.matchRule(pageId, input.post_id ?? '', message);
    return {
      matched_rule: rule ? { id: rule.id, name: rule.name, mode: rule.mode } : null,
      phone_found: phone,
      actions: rule ? this.plan(rule, input.from_name ?? null, phone) : {},
    };
  }

  private async findRule(id: number) {
    const r = await this.prisma.facebookCommentRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Không tìm thấy luật');
    return r;
  }

  private sanitize(input: Partial<CommentRuleInput>, creating: boolean) {
    const d: Record<string, unknown> = {};
    if (input.name !== undefined || creating) {
      const name = (input.name ?? '').trim();
      if (!name) throw new BadRequestException('Đặt tên cho luật');
      d.name = name.slice(0, 120);
    }
    if (input.page_id !== undefined) d.page_id = input.page_id?.trim() || null;
    if (input.post_id !== undefined) d.post_id = normalizePostId(input.post_id, (d.page_id as string | null | undefined) ?? input.page_id ?? null);
    if (input.keywords !== undefined) d.keywords = cleanList(input.keywords);
    if (input.exclude_keywords !== undefined) d.exclude_keywords = cleanList(input.exclude_keywords);
    if (input.public_replies !== undefined) d.public_replies = cleanList(input.public_replies);
    if (input.private_reply !== undefined) d.private_reply = input.private_reply?.trim().slice(0, MAX_TEXT) || null;
    if (input.hide_if_phone !== undefined) d.hide_if_phone = Boolean(input.hide_if_phone);
    if (input.once_per_user !== undefined) d.once_per_user = Boolean(input.once_per_user);
    if (input.mode !== undefined) {
      if (input.mode !== 'test' && input.mode !== 'live') throw new BadRequestException('Chế độ phải là "test" hoặc "live"');
      d.mode = input.mode;
    }
    if (input.is_active !== undefined) d.is_active = Boolean(input.is_active);
    if (input.position !== undefined) d.position = Math.trunc(Number(input.position) || 0);
    return d;
  }
}

const phoneVariants = (local: string): string[] => [local, `84${local.slice(1)}`, `+84${local.slice(1)}`];

function toDate(v: number | string | undefined): Date {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v) {
    const d = new Date(/^\d+$/.test(v) ? Number(v) * 1000 : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Một dòng kết quả luật cho thông báo: "Luật X: đã trả lời công khai, đã nhắn riêng". */
export function autoResultLine(ruleName: string | null, status: string, a: PlannedActions): string | null {
  if (!ruleName) return null;
  if (status === 'test') return `Luật "${ruleName}" (chạy thử)`;
  if (status === 'skipped') return `Luật "${ruleName}": bỏ qua (đã trả lời người này)`;
  const done = [a.public_reply?.id ? 'đã trả lời công khai' : null, a.private_reply?.message_id ? 'đã nhắn riêng' : null, a.hide?.done ? 'đã ẩn vì có SĐT' : null].filter(Boolean);
  const failed = [a.public_reply?.error, a.private_reply?.error, a.hide?.error].filter(Boolean).length;
  return `Luật "${ruleName}": ${done.length ? done.join(', ') : 'chưa làm được'}${failed ? ` (${failed} việc lỗi)` : ''}`;
}

/**
 * Bài nhập dạng link Facebook hoặc id. Graph dùng id `<page>_<post>`: link đã chứa sẵn `<page>_<post>` (link Trinity tạo) thì lấy luôn;
 * link chứa `/posts/<số>` hoặc `story_fbid=<số>` thì ghép với Page của luật. Link `pfbid…` không chứa số bài. Không đọc được ⇒ 400 (đừng lưu luật áp sai bài).
 */
export function normalizePostId(raw: string | null | undefined, pageId: string | null): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const pair = v.match(/(?:^|[^\d])(\d{5,}_\d{5,})(?:$|[^\d])/)?.[1] ?? (/^\d+_\d+$/.test(v) ? v : null);
  if (pair) return pair; // id hoặc link Trinity tạo: facebook.com/<page>_<post>
  const num = v.match(/(?:\/posts\/|story_fbid=|fbid=|\/videos\/|\/permalink\/)(\d{5,})/)?.[1] ?? (/^\d{5,}$/.test(v) ? v : null);
  if (num && pageId) return `${pageId}_${num}`;
  throw new BadRequestException('Không đọc được bài từ link này. Trên Facebook bấm vào giờ đăng của bài rồi chép link có dạng .../posts/<số> (link chứa "pfbid" không dùng được), hoặc chọn bài Trinity đã đăng, hoặc chọn Page trước rồi dán số bài.');
}
