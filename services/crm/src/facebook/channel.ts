/**
 * Giao diện kênh nhắn tin TỐI THIỂU. Facebook tự định nghĩa tại đây
 * (xem thêm `messaging/message-channel.interface.ts` cho interface chung).
 */
export interface ChannelSendResult {
  /** id tin do kênh trả về (Facebook: message_id). */
  externalId: string;
}

export interface MessagingChannel {
  readonly key: 'facebook' | 'zalo_oa';
  /** Gửi tin văn bản cho một người nhận (id theo kênh). Ném lỗi tiếng Việt nếu không gửi được. */
  sendText(accountId: string, recipientId: string, text: string): Promise<ChannelSendResult>;
}

/** Cửa sổ trả lời chuẩn của Messenger: 24 giờ kể từ tin KHÁCH gần nhất. https://developers.facebook.com/docs/messenger-platform/send-messages */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinMessagingWindow(lastInboundAt: Date | null | undefined, now = Date.now()): boolean {
  return Boolean(lastInboundAt) && now - (lastInboundAt as Date).getTime() < MESSAGING_WINDOW_MS;
}
