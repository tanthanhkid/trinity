import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma.service'
import { INTEGRATION_EVENT_META, type IntegrationEventMap, type IntegrationEventType } from './event-catalog'

/** Chỉ cần delegate `integrationEvent` — nhận được cả `PrismaService` lẫn `tx` của `$transaction`. */
export type OutboxClient = Pick<Prisma.TransactionClient, 'integrationEvent'>

export interface PublishOptions {
  /** id tài nguyên gốc (contact.id / deal.id / order.id). */
  resourceId: number | string
  /** Người thực hiện; null/bỏ trống = hệ thống hoặc dịch vụ ngoài. */
  actorUserId?: number | null
}

const bigintToString = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)

/** Ép payload về JSON thuần (BigInt → chuỗi, Date → ISO, bỏ undefined) để Prisma `Json` không ném lỗi serialize. */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, bigintToString)) as Prisma.InputJsonValue
}

/**
 * Ghi 1 dòng outbox. 🔴 PHẢI gọi với `tx` của CHÍNH transaction đang ghi dữ liệu nghiệp vụ: rollback ⇒ không
 * có dòng outbox (không bắn sự kiện ảo), commit ⇒ chắc chắn có dòng (không mất sự kiện). Cố ý KHÔNG nuốt lỗi:
 * outbox cùng transaction nên lỗi outbox = lỗi ghi (chọn nhất quán hơn là im lặng mất sự kiện); vì vậy bảng
 * `integration_events` không có FK/ràng buộc ngoài để insert luôn đơn giản.
 *
 * Là hàm thuần (không DI) có chủ đích: dùng được trong mọi service/test mà không đổi constructor.
 */
export async function publishIntegrationEvent<T extends IntegrationEventType>(
  client: OutboxClient,
  type: T,
  payload: IntegrationEventMap[T],
  opts: PublishOptions,
): Promise<void> {
  await client.integrationEvent.create({
    data: {
      event_type: type,
      resource: INTEGRATION_EVENT_META[type].resource,
      resource_id: String(opts.resourceId),
      payload: toJsonValue(payload),
      actor_user_id: opts.actorUserId ?? null,
    },
    select: { id: true },
  })
}

/** Bản ghi outbox cho worker. */
export interface PendingIntegrationEvent {
  id: bigint
  event_type: string
  resource: string
  resource_id: string
  payload: Prisma.JsonValue
  actor_user_id: number | null
  created_at: Date
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Đã dispatch > 30 ngày thì dọn. */
export const OUTBOX_DISPATCHED_RETENTION_DAYS = 30
/** Chưa dispatch nhưng quá cũ (cờ tắt nên không ai tiêu thụ) — dọn để bảng không phình vô hạn. */
export const OUTBOX_UNDISPATCHED_RETENTION_DAYS = 90
const PURGE_BATCH = 2000
const PURGE_MAX_BATCHES = 50

@Injectable()
export class IntegrationEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Wrapper của `publishIntegrationEvent` (không truyền client = ghi ngoài transaction). */
  publish<T extends IntegrationEventType>(
    client: OutboxClient | null,
    type: T,
    payload: IntegrationEventMap[T],
    opts: PublishOptions,
  ): Promise<void> {
    return publishIntegrationEvent(client ?? this.prisma, type, payload, opts)
  }

  /**
   * Lô sự kiện chưa dispatch theo thứ tự id tăng dần (index `integration_events_dispatch_idx`).
   * ⚠️ id BIGSERIAL cấp lúc INSERT, không theo thứ tự COMMIT: giao dịch dài có thể commit sau giao dịch ngắn
   * dù id nhỏ hơn. Worker vì vậy PHẢI lọc `dispatched_at IS NULL` (như hàm này) và KHÔNG dùng mốc "id lớn nhất
   * đã xử lý" — dùng mốc id sẽ bỏ sót vĩnh viễn sự kiện commit muộn.
   */
  fetchPending(limit = 100): Promise<PendingIntegrationEvent[]> {
    return this.prisma.integrationEvent.findMany({
      where: { dispatched_at: null },
      orderBy: { id: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
      select: { id: true, event_type: true, resource: true, resource_id: true, payload: true, actor_user_id: true, created_at: true },
    })
  }

  /** Đánh dấu đã dispatch; chỉ chạm dòng còn `dispatched_at IS NULL` (an toàn khi 2 worker trùng). */
  async markDispatched(ids: bigint[], at: Date = new Date()): Promise<number> {
    if (ids.length === 0) return 0
    const res = await this.prisma.integrationEvent.updateMany({
      where: { id: { in: ids }, dispatched_at: null },
      data: { dispatched_at: at },
    })
    return res.count
  }

  /** Dọn theo lô (không DELETE một phát hàng triệu dòng). Trả số dòng đã xoá mỗi loại. */
  async purge(now: Date = new Date()): Promise<{ dispatched: number; stale: number }> {
    const dispatched = await this.purgeWhere({
      dispatched_at: { not: null, lt: new Date(now.getTime() - OUTBOX_DISPATCHED_RETENTION_DAYS * DAY_MS) },
    })
    const stale = await this.purgeWhere({
      dispatched_at: null,
      created_at: { lt: new Date(now.getTime() - OUTBOX_UNDISPATCHED_RETENTION_DAYS * DAY_MS) },
    })
    return { dispatched, stale }
  }

  private async purgeWhere(where: Prisma.IntegrationEventWhereInput): Promise<number> {
    let total = 0
    for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
      const rows = await this.prisma.integrationEvent.findMany({ where, orderBy: { id: 'asc' }, take: PURGE_BATCH, select: { id: true } })
      if (rows.length === 0) break
      const res = await this.prisma.integrationEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
      total += res.count
      if (rows.length < PURGE_BATCH) break
    }
    return total
  }
}
