/**
 * Kênh nhắn tin chung: bot AI, bản tin định kỳ... gọi qua interface này thay vì biết Zalo OA, để sau này
 * thêm kênh khác (SMS, email) mà không sửa người gọi. Lỗi nghiệp vụ trả trong `SendResult` (ok=false), không ném.
 */
export interface OutboundTarget {
  /** Id người dùng phía kênh (Zalo: user_id theo OA). */
  externalUserId?: string;
  contactId?: number;
  phone?: string;
}

export interface OutboundMessage {
  to: OutboundTarget;
  /** Tin văn bản (tư vấn — trong cửa sổ trả lời của kênh). */
  text?: string;
  /** Tin theo mẫu đã duyệt (Zalo: ZNS). Cần `to.phone`. */
  template?: { id: string; data: Record<string, string>; trackingId?: string };
  /** Người gửi (user CRM); null/bỏ trống = hệ thống/bot. */
  sentBy?: number | null;
}

export interface SendResult {
  ok: boolean;
  messageId: string | null;
  /** Câu tiếng Việt khi ok=false. */
  error?: string;
}

export interface MessageChannel {
  readonly id: string;
  /** Kênh đã cấu hình + kết nối, sẵn sàng gửi? */
  isReady(): Promise<boolean>;
  send(msg: OutboundMessage): Promise<SendResult>;
}
