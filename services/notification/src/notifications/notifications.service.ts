import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { cronRegistry, isServerless, runInBackground } from '@trinity/rbac-nest'
import { SendNotificationDto, NotifChannel } from './dto/send-notification.dto'
import type { UnreadCountCategory } from './dto/query-unread-count.dto'
import { DeliveryService } from './delivery.service'
import { NotificationsGateway } from '../websocket/notifications.gateway'
import { isBusinessHours, getNextBusinessStart } from './helpers/timezone.helper'
import { MESSAGE_EVENT_TYPES } from './helpers/event-category.helper'

interface NotificationLog {
  id: number
  title: string | null
  body: string | null
  channel: string
  event_type: string | null
  action_url: string | null
  is_read: boolean
  created_at: Date
}

interface PaginatedResult {
  data: NotificationLog[]
  next_cursor: number | null
}

/** Serverless: giãn tối thiểu giữa 2 lần xử lý thông báo hẹn giờ kiểu "cơ hội" (kích bởi poll badge của FE). */
export const SCHEDULED_OPPORTUNISTIC_GAP_MS = 60_000
/** Dòng `processing` quá ngần này thì coi là kẹt. */
export const STUCK_PROCESSING_MS = 15 * 60 * 1000
/** Tổng số lần được thử của một dòng hẹn giờ (kể cả lần bị kẹt). */
export const MAX_SCHEDULED_ATTEMPTS = 3

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name)
  // key = `${userId}:${category ?? 'all'}` — cache rieng theo tung nhom
  private readonly unreadCache = new Map<string, { count: number; expiry: number }>()
  private lastOpportunistic = 0

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    // Thông báo hẹn giờ/nhắc việc: ở VPS do `NotificationsScheduler` (@Cron 2 phút) gọi; ở serverless không cron
    // nội bộ nên cron tick (`/internal/cron/tick`) + `maybeProcessScheduledInBackground` làm việc này.
    cronRegistry.register({
      name: 'notification.scheduled',
      budgetMs: 30_000,
      run: async () => ({ processed: await this.processScheduled() }),
    })
  }

  /**
   * Serverless: FE poll badge mỗi 30s ⇒ tận dụng để xử lý thông báo hẹn giờ đến hạn gần-đúng-giờ (cron của nền tảng chỉ
   * chạy thưa). `processScheduled` claim nguyên tử nên nhiều instance gọi trùng vẫn không gửi đôi. Không chặn
   * response (waitUntil/fire-and-forget), giãn ≥ 60s mỗi instance. Ngoài serverless = no-op (đã có @Cron).
   */
  maybeProcessScheduledInBackground(): boolean {
    if (!isServerless()) return false
    const now = Date.now()
    if (now - this.lastOpportunistic < SCHEDULED_OPPORTUNISTIC_GAP_MS) return false
    this.lastOpportunistic = now
    runInBackground(
      () => this.processScheduled(),
      (err) => this.logger.error(`processScheduled (nền) lỗi: ${err instanceof Error ? err.message : String(err)}`),
    )
    return true
  }

  async findByUser(
    userId: number,
    cursor: number | undefined,
    limit: number,
    read?: boolean,
  ): Promise<PaginatedResult> {
    const where: Record<string, unknown> = { recipient_id: userId }
    if (read !== undefined) where['is_read'] = read

    const data = await this.prisma.notificationLog.findMany({
      where,
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { created_at: 'desc' },
      select: {
        id: true, title: true, body: true,
        channel: true, event_type: true, action_url: true, is_read: true, created_at: true,
      },
    })

    const hasNext = data.length > limit
    if (hasNext) data.pop()
    const nextCursor = hasNext && data.length > 0
      ? data[data.length - 1].id : null

    return { data, next_cursor: nextCursor }
  }

  /**
   * So thong bao "Chua doc" — con so THONG NHAT dung ca cho badge lan popup
   * (KHONG phai length cua 1 trang list bi LIMIT).
   *
   * category:
   *  - undefined → tong tat ca (dung cho notification:count payload tong)
   *  - 'message' → chi event_type thuoc nhom tin nhan/de cap (icon MessageSquare)
   *  - 'profile' → phan con lai (icon Bell: thong bao he thong, phieu luong, cong viec...)
   */
  async getUnreadCount(
    userId: number,
    category?: UnreadCountCategory,
  ): Promise<{ count: number }> {
    const cacheKey = `${userId}:${category ?? 'all'}`
    // Serverless: cache RAM theo instance sẽ cũ tới 5 phút ở instance khác (invalidate chỉ chạm instance ghi)
    // badge poll 30s phải đúng ⇒ bỏ cache, COUNT theo index recipient_id/is_read đủ rẻ.
    const cached = isServerless() ? undefined : this.unreadCache.get(cacheKey)
    if (cached && cached.expiry > Date.now()) {
      return { count: cached.count }
    }

    const where: Record<string, unknown> = { recipient_id: userId, is_read: false }
    if (category === 'message') {
      where['event_type'] = { in: [...MESSAGE_EVENT_TYPES] }
    } else if (category === 'profile') {
      // event_type NULL cung thuoc nhom thong bao chung (isMessageEvent(null) === false
      // o FE) — SQL `NOT IN` bo sot hang NULL, phai OR them dieu kien IS NULL.
      where['OR'] = [
        { event_type: null },
        { event_type: { notIn: [...MESSAGE_EVENT_TYPES] } },
      ]
    }

    const count = await this.prisma.notificationLog.count({ where })

    if (!isServerless()) {
      this.unreadCache.set(cacheKey, {
        count, expiry: Date.now() + 5 * 60 * 1000,
      })
    }
    return { count }
  }

  // Ngoài phạm vi (không phải thông báo của mình) → 404, KHÔNG 403.
  async markAsRead(id: number, userId: number): Promise<{ success: boolean }> {
    const log = await this.prisma.notificationLog.findUnique({ where: { id } })
    if (!log || log.recipient_id !== userId) {
      throw new NotFoundException('Thong bao khong ton tai')
    }

    await this.prisma.notificationLog.update({
      where: { id },
      data: { is_read: true, status: 'read', read_at: new Date() },
    })

    this.invalidateUnreadCache(userId)
    await this.emitUnreadCounts(userId)
    return { success: true }
  }

  /**
   * Tinh lai ca 3 con so (tong, thong bao chung, tin nhan) va push 1 lan qua WS
   * client chi can nhan 'notification:count' roi refetch/invalidate,
   * KHONG tu cong/tru thu cong (tranh double-decrement khi vua nhan socket
   * vua nhan response mark-as-read).
   */
  async emitUnreadCounts(userId: number): Promise<void> {
    const [total, bell, message] = await Promise.all([
      this.getUnreadCount(userId),
      this.getUnreadCount(userId, 'profile'),
      this.getUnreadCount(userId, 'message'),
    ])
    this.gateway.emitUnreadCount(userId, {
      count: total.count,
      bell_count: bell.count,
      message_count: message.count,
    })
  }

  async send(dto: SendNotificationDto): Promise<{ id: number; status: string }> {
    if (await this.delivery.isDuplicate(dto)) {
      this.logger.debug(`Dedup: skip ${dto.event_type}:${dto.entity_id}:${dto.user_id}`)
      return { id: 0, status: 'deduplicated' }
    }

    const log = await this.delivery.createLog(dto)

    // Explicit future scheduling bypasses business-hours check
    if (dto.scheduled_at) {
      const scheduledAt = new Date(dto.scheduled_at)
      if (scheduledAt > new Date()) {
        await this.prisma.notificationLog.update({
          where: { id: log.id },
          data: { status: 'scheduled', scheduled_at: scheduledAt },
        })
        return { id: log.id, status: 'scheduled' }
      }
    }

    if (!isBusinessHours()) {
      const scheduledAt = getNextBusinessStart()
      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: 'scheduled', scheduled_at: scheduledAt },
      })
      return { id: log.id, status: 'scheduled' }
    }

    const finalStatus = await this.delivery.deliverWithRetry(log.id, dto)
    this.invalidateUnreadCache(dto.user_id)

    if (dto.channel === NotifChannel.IN_APP) {
      await this.emitUnreadCounts(dto.user_id)
    }

    return { id: log.id, status: finalStatus ?? 'sent' }
  }

  /**
   * Reaper: dòng kẹt ở `processing` quá lâu (instance chết giữa chừng) → trả về `scheduled` để gửi lại, hoặc
   * đánh `failed` khi đã thử đủ số lần. Dòng cũ chưa có `claimed_at` thì tính theo `scheduled_at`.
   */
  async reapStuckProcessing(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const cutoff = new Date(now.getTime() - STUCK_PROCESSING_MS)
    const stuck = await this.prisma.notificationLog.findMany({
      where: {
        status: 'processing',
        OR: [{ claimed_at: { lt: cutoff } }, { claimed_at: null, scheduled_at: { lt: cutoff } }],
      },
      select: { id: true, retry_count: true },
      take: 200,
    })
    let requeued = 0
    let failed = 0
    for (const row of stuck) {
      // Guard status='processing' để không đụng dòng vừa được xử lý xong bởi instance khác.
      if (row.retry_count + 1 >= MAX_SCHEDULED_ATTEMPTS) {
        const res = await this.prisma.notificationLog.updateMany({
          where: { id: row.id, status: 'processing' },
          data: { status: 'failed', retry_count: row.retry_count + 1, error: 'Kẹt ở trạng thái processing quá lâu, đã quá số lần thử' },
        })
        failed += res.count
      } else {
        const res = await this.prisma.notificationLog.updateMany({
          where: { id: row.id, status: 'processing' },
          data: { status: 'scheduled', retry_count: row.retry_count + 1, claimed_at: null },
        })
        requeued += res.count
      }
    }
    if (requeued + failed > 0) {
      this.logger.warn(`Reaper: trả ${requeued} dòng về scheduled, đánh failed ${failed} dòng kẹt processing`)
    }
    return { requeued, failed }
  }

  async processScheduled(): Promise<number> {
    await this.reapStuckProcessing()
    // Atomic claim: update status 'scheduled' → 'processing' to prevent double-delivery
    // when multiple instances run concurrently (no SELECT ... FOR UPDATE in Prisma).
    // KHÔNG chặn theo giờ hành chính ở đây: việc dời sang giờ hành chính đã nằm trong `scheduled_at`
    // (send() đặt `getNextBusinessStart()`), còn lịch gửi CỤ THỂ do người gọi chọn (vd 20:00) phải được giữ nguyên.
    const now = new Date()
    // Claim ONLY the batch we are about to deliver (previously every due row was claimed but only 100 processed,
    // leaving the rest stuck in 'processing'). Re-select by id after the guarded updateMany so concurrent
    // instances never deliver the same row twice.
    const due = await this.prisma.notificationLog.findMany({
      where: { status: 'scheduled', scheduled_at: { lte: now } },
      select: { id: true },
      take: 100,
      orderBy: { scheduled_at: 'asc' },
    })
    if (due.length === 0) return 0
    // Claim TỪNG dòng (guard status='scheduled'): chỉ dòng mà updateMany này thật sự đổi (count=1) mới được giao —
    // claim cả lô rồi chọn lại theo 'processing' sẽ nhặt cả dòng do instance khác vừa claim → gửi đôi.
    const won: number[] = []
    for (const { id } of due) {
      const res = await this.prisma.notificationLog.updateMany({
        where: { id, status: 'scheduled' },
        data: { status: 'processing', claimed_at: new Date() },
      })
      if (res.count === 1) won.push(id)
    }
    if (won.length === 0) return 0

    const pending = await this.prisma.notificationLog.findMany({
      where: { id: { in: won } },
      orderBy: { scheduled_at: 'asc' },
    })

    let processed = 0
    for (const log of pending) {
      const dto: SendNotificationDto = {
        user_id: log.recipient_id,
        channel: log.channel as NotifChannel,
        title: log.title ?? '',
        body: log.body ?? '',
        event_type: log.event_type ?? undefined,
        template_id: log.template_id ?? undefined,
        action_url: log.action_url ?? undefined,
        ...(log.webhook_url ? { metadata: { webhook_url: log.webhook_url } } : {}),
      }
      await this.delivery.deliverWithRetry(log.id, dto)
      // Như send(): thông báo hẹn giờ vừa giao cũng phải làm mới cache chưa-đọc + đẩy lại số đếm, kẻo badge cũ tới 5 phút.
      this.invalidateUnreadCache(log.recipient_id)
      if (dto.channel === NotifChannel.IN_APP) {
        try {
          await this.emitUnreadCounts(log.recipient_id)
        } catch (err) {
          this.logger.warn(`emitUnreadCounts sau processScheduled lỗi: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      processed++
    }
    return processed
  }

  invalidateUnreadCache(userId: number): void {
    this.unreadCache.delete(`${userId}:all`)
    this.unreadCache.delete(`${userId}:profile`)
    this.unreadCache.delete(`${userId}:message`)
  }
}
