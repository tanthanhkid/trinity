import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IntegrationAuditService, PrismaService, integrationFlags } from '@trinity/prisma';
import type { WebhookEndpoint } from '@prisma/client';
import { encryptSecret, generateWebhookSecret, IntegrationsKeyError, loadSecretKey } from './secret-crypto';
import { assertSafeUrl, SsrfBlockedError } from './ssrf-guard';
import { WebhookSenderService } from './webhook-sender.service';
import type { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from './dto/webhook-endpoint.dto';

export const MAX_ENDPOINTS = 20;

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Phản hồi endpoint — KHÔNG BAO GIỜ có `secret_enc`. */
export function toEndpointView(e: WebhookEndpoint) {
  const { secret_enc: _omit, ...rest } = e;
  return { ...rest, secret_set: true };
}

@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: IntegrationAuditService,
    private readonly sender: WebhookSenderService,
  ) {}

  /** Cờ tắt → 404 (như audit-logs): tính năng "không tồn tại" với mọi người. */
  assertEnabled(): void {
    if (!integrationFlags.webhooksEnabled()) throw new NotFoundException();
  }

  /** Thiếu/sai khoá mã hoá → 503 nói rõ (KHÔNG tự sinh khoá). */
  private key(): Buffer {
    try {
      return loadSecretKey();
    } catch (err) {
      if (err instanceof IntegrationsKeyError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  private async safeUrl(url: string): Promise<string> {
    try {
      return (await assertSafeUrl(url)).url.toString();
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  private async find(id: number): Promise<WebhookEndpoint> {
    const ep = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!ep) throw new NotFoundException('Không tìm thấy endpoint');
    return ep;
  }

  private log(userId: number, action: string, id: number, meta: Record<string, unknown> = {}): Promise<void> {
    return this.audit.log({ channel: 'webhook_out', action, status: 'ok', userId, resource: 'webhook_endpoint', resourceId: id, metadata: meta });
  }

  async list() {
    const rows = await this.prisma.webhookEndpoint.findMany({ orderBy: { id: 'desc' }, take: MAX_ENDPOINTS + 5 });
    return rows.map(toEndpointView);
  }

  async get(id: number) {
    return toEndpointView(await this.find(id));
  }

  async create(dto: CreateWebhookEndpointDto, userId: number) {
    const key = this.key();
    if ((await this.prisma.webhookEndpoint.count()) >= MAX_ENDPOINTS) {
      throw new BadRequestException(`Tối đa ${MAX_ENDPOINTS} endpoint webhook`);
    }
    const url = await this.safeUrl(dto.url);
    const secret = generateWebhookSecret();
    const ep = await this.prisma.webhookEndpoint.create({
      data: { name: dto.name, url, events: dto.events, secret_enc: encryptSecret(secret, key), created_by: userId },
    });
    await this.log(userId, 'endpoint.created', ep.id, { events: dto.events.length });
    return { ...toEndpointView(ep), secret };
  }

  /**
   * 🔴 Quyền của payload gắn với người CHỌN URL ĐÍCH. Đổi URL bởi người KHÁC chủ thể ⇒ chủ thể chuyển sang người
   * sửa (nếu không, người quyền thấp trỏ endpoint của admin về URL của mình sẽ nhận SĐT đầy đủ) + huỷ delivery chờ
   * (đã dựng theo quyền chủ thể cũ). Đổi sự kiện / tạo lại secret / đổi tên KHÔNG chuyển chủ thể: URL vẫn của chủ cũ
   * nên dữ liệu gửi đi vẫn bị chặn bởi quyền chủ cũ — chuyển chủ ở đó sẽ cho admin vô tình nâng quyền endpoint của người khác.
   */
  async update(id: number, dto: UpdateWebhookEndpointDto, userId: number) {
    const ep = await this.find(id);
    const data: Record<string, unknown> = {};
    let urlChanged = false;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.url !== undefined) {
      const safe = await this.safeUrl(dto.url); // luôn kiểm SSRF; so với bản ĐÃ chuẩn hoá đang lưu
      if (safe !== ep.url) {
        data.url = safe;
        urlChanged = true;
      }
    }
    if (dto.events !== undefined && !sameSet(dto.events, ep.events)) data.events = dto.events;
    if (dto.is_active !== undefined) {
      data.is_active = dto.is_active;
      if (dto.is_active) Object.assign(data, { disabled_reason: null, consecutive_failures: 0 });
      else data.disabled_reason = 'manual';
    }
    const ownerChanged = urlChanged && ep.created_by !== userId;
    if (ownerChanged) data.created_by = userId;
    const saved = await this.prisma.webhookEndpoint.update({ where: { id }, data });
    if (urlChanged) await this.cancelPending(id, 'endpoint_changed');
    else if (dto.is_active === false) await this.cancelPending(id, 'endpoint_disabled');
    await this.log(userId, 'endpoint.updated', id, { fields: Object.keys(data).filter((k) => k !== 'disabled_reason'), owner_changed: ownerChanged });
    return toEndpointView(saved);
  }

  async remove(id: number, userId: number): Promise<{ deleted: true }> {
    await this.find(id);
    await this.prisma.$transaction([
      this.prisma.webhookDelivery.deleteMany({ where: { endpoint_id: id } }),
      this.prisma.webhookEndpoint.delete({ where: { id } }),
    ]);
    await this.log(userId, 'endpoint.deleted', id);
    return { deleted: true };
  }

  async rotateSecret(id: number, userId: number) {
    const key = this.key();
    await this.find(id);
    const secret = generateWebhookSecret();
    const saved = await this.prisma.webhookEndpoint.update({ where: { id }, data: { secret_enc: encryptSecret(secret, key) } });
    await this.log(userId, 'endpoint.secret_rotated', id);
    return { ...toEndpointView(saved), secret };
  }

  /** Gửi sự kiện `ping` ĐỒNG BỘ, 1 lần, không thử lại, không tính vào bộ đếm lỗi liên tiếp. */
  async test(id: number, userId: number) {
    this.key();
    const ep = await this.find(id);
    const deliveryId = randomUUID();
    const now = new Date();
    await this.prisma.webhookDelivery.create({
      // `next_attempt_at` xa ⇒ worker không bao giờ nhận dòng ping (gửi đồng bộ ngay dưới).
      data: { id: deliveryId, endpoint_id: id, event_type: 'ping', payload: { message: 'Trinity webhook test' }, attempts: 1, created_at: now, next_attempt_at: new Date(now.getTime() + 86_400_000) },
    });
    const res = await this.sender.send(
      { endpointId: id, url: ep.url, secretEnc: ep.secret_enc, createdBy: userId },
      { deliveryId, eventType: 'ping', data: { message: 'Trinity webhook test' }, createdAt: now, attempt: 1 },
    );
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: res.ok ? 'success' : 'dead', delivered_at: res.ok ? new Date() : null, last_status_code: res.statusCode, last_error: res.error },
    });
    await this.prisma.webhookEndpoint.update({ where: { id }, data: res.ok ? { last_success_at: new Date() } : { last_failure_at: new Date() } });
    await this.log(userId, 'endpoint.tested', id, { ok: res.ok });
    return { delivery_id: deliveryId, ok: res.ok, status_code: res.statusCode, error: res.error, duration_ms: res.durationMs };
  }

  private async cancelPending(endpointId: number, reason: string): Promise<void> {
    await this.prisma.webhookDelivery.updateMany({
      where: { endpoint_id: endpointId, status: { in: ['pending', 'failed'] } },
      data: { status: 'dead', last_error: reason },
    });
  }

  async retryDelivery(deliveryId: string, userId: number) {
    const d = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!d) throw new NotFoundException('Không tìm thấy lượt gửi');
    if (d.event_type === 'ping') throw new BadRequestException('Không gửi lại sự kiện thử (ping)');
    if (d.status !== 'failed' && d.status !== 'dead') throw new ConflictException('Chỉ gửi lại được lượt đã lỗi/đã dừng');
    const ep = await this.find(d.endpoint_id);
    if (!ep.is_active) throw new ConflictException('Endpoint đang tắt — bật lại trước khi gửi lại');
    const res = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: { in: ['failed', 'dead'] } },
      data: { status: 'pending', attempts: 0, next_attempt_at: new Date(), last_error: null },
    });
    if (res.count === 0) throw new ConflictException('Lượt gửi vừa được xử lý');
    await this.log(userId, 'delivery.retry', d.endpoint_id, { delivery_id: deliveryId });
    return { id: deliveryId, status: 'pending' };
  }
}
