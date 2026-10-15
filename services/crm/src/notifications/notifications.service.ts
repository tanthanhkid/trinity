import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Permission } from '@trinity/rbac';
import { findUserIdsWithPermission } from '../common/helpers/permission-roster.helper';
import { CRM_WS_EMIT_PORT, WsEmitItem, WsEmitPort } from './ws-emit.port';

interface NotificationLogRow {
  recipient_id: number;
  event_type: string;
  channel: string;
  title: string;
  body: string;
  status: string;
  sent_at: Date;
  action_url?: string | null;
}

// Retry config: 3 lan, exponential backoff 500ms / 1500ms / 4500ms.
const RETRY_DELAYS_MS = [500, 1500, 4500];

/**
 * Hạ tầng thông báo dùng chung (findUserIdsWithPermission/createPendingLogs/
 * emitWsFireAndForget) + `notifyDealAssigned`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(CRM_WS_EMIT_PORT)
    private readonly wsEmitPort?: WsEmitPort,
  ) {}

  /**
   * Tìm mọi user active đang giữ MỘT quyền không-scoped (vai trò hệ thống
   * "Quản trị" luôn được tính).
   */
  async findUserIdsWithPermission(permission: Permission): Promise<number[]> {
    return findUserIdsWithPermission(this.prisma, permission);
  }

  /**
   * Sleep helper cho retry backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Bridge giữa CRM direct DB insert và WS gateway.
   * CRM ghi `notification_logs` status='sent' bằng Prisma; gateway WS nằm ở
   * module notification CÙNG process monolith → gọi in-process qua port.
   * Fire-and-forget — lỗi KHÔNG
   * chặn DB insert nhưng LUÔN log ERROR (không được nuốt âm thầm).
   */
  private emitWsFireAndForget(
    userIds: number[],
    eventType: string,
    content: { title: string; body: string; action_url?: string | null },
  ): void {
    if (!this.wsEmitPort) {
      this.logger.error(
        `emitWsFireAndForget: CRM_WS_EMIT_PORT chưa được nối — WS emit bị bỏ qua, chuông không kêu realtime (event=${eventType})`,
      );
      return;
    }
    const port = this.wsEmitPort;
    const items: WsEmitItem[] = userIds.map((uid) => ({
      recipient_id: uid,
      title: content.title,
      body: content.body,
      event_type: eventType,
      action_url: content.action_url ?? null,
    }));
    void (async () => {
      try {
        await port.emit(items);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `emitWsFireAndForget: emit thất bại (event=${eventType}, users=${userIds.length}): ${msg}`,
        );
      }
    })();
  }

  /**
   * Layer 1 — Persist noti logs vao DB ngay lap tuc (source of truth).
   * Wrap createMany boi retry loop 3 lan exponential backoff de chiu dung
   * transient DB error (pool exhausted, replica lag, dead connection).
   * Dedupe (recipient_id, event_type) de tranh double-notify khi retry hit
   * duplicate unique constraint.
   *
   * Tra ve so log thuc te insert. Neu tat ca retry deu fail, throw loi de
   * caller co the alert / log ERROR — KHONG swallow silently.
   */
  async createPendingLogs(
    userIds: number[],
    eventType: string,
    content: { title: string; body: string; action_url?: string | null },
  ): Promise<{ created: number }> {
    if (userIds.length === 0) return { created: 0 };

    const now = new Date();
    const data: NotificationLogRow[] = userIds.map((uid) => ({
      recipient_id: uid,
      event_type: eventType,
      channel: 'in_app',
      title: content.title,
      body: content.body,
      // status='sent' cho in_app: bell UI doc theo recipient_id + is_read,
      // khong filter theo status. Worker chi pickup status='scheduled'.
      status: 'sent',
      sent_at: now,
      action_url: content.action_url ?? null,
    }));

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const result = await this.prisma.notificationLog.createMany({
          data,
          skipDuplicates: true,
        });
        if (attempt > 0) {
          this.logger.warn(
            `createPendingLogs: succeeded after ${attempt} retry (event=${eventType}, users=${userIds.length})`,
          );
        }
        // Sau khi insert DB thành công, trigger WS emit qua notification
        // service. CRM dùng Prisma shared nên insert trực tiếp với status='sent',
        // nhưng WebSocket gateway chỉ tồn tại trong notification service.
        // Fire-and-forget: lỗi WS emit KHÔNG block DB insert (chỉ log WARN).
        if (result.count > 0) {
          this.emitWsFireAndForget(userIds, eventType, content);
        }
        return { created: result.count };
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt];
          this.logger.warn(
            `createPendingLogs attempt ${attempt + 1} failed: ${msg} — retry in ${delay}ms`,
          );
          await this.sleep(delay);
        } else {
          this.logger.error(
            `createPendingLogs FAILED after ${RETRY_DELAYS_MS.length + 1} attempts: ${msg} (event=${eventType}, users=${userIds.length})`,
          );
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('createPendingLogs failed after retries');
  }

  /**
   * Gửi notification cho người phụ trách khi có người tạo + gán thương vụ cho họ.
   *
   * action_url ưu tiên theo thứ tự:
   *   1. /contacts/<contactId> nếu deal liên kết contact (trường hợp phổ biến)
   *   2. /contacts (list page) fallback
   *
   * KHÔNG dùng /deals/<id> vì Next.js app không có route này (sẽ gây 404).
   */
  async notifyDealAssigned(payload: {
    dealId: number;
    dealTitle: string;
    saleUserId: number;
    creatorName: string;
    contactId?: number | null;
  }): Promise<{ created: number }> {
    const action_url = payload.contactId
      ? `/contacts/${payload.contactId}`
      : '/contacts';
    const title = 'Bạn được giao thương vụ mới';
    const body = `"${payload.dealTitle}" — giao bởi ${payload.creatorName}`;

    const result = await this.createPendingLogs(
      [payload.saleUserId],
      'deal.assigned',
      { title, body, action_url },
    );
    this.logger.log(
      `deal.assigned: deal=${payload.dealId} sale=${payload.saleUserId} contact=${payload.contactId ?? 'none'} created=${result.created}`,
    );
    return result;
  }
}
