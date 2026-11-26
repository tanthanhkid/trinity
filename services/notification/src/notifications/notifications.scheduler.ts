import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { ownership, runForEachCompany } from '@trinity/rbac-nest'
import { NotificationsService } from './notifications.service'

/** Tên job trong tệp sở hữu (`TRINITY_OWNERSHIP_FILE`). */
export const NOTIFICATION_SCHEDULED_JOB = 'notification.scheduled'

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name)

  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Cron quét thông báo hẹn giờ mỗi 2 phút: quy mô nhỏ không cần quét mỗi phút.
   * KHÔNG đổi logic `processScheduled()` (business hours, atomic claim...).
   */
  @Cron('0 */2 * * * *')
  async processScheduledNotifications(): Promise<void> {
    // Tệp sở hữu (T01): đọc lại mỗi lượt; job `notification.scheduled` đã giao cho Rust thì Node bỏ lượt.
    if (!ownership.nodeRunsJob(NOTIFICATION_SCHEDULED_JOB)) return
    // @Cron chạy ngoài request (không có công ty) ⇒ chạy cho TỪNG công ty, mỗi công ty trong ngữ cảnh riêng.
    await runForEachCompany(async () => {
      const processed = await this.notificationsService.processScheduled()
      if (processed > 0) {
        this.logger.log(`Processed ${processed} scheduled notifications`)
      }
    })
  }
}
