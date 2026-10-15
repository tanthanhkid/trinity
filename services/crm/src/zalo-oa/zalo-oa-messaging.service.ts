import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { MessageChannel, OutboundMessage, SendResult } from '../messaging/message-channel.interface';
import { ZaloOaApiClient } from './zalo-oa-api.client';
import { ZaloOaContactLinker } from './zalo-oa-contact-linker.service';
import { ZaloOaThreadsService } from './zalo-oa-threads.service';
import { ZaloOaTokenService } from './zalo-oa-token.service';
import { CONSULT_WINDOW_MS, toZaloPhone, zaloOaConfig } from './zalo-oa.config';
import { ZaloApiError, describeZaloError } from './zalo-oa.errors';

/** Gửi tin tư vấn (≤48h) và ZNS. Cài `MessageChannel` để bot AI / bản tin dùng chung. */
@Injectable()
export class ZaloOaMessagingService implements MessageChannel {
  readonly id = 'zalo_oa';
  private readonly logger = new Logger(ZaloOaMessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: ZaloOaApiClient,
    private readonly tokens: ZaloOaTokenService,
    private readonly threads: ZaloOaThreadsService,
    private readonly linker: ZaloOaContactLinker,
  ) {}

  async isReady(): Promise<boolean> {
    return (await this.tokens.status()).connected;
  }

  /** Trong cửa sổ 48h kể từ tin gần nhất của khách? */
  static inConsultWindow(lastInboundAt: Date | null, now = Date.now()): boolean {
    return lastInboundAt !== null && now - lastInboundAt.getTime() <= CONSULT_WINDOW_MS;
  }

  async sendText(threadId: number, text: string, sentBy: number | null): Promise<{ message_id: string | null }> {
    const body = text.trim();
    if (!body || body.length > 2000) throw new BadRequestException('Nội dung tin phải từ 1 đến 2000 ký tự');
    const thread = await this.threads.get(threadId);
    if (!ZaloOaMessagingService.inConsultWindow(thread.last_inbound_at)) {
      throw new BadRequestException('Đã quá 48 giờ kể từ tin gần nhất của khách — Zalo không cho gửi tin tư vấn. Hãy dùng ZNS.');
    }
    const { token } = await this.tokens.getAccessToken();
    let r: { msg_id: string | null };
    try {
      r = await this.api.sendText(token, thread.zalo_user_id, body);
    } catch (err) {
      throw await this.fail(err, threadId, body, sentBy);
    }
    // Zalo đã nhận tin: lỗi ghi lịch sử không được biến thành lỗi gửi (người dùng sẽ gửi lại, khách nhận hai lần).
    try {
      await this.threads.record({ threadId, direction: 'out', kind: 'text', msgId: r.msg_id, text: body, status: 'sent', sentBy });
    } catch (e) {
      this.logger.error(`Tin Zalo OA đã gửi nhưng không ghi được lịch sử: ${(e as Error)?.message}`);
    }
    return { message_id: r.msg_id };
  }

  async sendZns(p: { phone: string; templateId: string; templateData: Record<string, string>; trackingId?: string; sentBy: number | null }) {
    const phone = toZaloPhone(p.phone);
    if (!phone) throw new BadRequestException('Số điện thoại không hợp lệ (cần SĐT Việt Nam)');
    const { token } = await this.tokens.getAccessToken();
    const thread = await this.prisma.zaloOaThread.findFirst({ where: { phone: { in: this.linker.phoneVariants(phone) } }, select: { id: true } });
    let r: Awaited<ReturnType<ZaloOaApiClient['sendZns']>>;
    try {
      r = await this.api.sendZns(token, { phone, templateId: p.templateId, templateData: p.templateData, trackingId: p.trackingId, mode: zaloOaConfig().znsMode });
    } catch (err) {
      throw await this.fail(err, thread?.id ?? null, null, p.sentBy);
    }
    if (thread) {
      try {
        await this.threads.record({
          threadId: thread.id, direction: 'out', kind: 'zns', msgId: r.msg_id, text: null,
          payload: { template_id: p.templateId }, status: 'sent', sentBy: p.sentBy,
        });
      } catch (e) {
        this.logger.error(`ZNS đã gửi nhưng không ghi được lịch sử: ${(e as Error)?.message}`);
      }
    }
    return { message_id: r.msg_id, quota: r.quota };
  }

  /** Ghi tin lỗi (nếu có hội thoại), đánh dấu cần kết nối lại khi lỗi token, đổi sang BadRequest tiếng Việt. */
  private async fail(err: unknown, threadId: number | null, text: string | null, sentBy: number | null): Promise<Error> {
    if (!(err instanceof ZaloApiError)) {
      this.logger.error(`Gửi Zalo OA lỗi: ${(err as Error)?.message}`);
      return err as Error;
    }
    // Nguyên văn lỗi Zalo chỉ vào log (không chứa token) để chẩn đoán; người dùng thấy câu đã dịch.
    this.logger.warn(`Zalo từ chối ${text === null ? 'ZNS' : 'tin tư vấn'} (mã ${err.code}${err.httpStatus ? `, HTTP ${err.httpStatus}` : ''}): ${err.message.slice(0, 300)}`);
    const msg = describeZaloError(err, text === null ? 'zns' : 'consult');
    if (err.isAuthError) {
      const c = await this.tokens.getConnection();
      if (c) await this.tokens.markNeedsReauth(c.oa_id, `Zalo báo token lỗi (mã ${err.code})`);
    }
    if (threadId !== null) {
      await this.threads.record({ threadId, direction: 'out', kind: text === null ? 'zns' : 'text', msgId: null, text, status: 'failed', error: msg, sentBy });
    }
    return new BadRequestException(msg);
  }

  async send(m: OutboundMessage): Promise<SendResult> {
    try {
      if (m.template) {
        if (!m.to.phone) return { ok: false, messageId: null, error: 'ZNS cần số điện thoại người nhận' };
        const r = await this.sendZns({ phone: m.to.phone, templateId: m.template.id, templateData: m.template.data, trackingId: m.template.trackingId, sentBy: m.sentBy ?? null });
        return { ok: true, messageId: r.message_id };
      }
      if (!m.text) return { ok: false, messageId: null, error: 'Thiếu nội dung tin' };
      const thread = await this.findThread(m.to);
      if (!thread) return { ok: false, messageId: null, error: 'Chưa có hội thoại Zalo OA với người nhận' };
      const r = await this.sendText(thread, m.text, m.sentBy ?? null);
      return { ok: true, messageId: r.message_id };
    } catch (err) {
      return { ok: false, messageId: null, error: err instanceof BadRequestException ? err.message : 'Gửi Zalo OA thất bại' };
    }
  }

  private async findThread(to: OutboundMessage['to']): Promise<number | null> {
    const where = to.externalUserId ? { zalo_user_id: to.externalUserId } : to.contactId ? { contact_id: to.contactId } : null;
    if (!where) return null;
    return (await this.prisma.zaloOaThread.findFirst({ where, orderBy: { last_message_at: 'desc' }, select: { id: true } }))?.id ?? null;
  }
}
