import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { can, type Grants } from '@trinity/rbac';
import { PrismaService } from '@trinity/prisma';
import { autoResultLine, commentAnswered, type PlannedActions } from '../facebook/facebook-comments.service';
import { OrgFeaturesService } from '../settings/org-features.service';
import { vnTodayRange } from '../reports/dashboard-overview.util';

export type InteractionChannel = 'facebook' | 'zalo';
export type InteractionType = 'comment' | 'message';
/** unanswered = chưa ai trả lời · auto = luật/AI đã trả lời · staff = nhân viên đã trả lời · answered = Page đã trả lời (tin nhắn). */
export type InteractionStatus = 'unanswered' | 'auto' | 'staff' | 'answered';

export interface Interaction {
  key: string;
  channel: InteractionChannel;
  type: InteractionType;
  page_id: string | null;
  channel_name: string;
  at: string;
  customer_name: string | null;
  contact_id: number | null;
  text: string | null;
  post_url: string | null;
  rule_name: string | null;
  auto_result: string | null;
  hidden: boolean;
  status: InteractionStatus;
  /** Mở chi tiết: comment_id (bình luận), conversation_id (Messenger), thread_id (Zalo OA). */
  ref: { comment_id?: string; conversation_id?: number; thread_id?: number };
}

export interface InteractionQuery {
  channel?: InteractionChannel;
  type?: InteractionType;
  page_id?: string;
  status?: 'unanswered';
  /** true = chỉ bình luận có luật chạy; false = chỉ bình luận không có luật. */
  has_rule?: boolean;
  from?: Date;
  to?: Date;
  q?: string;
  limit?: number;
  /** Phân trang lùi theo thời gian: chỉ lấy mục cũ hơn mốc này. */
  before?: Date;
}

const postLink = (postId: string) => `https://www.facebook.com/${postId}`;

/**
 * "Tương tác": một dòng thời gian gộp bình luận Fanpage, hội thoại Messenger và Zalo OA — kèm luật đã chạy, kết quả, trạng thái
 * trả lời. Mỗi nguồn chỉ hiện khi tính năng của nó bật VÀ người xem có quyền như hộp thư từng kênh (Fanpage: integrations.webhooks,
 * Zalo OA: contacts.update). Dùng chung cho màn Tương tác và tool list_interactions.
 */
