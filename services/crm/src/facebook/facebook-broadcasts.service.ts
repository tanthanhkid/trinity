import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { FacebookBroadcast, FacebookConversation } from '@prisma/client';
import { Prisma, PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import { publishMessengerEvent } from './facebook-events';
import { runInBackground } from '@trinity/rbac-nest';
import { MESSAGING_WINDOW_MS, isWithinMessagingWindow } from './channel';
import { fillTemplate } from './facebook-comments.service';
import { MAX_TEXT } from './facebook-messenger.service';
import { FacebookPagesService } from './facebook-pages.service';
import { GraphApiError, GraphClient } from './graph-client';

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'done' | 'cancelled';
export interface BroadcastAudience {
  /** Chỉ khách thuộc các nguồn này (group_key='contact_source'). */
  source_ids?: number[];
  /** Chỉ khách vào chat qua các link/QR này. */
  chat_link_ids?: number[];
}
export interface BroadcastInput {
  name?: string;
  page_id?: string;
  text?: string;
  audience?: BroadcastAudience;
}

/** Tối đa người nhận một lượt (cửa sổ 24h nên con số thực tế thường nhỏ hơn nhiều). */
export const MAX_RECIPIENTS = 2000;
/** Người nhận ở trạng thái `sending` quá lâu ⇒ không rõ đã gửi chưa ⇒ báo lỗi, không gửi lại. */
const LEASE_MS = 10 * 60_000;
/** Hẹn giờ tối đa 7 ngày (khách phải còn trong 24h lúc gửi nên hẹn xa ít ý nghĩa). */
const MAX_AHEAD_MS = 7 * 86_400_000;
const BATCH = 20;

export interface AudiencePreview {
  /** Số khách còn trong cửa sổ 24h, khớp bộ lọc — sẽ nhận tin nếu gửi ngay. */
  eligible: number;
  /** Khách khớp bộ lọc nhưng đã quá 24h từ tin cuối — Messenger không cho gửi. */
  outside_window: number;
  sample: string[];
}

export type BroadcastView = Omit<FacebookBroadcast, 'audience'> & { page_name: string | null; audience: BroadcastAudience };

const ids = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 2_147_483_647))].slice(0, 50) : [];

export function cleanAudience(a: unknown): BroadcastAudience {
  const o = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
  const out: BroadcastAudience = {};
  const s = ids(o.source_ids);
  const l = ids(o.chat_link_ids);
  if (s.length) out.source_ids = s;
  if (l.length) out.chat_link_ids = l;
  return out;
}

/**
 * Gửi tin hàng loạt qua Messenger của Fanpage. Luật Meta: Page chỉ được nhắn chủ động trong 24 giờ kể từ tin cuối của khách
 * (ngoài cửa sổ cần message tag — không dùng cho tin quảng bá) ⇒ chỉ gửi khách còn trong cửa sổ, kiểm lại ngay trước khi gửi từng người.
 * Danh sách người nhận chốt lúc bắt đầu gửi. Gửi chạy nền theo lô (job mỗi phút / cron tick trên serverless).
 */
