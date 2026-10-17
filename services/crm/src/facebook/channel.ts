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

/**
 * Nhân viên (người thật) trả lời thêm tới 7 ngày sau tin khách cuối bằng thẻ `HUMAN_AGENT` (cần Meta duyệt quyền Human Agent).
 * Chỉ dùng cho tin người gõ — kịch bản, gửi hàng loạt, luật tự động vẫn theo 24 giờ.
 * https://developers.facebook.com/docs/messenger-platform/send-messages/message-tags#human-agent
 */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Cách nhân viên trả lời được: `standard` (≤24h), `human_agent` (24h–7 ngày, gửi kèm thẻ), `closed` (quá 7 ngày / chưa có tin khách). */
export type MessengerReplyMode = 'standard' | 'human_agent' | 'closed';

export function messengerReplyMode(lastInboundAt: Date | null | undefined, now = Date.now()): MessengerReplyMode {
  if (!lastInboundAt) return 'closed';
  const age = now - lastInboundAt.getTime();
  return age < MESSAGING_WINDOW_MS ? 'standard' : age < HUMAN_AGENT_WINDOW_MS ? 'human_agent' : 'closed';
}
