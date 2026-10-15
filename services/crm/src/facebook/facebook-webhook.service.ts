import { ForbiddenException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OrgFeaturesService } from '../settings/org-features.service';
import { PrismaService } from '@trinity/prisma';
import { FORWARDED_HEADER, loadFacebookConfig, webhookForwardUrl } from './facebook.config';
import { verifyMetaSignature } from './facebook-signature';
import { FacebookLeadsService, type LeadgenChange } from './facebook-leads.service';
import { FacebookMessengerService, type MessagingEvent } from './facebook-messenger.service';
import { FacebookCommentsService, type FeedChange } from './facebook-comments.service';
import { FacebookFlowsService } from './facebook-flows.service';
import { safeEqual } from '../integrations/oauth/oauth-crypto';

interface WebhookEntry {
  id?: string;
  messaging?: MessagingEvent[];
  changes?: Array<{ field?: string; value?: LeadgenChange & FeedChange }>;
}
export interface WebhookBody {
  object?: string;
  entry?: WebhookEntry[];
}

/**
 * Webhook Meta: GET xác minh (`hub.verify_token`) + POST sự kiện (chữ ký `X-Hub-Signature-256` bằng app secret).
 * Phải trả 200 trong ≤5 giây, và Meta gửi lại khi lỗi nên xử lý idempotent.
 * Docs: https://developers.facebook.com/docs/messenger-platform/webhooks
 */
@Injectable()
export class FacebookWebhookService {
  private readonly logger = new Logger(FacebookWebhookService.name);

  constructor(
    private readonly messenger: FacebookMessengerService,
    private readonly leads: FacebookLeadsService,
    private readonly comments: FacebookCommentsService,
    private readonly flows: FacebookFlowsService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly prisma: PrismaService,
  ) {}

  /** Bước xác minh khi khai webhook trong App Dashboard. Trả chuỗi `hub.challenge`. */
  verify(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    const expected = loadFacebookConfig().verifyToken;
    if (!expected || mode !== 'subscribe' || !token || !challenge || !safeEqual(token, expected)) throw new ForbiddenException();
    return challenge;
  }

  /** Trả số sự kiện đã xử lý. Chữ ký sai ⇒ 401. Cờ gói tắt ⇒ bỏ qua (vẫn 200 để Meta không tắt webhook). */
  async receive(rawBody: Buffer | undefined, signature: string | undefined, body: unknown, opts: { forwarded?: boolean } = {}): Promise<number> {
    const secret = loadFacebookConfig().appSecret;
    if (!secret) throw new ServiceUnavailableException();
    if (!verifyMetaSignature(rawBody, signature, secret)) throw new UnauthorizedException('Chữ ký không hợp lệ');
    const b = (body ?? {}) as WebhookBody;
    if (!opts.forwarded) await this.forwardForeignPages(rawBody as Buffer, signature as string, b);
    if (!(await this.orgFeatures.isEnabled('facebook_page'))) return 0;
    if (b.object !== 'page' || !Array.isArray(b.entry)) return 0;
    let n = 0;
    for (const entry of b.entry) {
      if (!entry.id) continue;
      for (const ev of entry.messaging ?? []) {
        // Link/QR mở chat (`ref`) xử lý TRƯỚC tin nhắn cùng sự kiện ⇒ khách mới tạo ra mang nguồn của link.
        n += (await this.safe(() => this.messenger.ingestReferral(entry.id as string, ev))) ? 1 : 0;
        const isNew = await this.safe(() => this.messenger.ingest(entry.id as string, ev));
        n += isNew ? 1 : 0;
        // Kịch bản nhắn tin chạy SAU khi tin đã lưu (đếm tin đầu, nút bấm, câu trả lời của khách).
        await this.safe(() => this.flows.handleEvent(entry.id as string, ev, isNew));
      }
      for (const ch of entry.changes ?? []) {
        if (ch.field === 'feed' && ch.value) {
          n += (await this.safe(() => this.comments.ingest(entry.id as string, ch.value as FeedChange))) ? 1 : 0;
          continue;
        }
        if (ch.field !== 'leadgen' || !ch.value) continue;
        // Lỗi tạm của Graph được ném ra ⇒ controller trả 5xx ⇒ Meta gửi lại.
        const r = await this.leads.handle({ ...ch.value, page_id: ch.value.page_id ?? entry.id });
        n += r === 'created' || r === 'duplicate' ? 1 : 0;
      }
    }
    return n;
  }

  /**
   * Lô có Page KHÔNG nối vào bản này ⇒ chuyển nguyên body + chữ ký gốc sang `FACEBOOK_WEBHOOK_FORWARD_URL` (không chờ, timeout 8s).
   * Không tách lô được vì chữ ký phủ cả body; bản nhận tự bỏ qua Page không phải của nó. Lỗi chuyển tiếp chỉ ghi log, không làm hỏng lô này.
   */
  private async forwardForeignPages(rawBody: Buffer, signature: string, b: WebhookBody): Promise<boolean> {
    const url = webhookForwardUrl();
    if (!url || b.object !== 'page' || !Array.isArray(b.entry)) return false;
    const ids = [...new Set(b.entry.map((e) => e.id).filter((x): x is string => Boolean(x)))];
    if (!ids.length) return false;
    let known: Set<string>;
    try {
      const rows = await this.prisma.facebookPage.findMany({ where: { page_id: { in: ids } }, select: { page_id: true } });
      known = new Set(rows.map((r) => r.page_id));
    } catch (err) {
      this.logger.error(`Tra Page để chuyển tiếp webhook lỗi: ${(err as Error).message}`);
      return false;
    }
    if (ids.every((id) => known.has(id))) return false;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, [FORWARDED_HEADER]: '1' },
      body: rawBody,
      signal: AbortSignal.timeout(8000),
    })
      .then((r) => {
        if (!r.ok) this.logger.warn(`Chuyển tiếp webhook Facebook: bản kia trả ${r.status}`);
      })
      .catch((err: Error) => this.logger.warn(`Chuyển tiếp webhook Facebook lỗi: ${err.message}`));
    return true;
  }

  /** Lỗi DB của 1 tin không được làm hỏng cả lô (và gây Meta gửi lại tin đã xử lý). */
  private async safe(fn: () => Promise<boolean>): Promise<boolean> {
    try {
      return await fn();
    } catch (err) {
      this.logger.error(`Xử lý sự kiện Facebook lỗi: ${(err as Error).message}`);
      return false;
    }
  }
}
