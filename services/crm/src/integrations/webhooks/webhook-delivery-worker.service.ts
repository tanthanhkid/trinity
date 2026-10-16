import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService, isIntegrationEventType, type IntegrationEventType } from '@trinity/prisma';
import { NotificationsService } from '../../notifications/notifications.service';
import { evaluateEvent, type ActorScopes } from './webhook-payload';
import { AUTO_DISABLE_AFTER_FAILURES, MAX_ATTEMPTS, nextRetryDelayMs } from './webhook-retry';
import { WebhookActorService } from './webhook-actor.service';
import { WebhookSenderService } from './webhook-sender.service';
import type { HttpPostResult } from './webhook-http-client';

export const CLAIM_BATCH = 20;
const CONCURRENCY = 5;
/** Hợp đồng thuê (lease): việc đã nhận mà chưa ghi kết quả (crash) sẽ được nhận lại sau chừng này. */
export const LEASE_SECONDS = 120;

interface ClaimedRow {
  id: string;
  endpoint_id: number;
  event_type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

/** Nhận việc (`FOR UPDATE SKIP LOCKED`) → gửi → ghi kết quả. Mỗi lượt nhận tăng `attempts` NGAY (chặn thử lại vô hạn). */
@Injectable()
export class WebhookDeliveryWorker {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: WebhookSenderService,
    private readonly actors: WebhookActorService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * UPDATE … RETURNING trong 1 câu: 2 instance không bao giờ nhận cùng 1 dòng (SKIP LOCKED + dịch
   * `next_attempt_at` ra sau = lease). Chỉ nhận việc của endpoint đang bật.
   */
  async claim(limit = CLAIM_BATCH): Promise<ClaimedRow[]> {
    return this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE webhook_deliveries d
         SET attempts = d.attempts + 1,
             next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE d.id IN (
         SELECT d2.id FROM webhook_deliveries d2
           JOIN webhook_endpoints e ON e.id = d2.endpoint_id AND e.is_active = true
          WHERE d2.status IN ('pending', 'failed') AND d2.next_attempt_at <= now() AND d2.attempts < ${MAX_ATTEMPTS}
          ORDER BY d2.next_attempt_at ASC
          LIMIT ${limit}
          FOR UPDATE OF d2 SKIP LOCKED)
      RETURNING d.id::text AS id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.created_at`;
  }

  /**
   * Việc đã hết lượt (`attempts >= MAX`) mà vẫn pending/failed ⇒ lượt cuối bị gián đoạn (crash/lỗi xử lý) và lease đã hết:
   * chuyển `dead` thay vì nhận lại — trần số lần gửi là TUYỆT ĐỐI kể cả khi `settle` không bao giờ chạy tới.
   */
  async sweepExhausted(): Promise<number> {
    const res = await this.prisma.webhookDelivery.updateMany({
      where: { status: { in: ['pending', 'failed'] }, attempts: { gte: MAX_ATTEMPTS }, next_attempt_at: { lte: new Date() } },
      data: { status: 'dead', last_error: 'attempts_exhausted' },
    });
    return res.count;
  }

  async processBatch(rows: ClaimedRow[]): Promise<void> {
    const queue = [...rows];
    const scopesCache = new Map<number, ActorScopes | null>();
    const lane = async (): Promise<void> => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          await this.processOne(r, scopesCache);
        } catch (err) {
          // Lease sẽ nhận lại việc này; attempts đã tăng nên vẫn có trần.
          this.logger.error(`Webhook delivery ${r.id}: lỗi xử lý (${(err as Error)?.message})`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, lane));
  }

  private async processOne(row: ClaimedRow, cache: Map<number, ActorScopes | null>): Promise<void> {
    const ep = await this.prisma.webhookEndpoint.findUnique({ where: { id: row.endpoint_id } });
    if (!ep || !ep.is_active) return this.settle(row, { dead: 'endpoint_inactive' });
    if (!cache.has(ep.created_by)) cache.set(ep.created_by, await this.actors.scopesFor(ep.created_by));
    const scopes = cache.get(ep.created_by) ?? null;
    if (!scopes) {
      await this.deactivate(ep.id, 'creator_unauthorized', ep.created_by, ep.name);
      return this.settle(row, { dead: 'creator_unauthorized' });
    }
    if (!isIntegrationEventType(row.event_type)) return this.settle(row, { dead: 'unknown_event' });
    // Che/lọc LẠI theo quyền HIỆN TẠI (có thể đã đổi từ lúc tạo delivery).
    const ev = evaluateEvent(row.event_type as IntegrationEventType, row.payload, scopes);
    if (!ev.deliver) return this.settle(row, { dead: 'no_longer_visible' });
    const res = await this.sender.send(
      { endpointId: ep.id, url: ep.url, secretEnc: ep.secret_enc, createdBy: ep.created_by },
      { deliveryId: row.id, eventType: row.event_type, data: ev.data, createdAt: row.created_at, attempt: row.attempts },
    );
    await this.settle(row, { result: res }, ep);
  }

  /** Ghi kết quả CHỈ khi lượt nhận còn hiệu lực (`attempts` khớp, còn pending/failed) — chống ghi đè muộn. */
  private async settle(
    row: ClaimedRow,
    outcome: { dead: string } | { result: HttpPostResult },
    ep?: { id: number; created_by: number; name: string },
  ): Promise<void> {
    const guard = { id: row.id, attempts: row.attempts, status: { in: ['pending', 'failed'] } };
    if ('dead' in outcome) {
      await this.prisma.webhookDelivery.updateMany({ where: guard, data: { status: 'dead', last_error: outcome.dead } });
      return;
    }
    const res = outcome.result;
    if (res.ok) {
      const done = await this.prisma.webhookDelivery.updateMany({
        where: guard,
        data: { status: 'success', delivered_at: new Date(), last_status_code: res.statusCode, last_error: null },
      });
      if (done.count > 0 && ep) {
        await this.prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { last_success_at: new Date(), consecutive_failures: 0 } });
      }
      return;
    }
    const delay = nextRetryDelayMs(row.attempts);
    const failed = await this.prisma.webhookDelivery.updateMany({
      where: guard,
      data: {
        status: delay === null ? 'dead' : 'failed',
        last_status_code: res.statusCode,
        last_error: res.error,
        ...(delay === null ? {} : { next_attempt_at: new Date(Date.now() + delay) }),
      },
    });
    // Lỗi cấu hình khoá (secret_*) không phải lỗi của endpoint ⇒ không tính vào bộ đếm tự tắt (đổi khoá không được tắt hàng loạt).
    if (failed.count > 0 && ep && !res.error?.startsWith('secret_')) await this.recordEndpointFailure(ep);
  }

  private async recordEndpointFailure(ep: { id: number; created_by: number; name: string }): Promise<void> {
    const upd = await this.prisma.webhookEndpoint.update({
      where: { id: ep.id },
      data: { last_failure_at: new Date(), consecutive_failures: { increment: 1 } },
      select: { consecutive_failures: true },
    });
    if (upd.consecutive_failures >= AUTO_DISABLE_AFTER_FAILURES) {
      await this.deactivate(ep.id, 'consecutive_failures', ep.created_by, ep.name);
    }
  }

  /** Tắt endpoint (idempotent: chỉ lần chuyển true→false mới thông báo). */
  async deactivate(endpointId: number, reason: string, creatorId: number, name: string): Promise<void> {
    const res = await this.prisma.webhookEndpoint.updateMany({
      where: { id: endpointId, is_active: true },
      data: { is_active: false, disabled_reason: reason },
    });
    if (res.count === 0) return;
    await this.prisma.webhookDelivery.updateMany({
      where: { endpoint_id: endpointId, status: { in: ['pending', 'failed'] } },
      data: { status: 'dead', last_error: 'endpoint_disabled' },
    });
    this.logger.warn(`Webhook endpoint=${endpointId} tự tắt (${reason})`);
    const why = reason === 'consecutive_failures'
      ? `lỗi liên tiếp ${AUTO_DISABLE_AFTER_FAILURES} lần`
      : 'người tạo không còn quyền quản lý webhook';
    try {
      await this.notifications?.createPendingLogs([creatorId], 'webhook_endpoint_disabled', {
        title: 'Webhook tự động tắt',
        body: `Endpoint "${name}" đã bị tắt: ${why}. Kiểm tra rồi bật lại ở Cài đặt > Kết nối & AI.`,
        action_url: '/connections?muc=webhook-out',
      });
    } catch (err) {
      this.logger.warn(`Không gửi được thông báo tắt webhook endpoint=${endpointId}: ${(err as Error)?.message}`);
    }
  }
}

