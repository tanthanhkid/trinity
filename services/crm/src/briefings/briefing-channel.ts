import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { shortBody } from './briefing-text';
import type { BriefingConfig, BriefingContent, BriefingSlot } from './briefing.types';

export interface BriefingRecipient {
  id: number;
  email: string;
  name: string;
}

export interface BriefingDelivery {
  briefingId: number;
  slot: BriefingSlot;
  recipient: BriefingRecipient;
  content: BriefingContent;
}

/**
 * Kênh gửi bản tin. Thêm kênh mới (vd Zalo OA) = viết 1 class implements interface này
 * rồi thêm vào mảng `BRIEFING_CHANNELS` ở `briefings.module.ts`; service không phải sửa.
 */
export interface BriefingChannel {
  readonly name: string;
  /** Kênh có bật trong cấu hình + đủ điều kiện chạy không. */
  isEnabled(cfg: BriefingConfig): Promise<boolean> | boolean;
  /** true = đã gửi. Không ném lỗi (service coi lỗi của 1 kênh không chặn kênh khác). */
  send(d: BriefingDelivery): Promise<boolean>;
}

export const BRIEFING_CHANNELS = Symbol('BRIEFING_CHANNELS');

@Injectable()
export class InAppBriefingChannel implements BriefingChannel {
  readonly name = 'in_app';
  constructor(private readonly notifications: NotificationsService) {}

  isEnabled(cfg: BriefingConfig): boolean {
    return cfg.in_app;
  }

  async send(d: BriefingDelivery): Promise<boolean> {
    const res = await this.notifications.createPendingLogs([d.recipient.id], `briefing.${d.slot}`, {
      title: d.content.title,
      body: shortBody(d.content),
      action_url: `/briefings?id=${d.briefingId}`,
    });
    return res.created > 0;
  }
}