@Injectable()
export class InteractionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly features: OrgFeaturesService,
  ) {}

  private async sources(grants: Grants) {
    const f = await this.features.get();
    const inbox = f.inbox !== false;
    return {
      facebook: inbox && f.facebook_page !== false && can(grants, 'integrations.webhooks'),
      zalo: inbox && f.zalo_oa !== false && can(grants, 'contacts.update'),
    };
  }

  async list(grants: Grants, q: InteractionQuery = {}): Promise<{ data: Interaction[]; next_before: string | null }> {
    const src = await this.sources(grants);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const time = (field: string) => ({ ...(q.from || q.to || q.before ? { [field]: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}), ...(q.before ? { lt: q.before } : {}) } } : {}) });
    const text = q.q?.trim();
    const wantComments = src.facebook && q.channel !== 'zalo' && q.type !== 'message';
    const wantFbMsg = src.facebook && q.channel !== 'zalo' && q.type !== 'comment' && q.has_rule === undefined;
    const wantZalo = src.zalo && q.channel !== 'facebook' && q.type !== 'comment' && q.has_rule === undefined && !q.page_id;
    // Lọc "chưa trả lời" của bình luận nằm trong JSON ⇒ lấy rộng hơn rồi lọc.
    const take = q.status === 'unanswered' ? Math.min(limit * 4, 300) : limit;

    const [comments, convs, threads, pages] = await Promise.all([
      wantComments
        ? this.prisma.facebookComment.findMany({
          where: {
            ...time('commented_at'),
            ...(q.page_id ? { page_id: q.page_id } : {}),
            ...(q.has_rule === true ? { rule_id: { not: null } } : q.has_rule === false ? { rule_id: null } : {}),
            ...(text ? { OR: [{ message: { contains: text, mode: 'insensitive' } }, { from_name: { contains: text, mode: 'insensitive' } }] } : {}),
          } as Prisma.FacebookCommentWhereInput,
          orderBy: { commented_at: 'desc' },
          take,
        })
        : Promise.resolve([]),
      wantFbMsg
        ? this.prisma.facebookConversation.findMany({
          where: {
            ...time('last_message_at'),
            ...(q.page_id ? { page_id: q.page_id } : {}),
            ...(text ? { OR: [{ customer_name: { contains: text, mode: 'insensitive' } }, { last_message_preview: { contains: text, mode: 'insensitive' } }] } : {}),
          } as Prisma.FacebookConversationWhereInput,
          orderBy: { last_message_at: 'desc' },
          take,
        })
        : Promise.resolve([]),
      wantZalo
        ? this.prisma.zaloOaThread.findMany({
          where: {
            last_message_at: { not: null, ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}), ...(q.before ? { lt: q.before } : {}) },
            ...(text ? { OR: [{ display_name: { contains: text, mode: 'insensitive' } }, { last_message_preview: { contains: text, mode: 'insensitive' } }] } : {}),
          } as Prisma.ZaloOaThreadWhereInput,
          orderBy: { last_message_at: 'desc' },
          take,
        })
        : Promise.resolve([]),
      this.prisma.facebookPage.findMany({ select: { page_id: true, name: true } }),
    ]);
    const pageName = new Map(pages.map((p) => [p.page_id, p.name]));
    const ruleIds = [...new Set(comments.map((c) => c.rule_id).filter((x): x is number => x != null))];
    const rules = ruleIds.length ? await this.prisma.facebookCommentRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } }) : [];
    const ruleName = new Map(rules.map((r) => [r.id, r.name]));

    const items: Interaction[] = [
      ...comments.map((c): Interaction => {
        const a = (c.actions ?? {}) as PlannedActions;
        const rn = c.rule_id ? (ruleName.get(c.rule_id) ?? null) : null;
        const status: InteractionStatus = a.manual?.length ? 'staff' : commentAnswered(c) ? 'auto' : 'unanswered';
        return {
          key: `fb-comment:${c.id}`, channel: 'facebook', type: 'comment', page_id: c.page_id, channel_name: pageName.get(c.page_id) ?? 'Fanpage',
          at: c.commented_at.toISOString(), customer_name: c.from_name, contact_id: c.contact_id, text: c.message, post_url: postLink(c.post_id),
          rule_name: rn, auto_result: autoResultLine(rn, c.status, a), hidden: c.hidden, status, ref: { comment_id: c.id.toString() },
        };
      }),
      ...convs.map((c): Interaction => ({
        key: `fb-conv:${c.id}`, channel: 'facebook', type: 'message', page_id: c.page_id, channel_name: pageName.get(c.page_id) ?? 'Fanpage',
        at: c.last_message_at.toISOString(), customer_name: c.customer_name, contact_id: c.contact_id, text: c.last_message_preview, post_url: null,
        rule_name: null, auto_result: null, hidden: false,
        status: c.last_inbound_at && c.last_inbound_at.getTime() >= c.last_message_at.getTime() ? 'unanswered' : 'answered',
        ref: { conversation_id: c.id },
      })),
      ...threads.map((t): Interaction => ({
        key: `zalo-thread:${t.id}`, channel: 'zalo', type: 'message', page_id: null, channel_name: 'Zalo OA',
        at: (t.last_message_at as Date).toISOString(), customer_name: t.display_name, contact_id: t.contact_id, text: t.last_message_preview, post_url: null,
        rule_name: null, auto_result: null, hidden: false,
        status: t.last_inbound_at && t.last_message_at && t.last_inbound_at.getTime() >= t.last_message_at.getTime() ? 'unanswered' : 'answered',
        ref: { thread_id: t.id },
      })),
    ];
    const filtered = (q.status === 'unanswered' ? items.filter((i) => i.status === 'unanswered') : items).sort((x, y) => y.at.localeCompare(x.at));
    const page = filtered.slice(0, limit);
    return { data: page, next_before: filtered.length > limit ? page[page.length - 1].at : null };
  }

  /** Số đầu trang hôm nay (giờ VN): tin khách gửi tới, bình luận, việc chưa trả lời, bình luận luật đã tự xử lý. */
  async stats(grants: Grants, now = new Date()) {
    const src = await this.sources(grants);
    const { start, end } = vnTodayRange(now);
    const today = { gte: start, lt: end };
    const [fbIn, zaloIn, comments, auto, unanswered] = await Promise.all([
      src.facebook ? this.prisma.facebookMessage.count({ where: { direction: 'in', sent_at: today } }) : 0,
      src.zalo ? this.prisma.zaloOaMessage.count({ where: { direction: 'in', created_at: today } }) : 0,
      src.facebook ? this.prisma.facebookComment.count({ where: { commented_at: today } }) : 0,
      src.facebook ? this.prisma.facebookComment.count({ where: { commented_at: today, rule_id: { not: null }, status: { in: ['done', 'test'] } } }) : 0,
      this.list(grants, { status: 'unanswered', from: new Date(now.getTime() - 7 * 86_400_000), limit: 100 }).then((r) => r.data.length),
    ]);
    return { messages_today: fbIn + zaloIn, comments_today: comments, auto_handled_today: auto, unanswered_7d: unanswered, channels: src };
  }
}
