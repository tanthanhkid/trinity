import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { NotificationsService } from './notifications.service';

export type ChannelEvent = 'facebook.comment_received' | 'messenger.message_received' | 'zalo_oa.message_received';

export interface ChannelNotice {
  event: ChannelEvent;
  /** Tên kênh hiện cho người đọc (tên Fanpage, "Zalo OA"). */
  channelName: string;
  /** Người nhận khách mặc định của kênh (vd default_assignee của Page). */
  defaultAssignee?: number | null;
  contactId?: number | null;
  contactCreated?: boolean;
  fromName?: string | null;
  text?: string | null;
  /** Một dòng kết quả luật tự xử lý (bình luận), vd "đã trả lời công khai, đã nhắn riêng". */
  autoResult?: string | null;
  actionUrl: string;
  /** Có giá trị ⇒ tin liên tiếp cùng hội thoại trong THROTTLE_MS chỉ báo một lần. Gộp theo actionUrl, nên actionUrl phải RIÊNG cho từng hội thoại. */
  threadKey?: string;
}

/** Tin nhắn liên tiếp trong cùng hội thoại: chỉ báo lần đầu trong 3 phút để chuông không dồn. */
export const THROTTLE_MS = 3 * 60 * 1000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Thông báo trong app (chuông) khi khách bình luận Fanpage, nhắn Messenger hoặc Zalo OA, kể cả khi vừa tạo khách mới từ kênh.
 * Người nhận: người phụ trách khách + người nhận khách mặc định của kênh + người quản lý kết nối (quyền integrations.webhooks).
 * Chỉ in-app (không email/Zalo ra ngoài). Lỗi ở đây KHÔNG làm hỏng việc nhận tin.
 */
@Injectable()
export class ChannelNotificationsService {
  private readonly logger = new Logger(ChannelNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async notify(n: ChannelNotice): Promise<void> {
    try {
      const owner = n.contactId ? (await this.prisma.contact.findUnique({ where: { id: n.contactId }, select: { assigned_to: true } }))?.assigned_to ?? null : null;
      const managers = await this.notifications.findUserIdsWithPermission('integrations.webhooks');
      let recipients = [...new Set([owner, n.defaultAssignee ?? null, ...managers].filter((x): x is number => typeof x === 'number' && x > 0))];
      if (recipients.length === 0) return;
      if (n.threadKey) {
        const since = new Date(Date.now() - THROTTLE_MS);
        const recent = await this.prisma.notificationLog.findMany({
          where: { recipient_id: { in: recipients }, event_type: n.event, action_url: n.actionUrl, created_at: { gte: since } },
          select: { recipient_id: true },
        });
        const done = new Set(recent.map((r) => r.recipient_id));
        recipients = recipients.filter((r) => !done.has(r));
        if (recipients.length === 0) return;
      }
      const who = n.fromName?.trim() || 'Khách';
      const title = n.event === 'facebook.comment_received'
        ? `Bình luận mới trên ${n.channelName}`
        : n.event === 'messenger.message_received'
          ? `Tin nhắn mới · ${n.channelName}`
          : 'Tin nhắn Zalo OA mới';
      const parts = [`${who}: ${clip((n.text ?? '').replace(/\s+/g, ' ').trim() || '[không có chữ]', 120)}`];
      if (n.autoResult) parts.push(n.autoResult);
      if (n.contactCreated) parts.push('đã tạo khách mới');
      await this.notifications.createPendingLogs(recipients, n.event, { title, body: clip(parts.join(' · '), 280), action_url: n.actionUrl });
    } catch (err) {
      this.logger.warn(`Thông báo kênh lỗi (${n.event}): ${(err as Error).message}`);
    }
  }
}