@Injectable()
export class FacebookBroadcastsService {
  private readonly logger = new Logger(FacebookBroadcastsService.name);
  private running = false;
  private lastDueCheck = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphClient,
    private readonly pages: FacebookPagesService,
  ) {}

  /* ---------------- Quản trị ---------------- */

  async list(limit = 50): Promise<BroadcastView[]> {
    const rows = await this.prisma.facebookBroadcast.findMany({ orderBy: { id: 'desc' }, take: Math.min(Math.max(limit, 1), 100) });
    return this.view(rows);
  }

  async get(id: number): Promise<BroadcastView> {
    const b = await this.prisma.facebookBroadcast.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Không tìm thấy lượt gửi');
    return (await this.view([b]))[0];
  }

  private async view(rows: FacebookBroadcast[]): Promise<BroadcastView[]> {
    const pages = await this.prisma.facebookPage.findMany({ where: { page_id: { in: [...new Set(rows.map((r) => r.page_id))] } }, select: { page_id: true, name: true } });
    const names = new Map(pages.map((p) => [p.page_id, p.name]));
    return rows.map((r) => ({ ...r, page_name: names.get(r.page_id) ?? null, audience: cleanAudience(r.audience) }));
  }

  /** Người nhận của một lượt (để xem ai đã nhận, ai bị bỏ qua vì quá 24h). */
  async recipients(id: number, limit = 200) {
    await this.get(id);
    const rows = await this.prisma.facebookBroadcastRecipient.findMany({ where: { broadcast_id: id }, orderBy: { id: 'asc' }, take: Math.min(Math.max(limit, 1), 500) });
    const convs = await this.prisma.facebookConversation.findMany({ where: { id: { in: rows.map((r) => r.conversation_id) } }, select: { id: true, customer_name: true, contact_id: true } });
    const by = new Map(convs.map((c) => [c.id, c]));
    return rows.map((r) => ({ ...r, customer_name: by.get(r.conversation_id)?.customer_name ?? null, contact_id: by.get(r.conversation_id)?.contact_id ?? null }));
  }

  /** Kiểm đầu vào; trả bản đã chuẩn hoá. `partial` = sửa (trường nào thiếu thì giữ). */
  async validate(input: BroadcastInput, partial = false): Promise<{ name?: string; page_id?: string; text?: string; audience?: BroadcastAudience }> {
    const out: { name?: string; page_id?: string; text?: string; audience?: BroadcastAudience } = {};
    if (input.name !== undefined || !partial) {
      const name = (input.name ?? '').trim();
      if (!name) throw new BadRequestException('Đặt tên cho lượt gửi (vd "Báo lịch khai giảng").');
      out.name = name.slice(0, 120);
    }
    if (input.page_id !== undefined || !partial) {
      const page = await this.prisma.facebookPage.findFirst({ where: { page_id: input.page_id ?? '', is_active: true } });
      if (!page) throw new BadRequestException('Chọn Fanpage đang kết nối.');
      out.page_id = page.page_id;
    }
    if (input.text !== undefined || !partial) {
      const text = (input.text ?? '').trim();
      if (!text) throw new BadRequestException('Nhập nội dung tin.');
      if (text.length > MAX_TEXT) throw new BadRequestException(`Nội dung tối đa ${MAX_TEXT} ký tự.`);
      out.text = text;
    }
    if (input.audience !== undefined) out.audience = cleanAudience(input.audience);
    return out;
  }

  async create(input: BroadcastInput, userId: number, source = 'web'): Promise<BroadcastView> {
    const v = await this.validate(input);
    const b = await this.prisma.facebookBroadcast.create({
      data: { name: v.name!, page_id: v.page_id!, text: v.text!, audience: (v.audience ?? {}) as Prisma.InputJsonValue, created_by: userId, source },
    });
    return this.get(b.id);
  }

  async update(id: number, input: BroadcastInput): Promise<BroadcastView> {
    const b = await this.get(id);
    if (b.status !== 'draft' && b.status !== 'scheduled') throw new BadRequestException('Lượt gửi đã chạy — không sửa được nữa.');
    const v = await this.validate(input, true);
    // Có điều kiện: lượt vừa tới giờ và chuyển sang "đang gửi" thì không sửa nữa (người nhận đã chốt theo bản cũ).
    const n = await this.prisma.facebookBroadcast.updateMany({ where: { id, status: { in: ['draft', 'scheduled'] } }, data: { ...v, audience: v.audience as Prisma.InputJsonValue | undefined } });
    if (n.count !== 1) throw new BadRequestException('Lượt gửi vừa bắt đầu chạy — không sửa được nữa.');
    return this.get(id);
  }

  /** Xoá lượt nháp/đã huỷ/đã xong (tin đã gửi giữ nguyên trong hộp thư). Đang gửi thì phải huỷ trước. */
  async remove(id: number): Promise<void> {
    const b = await this.get(id);
    if (b.status === 'sending' || b.status === 'scheduled') throw new BadRequestException('Lượt gửi đang chờ/đang chạy — bấm Huỷ trước.');
    await this.prisma.$transaction([
      this.prisma.facebookBroadcastRecipient.deleteMany({ where: { broadcast_id: id } }),
      this.prisma.facebookBroadcast.delete({ where: { id } }),
    ]);
  }

  /** Khách khớp bộ lọc trong cửa sổ 24h (danh sách thật để chốt người nhận) + số khách khớp nhưng đã quá 24h. */
  private async audience(pageId: string, a: BroadcastAudience, now: number): Promise<{ eligible: FacebookConversation[]; outside: number }> {
    const since = new Date(now - MESSAGING_WINDOW_MS);
    const base: Prisma.FacebookConversationWhereInput = { page_id: pageId };
    if (a.chat_link_ids?.length) base.entry_link_id = { in: a.chat_link_ids };
    const inWindow = await this.prisma.facebookConversation.findMany({ where: { ...base, last_inbound_at: { gte: since } }, orderBy: { last_inbound_at: 'desc' }, take: MAX_RECIPIENTS * 2 });
    let eligible = inWindow;
    if (a.source_ids?.length) {
      const contactIds = inWindow.map((c) => c.contact_id).filter((x): x is number => x !== null);
      const ok = new Set((await this.prisma.contact.findMany({ where: { id: { in: contactIds }, source_id: { in: a.source_ids } }, select: { id: true } })).map((c) => c.id));
      eligible = inWindow.filter((c) => c.contact_id !== null && ok.has(c.contact_id));
    }
    const outsideWhere: Prisma.FacebookConversationWhereInput = { ...base, OR: [{ last_inbound_at: { lt: since } }, { last_inbound_at: null }] };
    if (a.source_ids?.length) {
      const contactIds = (await this.prisma.contact.findMany({ where: { source_id: { in: a.source_ids } }, select: { id: true }, take: 50_000 })).map((c) => c.id);
      outsideWhere.contact_id = { in: contactIds };
    }
    const outside = await this.prisma.facebookConversation.count({ where: outsideWhere });
    return { eligible: eligible.slice(0, MAX_RECIPIENTS), outside };
  }

  async preview(pageId: string, audience: unknown, now = Date.now()): Promise<AudiencePreview> {
    const page = await this.prisma.facebookPage.findFirst({ where: { page_id: pageId, is_active: true } });
    if (!page) throw new BadRequestException('Chọn Fanpage đang kết nối.');
    const r = await this.audience(pageId, cleanAudience(audience), now);
    return { eligible: r.eligible.length, outside_window: r.outside, sample: r.eligible.slice(0, 5).map((c) => c.customer_name ?? 'Khách') };
  }

  /** Giờ gửi thật: bỏ trống/đã qua = ngay; quá 7 ngày ⇒ lỗi. Tool AI gọi trước để bản xem trước không hợp lệ giả. */
  sendTime(at?: string | null, now = Date.now()): Date {
    if (!at) return new Date(now);
    const t = Date.parse(at);
    if (Number.isNaN(t)) throw new BadRequestException('Giờ hẹn không hợp lệ.');
    if (t > now + MAX_AHEAD_MS) throw new BadRequestException('Hẹn tối đa 7 ngày tới — Messenger chỉ cho nhắn khách trong 24 giờ từ tin cuối của họ, nên hẹn xa thường không còn ai nhận.');
    return new Date(Math.max(t, now));
  }

  /** Gửi ngay hoặc hẹn giờ (`at`). Người nhận chốt lúc tới giờ gửi. */
  async send(id: number, at?: string | null, now = Date.now()): Promise<BroadcastView> {
    const b = await this.get(id);
    if (b.status !== 'draft' && b.status !== 'scheduled') throw new BadRequestException('Lượt này đã gửi hoặc đã huỷ — tạo lượt mới.');
    const when = this.sendTime(at, now);
    // Có điều kiện: luồng nền vừa chốt (đang gửi) thì không kéo lượt về "chờ gửi".
    const n = await this.prisma.facebookBroadcast.updateMany({ where: { id, status: { in: ['draft', 'scheduled'] } }, data: { status: 'scheduled', scheduled_at: when } });
    if (n.count !== 1) throw new BadRequestException('Lượt này vừa bắt đầu gửi — không đổi giờ được nữa.');
    return this.get(id);
  }

  /** Huỷ: lượt chưa chạy thì về đã huỷ; đang gửi thì dừng, người chưa gửi ghi "bỏ qua". */
  /** Chỉ huỷ khi lượt CÒN đang chờ (chưa ai nhận) — đổi trạng thái có điều kiện, không đua với lúc bắt đầu gửi. */
  async cancelPending(id: number): Promise<BroadcastView> {
    const n = await this.prisma.facebookBroadcast.updateMany({ where: { id, status: 'scheduled' }, data: { status: 'cancelled', finished_at: new Date() } });
    if (n.count !== 1) {
      const b = await this.get(id);
      throw new BadRequestException(b.status === 'sending' ? 'Lượt này vừa bắt đầu gửi — dừng ở màn Gửi hàng loạt của Trinity.' : 'Chỉ huỷ được lượt đang chờ tới giờ gửi.');
    }
    return this.get(id);
  }

  async cancel(id: number): Promise<BroadcastView> {
    const b = await this.get(id);
    if (b.status === 'done' || b.status === 'cancelled') throw new BadRequestException('Lượt gửi đã kết thúc.');
    if (b.status === 'draft') throw new BadRequestException('Lượt nháp chưa gửi — không cần huỷ.');
    const n = await this.prisma.facebookBroadcastRecipient.updateMany({ where: { broadcast_id: id, status: 'queued' }, data: { status: 'skipped', note: 'Đã huỷ lượt gửi' } });
    await this.prisma.facebookBroadcast.update({ where: { id }, data: { status: 'cancelled', finished_at: new Date(), skipped: { increment: n.count } } });
    return this.get(id);
  }

  /* ---------------- Chạy nền ---------------- */

  /** Gửi ngay sau request (serverless: giữ hàm sống tới khi xong; VPS: chạy nền). Không chạy chồng trong cùng process. */
  kick(): void {
    if (this.running) return;
    this.running = true;
    runInBackground(
      () => this.runDue(40_000).finally(() => (this.running = false)),
      (err) => this.logger.error(`Gửi hàng loạt nền lỗi: ${(err as Error)?.message}`),
    );
  }

  /**
   * Serverless không có timer và Vercel Cron gói thường chỉ chạy mỗi ngày ⇒ web đang mở gọi `POST facebook/broadcasts/tick` mỗi phút
   * để lượt hẹn giờ / lượt đang gửi dở chạy tiếp. Mỗi instance kiểm DB tối đa một lần mỗi 20 giây.
   */
  /** Giờ lượt gửi hàng loạt kế tiếp: đang gửi dở ⇒ bây giờ; hẹn giờ ⇒ giờ hẹn sớm nhất; không có ⇒ null. */
  async nextDueAt(now = Date.now()): Promise<Date | null> {
    const sending = await this.prisma.facebookBroadcast.findFirst({ where: { status: 'sending' }, select: { id: true } });
    if (sending) return new Date(now);
    const r = await this.prisma.facebookBroadcast.aggregate({ where: { status: 'scheduled' }, _min: { scheduled_at: true } });
    return r._min.scheduled_at ?? null;
  }

  async kickIfDue(now = Date.now()): Promise<{ due: boolean }> {
    if (this.running || now - this.lastDueCheck < 20_000) return { due: false };
    this.lastDueCheck = now;
    const due = await this.prisma.facebookBroadcast.findFirst({
      where: { OR: [{ status: 'scheduled', scheduled_at: { lte: new Date(now) } }, { status: 'sending' }] },
      select: { id: true },
    });
    if (due) this.kick();
    return { due: Boolean(due) };
  }

  /** Bắt đầu các lượt đã tới giờ (chốt người nhận), rồi gửi tiếp các lượt đang chạy trong `budgetMs`. */
  async runDue(budgetMs: number, now = Date.now()): Promise<{ started: number; sent: number; failed: number; skipped: number }> {
    const t0 = Date.now();
    const out = { started: 0, sent: 0, failed: 0, skipped: 0 };
    const due = await this.prisma.facebookBroadcast.findMany({ where: { status: 'scheduled', scheduled_at: { lte: new Date(now) } }, orderBy: { scheduled_at: 'asc' }, take: 5 });
    for (const b of due) if (await this.start(b, now)) out.started++;
    await this.sweepStale(now);
    const running = await this.prisma.facebookBroadcast.findMany({ where: { status: 'sending' }, orderBy: { id: 'asc' }, take: 5 });
    for (const b of running) {
      while (Date.now() - t0 < budgetMs) {
        const r = await this.sendBatch(b);
        out.sent += r.sent;
        out.failed += r.failed;
        out.skipped += r.skipped;
        if (r.left === 0) break;
      }
    }
    return out;
  }

  /** Chốt danh sách người nhận (khách trong 24h khớp bộ lọc). Chỉ một tiến trình thắng nhờ updateMany theo trạng thái. */
  private async start(due: FacebookBroadcast, now: number): Promise<boolean> {
    // Chốt có điều kiện CẢ giờ gửi: lượt vừa bị dời giờ (sửa) sau lúc liệt kê thì chưa tới lượt.
    const claimed = await this.prisma.facebookBroadcast.updateMany({ where: { id: due.id, status: 'scheduled', scheduled_at: { lte: new Date(now) } }, data: { status: 'sending', started_at: new Date(now) } });
    if (claimed.count === 0) return false;
    // Đọc lại SAU khi chốt: bản liệt kê có thể đã cũ (vừa sửa nội dung / bộ lọc); từ giờ lượt là "đang gửi" nên không ai sửa được nữa.
    const b = await this.prisma.facebookBroadcast.findUnique({ where: { id: due.id } });
    if (!b) return false;
    const { eligible } = await this.audience(b.page_id, cleanAudience(b.audience), now);
    if (eligible.length) {
      await this.prisma.facebookBroadcastRecipient.createMany({ data: eligible.map((c) => ({ broadcast_id: b.id, conversation_id: c.id })), skipDuplicates: true });
    }
    await this.prisma.facebookBroadcast.update({
      where: { id: b.id },
      data: eligible.length ? { total: eligible.length } : { total: 0, status: 'done', finished_at: new Date(now) },
    });
    return true;
  }

  /** Người nhận kẹt ở `sending` (tiến trình chết giữa chừng) ⇒ lỗi, không gửi lại. */
  private async sweepStale(now: number): Promise<void> {
    const stale = await this.prisma.facebookBroadcastRecipient.findMany({ where: { status: 'sending', claimed_at: { lt: new Date(now - LEASE_MS) } }, select: { id: true, broadcast_id: true }, take: 200 });
    for (const s of stale) {
      const n = await this.prisma.facebookBroadcastRecipient.updateMany({ where: { id: s.id, status: 'sending' }, data: { status: 'failed', note: 'Bị gián đoạn khi đang gửi — không rõ khách đã nhận chưa' } });
      if (n.count) await this.prisma.facebookBroadcast.update({ where: { id: s.broadcast_id }, data: { failed: { increment: 1 } } });
    }
  }

  private async sendBatch(b: FacebookBroadcast): Promise<{ sent: number; failed: number; skipped: number; left: number }> {
    const r = { sent: 0, failed: 0, skipped: 0, left: 0 };
    const cur = await this.prisma.facebookBroadcast.findUnique({ where: { id: b.id }, select: { status: true } });
    if (cur?.status !== 'sending') return r;
    const queue = await this.prisma.facebookBroadcastRecipient.findMany({ where: { broadcast_id: b.id, status: 'queued' }, orderBy: { id: 'asc' }, take: BATCH });
    if (queue.length === 0) {
      await this.finishIfDone(b.id);
      return r;
    }
    const ctx = await this.pages.activePageWithToken(b.page_id);
    for (const q of queue) {
      const claim = await this.prisma.facebookBroadcastRecipient.updateMany({ where: { id: q.id, status: 'queued' }, data: { status: 'sending', claimed_at: new Date() } });
      if (claim.count === 0) continue;
      const res = await this.deliver(b, q.conversation_id, ctx);
      await this.prisma.facebookBroadcastRecipient.update({ where: { id: q.id }, data: { status: res.status, note: res.note?.slice(0, 300) ?? null, sent_at: res.status === 'sent' ? new Date() : null } });
      await this.prisma.facebookBroadcast.update({ where: { id: b.id }, data: { [res.status === 'sent' ? 'sent' : res.status === 'failed' ? 'failed' : 'skipped']: { increment: 1 } } });
      r[res.status]++;
      if (res.stopAll) {
        // Page mất kết nối: phần còn lại báo lỗi luôn, không thử từng người.
        const n = await this.prisma.facebookBroadcastRecipient.updateMany({ where: { broadcast_id: b.id, status: 'queued' }, data: { status: 'failed', note: res.note ?? 'Fanpage mất kết nối' } });
        await this.prisma.facebookBroadcast.update({ where: { id: b.id }, data: { failed: { increment: n.count } } });
        r.failed += n.count;
        break;
      }
    }
    r.left = await this.prisma.facebookBroadcastRecipient.count({ where: { broadcast_id: b.id, status: 'queued' } });
    if (r.left === 0) await this.finishIfDone(b.id);
    return r;
  }

  private async deliver(
    b: FacebookBroadcast,
    conversationId: number,
    ctx: { token: string } | null,
  ): Promise<{ status: 'sent' | 'failed' | 'skipped'; note?: string; stopAll?: boolean }> {
    if (!ctx) return { status: 'failed', note: 'Fanpage đã tắt hoặc mất kết nối', stopAll: true };
    const conv = await this.prisma.facebookConversation.findUnique({ where: { id: conversationId } });
    if (!conv) return { status: 'skipped', note: 'Hội thoại không còn' };
    if (!isWithinMessagingWindow(conv.last_inbound_at)) return { status: 'skipped', note: 'Quá 24 giờ kể từ tin cuối của khách — Messenger không cho gửi' };
    const text = fillTemplate(b.text, conv.customer_name);
    try {
      const res = await this.graph.sendText(ctx.token, conv.psid, text);
      await this.recordOut(conv, res.message_id, text, b);
      return { status: 'sent' };
    } catch (err) {
      if (err instanceof GraphApiError) {
        if (err.isOutsideWindow) return { status: 'skipped', note: 'Quá 24 giờ kể từ tin cuối của khách' };
        if (err.isTokenError) {
          await this.pages.markTokenInvalid(b.page_id);
          return { status: 'failed', note: 'Fanpage mất kết nối (token hết hạn) — kết nối lại rồi tạo lượt mới', stopAll: true };
        }
      }
      this.logger.warn(`Gửi hàng loạt #${b.id} → hội thoại ${conversationId} lỗi: ${(err as Error).message}`);
      return { status: 'failed', note: `Facebook không nhận tin: ${(err as Error).message}` };
    }
  }

  private async finishIfDone(id: number): Promise<void> {
    const pending = await this.prisma.facebookBroadcastRecipient.count({ where: { broadcast_id: id, status: { in: ['queued', 'sending'] } } });
    if (pending > 0) return;
    const r = await this.prisma.facebookBroadcast.updateMany({ where: { id, status: 'sending' }, data: { status: 'done', finished_at: new Date() } });
    if (!r.count) return;
    const b = await this.prisma.facebookBroadcast.findUnique({ where: { id } });
    if (!b) return;
    await publishIntegrationEvent(
      this.prisma,
      'messenger.broadcast_finished',
      { broadcast_id: b.id, page_id: b.page_id, name: b.name, status: b.status, total: b.total, sent: b.sent, failed: b.failed, skipped: b.skipped },
      { resourceId: b.id, actorUserId: b.created_by },
    ).catch((e) => this.logger.warn(`Sự kiện webhook lượt gửi xong lỗi: ${(e as Error).message}`));
  }

  /** Lưu tin vào hộp thư + ghi lịch sử khách. Echo của Meta tới sau bị bỏ qua vì trùng `mid`. */
  private async recordOut(conv: FacebookConversation, mid: string, text: string, b: FacebookBroadcast): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.$transaction([
        this.prisma.facebookMessage.create({ data: { conversation_id: conv.id, mid, direction: 'out', text, sent_at: now } }),
        this.prisma.facebookConversation.update({ where: { id: conv.id }, data: { last_message_at: now, last_message_preview: text.slice(0, 200) } }),
      ]);
      await publishMessengerEvent(this.prisma, conv, 'out', 'broadcast', b.created_by).catch((e) => this.logger.warn(`Sự kiện webhook tin gửi hàng loạt lỗi: ${(e as Error).message}`));
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
    if (conv.contact_id) {
      await this.prisma.activity.create({
        data: {
          contact_id: conv.contact_id,
          action: 'note',
          details: { description: `Gửi tin hàng loạt "${b.name}" qua Messenger: ${text}`.slice(0, 2000), source: 'facebook_messenger' },
          metadata: { facebook_page_id: conv.page_id, psid: conv.psid, broadcast_id: b.id } as Prisma.InputJsonObject,
          created_by: b.created_by,
        },
      });
    }
  }
}
