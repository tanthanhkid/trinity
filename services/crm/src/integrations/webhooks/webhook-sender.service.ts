import { Injectable, Logger } from '@nestjs/common';
import { IntegrationAuditService } from '@trinity/prisma';
import { decryptSecret, IntegrationsKeyError, loadSecretKey } from './secret-crypto';
import { buildSignatureHeader } from './signature';
import { postJson, type HttpPostResult } from './webhook-http-client';

export interface SendTarget {
  endpointId: number;
  url: string;
  secretEnc: string;
  createdBy: number;
}

export interface SendItem {
  deliveryId: string;
  eventType: string;
  data: unknown;
  createdAt: Date;
  attempt: number;
}

/** Dựng body + ký + gửi 1 lần + ghi nhật ký. KHÔNG đụng DB delivery (việc của dispatcher/endpoints service). */
@Injectable()
export class WebhookSenderService {
  private readonly logger = new Logger(WebhookSenderService.name);

  constructor(private readonly audit: IntegrationAuditService) {}

  async send(target: SendTarget, item: SendItem): Promise<HttpPostResult> {
    let secret: string;
    try {
      secret = decryptSecret(target.secretEnc, loadSecretKey());
    } catch (err) {
      const code = err instanceof IntegrationsKeyError ? 'secret_unavailable' : 'secret_error';
      this.logger.error(`Webhook endpoint=${target.endpointId}: không giải mã được secret (${code})`);
      const res: HttpPostResult = { ok: false, statusCode: null, error: code, durationMs: 0 };
      await this.record(target, item, res);
      return res;
    }
    // Chuỗi JSON dựng MỘT lần: chính xác các byte này vừa được ký vừa được gửi.
    const body = JSON.stringify({
      id: item.deliveryId,
      type: item.eventType,
      created_at: item.createdAt.toISOString(),
      data: item.data,
    });
    const res = await postJson({
      url: target.url,
      body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Trinity-Webhooks/1.0',
        'X-Trinity-Event': item.eventType,
        'X-Trinity-Delivery': item.deliveryId,
        'X-Trinity-Signature': buildSignatureHeader(secret, body),
      },
    });
    await this.record(target, item, res);
    return res;
  }

  /** Nhật ký: KHÔNG ghi URL (có thể chứa token), KHÔNG ghi body/payload (có SĐT) — chỉ định danh + kết quả. */
  private record(target: SendTarget, item: SendItem, res: HttpPostResult): Promise<void> {
    return this.audit.log({
      channel: 'webhook_out',
      action: item.eventType,
      status: res.ok ? 'ok' : 'error',
      userId: target.createdBy,
      resource: 'webhook_endpoint',
      resourceId: target.endpointId,
      httpStatus: res.statusCode,
      durationMs: res.durationMs,
      error: res.error,
      metadata: { delivery_id: item.deliveryId, attempt: item.attempt },
    });
  }
}
