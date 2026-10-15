export interface DeliveryResult {
  success: boolean
  messageId?: string
  error?: string
  /** Kênh chưa được cấu hình/tích hợp: không gửi, không thử lại, ghi trạng thái `skipped` (không phải `sent`). */
  skipped?: boolean
  /** `false` = lỗi vĩnh viễn (vd URL bị chặn), thử lại cũng vô ích. */
  retryable?: boolean
}

export interface NotificationChannel {
  send(
    recipientId: number,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeliveryResult>
}
