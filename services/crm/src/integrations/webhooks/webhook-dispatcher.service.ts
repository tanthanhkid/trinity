import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  IntegrationEventsService,
  PrismaService,
  currentCompanyId,
  integrationFlags,
  isIntegrationEventType,
  type PendingIntegrationEvent,
} from '@trinity/prisma';
import { isSecretKeyConfigured } from './secret-crypto';
import { WebhookActorService } from './webhook-actor.service';
import { WebhookDeliveryWorker } from './webhook-delivery-worker.service';
import { evaluateEvent, type ActorScopes } from './webhook-payload';
import { tenantTimerTick } from '../../common/helpers/tenant-timer';
import type { WebhookEndpoint } from '@prisma/client';

export const TICK_MS = 10_000;
const EVENT_BATCH = 200;
const MAX_EVENT_LOOPS = 5;
/** Sự kiện outbox cũ hơn mức này (vd cờ tắt rồi bật lại) không đẩy nữa — tránh dội sự kiện lỗi thời. */
export const EVENT_MAX_AGE_MS = 7 * 86_400_000;
const DELIVERY_RETENTION_DAYS = 30;
/** Receipt idempotency của webhook vào: đủ dài cho mọi cơ chế gửi lại hợp lý của bên gửi. */
const RECEIPT_RETENTION_DAYS = 180;
const HOUSEKEEPING_EVERY_MS = 6 * 60 * 60 * 1000;
const KEY_WARN_EVERY_MS = 10 * 60 * 1000;

/**
 * Worker webhook ra. MẶC ĐỊNH TẮT — không timer nào được tạo khi `INTEGRATIONS_WEBHOOKS_ENABLED`
 * tắt. Mỗi tick: (1) outbox → delivery cho từng endpoint đăng ký; (2) nhận + gửi tối đa 20 việc đến hạn.
 * Nhiều instance chạy trùng vẫn đúng: delivery có UNIQUE (endpoint_id,event_id), việc gửi nhận bằng SKIP LOCKED.
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Timer chạy ngoài request: mỗi lượt chạy cho từng công ty (multi-tenant). */
  private readonly timerTick = tenantTimerTick(this.logger, 'Webhook tick', () => this.tick(), undefined, 'integrations.webhook-dispatch');
  /**
   * Trạng thái theo công ty (multi-tenant): công ty A đang gửi không được chặn/nuốt lượt của công ty B, và
   * mốc dọn dẹp của A không được làm B bỏ lượt dọn.
   */
  private readonly running = new Set<number>();
  private readonly lastHousekeeping = new Map<number, number>();
  private lastKeyWarn = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: IntegrationEventsService,
    private readonly actors: WebhookActorService,
    private readonly worker: WebhookDeliveryWorker,
  ) {}

  onModuleInit(): void {
    if (!integrationFlags.webhooksEnabled()) return;
    if (!isSecretKeyConfigured()) {
      this.logger.error(
        'INTEGRATIONS_WEBHOOKS_ENABLED=true nhưng INTEGRATIONS_SECRET_KEY thiếu/sai (cần 32 byte base64) — worker webhook KHÔNG chạy, API tạo/gửi webhook sẽ trả lỗi 503.',
      );
      return;
    }
    this.timer = setInterval(() => void this.timerTick(), TICK_MS);
    this.timer.unref();
    this.logger.log('Webhook worker bật (INTEGRATIONS_WEBHOOKS_ENABLED=true)');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Public cho test. Không ném lỗi, không chạy chồng trong cùng process. */
  async tick(opts: { housekeeping?: boolean } = {}): Promise<void> {
    const company = companyKey();
    if (this.running.has(company) || !integrationFlags.webhooksEnabled()) return;
    if (!isSecretKeyConfigured()) {
      if (Date.now() - this.lastKeyWarn > KEY_WARN_EVERY_MS) {
        this.lastKeyWarn = Date.now();
        this.logger.error('Webhook worker tạm dừng: INTEGRATIONS_SECRET_KEY thiếu/sai');
      }
      return;
    }
    this.running.add(company);
    try {
      await this.dispatchEvents();
      await this.worker.sweepExhausted();
      const rows = await this.worker.claim();
      if (rows.length) await this.worker.processBatch(rows);
      if (opts.housekeeping !== false) await this.housekeeping();
    } catch (err) {
      this.logger.error(`Webhook tick lỗi: ${(err as Error)?.message}`);
    } finally {
      this.running.delete(company);
    }
  }

  /** Outbox → delivery. Lọc `dispatched_at IS NULL` (qua `fetchPending`), KHÔNG dùng mốc id (xem ghi chú ở đó). */
  async dispatchEvents(): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_EVENT_LOOPS; i++) {
      const pending = await this.events.fetchPending(EVENT_BATCH);
      if (pending.length === 0) break;
      const endpoints = await this.prisma.webhookEndpoint.findMany({ where: { is_active: true } });
      const rows = await this.buildDeliveries(pending, endpoints);
      if (rows.length) await this.prisma.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
      await this.events.markDispatched(pending.map((e) => e.id));
      total += rows.length;
      if (pending.length < EVENT_BATCH) break;
    }
    return total;
  }

  private async buildDeliveries(pending: PendingIntegrationEvent[], endpoints: WebhookEndpoint[]) {
    const scopes = new Map<number, ActorScopes | null>();
    const rows: Array<{ endpoint_id: number; event_id: bigint; event_type: string; payload: object }> = [];
    for (const ep of endpoints) {
      const oldest = Date.now() - EVENT_MAX_AGE_MS;
      const mine = pending.filter((e) => ep.events.includes(e.event_type) && e.created_at >= ep.created_at && e.created_at.getTime() >= oldest);
      if (mine.length === 0) continue;
      if (!scopes.has(ep.created_by)) scopes.set(ep.created_by, await this.actors.scopesFor(ep.created_by));
      const s = scopes.get(ep.created_by) ?? null;
      if (!s) {
        await this.worker.deactivate(ep.id, 'creator_unauthorized', ep.created_by, ep.name);
        continue;
      }
      for (const ev of mine) {
        if (!isIntegrationEventType(ev.event_type)) continue;
        const out = evaluateEvent(ev.event_type, ev.payload, s);
        if (out.deliver) rows.push({ endpoint_id: ep.id, event_id: ev.id, event_type: ev.event_type, payload: out.data as object });
      }
    }
    return rows;
  }

  /** Dọn delivery xong/chết > 30 ngày + receipt webhook vào > 180 ngày (theo lô). */
  private async housekeeping(): Promise<void> {
    const company = companyKey();
    if (Date.now() - (this.lastHousekeeping.get(company) ?? 0) < HOUSEKEEPING_EVERY_MS) return;
    this.lastHousekeeping.set(company, Date.now());
    const before = new Date(Date.now() - DELIVERY_RETENTION_DAYS * 86_400_000);
    await this.prisma.webhookInboundReceipt.deleteMany({ where: { created_at: { lt: new Date(Date.now() - RECEIPT_RETENTION_DAYS * 86_400_000) } } });
    for (let i = 0; i < 20; i++) {
      const old = await this.prisma.webhookDelivery.findMany({
        where: { status: { in: ['success', 'dead'] }, created_at: { lt: before } },
        select: { id: true },
        orderBy: { created_at: 'asc' },
        take: 1000,
      });
      if (old.length === 0) break;
      await this.prisma.webhookDelivery.deleteMany({ where: { id: { in: old.map((d) => d.id) } } });
      if (old.length < 1000) break;
    }
  }
}

/** Khoá trạng thái trong RAM theo công ty hiện tại (0 = chưa có ngữ cảnh; truy vấn DB khi đó sẽ tự báo lỗi). */
function companyKey(): number {
  return currentCompanyId() ?? 0;
}
